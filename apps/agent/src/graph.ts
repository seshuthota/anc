import { randomUUID } from "node:crypto";
import { Annotation, END, START, StateGraph } from "@langchain/langgraph";
import { SqliteSaver } from "@langchain/langgraph-checkpoint-sqlite";
import type { AgentFinding, Domain, EntityRef, InvestigationTask, PresentationInput, SemanticAction, TaskResult } from "@anc/contracts";
import type { Principal } from "@anc/policy";
import { DEMO_OWNER_ID, hasGrant } from "@anc/policy";
import { peekSubstitutions } from "./execution.js";
import { isBroadObjective, proposePlan, validatePlan } from "./planner.js";
import { resolveExecutionMode } from "./provider.js";
import { RuntimeStore } from "@anc/runtime-storage";
import { validateA2UI } from "./a2ui-validate.js";
import { composeA2UI } from "./composer.js";
import { runSpecialist, specialistLabel } from "./specialists/index.js";
import { CURRENT } from "./windows.js";

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
    window: { start: CURRENT.from, end: CURRENT.to, timezone: "UTC", grain: "hour" },
    dependencies: deps,
    status: "pending",
    attemptCount: 0,
    capabilities,
  };
}

function affectedFrom(findings: AgentFinding[]): EntityRef[] {
  const seen = new Set<string>();
  const entities: EntityRef[] = [];
  for (const finding of findings) {
    for (const entity of finding.entities) {
      if (entity.type === "customer" && !seen.has(entity.id)) {
        seen.add(entity.id);
        entities.push(entity);
      }
    }
  }
  return entities;
}

function releaseFrom(findings: AgentFinding[]): EntityRef | undefined {
  for (const finding of findings) {
    const entity = finding.entities.find((item) => item.type === "release");
    if (entity) return entity;
  }
  return undefined;
}

function ctxOf(state: { runId: string }): GraphContext {
  const ctx = graphContexts.get(state.runId);
  if (!ctx?.store || !ctx.emit || !ctx.checkCancelled) throw new Error("missing graph context");
  return ctx;
}

async function planNode(state: typeof State.State): Promise<Partial<GraphState>> {
  const ctx = ctxOf(state);
  await waitForTestDelay(ctx.checkCancelled);
  if (ctx.checkCancelled()) return { status: "cancelled" };
  const existing = Object.values(state.tasks);
  if (existing.length) {
    const customers = affectedFrom(Object.values(state.findings));
    const hasFinance = existing.some((item) => item.domain === "finance");
    const canFollowUp = customers.length && !hasFinance && hasGrant(ctx.principal, "cap.finance.arr") && existing.some((item) => item.domain === "reliability") && state.round < 3;
    if (canFollowUp && resolveExecutionMode() === "fixture") {
      const question = "Calculate represented ARR for the validated affected-account set.";
      const exists = existing.some((item) => fingerprint(item.domain, item.question, item.entityScope) === fingerprint("finance", question, customers));
      if (exists) return { intent: state.intent };
      const financeTask = task("finance", question, customers, ["cap.finance.arr"]);
      ctx.emit(`${specialistLabel("finance")} scheduled`, "task_delegated");
      ctx.store.upsertTask({ id: financeTask.taskId, runId: state.runId, investigationId: state.investigationId, domain: financeTask.domain, question: financeTask.question, status: "pending", payload: financeTask, now: new Date().toISOString() });
      return { tasks: { [financeTask.taskId]: financeTask }, intent: state.intent, round: state.round + 1 };
    }
    if (canFollowUp) {
      const completed = existing.flatMap((item) => item.capabilities);
      const plan = await proposePlan({
        objective: `${state.objective}\nAffected account ids are now known. Add at most one authorized exposure task for that set. Do not repeat completed capabilities.`,
        principal: ctx.principal,
        selectedEntities: customers,
        completedCapabilities: completed,
        runId: state.runId,
      });
      const fresh = plan.tasks.filter((item) => !existing.some((current) => current.domain === item.domain));
      if (!fresh.length) return { intent: state.intent };
      const next = task(fresh[0]!.domain, fresh[0]!.question, customers, fresh[0]!.capabilities);
      ctx.emit(`${specialistLabel(next.domain)} scheduled`, "task_delegated");
      ctx.store.upsertTask({ id: next.taskId, runId: state.runId, investigationId: state.investigationId, domain: next.domain, question: next.question, status: "pending", payload: next, now: new Date().toISOString() });
      return { tasks: { [next.taskId]: next }, intent: plan.intent || state.intent, round: state.round + 1 };
    }
    return { intent: state.intent };
  }
  const plan = await proposePlan({
    objective: state.objective,
    action: state.intent ? { name: state.intent } as SemanticAction : undefined,
    principal: ctx.principal,
    selectedEntities: state.selectedEntities,
    priorIntent: state.intent,
    runId: state.runId,
  });
  const planErrors = validatePlan(plan);
  if (planErrors.length) ctx.emit(`Plan adjusted: ${planErrors[0]}`, "status");
  if (plan.unsupported) {
    ctx.emit(plan.unsupported, "status");
    return { intent: "unsupported", view: "summary", status: "completed" };
  }
  if (!plan.tasks.length) return { intent: plan.intent, view: plan.view };
  const selected = state.selectedEntities;
  const planned: InvestigationTask[] = plan.tasks.map((item) => task(item.domain, item.question, selected, item.capabilities));
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
  const ready = pending.slice(0, 3);
  const findings: Record<string, AgentFinding> = {};
  const results: Record<string, TaskResult> = {};
  const tasks: Record<string, InvestigationTask> = {};
  await Promise.all(ready.map(async (item) => {
    const running = { ...item, status: "running" as const, attemptCount: item.attemptCount + 1 };
    tasks[item.taskId] = running;
    ctx.store.upsertTask({ id: item.taskId, runId: state.runId, investigationId: state.investigationId, domain: item.domain, question: item.question, status: "running", payload: running, now: new Date().toISOString() });
    let result: TaskResult;
    if (process.env.FORCE_FINANCE_FAILURE === "1" && item.domain === "finance") {
      result = { taskId: item.taskId, status: "failed", findingIds: [], findings: [], unresolvedQuestions: ["Finance timed out"], suggestedFollowUps: [], error: "Finance timed out" };
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
  noteContradictions(Object.values(mergedFindings), ctx);
  return { tasks, results, findings, selectedEntities: affectedFrom(Object.values(mergedFindings)) };
}

function noteContradictions(findings: AgentFinding[], ctx: GraphContext) {
  const byMetric = new Map<string, number[]>();
  for (const finding of findings) {
    for (const claim of finding.claims) {
      for (const metric of claim.metrics) {
        const values = byMetric.get(metric.name) ?? [];
        values.push(metric.value);
        byMetric.set(metric.name, values);
      }
    }
  }
  for (const [name, values] of byMetric) {
    const min = Math.min(...values);
    const max = Math.max(...values);
    if (max - min > Math.max(1e-6, Math.abs(min) * 0.05)) {
      ctx.emit(`Contradictory ${name} values remain visible until resolved`, "status");
    }
  }
}

async function composeNode(state: typeof State.State): Promise<Partial<GraphState>> {
  const ctx = ctxOf(state);
  if (ctx.checkCancelled()) return { status: "cancelled" };
  const findings = Object.values(state.findings);
  const failedDomains = [...new Set(Object.values(state.tasks).filter((item) => item.status === "failed").map((item) => item.domain))];
  const failedFinance = failedDomains.includes("finance")
    || Object.values(state.results).some((result) => result.taskId.includes("finance") && result.status === "failed");
  const listed = ctx.store.listArtifacts(state.threadId, ctx.principal.id);
  const current = listed.filter((item) => item.runId === state.runId);
  const artifacts = current.length ? current : listed;
  const presentation = toPresentation(state.intent, state.objective, findings, failedFinance, failedDomains, artifacts, state.view);
  const surfaceId = `surface-${state.investigationId}`;
  const revision = (state.surfaceRevision ?? 0) + 1;
  const composed = composeA2UI(surfaceId, presentation);
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

function routeAfterPlan(state: typeof State.State): "execute" | "compose" | typeof END {
  if (state.status === "cancelled") return END;
  const pending = Object.values(state.tasks).filter((item) => item.status === "pending");
  return pending.length ? "execute" : "compose";
}

function routeAfterExecute(state: typeof State.State): "plan" | "compose" | typeof END {
  if (state.status === "cancelled") return END;
  const customers = affectedFrom(Object.values(state.findings));
  const hasFinance = Object.values(state.tasks).some((item) => item.domain === "finance");
  const pending = Object.values(state.tasks).filter((item) => item.status === "pending");
  if (pending.length) return "plan";
  if (customers.length && !hasFinance && state.round < 3 && Object.values(state.tasks).some((item) => item.domain === "reliability")) return "plan";
  return "compose";
}

export function createInvestigationGraph(checkpointer: SqliteSaver) {
  const graph = new StateGraph(State)
    .addNode("plan", planNode)
    .addNode("execute", executeNode)
    .addNode("compose", composeNode)
    .addEdge(START, "plan")
    .addConditionalEdges("plan", routeAfterPlan, { execute: "execute", compose: "compose", [END]: END })
    .addConditionalEdges("execute", routeAfterExecute, { plan: "plan", compose: "compose", [END]: END })
    .addEdge("compose", END);
  return graph.compile({ checkpointer });
}

export function incrementRound(state: GraphState): GraphState {
  return { ...state, round: state.round + 1 };
}

export function toPresentation(
  intent: string,
  objective: string,
  findings: AgentFinding[],
  financeFailed = false,
  failedDomains: Domain[] = [],
  artifacts: Array<{ id: string; kind: string; payload: unknown }> = [],
  view?: string,
): PresentationInput {
  const customers = affectedFrom(findings);
  if (!findings.length && failedDomains.length) {
    return {
      title: "Incomplete answer",
      subtitle: "One or more specialists could not complete this question.",
      metrics: [],
      findings: [],
      actions: [],
      limitations: failedDomains.map((domain) => `${specialistLabel(domain)} results are unavailable for this run.`),
    };
  }
  const release = releaseFrom(findings);
  const metrics = findings.flatMap((finding) => finding.claims.flatMap((claim) => claim.metrics.map((metric) => {
    const evidenceId = claim.evidenceIds[0];
    if (!evidenceId) return [];
    let value = String(metric.value);
    if (metric.unit === "ratio") value = `${(metric.value * 100).toFixed(1)}%`;
    if (metric.unit === "percent") value = `${metric.value.toFixed(0)}%`;
    if (metric.unit === "minor_units") value = `$${(metric.value / 100 / 1_000_000).toFixed(1)}M`;
    return [{
      id: `${finding.findingId}-${metric.name}`,
      label: metric.name.replaceAll("_", " "),
      value,
      detail: evidenceId,
      evidenceId,
      tone: (metric.unit === "ratio" && metric.value >= 0.05) || (metric.unit === "percent" && metric.value <= -10) ? "danger" as const : "neutral" as const,
    }];
  }))).flat();

  const presentationFindings = findings.map((finding) => ({
    id: finding.findingId,
    title: finding.title,
    body: finding.summary,
    kind: finding.kind,
    evidenceIds: finding.claims.flatMap((claim) => claim.evidenceIds),
  }));

  const tableArtifact = artifacts.find((item) => item.kind === "comparison" || item.kind === "queue" || item.kind === "table");
  const tablePayload = tableArtifact?.payload as {
    title?: string;
    columns?: string[];
    rows?: Array<{ id: string; cells: string[]; entityType?: string; entityId?: string; actionName?: string }>;
    rowAction?: { name: string; label?: string };
  } | undefined;

  if (intent === "unsupported") {
    return {
      title: "Not available",
      subtitle: "This workspace cannot complete that request with the current capabilities and permissions.",
      metrics: [],
      findings: [],
      actions: [],
      limitations: ["No fabricated success. Ask a supported operations, finance, or support question."],
    };
  }

  const wantsTable = view === "table" || view === "queue" || view === "comparison" || Boolean(tablePayload);
  const synthesized = !tablePayload && wantsTable && customers.length
    ? customers.map((entity) => ({
      id: entity.id,
      cells: [entity.label ?? entity.id, entity.id],
      entityType: "customer",
      entityId: entity.id,
      actionName: "inspect_account",
    }))
    : [];
  const rows = (tablePayload?.rows ?? synthesized).map((row) => ({
    ...row,
    actionName: row.actionName ?? tablePayload?.rowAction?.name ?? actionNameFor(row.entityType),
  }));
  const quiet = !findings.some((finding) => finding.severity === "high" || finding.severity === "critical");
  const broad = isBroadObjective(objective);
  const title = tablePayload?.title
    || (rows.length && !broad ? (presentationFindings[0]?.title ?? "Results") : "")
    || (release && !broad ? release.id : "")
    || (customers.length === 1 && !broad ? (customers[0]?.label ?? customers[0]?.id ?? "Account") : "")
    || (broad ? "Morning overview" : (presentationFindings[0]?.title ?? "Results"));
  const subtitle = view === "table" && tablePayload && !findings.length
    ? "Same records as the previous view, shown as a table."
    : quiet
      ? "No major supported anomaly was verified in the current window."
      : (presentationFindings[0]?.body ?? "Records from authorized tools.");
  const actions = followUpActions(rows, tablePayload?.rowAction, customers, release);

  return {
    title,
    subtitle,
    metrics: view === "table" ? [] : metrics.slice(0, broad ? 3 : 4),
    findings: presentationFindings,
    table: rows.length && wantsTable ? {
      id: tableArtifact?.id ?? "records",
      columns: tablePayload?.columns ?? ["Account", "ID"],
      rows,
    } : undefined,
    actions,
    limitations: [
      financeFailed ? "Financial information is unavailable for this run." : "",
      broad ? "Root cause is not confirmed." : "",
      objective ? `Question: ${objective}` : "",
    ].filter(Boolean),
  };
}

function actionNameFor(entityType?: string): string {
  if (entityType === "release") return "inspect_release";
  if (entityType === "customer") return "inspect_account";
  return "show_evidence";
}

function followUpActions(
  rows: Array<{ id: string; entityType?: string; entityId?: string }>,
  rowAction: { name: string; label?: string } | undefined,
  customers: EntityRef[],
  release: EntityRef | undefined,
): PresentationInput["actions"] {
  if (rowAction && rows[0]) {
    const row = rows[0];
    return [{
      id: `${rowAction.name}-${row.id}`,
      label: rowAction.label ?? `${rowAction.name} ${row.id}`,
      name: rowAction.name,
      entities: [{ type: row.entityType ?? "record", id: row.entityId ?? row.id }],
    }];
  }
  const actions: PresentationInput["actions"] = [];
  if (customers.length > 1) {
    actions.push({ id: "accounts", label: "Show affected accounts", name: "show_affected_accounts", entities: customers });
  }
  if (release) {
    actions.push({ id: "release", label: "Inspect release", name: "inspect_release", entities: [release] });
  }
  if (customers.length) {
    actions.push({ id: "finance", label: "Inspect financial impact", name: "inspect_financial_impact", entities: customers.slice(0, 1) });
  }
  if (customers.length === 1) {
    const entity = customers[0]!;
    actions.push({ id: `inspect-${entity.id}`, label: `Inspect ${entity.label ?? entity.id}`, name: "inspect_account", entities: [entity] });
  }
  return actions.slice(0, 3);
}
