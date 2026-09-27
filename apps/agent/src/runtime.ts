import "./load-env.js";
import { randomUUID } from "node:crypto";
import { SqliteSaver } from "@langchain/langgraph-checkpoint-sqlite";
import { SemanticActionSchema, type EntityRef, type SemanticAction } from "@anc/contracts";
import { DEFAULT_RUNTIME_DB_PATH, openRuntimeDatabase, RuntimeStore } from "@anc/runtime-storage";
import { peekSubstitutions, takeSubstitutions, type SpecialistSubstitution } from "./execution.js";
import { publishEvent } from "./events.js";
import { createInvestigationGraph, graphContexts, toPresentation, type ActivitySink, type GraphState } from "./graph.js";
import { composeA2UI } from "./composer.js";
import { validateA2UI } from "./a2ui-validate.js";
import { resolveExecutionMode, resolveModelConfig } from "./provider.js";
import { assertUsdBudgetCanBeEnforced, priceCost, takeUsage, type ModelUsage } from "./usage.js";
import { DEMO_OWNER_ID, redactForPrincipal, resolvePrincipal, sessionThreadId, withoutGrants, type Principal } from "@anc/policy";
import { commitTicketAssignment, prepareTicketAssignment } from "./operations.js";
import { DEFAULT_THREAD_ID } from "./windows.js";

const db = openRuntimeDatabase(process.env.RUNTIME_DB_PATH ?? DEFAULT_RUNTIME_DB_PATH);
export const store = new RuntimeStore(db);
const checkpointer = SqliteSaver.fromConnString(process.env.RUNTIME_DB_PATH ?? DEFAULT_RUNTIME_DB_PATH);
export const graph = createInvestigationGraph(checkpointer);

const controllers = new Map<string, AbortController>();
const cancelledIds = new Set<string>();

export type ExecutionTrace = {
  provider: string;
  executionMode: "fixture" | "live-strict" | "live-fallback";
  substitutions: SpecialistSubstitution[];
};

export type PublicState = {
  threadId: string;
  investigationId: string | null;
  runId: string | null;
  status: string;
  surface: {
    surfaceId: string;
    revision: number;
    title: string;
    messages: unknown;
    dataModel: unknown;
  } | null;
  activity: Array<{ id: string; message: string; kind: string; timestamp: string }>;
  selectedEntities: unknown[];
  surfaceHistory: Array<{ surfaceId: string; revision: number; title: string }>;
  principal?: { id: string; displayName: string; title: string };
  execution: ExecutionTrace;
  timing?: {
    startedAt: string;
    firstActivityMs: number | null;
    firstFindingMs: number | null;
    completedMs: number;
  };
  usage?: ModelUsage & { estimatedCostUsd: number | null; costStatus: "known" | "unknown" };
}

function principalNow(ownerId: string): Principal {
  return withoutGrants(resolvePrincipal(ownerId), store.listRevocations(ownerId));
}

function inferredGrants(value: unknown): string[] {
  const keys = new Set<string>();
  const walk = (node: unknown) => {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) {
      node.forEach(walk);
      return;
    }
    for (const [key, nested] of Object.entries(node as Record<string, unknown>)) {
      keys.add(key);
      walk(nested);
    }
  };
  walk(value);
  return ["arrMinorUnits", "arr_minor_units", "amountMinorUnits", "amount_minor_units"].some((key) => keys.has(key))
    ? ["cap.finance.arr", "cap.finance.invoices"]
    : [];
}

function visibleSurface(surface: NonNullable<ReturnType<typeof store.getSurface>>, ownerId: string) {
  const principal = principalNow(ownerId);
  const required = surface.requiredGrants.length ? surface.requiredGrants : inferredGrants(surface.dataModel);
  if (required.some((grant) => !principal.grants.includes(grant))) {
    return {
      surfaceId: surface.surfaceId,
      revision: surface.revision,
      title: "Saved view withheld",
      messages: [],
      dataModel: { unavailable: true, limitation: "This saved view used access that has been revoked." },
    };
  }
  return {
    surfaceId: surface.surfaceId,
    revision: surface.revision,
    title: surface.title,
    messages: redactForPrincipal(principal, surface.messages),
    dataModel: redactForPrincipal(principal, surface.dataModel),
  };
};

function executionTrace(runId: string | null): ExecutionTrace {
  return {
    provider: resolveModelConfig().provider,
    executionMode: resolveExecutionMode(),
    substitutions: runId ? peekSubstitutions(runId) : [],
  };
}

export function publicState(threadId = DEFAULT_THREAD_ID, ownerId = DEMO_OWNER_ID): PublicState {
  const thread = store.getThreadState(threadId);
  const principal = principalNow(ownerId);
  if ((thread?.ownerId && thread.ownerId !== ownerId) || (thread?.organizationId && thread.organizationId !== principal.organizationId)) {
    return {
      threadId,
      investigationId: null,
      runId: null,
      status: "idle",
      surface: null,
      activity: [],
      selectedEntities: [],
      surfaceHistory: [],
      principal: { id: ownerId, displayName: principal.displayName, title: principal.title },
      execution: executionTrace(null),
    };
  }
  const surface = thread?.activeSurfaceId && thread.activeSurfaceRevision
    ? store.getSurface(thread.activeSurfaceId, thread.activeSurfaceRevision)
    : undefined;
  return {
    threadId,
    investigationId: thread?.investigationId ?? null,
    runId: thread?.activeRunId ?? null,
    status: thread?.status ?? "idle",
    surface: surface ? visibleSurface(surface, ownerId) : null,
    activity: store.listActivity(threadId).map((item) => ({ id: item.id, message: item.message, kind: item.kind, timestamp: item.createdAt })),
    selectedEntities: thread?.selectedEntities ?? [],
    surfaceHistory: store.listSurfaces(threadId),
    principal: { id: ownerId, displayName: principal.displayName, title: principal.title },
    execution: executionTrace(thread?.activeRunId ?? null),
  };
}

function publish(threadId: string, runId: string, event: { type: string } & Record<string, unknown>) {
  publishEvent({ ...event, threadId, runId, timestamp: new Date().toISOString() });
}

function emitFor(threadId: string, runId: string, ownerId: string, extra?: ActivitySink): ActivitySink {
  return (message, kind = "status") => {
    store.appendActivity({ id: randomUUID(), threadId, runId, message, kind, now: new Date().toISOString(), ownerId });
    extra?.(message, kind);
    publish(threadId, runId, { type: "STEP_STARTED", stepName: kind });
    publish(threadId, runId, { type: "CUSTOM", name: "activity", value: { message, kind } });
    publish(threadId, runId, { type: "STATE_SNAPSHOT", snapshot: publicState(threadId, ownerId) });
    publish(threadId, runId, { type: "STEP_FINISHED", stepName: kind });
  };
}

export async function runInvestigation(input: {
  question: string;
  threadId?: string;
  runId?: string;
  action?: SemanticAction;
  entities?: EntityRef[];
  emit?: ActivitySink;
  principal?: Principal;
}): Promise<PublicState> {
  assertUsdBudgetCanBeEnforced();
  const principal = input.principal ?? resolvePrincipal(DEMO_OWNER_ID);
  const threadId = input.threadId ?? sessionThreadId(principal.id);
  store.assertThreadOwner(threadId, principal.id);
  const existing = store.getThreadState(threadId);
  if (existing?.activeRunId && existing.status === "running") {
    cancelRun(existing.activeRunId, threadId);
  }
  const investigationId = existing?.investigationId ?? `investigation-${randomUUID()}`;
  const runId = input.runId ?? `run-${randomUUID()}`;
  const now = new Date().toISOString();
  controllers.set(runId, new AbortController());
  store.upsertInvestigation({ id: investigationId, threadId, objective: input.question, status: "running", now });
  store.insertRun({ id: runId, investigationId, threadId, status: "running", now });
  store.setThreadState({ threadId, investigationId, activeRunId: runId, status: "running", now, selectedEntities: input.entities ?? existing?.selectedEntities ?? [], ownerId: principal.id, organizationId: principal.organizationId });
  const startedMs = Date.parse(now);
  let firstActivityMs: number | null = null;
  let firstFindingMs: number | null = null;
  const emit = emitFor(threadId, runId, principal.id, (message, kind) => {
    const elapsed = Date.now() - startedMs;
    if (firstActivityMs === null) firstActivityMs = elapsed;
    if (kind === "finding_discovered" && firstFindingMs === null) firstFindingMs = elapsed;
    input.emit?.(message, kind);
  });
  const ctx = {
    store,
    emit,
    checkCancelled: () => cancelledIds.has(runId) || store.isRunCancelled(runId) || Boolean(controllers.get(runId)?.signal.aborted),
    principal,
  };
  graphContexts.set(runId, ctx);
  publish(threadId, runId, { type: "RUN_STARTED" });
  publish(threadId, runId, { type: "STATE_SNAPSHOT", snapshot: publicState(threadId, principal.id) });
  emit("Looking into your question", "status");
  const start: GraphState = {
    objective: input.question,
    threadId,
    investigationId,
    runId,
    status: "running",
    intent: input.action?.name ?? "",
    tasks: {},
    results: {},
    findings: {},
    selectedEntities: input.entities ?? (input.action?.entities as EntityRef[] | undefined) ?? [],
    round: 0,
  };
  try {
    if (cancelledIds.has(runId) || store.isRunCancelled(runId)) {
      cancelRun(runId, threadId);
      return withMetrics(publicState(threadId, principal.id), runId, startedMs, firstActivityMs, firstFindingMs);
    }
    const result = await graph.invoke(start, {
      configurable: { thread_id: `${threadId}:${runId}` },
    });
    const current = store.getThreadState(threadId);
    const cancelled = store.isRunCancelled(runId) || result.status === "cancelled";
    if (current?.activeRunId !== runId) {
      store.updateRun(runId, { status: "cancelled", cancelled: true, finishedAt: new Date().toISOString() });
      publish(threadId, runId, { type: "RUN_FINISHED", result: publicState(threadId, principal.id), superseded: true });
      return withMetrics(publicState(threadId, principal.id), runId, startedMs, firstActivityMs, firstFindingMs);
    }
    if (cancelled) {
      store.updateRun(runId, { status: "cancelled", cancelled: true, finishedAt: new Date().toISOString() });
      store.setThreadState({
        threadId,
        investigationId,
        activeRunId: runId,
        status: "cancelled",
        now: new Date().toISOString(),
      });
      const state = withMetrics(publicState(threadId, principal.id), runId, startedMs, firstActivityMs, firstFindingMs);
      publish(threadId, runId, { type: "STATE_SNAPSHOT", snapshot: state });
      publish(threadId, runId, { type: "RUN_FINISHED", result: state });
      return state;
    }
    const status = result.status ?? "completed";
    store.updateRun(runId, { status, finishedAt: new Date().toISOString() });
    store.upsertInvestigation({ id: investigationId, threadId, objective: input.question, status, now: new Date().toISOString() });
    store.setThreadState({
      threadId,
      investigationId,
      activeRunId: runId,
      activeSurfaceId: result.surfaceId ?? existing?.activeSurfaceId ?? null,
      activeSurfaceRevision: result.surfaceRevision ?? existing?.activeSurfaceRevision ?? null,
      selectedEntities: result.selectedEntities ?? existing?.selectedEntities ?? [],
      status,
      now: new Date().toISOString(),
    });
    const state = withMetrics(publicState(threadId, principal.id), runId, startedMs, firstActivityMs, firstFindingMs);
    publish(threadId, runId, { type: "STATE_SNAPSHOT", snapshot: state });
    publish(threadId, runId, { type: "RUN_FINISHED", result: state });
    return state;
  } catch (error) {
    const current = store.getThreadState(threadId);
    store.updateRun(runId, { status: "failed", finishedAt: new Date().toISOString() });
    if (current?.activeRunId === runId) {
      store.setThreadState({ threadId, investigationId, activeRunId: runId, status: "failed", now: new Date().toISOString() });
      emit(error instanceof Error ? error.message : "Investigation failed", "status");
    }
    publish(threadId, runId, { type: "RUN_ERROR", message: error instanceof Error ? error.message : "investigation failed" });
    throw error;
  } finally {
    graphContexts.delete(runId);
    controllers.delete(runId);
  }
}

export function cancelRun(runId: string, threadId?: string) {
  cancelledIds.add(runId);
  store.updateRun(runId, { status: "cancelled", cancelled: true, finishedAt: new Date().toISOString() });
  controllers.get(runId)?.abort();
  const thread = store.getThreadState(threadId ?? store.getRun(runId)?.threadId ?? DEFAULT_THREAD_ID);
  const resolvedThreadId = threadId ?? thread?.threadId;
  if (resolvedThreadId && thread?.activeRunId === runId) {
    store.setThreadState({
      threadId: resolvedThreadId,
      investigationId: thread.investigationId ?? undefined,
      activeRunId: runId,
      status: "cancelled",
      now: new Date().toISOString(),
    });
    store.appendActivity({
      id: randomUUID(),
      threadId: resolvedThreadId,
      runId,
      message: "Stopped this request",
      kind: "status",
      now: new Date().toISOString(),
    });
    const snapshot = publicState(resolvedThreadId);
    publish(resolvedThreadId, runId, { type: "STATE_SNAPSHOT", snapshot });
    publish(resolvedThreadId, runId, { type: "RUN_FINISHED", result: snapshot, cancelled: true });
  }
}

export function restoreSurface(threadId: string, surfaceId: string, revision: number, ownerId = DEMO_OWNER_ID): PublicState {
  store.assertThreadOwner(threadId, ownerId);
  const surface = store.getSurface(surfaceId, revision);
  if (!surface) throw new Error("unknown surface revision");
  const thread = store.getThreadState(threadId);
  store.setThreadState({
    threadId,
    investigationId: thread?.investigationId ?? surface.investigationId,
    activeSurfaceId: surfaceId,
    activeSurfaceRevision: revision,
    status: thread?.status === "running" ? thread.status : thread?.status ?? "completed",
    now: new Date().toISOString(),
    ownerId,
  });
  store.appendActivity({ id: randomUUID(), threadId, message: `Restored ${surface.title}`, kind: "status", now: new Date().toISOString(), ownerId });
  return publicState(threadId, ownerId);
}

function withMetrics(state: PublicState, runId: string, startedMs: number, firstActivityMs: number | null, firstFindingMs: number | null): PublicState {
  const usage = takeUsage(runId);
  const substitutions = takeSubstitutions(runId);
  return {
    ...state,
    execution: {
      ...state.execution,
      substitutions,
    },
    timing: {
      startedAt: new Date(startedMs).toISOString(),
      firstActivityMs,
      firstFindingMs,
      completedMs: Date.now() - startedMs,
    },
    usage: { ...usage, ...priceCost(usage) },
  };
}

export async function handleAction(raw: Record<string, unknown>, principal = resolvePrincipal(DEMO_OWNER_ID)): Promise<PublicState> {
  const threadId = String(raw.threadId ?? sessionThreadId(principal.id));
  store.assertThreadOwner(threadId, principal.id);
  const current = publicState(threadId, principal.id);
  const parsed = SemanticActionSchema.safeParse({
    actionId: String(raw.actionId ?? randomUUID()),
    name: raw.name ?? raw.intent ?? "investigate",
    threadId,
    investigationId: String(raw.investigationId ?? current.investigationId ?? "unknown"),
    surfaceId: String(raw.surfaceId ?? current.surface?.surfaceId ?? "unknown"),
    surfaceRevision: Number(raw.surfaceRevision ?? current.surface?.revision ?? 1),
    entities: raw.entities ?? [],
    parameters: raw.parameters ?? raw.context ?? {},
  });
  if (!parsed.success) throw new Error(parsed.error.message);
  const action = parsed.data;
  if (!store.rememberAction(action.actionId, threadId, new Date().toISOString())) {
    return current;
  }
  if (current.surface && (action.surfaceId !== current.surface.surfaceId || action.surfaceRevision !== current.surface.revision)) {
    throw new Error("stale surface action");
  }
  if (action.name === "show_evidence") {
    const evidenceId = String(action.parameters.evidenceId ?? (Array.isArray(action.parameters.evidenceIds) ? action.parameters.evidenceIds[0] : ""));
    store.appendActivity({ id: randomUUID(), threadId, message: `Opened supporting evidence`, kind: "action", now: new Date().toISOString(), ownerId: principal.id });
    return { ...publicState(threadId, principal.id), evidence: evidenceId ? store.getEvidence(evidenceId, principal.id) ?? { error: "not authorized" } : null } as PublicState;
  }
  if (action.name === "prepare_assignment") {
    const ticketId = String(action.entities[0]?.id ?? action.parameters.ticketId ?? action.parameters.entityId ?? "");
    await prepareTicketAssignment({ store, principal, threadId, ticketId });
    return publicState(threadId, principal.id);
  }
  if (action.name === "commit_assignment") {
    await commitTicketAssignment({
      store,
      principal,
      threadId,
      proposalId: String(action.parameters.proposalId ?? ""),
      assigneeId: typeof action.parameters.assigneeId === "string" ? action.parameters.assigneeId : undefined,
    });
    return publicState(threadId, principal.id);
  }
  if (action.name === "select_assignee") {
    return current;
  }
  if (action.name === "set_selection") {
    return applySelection({ threadId, principal, action });
  }
  if (action.name === "save_draft") {
    return saveDraftEdits({ threadId, principal, action, current });
  }
  const question = action.name === "show_affected_accounts"
    ? "Who is affected?"
    : action.name === "inspect_release"
      ? "Inspect the temporally relevant release."
      : action.name === "inspect_account"
        ? `Inspect account ${action.entities[0]?.id ?? action.parameters.entityId ?? ""}`
        : action.name === "inspect_financial_impact"
          ? "What ARR is represented by the affected accounts?"
          : action.name === "show_as_table"
            ? "Show this as a table"
            : "Investigate the current findings.";
  const entities = action.entities.length
    ? action.entities
    : action.parameters.entityId
      ? [{ type: "customer" as const, id: String(action.parameters.entityId) }]
      : (current.selectedEntities as EntityRef[]);
  return runInvestigation({
    question,
    threadId,
    principal,
    runId: typeof raw.runId === "string" ? raw.runId : undefined,
    action,
    entities,
  });
}

/**
 * Narrows the thread to the records the user selected and re-runs the current
 * objective against them, so "only these accounts" carries into the follow-up.
 */
async function applySelection(input: { threadId: string; principal: Principal; action: SemanticAction }): Promise<PublicState> {
  const selected = Array.isArray(input.action.parameters.selected) ? input.action.parameters.selected.map(String) : [];
  const entities: EntityRef[] = selected.map((id) => ({ type: "customer" as const, id }));
  store.setThreadState({
    threadId: input.threadId,
    selectedEntities: entities,
    status: "running",
    now: new Date().toISOString(),
    ownerId: input.principal.id,
  });
  store.appendActivity({
    id: randomUUID(),
    threadId: input.threadId,
    message: selected.length ? `Narrowed scope to ${selected.length} selected record(s)` : "Selection cleared",
    kind: "action",
    now: new Date().toISOString(),
    ownerId: input.principal.id,
  });
  const thread = store.getThreadState(input.threadId);
  const question = String(thread?.investigationId ?? "Review the selected records.");
  return runInvestigation({
    question: selected.length ? `Review only these records: ${selected.join(", ")}` : question,
    threadId: input.threadId,
    principal: input.principal,
    entities,
  });
}

/**
 * Persists user edits to a model-authored draft. Edits are stored as an
 * `edited` draft rather than promoted to an observed finding, and a draft is
 * never treated as an executed operation.
 */
function saveDraftEdits(input: { threadId: string; principal: Principal; action: SemanticAction; current: PublicState }): PublicState {
  const draftId = String(input.action.parameters.draftId ?? "");
  const artifacts = store.listArtifacts(input.threadId, input.principal.id);
  const artifact = artifacts.find((item) => item.kind === "draft" && (item.id === draftId || String((item.payload as { id?: string })?.id) === draftId));
  if (!artifact) throw new Error("Draft not found");
  const payload = artifact.payload as { id: string; title: string; steps: Array<{ id: string; text: string; done?: boolean }>; assumptions: string[] };
  const clientFields = (input.action.parameters.clientFields ?? {}) as Record<string, string>;
  const clientSelections = (input.action.parameters.clientSelections ?? {}) as Record<string, string[]>;
  const completed = new Set(clientSelections[draftId] ?? clientSelections[payload.id] ?? []);
  const steps = payload.steps.map((step) => {
    const edited = clientFields[`draft_text_${step.id}`];
    return { ...step, text: typeof edited === "string" && edited.trim() ? edited : step.text, done: completed.has(step.id) || step.done };
  });
  const next = { ...payload, steps, status: "edited" as const };
  store.saveArtifact({
    id: artifact.id,
    threadId: input.threadId,
    runId: artifact.runId ?? undefined,
    ownerId: input.principal.id,
    kind: "draft",
    payload: next,
    now: new Date().toISOString(),
  });
  store.appendActivity({
    id: randomUUID(),
    threadId: input.threadId,
    message: `Saved edits to draft ${payload.title}`,
    kind: "action",
    now: new Date().toISOString(),
    ownerId: input.principal.id,
  });
  const state = publicState(input.threadId, input.principal.id);
  const surface = state.surface;
  if (!surface) return state;
  const stored = store.getSurface(surface.surfaceId, surface.revision);
  if (!stored) return state;
  const presentation = toPresentation(
    String((surface.dataModel as { view?: string })?.view ?? "form"),
    "Saved draft",
    [],
    false,
    [],
    store.listArtifacts(input.threadId, input.principal.id),
    "form",
  );
  const composed = composeA2UI(surface.surfaceId, presentation);
  if (validateA2UI(composed.messages).length) return state;
  store.saveSurface({
    surfaceId: surface.surfaceId,
    revision: surface.revision + 1,
    threadId: input.threadId,
    investigationId: stored.investigationId,
    runId: state.runId ?? undefined,
    ownerId: input.principal.id,
    title: presentation.title,
    messages: composed.messages,
    dataModel: composed.dataModel,
    findingIds: stored.findingIds,
    requiredGrants: stored.requiredGrants,
    now: new Date().toISOString(),
  });
  return publicState(input.threadId, input.principal.id);
}
