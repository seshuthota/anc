import { randomUUID } from "node:crypto";
import { Annotation, END, START, StateGraph } from "@langchain/langgraph";
import { SqliteSaver } from "@langchain/langgraph-checkpoint-sqlite";
import { PRESENTATION_VIEWS, getMetricDefinition, type AgentFinding, type Domain, type EntityRef, type InvestigationTask, type PresentationInput, type SemanticAction, type TaskResult } from "@anc/contracts";
import type { Principal } from "@anc/policy";
import { hasGrant } from "@anc/policy";
import { peekSubstitutions } from "./execution.js";
import { isBroadObjective, MAX_TASKS, proposePlan, validatePlan } from "./planner.js";
import { synthesize, type Synthesis } from "./synthesis.js";
import { headlineMetrics, reconcileMetrics, type ReconcileResult } from "./reconcile.js";
import { rankBriefing, type BriefingPlan } from "./rank.js";
import { buildBriefing } from "./briefing.js";
import { RuntimeStore } from "@anc/runtime-storage";
import { validateA2UI } from "./a2ui-validate.js";
import { recordSubstitution } from "./execution.js";
import { composeSurface } from "./ui-composer.js";
import { runSpecialist, specialistLabel } from "./specialists/index.js";
import { CURRENT, TIMEZONE } from "./windows.js";

export type GraphState = {
  objective: string;
  threadId: string;
  investigationId: string;
  runId: string;
  status: "running" | "partial" | "completed" | "cancelled" | "failed";
  intent: string;
  tasks: Record<string, InvestigationTask>;
  results: Record<string, TaskResult>;
  findings: Record<string, AgentFinding>;
  selectedEntities: EntityRef[];
  round: number;
  surfaceId?: string;
  surfaceRevision?: number;
  view?: string;
  clarification?: string;
  synthesis?: Synthesis;
  reconciled?: ReconcileResult;
  briefingPlan?: BriefingPlan;
};

const State = Annotation.Root({
  objective: Annotation<string>(),
  threadId: Annotation<string>(),
  investigationId: Annotation<string>(),
  runId: Annotation<string>(),
  status: Annotation<GraphState["status"]>(),
  intent: Annotation<string>(),
  tasks: Annotation<Record<string, InvestigationTask>>({
    reducer: (left, right) => ({ ...left, ...right }),
    default: () => ({}),
  }),
  results: Annotation<Record<string, TaskResult>>({
    reducer: (left, right) => ({ ...left, ...right }),
    default: () => ({}),
  }),
  findings: Annotation<Record<string, AgentFinding>>({
    reducer: (left, right) => ({ ...left, ...right }),
    default: () => ({}),
  }),
  selectedEntities: Annotation<EntityRef[]>({
    reducer: (_left, right) => right,
    default: () => [],
  }),
  round: Annotation<number>({
    reducer: (_left, right) => right,
    default: () => 0,
  }),
  surfaceId: Annotation<string | undefined>(),
  surfaceRevision: Annotation<number | undefined>(),
  view: Annotation<string | undefined>(),
  clarification: Annotation<string | undefined>(),
  synthesis: Annotation<Synthesis | undefined>(),
  reconciled: Annotation<ReconcileResult | undefined>(),
  briefingPlan: Annotation<BriefingPlan | undefined>(),
});

export type ActivitySink = (message: string, kind?: "agent_started" | "agent_completed" | "tool_queried" | "finding_discovered" | "task_delegated" | "investigation_completed" | "status") => void;

export type GraphContext = {
  store: RuntimeStore;
  emit: ActivitySink;
  checkCancelled: () => boolean;
  principal: Principal;
};

export const graphContexts = new Map<string, GraphContext>();

async function waitForTestDelay(checkCancelled: () => boolean) {
  const ms = Number(process.env.INVESTIGATION_STEP_DELAY_MS ?? 0);
  if (!ms) return;
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (checkCancelled()) return;
    await new Promise((resolve) => setTimeout(resolve, Math.min(50, deadline - Date.now())));
  }
}

function fingerprint(domain: Domain, question: string, entities: EntityRef[]) {
  const scope = [...entities].map((entity) => `${entity.type}:${entity.id}`).sort().join(",");
  return `${domain}|${question}|${scope}`;
}

function task(domain: Domain, question: string, entities: EntityRef[] = [], capabilities: string[] = [], deps: string[] = []): InvestigationTask {
  return {
    taskId: `task-${domain}-${randomUUID().slice(0, 8)}`,
    domain,
    question,
    entityScope: entities,
    window: { start: CURRENT.from, end: CURRENT.to, timezone: TIMEZONE, grain: "hour" },
    dependencies: deps,
    status: "pending",
    attemptCount: 0,
    capabilities,
  };
}

/** The records the findings are about, carried forward so a follow-up can be scoped to them. */
function entitiesFrom(findings: AgentFinding[]): EntityRef[] {
  const seen = new Set<string>();
  const entities: EntityRef[] = [];
  for (const finding of findings) {
    for (const entity of finding.entities) {
      const key = `${entity.type}:${entity.id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      entities.push(entity);
    }
  }
  return entities.slice(0, 24);
}

function ctxOf(state: { runId: string }): GraphContext {
  const ctx = graphContexts.get(state.runId);
  if (!ctx?.store || !ctx.emit || !ctx.checkCancelled) throw new Error("missing graph context");
  return ctx;
}

/**
 * The view of the last accepted surface on this thread. A new run starts with an
 * empty intent, so without this a typed follow-up like "show these as a table"
 * could not tell that it was continuing an existing answer.
 */
function priorViewOf(store: RuntimeStore, threadId: string): string | undefined {
  const latest = store.listSurfaces(threadId)[0];
  if (!latest) return undefined;
  const surface = store.getSurface(latest.surfaceId, latest.revision);
  const view = (surface?.dataModel as { view?: string } | undefined)?.view;
  return view || undefined;
}

async function planNode(state: typeof State.State): Promise<Partial<GraphState>> {
  const ctx = ctxOf(state);
  await waitForTestDelay(ctx.checkCancelled);
  if (ctx.checkCancelled()) return { status: "cancelled" };
  // One round of work per question: the specialists run once, then the lead analyst connects what they found.
  if (Object.keys(state.tasks).length) return { intent: state.intent };
  const plan = await proposePlan({
    objective: state.objective,
    action: state.intent ? { name: state.intent } as SemanticAction : undefined,
    principal: ctx.principal,
    selectedEntities: state.selectedEntities,
    priorIntent: state.intent || priorViewOf(ctx.store, state.threadId),
    runId: state.runId,
  });
  const planErrors = validatePlan(plan);
  if (planErrors.length) ctx.emit(`Plan adjusted: ${planErrors[0]}`, "status");
  if (plan.clarification && !plan.tasks.length) {
    ctx.emit(plan.clarification, "status");
    return { intent: "clarification", view: "summary", clarification: plan.clarification, status: "completed" };
  }
  if (plan.unsupported) {
    ctx.emit(plan.unsupported, "status");
    return { intent: "unsupported", view: "summary", status: "completed" };
  }
  if (!plan.tasks.length) return { intent: plan.intent, view: plan.view };
  const planned: InvestigationTask[] = plan.tasks.map((item) => task(item.domain, item.question, item.entities ?? state.selectedEntities, item.capabilities));
  const intent = plan.intent;
  const seen = new Set<string>();
  const tasks: Record<string, InvestigationTask> = {};
  for (const item of planned) {
    const key = fingerprint(item.domain, item.question, item.entityScope);
    if (seen.has(key)) continue;
    seen.add(key);
    tasks[item.taskId] = item;
    ctx.emit(`${specialistLabel(item.domain)} started`, "agent_started");
    ctx.store.upsertTask({ id: item.taskId, runId: state.runId, investigationId: state.investigationId, domain: item.domain, question: item.question, status: "pending", payload: item, now: new Date().toISOString() });
  }
  return { tasks, intent, view: plan.view };
}

async function executeNode(state: typeof State.State): Promise<Partial<GraphState>> {
  const ctx = ctxOf(state);
  await waitForTestDelay(ctx.checkCancelled);
  if (ctx.checkCancelled()) return { status: "cancelled" };
  const pending = Object.values(state.tasks).filter((item) => item.status === "pending" || item.status === "running");
  const ready = pending.slice(0, MAX_TASKS);
  const findings: Record<string, AgentFinding> = {};
  const results: Record<string, TaskResult> = {};
  const tasks: Record<string, InvestigationTask> = {};
  await Promise.all(ready.map(async (item) => {
    const running = { ...item, status: "running" as const, attemptCount: item.attemptCount + 1 };
    tasks[item.taskId] = running;
    ctx.store.upsertTask({ id: item.taskId, runId: state.runId, investigationId: state.investigationId, domain: item.domain, question: item.question, status: "running", payload: running, now: new Date().toISOString() });
    let result: TaskResult;
    if (process.env.FORCE_SPECIALIST_FAILURE === item.domain) {
      // Test hook: one specialist times out so the others' work can be shown without it.
      result = { taskId: item.taskId, status: "failed", findingIds: [], findings: [], unresolvedQuestions: ["Timed out"], suggestedFollowUps: [], error: "Timed out" };
    } else {
      try {
        result = await runSpecialist(ctx.store, running, state.runId, ctx.principal.id);
        const substitution = peekSubstitutions(state.runId).find((item) => item.specialist === running.domain);
        if (substitution) {
          ctx.emit(`${specialistLabel(item.domain)} used the deterministic specialist (${substitution.reason})`, "status");
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : "specialist failed";
        result = { taskId: item.taskId, status: "failed", findingIds: [], findings: [], unresolvedQuestions: [message], suggestedFollowUps: [], error: message };
      }
    }
    results[item.taskId] = result;
    tasks[item.taskId] = { ...running, status: result.status };
    ctx.store.upsertTask({ id: item.taskId, runId: state.runId, investigationId: state.investigationId, domain: item.domain, question: item.question, status: result.status, payload: running, result, now: new Date().toISOString() });
    for (const finding of result.findings) {
      findings[finding.findingId] = finding;
      ctx.emit(`${specialistLabel(item.domain)} finding: ${finding.title}`, "finding_discovered");
    }
    ctx.emit(`${specialistLabel(item.domain)} ${result.status}`, result.status === "failed" ? "status" : "agent_completed");
  }));
  ctx.store.claimArtifacts(state.runId, state.threadId, ctx.principal.id);
  const mergedFindings = { ...state.findings, ...findings };
  return { tasks, results, findings, selectedEntities: entitiesFrom(Object.values(mergedFindings)) };
}

async function reconcileNode(state: typeof State.State): Promise<Partial<GraphState>> {
  const ctx = ctxOf(state);
  if (ctx.checkCancelled()) return { status: "cancelled" };
  const findings = Object.values(state.findings);
  const reconciled = reconcileMetrics(findings);
  for (const note of reconciled.notes) {
    ctx.emit(`Reconciliation: ${note}`, "status");
  }
  return { reconciled };
}

async function composeNode(state: typeof State.State): Promise<Partial<GraphState>> {
  const ctx = ctxOf(state);
  if (ctx.checkCancelled()) return { status: "cancelled" };
  const findings = Object.values(state.findings);
  const failedDomains = [...new Set(Object.values(state.tasks).filter((item) => item.status === "failed").map((item) => item.domain))];
  const listed = ctx.store.listArtifacts(state.threadId, ctx.principal.id);
  const current = listed.filter((item) => item.runId === state.runId);
  // Earlier runs' artifacts are only for re-presenting them (a table toggle, a
  // form step). A run that did its own work is composed from that work alone,
  // so an older table cannot title or pad a new answer.
  const didWork = Object.keys(state.tasks).length > 0;
  const artifacts = didWork ? current : [...current, ...listed.filter((item) => item.runId !== state.runId)];
  const presentation = toPresentation({ intent: state.intent, objective: state.objective, findings, failedDomains, artifacts, view: state.view, clarification: state.clarification, synthesis: state.synthesis, principal: ctx.principal, reconciled: state.reconciled, briefingPlan: state.briefingPlan, checkedDomains: [...new Set(Object.values(state.tasks).filter((item) => item.status !== "failed").map((item) => item.domain))] });
  const surfaceId = `surface-${state.investigationId}`;
  const revision = (state.surfaceRevision ?? 0) + 1;
  ctx.emit("UI Composer is designing the workspace", "status");
  const composed = await composeSurface(surfaceId, presentation, {
    objective: state.objective,
    runId: state.runId,
    mode: isBroadObjective(state.objective) ? "briefing" : "detail",
    audience: `${ctx.principal.title}. Cares about: ${ctx.principal.preferences.priorities.join(", ")}.`,
  });
  if (composed.reason) {
    // Not silent: a rejected model layout is reported and counted like any other substitution.
    ctx.emit("UI Composer layout was rejected; showing the standard layout", "status");
    console.warn(`UI Composer layout rejected: ${composed.reason}`);
    recordSubstitution(state.runId, "ui-composer", composed.reason);
  }
  const invalid = validateA2UI(composed.messages);
  if (invalid.length) {
    ctx.emit(`Composer output invalid; keeping last accepted surface. ${invalid[0]}`, "status");
    return {
      surfaceId: state.surfaceId,
      surfaceRevision: state.surfaceRevision,
      status: "partial",
    };
  }
  ctx.store.saveSurface({
    surfaceId,
    revision,
    threadId: state.threadId,
    investigationId: state.investigationId,
    runId: state.runId,
    ownerId: ctx.principal.id,
    title: presentation.title,
    messages: composed.messages,
    dataModel: composed.dataModel,
    findingIds: findings.map((item) => item.findingId),
    requiredGrants: [...new Set(Object.values(state.tasks).flatMap((task) => task.capabilities))],
    now: new Date().toISOString(),
  });
  ctx.emit("Investigation completed", "investigation_completed");
  const failed = Object.values(state.results).some((result) => result.status === "failed");
  return {
    surfaceId,
    surfaceRevision: revision,
    status: failed ? "partial" : "completed",
  };
}

/**
 * The lead analyst reads every specialist's findings together and states how
 * they connect. Specialists never see each other's work, so this is the only
 * place a cause in one part of the network is tied to its effects in another.
 */
async function synthesizeNode(state: typeof State.State): Promise<Partial<GraphState>> {
  const ctx = ctxOf(state);
  if (ctx.checkCancelled()) return { status: "cancelled" };
  const findings = Object.values(state.findings);
  const reconciled = state.reconciled ?? reconcileMetrics(findings);
  const audience = `${ctx.principal.title}. ${ctx.principal.preferences.roleDescription} Cares about: ${ctx.principal.preferences.priorities.join(", ")}.`;
  const outcome = await synthesize({ objective: state.objective, audience, findings, runId: state.runId, reconciled, principal: ctx.principal });
  if (outcome.reason && outcome.synthesis) {
    ctx.emit("Lead Analyst ranking was replaced by the deterministic ranker", "status");
    recordSubstitution(state.runId, "lead-analyst", outcome.reason);
  }
  if (outcome.synthesis) {
    ctx.emit(`Lead Analyst connected the findings: ${outcome.synthesis.headline}`, "finding_discovered");
    return { synthesis: outcome.synthesis, briefingPlan: outcome.briefingPlan, reconciled };
  }
  if (outcome.briefingPlan) {
    return { briefingPlan: outcome.briefingPlan, reconciled };
  }
  if (outcome.reason) {
    ctx.emit("Lead Analyst could not connect the findings; showing them side by side", "status");
    recordSubstitution(state.runId, "lead-analyst", outcome.reason);
  }
  return { reconciled, briefingPlan: outcome.briefingPlan ?? rankBriefing({ findings, reconciled, principal: ctx.principal }) };
}

function routeAfterPlan(state: typeof State.State): "execute" | "compose" | typeof END {  if (state.status === "cancelled") return END;
  const pending = Object.values(state.tasks).filter((item) => item.status === "pending");
  return pending.length ? "execute" : "compose";
}

function routeAfterExecute(state: typeof State.State): "plan" | "reconcile" | typeof END {
  if (state.status === "cancelled") return END;
  const pending = Object.values(state.tasks).filter((item) => item.status === "pending");
  return pending.length ? "plan" : "reconcile";
}

export function createInvestigationGraph(checkpointer: SqliteSaver) {
  const graph = new StateGraph(State)
    .addNode("plan", planNode)
    .addNode("execute", executeNode)
    .addNode("reconcile", reconcileNode)
    .addNode("synthesize", synthesizeNode)
    .addNode("compose", composeNode)
    .addEdge(START, "plan")
    .addConditionalEdges("plan", routeAfterPlan, { execute: "execute", compose: "compose", [END]: END })
    .addConditionalEdges("execute", routeAfterExecute, { plan: "plan", reconcile: "reconcile", [END]: END })
    .addEdge("reconcile", "synthesize")
    .addEdge("synthesize", "compose")
    .addEdge("compose", END);
  return graph.compile({ checkpointer });
}

export function incrementRound(state: GraphState): GraphState {
  return { ...state, round: state.round + 1 };
}

type PresentationSource = {
  intent: string;
  objective: string;
  findings: AgentFinding[];
  failedDomains?: Domain[];
  artifacts?: Array<{ id: string; kind: string; payload: unknown }>;
  view?: string;
  clarification?: string;
  synthesis?: Synthesis;
  principal?: Principal;
  reconciled?: ReconcileResult;
  briefingPlan?: BriefingPlan;
  /** Specialists that completed their part, for the quiet-day "Checked:" line. */
  checkedDomains?: Domain[];
};

const SEVERITY_ORDER = ["critical", "high", "medium", "low", "info"];

/**
 * Turns verified findings, tool-built tables and charts, and the lead analyst's
 * synthesis into the data a surface is composed from. Everything here comes
 * from stored evidence or checked findings; nothing is authored at this step.
 */
export function toPresentation(source: PresentationSource): PresentationInput {
  const { intent, objective, failedDomains = [], artifacts = [], view, clarification, principal, reconciled, briefingPlan } = source;
  // Specialists finish in any order; sort on content (not arrival or random ids) so the same data lays out the same way.
  const findings = [...source.findings].sort((a, b) => SEVERITY_ORDER.indexOf(a.severity) - SEVERITY_ORDER.indexOf(b.severity)
    || a.agentId.localeCompare(b.agentId) || a.title.localeCompare(b.title));
  const question = clarification ?? (intent === "clarification" ? "A detail is needed before this can be answered." : undefined);
  if (question) {
    return { title: "One detail is needed", subtitle: question, view: "summary", metrics: [], findings: [], actions: [], limitations: ["Answering now would mean guessing. Nothing has been assumed on your behalf."] };
  }
  if (intent === "unsupported") {
    return { title: "Not available", subtitle: "This workspace cannot complete that request with the access you have.", view: "summary", metrics: [], findings: [], actions: [], limitations: ["Nothing was made up to fill the gap. Ask about hubs, parcels, lockers, shippers or complaints."] };
  }
  const unavailable = failedDomains.map((domain) => `${specialistLabel(domain)} could not complete its part, so that part is missing.`);
  if (!findings.length && failedDomains.length) {
    return { title: "Incomplete answer", subtitle: "The specialists could not complete this question.", view: "summary", metrics: [], findings: [], actions: [], limitations: unavailable };
  }

  const plan = briefingPlan ?? (reconciled ? rankBriefing({ findings, reconciled, principal }) : undefined);
  // The Lead Analyst's headline and whyItMatters stand only when they describe the
  // ranked primary. With a plan but no primary (quiet, or withheld), there is no headline to write.
  const synthesis = plan
    ? (plan.primary && source.synthesis?.primaryFindingId === plan.primary.findingId ? source.synthesis : undefined)
    : source.synthesis;
  const evidenceOf = (ids: string[]) => [...new Set(findings.filter((finding) => ids.includes(finding.findingId)).flatMap((finding) => finding.claims.flatMap((claim) => claim.evidenceIds)))];

  // Metrics come only from the reconciled set (never a raw flatten of every claim),
  // and only headline-eligible ones: no of-which child, orphan, or conflicted value.
  const reconciledMetrics = reconciled ? headlineMetrics(reconciled) : [];
  const allMetrics = reconciledMetrics.map((metric) => {
    const ratio = /ratio|rate|percent|share/i.test(metric.unit) && metric.value >= 0 && metric.value <= 1;
    const percent = /percent/i.test(metric.unit) && metric.value > 1;
    const value = ratio ? `${(metric.value * 100).toFixed(1)}%` : percent ? `${metric.value.toFixed(1)}%` : metric.value.toLocaleString("en-IN", { maximumFractionDigits: 1 });
    const denominatorLabel = metric.denominator?.metricId ? getMetricDefinition(metric.denominator.metricId)?.label.toLowerCase() : undefined;
    const den = metric.denominator ? ` · of ${metric.denominator.value.toLocaleString("en-IN")}${denominatorLabel ? ` ${denominatorLabel}` : ""}` : "";
    return {
      id: `${metric.metricId}-${metric.scope.type}-${metric.scope.id ?? "all"}`.replace(/[^a-zA-Z0-9_-]/g, "_"),
      metricId: metric.metricId,
      label: metric.label,
      value,
      detail: metric.definition + den,
      evidenceId: metric.evidenceIds[0]!,
      tone: metric.value > 0 && (metric.metricId === "parcels_at_risk_today" || metric.scope.type === "network") ? "danger" as const : "neutral" as const,
    };
  }).filter((metric) => metric.evidenceId);
  const metrics = allMetrics.slice(0, 4);

  const primaryFinding = plan?.primary ? findings.find((finding) => finding.findingId === plan.primary!.findingId) : undefined;
  const secondaryIds = new Set(plan?.secondary.map((item) => item.findingId) ?? []);
  const presentationFindings = (
    plan?.primary
      ? [
          ...(primaryFinding ? [primaryFinding] : []),
          ...findings.filter((finding) => secondaryIds.has(finding.findingId) && finding.findingId !== plan.primary!.findingId),
          // Keep remaining findings available for non-briefing views.
          ...(!isBroadObjective(objective) ? findings.filter((finding) => finding.findingId !== plan.primary!.findingId && !secondaryIds.has(finding.findingId)) : []),
        ]
      // No primary on a briefing: only the ranked secondary items, never the
      // conflicted findings whose figures were withheld.
      : plan && isBroadObjective(objective) ? findings.filter((finding) => secondaryIds.has(finding.findingId)) : findings
  ).map((finding) => ({
    id: finding.findingId,
    title: finding.title,
    body: finding.summary,
    kind: finding.kind,
    severity: finding.severity,
    evidenceIds: finding.claims.flatMap((claim) => claim.evidenceIds),
  }));

  const tableArtifact = artifacts.find((item) => item.kind === "table");
  const tablePayload = tableArtifact?.payload as {
    title?: string; columns?: string[]; totals?: string[]; completeness?: "complete" | "partial" | "empty";
    rows?: Array<{ id: string; cells: string[]; sortValues?: number[]; entityType?: string; entityId?: string; actionName?: string }>;
    rowAction?: { name: string; label?: string };
  } | undefined;
  const seriesArtifact = artifacts.find((item) => item.kind === "series");
  const seriesPayload = seriesArtifact?.payload as { title?: string; unit?: string; points?: Array<{ label: string; value: number }> } | undefined;
  const points = seriesPayload?.points ?? [];

  const broad = isBroadObjective(objective);
  const rowAction = tablePayload?.rowAction && (!principal || hasGrant(principal, "cap.complaints.assign")) ? tablePayload.rowAction : undefined;
  const rows = (tablePayload?.rows ?? []).map((row) => ({ ...row, actionName: rowAction?.name }));
  const resolvedView = resolveView(view, { hasTable: rows.length > 0, hasChart: points.length >= 2, hasForm: intent === "prepare_assignment" || intent === "commit_assignment" });
  const quiet = plan ? plan.quiet : false;
  const single = resolvedView !== "summary" && !synthesis;
  const title = synthesis?.headline
    ?? (plan?.primary && primaryFinding ? primaryFinding.title : undefined)
    ?? (single && tablePayload?.title ? tablePayload.title.split(":")[0]! : undefined)
    ?? (broad ? (quiet ? "Nothing needs your attention this morning" : "This morning") : (presentationFindings[0]?.title ?? "Results"));
  const subtitle = quiet && broad
    ? "The network is running to plan as far as the specialists could see."
    : (synthesis?.whyItMatters ?? plan?.primary?.whyItMatters ?? primaryFinding?.summary ?? (plan?.withheld && broad ? "The specialists found something serious, but no single figure can headline it yet." : undefined) ?? presentationFindings[0]?.body ?? "Records from the company's systems.");
  const numericColumn = rows[0]?.sortValues?.findIndex((value) => Number.isFinite(value)) ?? -1;

  // A morning briefing is laid out from the briefing plan alone: one primary
  // (with its one figure), a collapsed rest, at most three actions. No free
  // metric tiles, no finding cards, no Sequence outside the primary block.
  if (broad && plan && resolvedView === "summary") {
    const briefing = buildBriefing({ plan, findings, synthesis, reconciled, checkedDomains: source.checkedDomains ?? [] });
    return {
      title: briefing.primary?.headline ?? (quiet ? "Nothing needs your attention this morning" : "This morning"),
      subtitle: briefing.primary?.whyItMatters ?? briefing.quiet.label,
      view: "summary",
      briefing,
      metrics: [],
      findings: [],
      actions: [],
      limitations: [
        ...unavailable,
        ...(reconciled?.notes ?? []),
        briefing.primary?.chain.some((hop) => hop.kind === "inferred") ? "Links marked as inferred are the analyst's reasoning across findings, not something a system recorded." : "",
      ].filter(Boolean),
    };
  }

  return {
    title,
    subtitle,
    view: resolvedView,
    synthesis: synthesis ? {
      headline: synthesis.headline,
      steps: synthesis.steps.map((step) => ({ ...step, evidenceIds: evidenceOf(step.findingIds) })),
      separate: synthesis.separate.map((item) => ({ ...item, evidenceIds: evidenceOf(item.findingIds) })),
    } : undefined,
    metrics: resolvedView === "table" ? [] : (() => {
      if (broad && quiet) return [];
      if (!broad) return metrics;
      // A briefing shows exactly the primary's own figure, or none.
      const primaryMetric = plan?.primary?.metric;
      if (!primaryMetric) return [];
      return allMetrics.filter((metric) => metric.metricId === primaryMetric.metricId && metric.id === `${primaryMetric.metricId}-${primaryMetric.scope.type}-${primaryMetric.scope.id ?? "all"}`.replace(/[^a-zA-Z0-9_-]/g, "_")).slice(0, 1);
    })(),
    findings: broad && quiet ? [] : broad && plan ? presentationFindings.slice(0, 1 + (plan.secondary.length)) : presentationFindings,
    chart: points.length >= 2 ? {
      id: seriesArtifact!.id,
      title: seriesPayload?.title ?? "Trend",
      unit: seriesPayload?.unit ?? "",
      points,
      caption: "Each point is a total from the company's records, not a single parcel.",
    } : undefined,
    table: rows.length ? {
      id: tableArtifact!.id,
      columns: tablePayload?.columns ?? [],
      rows,
      totals: tablePayload?.totals,
      completeness: tablePayload?.completeness ?? "complete",
      defaultSort: resolvedView === "comparison" && numericColumn >= 0 ? numericColumn : 0,
    } : undefined,
    actions: [],
    limitations: [
      ...unavailable,
      ...(reconciled?.notes ?? []),
      plan?.withheld ?? "",
      synthesis?.steps.some((step) => step.kind === "inferred") ? "Links marked as inferred are the analyst's reasoning across findings, not something a system recorded." : "",
      objective && !broad ? `Question: ${objective}` : "",
    ].filter(Boolean),
  };
}

function resolveView(view: string | undefined, available: { hasTable: boolean; hasChart: boolean; hasForm: boolean }): PresentationInput["view"] {
  if (available.hasForm) return "form";
  if (view && (PRESENTATION_VIEWS as readonly string[]).includes(view)) return view as PresentationInput["view"];
  if (available.hasChart) return "trend";
  if (available.hasTable) return "table";
  return "summary";
}
