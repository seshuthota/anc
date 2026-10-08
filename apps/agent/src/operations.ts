import { createHash, randomUUID } from "node:crypto";
import type { Principal } from "@anc/policy";
import { hasGrant } from "@anc/policy";
import { CompanyMcpClient } from "./mcp-client.js";
import { PresentationBriefingSchema, type PresentationBriefing, type PresentationInput, type Domain } from "@anc/contracts";
import { composeA2UI } from "./composer.js";
import { validateA2UI } from "./a2ui-validate.js";
import type { RuntimeStore } from "@anc/runtime-storage";
import { catalogAction, type CatalogAction, type CatalogActionId } from "./action-catalog.js";
import { DEMO_CLOCK } from "@anc/logistics-db/constants";
import type { AgentFinding } from "@anc/contracts";

/*
 * Operations: every change to a company record goes through prepareOperation (a
 * proposal with an expiry, owned by one person) and commitOperation (grant check,
 * idempotency key, the MCP write on a writable connection, operation and audit
 * records). Complaint assignment and the three briefing actions are instances.
 * Specialists never reach this module; their MCP connections are read-only.
 */

const PROPOSAL_TTL_MS = 15 * 60 * 1000;
type Proposal = NonNullable<ReturnType<RuntimeStore["getProposal"]>>;

function audit(store: RuntimeStore, principal: Principal, action: string, resource: string, outcome: string, detail?: string) {
  store.appendAudit({ id: randomUUID(), organizationId: principal.organizationId, actorId: principal.id, action, resource, outcome, detail: detail ?? null, now: new Date().toISOString() });
}

/** Saves a proposal (status "prepared", or "blocked" when there is nothing to confirm) and audits it. */
export function prepareOperation(input: {
  store: RuntimeStore;
  principal: Principal;
  threadId: string;
  capability: string;
  payload: Record<string, unknown>;
  resource: string;
  status?: "prepared" | "blocked";
}): string {
  if (!hasGrant(input.principal, input.capability)) throw new Error(`Not authorized: ${input.capability}`);
  const proposalId = `proposal-${randomUUID()}`;
  input.store.saveProposal({
    id: proposalId,
    threadId: input.threadId,
    ownerId: input.principal.id,
    capability: input.capability,
    revision: 1,
    payload: input.payload,
    expiresAt: new Date(Date.now() + PROPOSAL_TTL_MS).toISOString(),
    status: input.status ?? "prepared",
    now: new Date().toISOString(),
  });
  audit(input.store, input.principal, "operation.prepare", input.resource, input.status ?? "prepared");
  return proposalId;
}

/** A proposal that may still be committed by this person, or the reason it may not. */
export function openProposal(store: RuntimeStore, principal: Principal, proposalId: string, notFound = "Proposal not found"): Proposal {
  const proposal = store.getProposal(proposalId, principal.id);
  if (!proposal) throw new Error(notFound);
  if (proposal.status !== "prepared") throw new Error("Proposal is no longer valid");
  if (Date.parse(proposal.expiresAt) < Date.now()) throw new Error("Proposal expired");
  return proposal;
}

function setProposalStatus(store: RuntimeStore, principal: Principal, proposal: Proposal, status: string) {
  store.saveProposal({ ...proposal, ownerId: principal.id, payload: proposal.payload, status, expiresAt: proposal.expiresAt, now: new Date().toISOString() });
}

export type CommitOutcome<R> =
  | { status: "succeeded"; operationId: string; result: R; already: false }
  | { status: "succeeded"; operationId: string; already: true; previous: Record<string, unknown> };

/**
 * Runs one write under an idempotency key. A key that already succeeded is not
 * written again. The write gets the only writable MCP connection in the runtime.
 * A failure is recorded ("failed" for a stale version, else "unknown") and rethrown.
 */
export async function commitOperation<R>(input: {
  store: RuntimeStore;
  principal: Principal;
  proposal: Proposal;
  capability: string;
  idempotencyKey: string;
  payload: Record<string, unknown>;
  resource: string;
  write: (client: CompanyMcpClient) => Promise<R>;
}): Promise<CommitOutcome<R>> {
  const { store, principal, proposal } = input;
  if (!hasGrant(principal, input.capability)) throw new Error(`Not authorized: ${input.capability}`);
  const existing = store.getOperationByKey(input.idempotencyKey, principal.id);
  if (existing?.status === "succeeded") {
    setProposalStatus(store, principal, proposal, "committed");
    return { status: "succeeded", operationId: existing.id, already: true, previous: existing.payload };
  }
  const operationId = existing?.id ?? `op-${randomUUID()}`;
  const record = (status: string, payload: Record<string, unknown>) => store.saveOperation({
    id: operationId, idempotencyKey: input.idempotencyKey, ownerId: principal.id, capability: input.capability, proposalId: proposal.id, status, payload, now: new Date().toISOString(),
  });
  record("pending", input.payload);
  const client = new CompanyMcpClient(store, { runId: operationId, principalId: principal.id, writable: true });
  await client.connect();
  try {
    const result = await input.write(client);
    record("succeeded", { ...input.payload, result });
    setProposalStatus(store, principal, proposal, "committed");
    audit(store, principal, "operation.commit", input.resource, "succeeded", operationId);
    return { status: "succeeded", operationId, result, already: false };
  } catch (error) {
    const message = error instanceof Error ? error.message : "operation failed";
    record(/stale|already/i.test(message) ? "failed" : "unknown", { ...input.payload, error: message });
    audit(store, principal, "operation.commit", input.resource, "failed", message);
    throw error;
  } finally {
    await client.close();
  }
}

/** One confirm at a time per proposal: a double click waits for the first and then finds it committed. */
const inFlight = new Map<string, Promise<unknown>>();
async function once<T>(key: string, run: () => Promise<T>): Promise<T | undefined> {
  const running = inFlight.get(key);
  if (running) {
    await running.catch(() => undefined);
    return undefined;
  }
  const promise = run();
  inFlight.set(key, promise);
  try {
    return await promise;
  } finally {
    inFlight.delete(key);
  }
}

async function readOnly<T>(store: RuntimeStore, principal: Principal, runId: string, read: (client: CompanyMcpClient) => Promise<T>): Promise<T> {
  const client = new CompanyMcpClient(store, { runId, principalId: principal.id });
  await client.connect();
  try {
    return await read(client);
  } finally {
    await client.close();
  }
}

const rowsOf = (evidence: Record<string, unknown>) => ((evidence.result as { rows?: Array<Record<string, unknown>> } | undefined)?.rows ?? []);
const clock = (iso: unknown) => (typeof iso === "string" && /T\d{2}:\d{2}/.test(iso) ? `${iso.slice(11, 16)} IST` : "");
const shortId = (operationId: string) => operationId.slice(0, 11);

// ---------------------------------------------------------------------------
// Complaint assignment (a form, from the complaints queue)
// ---------------------------------------------------------------------------

export async function prepareComplaintAssignment(input: {
  store: RuntimeStore;
  principal: Principal;
  threadId: string;
  complaintId: string;
}): Promise<void> {
  if (!hasGrant(input.principal, "cap.complaints.assign")) throw new Error("Not authorized to assign complaints");
  const [queue, owners] = await readOnly(input.store, input.principal, `prep-${randomUUID()}`, (client) => Promise.all([
    client.call("list_complaints", { status: "open", unassignedOnly: true, page: { limit: 100, offset: 0 } }, "customers"),
    client.call("list_eligible_assignees", { team: "customer-care" }, "customers"),
  ]));
  const complaint = rowsOf(queue).find((row) => String(row.id) === input.complaintId);
  if (!complaint) throw new Error("That complaint is not open and unassigned");
  const assignees = rowsOf(owners).map((row) => ({ id: String(row.id), label: String(row.name ?? row.id) }));
  const payload = {
    complaintId: String(complaint.id),
    expectedVersion: Number(complaint.version ?? 1),
    assigneeId: assignees[0]?.id,
    assignees,
    preview: `${complaint.shipperName ?? complaint.shipperId}: "${complaint.subject}". Choose who should own it.`,
  };
  const proposalId = prepareOperation({ store: input.store, principal: input.principal, threadId: input.threadId, capability: "cap.complaints.assign", payload, resource: `complaint:${payload.complaintId}` });
  saveGeneratedSurface(input.store, input.threadId, input.principal.id, assignmentForm(proposalId, payload), ["cap.complaints.assign"]);
}

export async function commitComplaintAssignment(input: {
  store: RuntimeStore;
  principal: Principal;
  threadId: string;
  proposalId: string;
  assigneeId?: string;
}): Promise<void> {
  if (!hasGrant(input.principal, "cap.complaints.assign")) throw new Error("Not authorized to assign complaints");
  const proposal = openProposal(input.store, input.principal, input.proposalId, "Assignment proposal not found");
  const complaintId = String(proposal.payload.complaintId);
  const expectedVersion = Number(proposal.payload.expectedVersion);
  const assigneeId = input.assigneeId ?? String(proposal.payload.assigneeId ?? "");
  const offered = (proposal.payload.assignees ?? []) as Array<{ id: string; label: string }>;
  const chosen = offered.find((item) => item.id === assigneeId);
  // Only someone the form offered can be chosen, whatever the request says.
  if (!chosen) throw new Error("That person cannot own this complaint");
  const outcome = await commitOperation({
    store: input.store,
    principal: input.principal,
    proposal,
    capability: "cap.complaints.assign",
    idempotencyKey: `${complaintId}:${expectedVersion}:${assigneeId}`,
    payload: { complaintId, assigneeId, expectedVersion },
    resource: `complaint:${complaintId}`,
    write: (client) => client.call("commit_complaint_assignment", { complaintId, assigneeId, expectedVersion }),
  });
  receiptSurface(input.store, input.threadId, input.principal.id, outcome.operationId, "succeeded", outcome.already ? "This assignment was already completed." : `Complaint ${complaintId} is now owned by ${chosen.label}.`);
}

type AssignmentPayload = { complaintId: string; expectedVersion: number; assigneeId?: string; assignees: Array<{ id: string; label: string }>; preview: string };

function assignmentForm(proposalId: string, payload: AssignmentPayload): PresentationInput {
  const chosen = payload.assignees.find((item) => item.id === payload.assigneeId);
  return {
    title: `Assign complaint ${payload.complaintId}`,
    subtitle: payload.preview,
    view: "form",
    metrics: [],
    findings: [],
    form: {
      id: proposalId,
      fields: [{ id: "assignee", label: chosen ? `Owner: ${chosen.label}. Choose someone else:` : "Choose an owner:", name: "assigneeId", value: payload.assigneeId, options: payload.assignees }],
      submitLabel: chosen ? `Assign to ${chosen.label}` : "Assign",
      submitAction: "commit_assignment",
    },
    actions: [],
    limitations: ["Confirming changes the complaint record. It is not undone automatically."],
  };
}

/** Records which owner the person picked on an open assignment form, and redraws the form to show it. */
export function selectComplaintAssignee(input: { store: RuntimeStore; principal: Principal; threadId: string; proposalId: string; assigneeId: string }): void {
  if (!hasGrant(input.principal, "cap.complaints.assign")) throw new Error("Not authorized to assign complaints");
  const proposal = input.store.getProposal(input.proposalId, input.principal.id);
  if (!proposal || proposal.status !== "prepared") throw new Error("This assignment is no longer open");
  const payload = proposal.payload as AssignmentPayload;
  if (!payload.assignees.some((item) => item.id === input.assigneeId)) throw new Error("That person cannot own this complaint");
  const next = { ...payload, assigneeId: input.assigneeId };
  input.store.saveProposal({ ...proposal, ownerId: input.principal.id, payload: next, status: "prepared", expiresAt: proposal.expiresAt, now: new Date().toISOString() });
  saveGeneratedSurface(input.store, input.threadId, input.principal.id, assignmentForm(proposal.id, next), ["cap.complaints.assign"]);
}

function receiptSurface(store: RuntimeStore, threadId: string, ownerId: string, operationId: string, status: string, summary: string) {
  saveGeneratedSurface(store, threadId, ownerId, {
    title: "Assignment receipt",
    subtitle: summary,
    view: "form",
    metrics: [],
    findings: [],
    receipt: { operationId, status, summary },
    actions: [],
    limitations: ["Cancellation after commit does not roll this back."],
  }, ["cap.complaints.assign"]);
}

/** Saves a new revision of the thread's active surface (or its first surface). */
function saveGeneratedSurface(store: RuntimeStore, threadId: string, ownerId: string, presentation: PresentationInput, requiredGrants: string[], findingIds: string[] = []) {
  const thread = store.getThreadState(threadId);
  const surfaceId = thread?.activeSurfaceId ?? `surface-${threadId}`;
  const revision = Math.max(thread?.activeSurfaceRevision ?? 0, store.latestSurfaceRevision(surfaceId)) + 1;
  const composed = composeA2UI(surfaceId, presentation);
  const invalid = validateA2UI(composed.messages);
  if (invalid.length) throw new Error(invalid[0]);
  store.saveSurface({
    surfaceId,
    revision,
    threadId,
    investigationId: thread?.investigationId ?? `investigation-${threadId}`,
    title: presentation.title,
    messages: composed.messages,
    dataModel: composed.dataModel,
    findingIds,
    now: new Date().toISOString(),
    ownerId,
    requiredGrants,
  });
  store.setThreadState({
    threadId,
    ownerId,
    organizationId: "org-democo",
    activeSurfaceId: surfaceId,
    activeSurfaceRevision: revision,
    status: "completed",
    now: new Date().toISOString(),
  });
}

// ---------------------------------------------------------------------------
// Briefing actions (Slice 4): propose → confirm or cancel, on the same surface
// ---------------------------------------------------------------------------

type ActiveBriefing = {
  presentation: PresentationInput;
  briefing: PresentationBriefing;
  requiredGrants: string[];
  findingIds: string[];
};

/** The briefing on the thread's active surface, rebuilt from its data model (no model, no company read). */
function activeBriefing(store: RuntimeStore, threadId: string): ActiveBriefing {
  const thread = store.getThreadState(threadId);
  const surface = thread?.activeSurfaceId && thread.activeSurfaceRevision ? store.getSurface(thread.activeSurfaceId, thread.activeSurfaceRevision) : undefined;
  const model = surface?.dataModel as { title?: string; subtitle?: string; limitations?: string; briefing?: Record<string, unknown> } | undefined;
  if (!surface || !model?.briefing) throw new Error("There is no briefing on screen to act on");
  const raw = model.briefing;
  const briefing = PresentationBriefingSchema.parse({
    ...raw,
    secondary: Object.values((raw.secondary ?? {}) as Record<string, unknown>),
    restLabel: raw.restLabel || undefined,
  });
  return {
    briefing,
    presentation: {
      title: model.title ?? surface.title,
      subtitle: model.subtitle ?? surface.title,
      view: "summary",
      briefing,
      metrics: [],
      findings: [],
      actions: [],
      limitations: model.limitations ? [model.limitations] : [],
    },
    requiredGrants: surface.requiredGrants,
    findingIds: surface.findingIds,
  };
}

function saveBriefing(store: RuntimeStore, threadId: string, ownerId: string, active: ActiveBriefing, briefing: PresentationBriefing) {
  saveGeneratedSurface(store, threadId, ownerId, { ...active.presentation, briefing }, active.requiredGrants, active.findingIds);
}

function authorize(principal: Principal, action: CatalogAction) {
  if (!hasGrant(principal, action.requiredGrant)) throw new Error(`Not authorized to ${action.verb}`);
}

/**
 * The business day an operation belongs to: the data's own "as of" date from the
 * tool that was read, else the logistics database's demo clock. Never the wall clock
 * and never a hardcoded date, so idempotency keys follow the dataset.
 */
export function businessDate(dataAsOf?: unknown): string {
  if (typeof dataAsOf === "string" && /^\d{4}-\d{2}-\d{2}/.test(dataAsOf)) return dataAsOf.slice(0, 10);
  return DEMO_CLOCK.slice(0, 10);
}

const NOTIFY_TOPIC = "at-risk-today";
const LATE_AT_RISK_ARGS = { status: "open", category: "late", unassignedOnly: true, atRiskOnly: true, page: { limit: 100, offset: 0 } };

type Prepared = { payload: Record<string, unknown>; text: string; confirmLabel: string; blocked?: boolean; resource: string };

/** Reads the current state of the bound record (read-only) and words the confirm step. */
async function prepareBriefingAction(store: RuntimeStore, principal: Principal, action: CatalogAction, entities: Array<{ type: string; id: string; label?: string }>): Promise<Prepared> {
  const runId = `prep-${randomUUID()}`;
  if (action.id === "escalate_equipment_fault") {
    const eventId = entities.find((entity) => entity.type === "equipment")?.id;
    if (!eventId) throw new Error("This action is not bound to an equipment fault");
    const events = await readOnly(store, principal, runId, (client) => client.call("list_equipment_events", { openOnly: true }, "network"));
    const row = rowsOf(events).find((item) => String(item.id) === eventId);
    const resource = `equipment:${eventId}`;
    if (!row) return { payload: { actionId: action.id, eventId }, text: `${eventId} is no longer an open fault, so there is nothing to escalate.`, confirmLabel: "Back", blocked: true, resource };
    if (row.escalatedAt) return { payload: { actionId: action.id, eventId }, text: `${row.equipment} (${eventId}) was already escalated to ${row.escalatedToName ?? row.escalatedTo} at ${clock(row.escalatedAt)}.`, confirmLabel: "Back", blocked: true, resource };
    if (!row.onCallEngineerId) return { payload: { actionId: action.id, eventId }, text: `No engineer is on call for ${row.hubName}, so this cannot be escalated here.`, confirmLabel: "Back", blocked: true, resource };
    return {
      payload: { actionId: action.id, eventId, expectedVersion: Number(row.version ?? 1), equipment: String(row.equipment), hubName: String(row.hubName), engineerId: String(row.onCallEngineerId), engineerName: String(row.onCallEngineerName ?? row.onCallEngineerId) },
      text: `Escalate ${row.equipment} at ${row.hubName} (${eventId}) to ${row.onCallEngineerName}, the hub engineer on call? This writes to the maintenance log. It is not undone automatically.`,
      confirmLabel: "Confirm escalation",
      resource,
    };
  }
  if (action.id === "notify_shipper") {
    const shipperId = entities.find((entity) => entity.type === "shipper")?.id;
    if (!shipperId) throw new Error("This action is not bound to a shipper");
    const evidence = await readOnly(store, principal, runId, (client) => client.call("get_shipper", { shipperId }, "customers"));
    const result = evidence.result as { shipper?: Record<string, unknown>; queuedNotifications?: Array<Record<string, unknown>> };
    const name = String(result.shipper?.name ?? shipperId);
    const manager = String(result.shipper?.accountManagerName ?? "their account manager");
    const resource = `shipper:${shipperId}`;
    const topic = NOTIFY_TOPIC;
    const idempotencyKey = `notify:${shipperId}:${topic}:${businessDate(evidence.dataAsOf)}`;
    const queued = (result.queuedNotifications ?? []).find((item) => item.topic === topic);
    if (queued) return { payload: { actionId: action.id, shipperId }, text: `A notice for ${name} is already queued for ${manager} (${queued.id}). Nothing more to queue.`, confirmLabel: "Back", blocked: true, resource };
    return {
      payload: { actionId: action.id, shipperId, shipperName: name, accountManagerId: result.shipper?.accountManagerId ?? null, accountManagerName: manager, topic, idempotencyKey,
        message: `Parcels from ${name} promised for delivery today are at risk of arriving late. Please let the shipper know and agree next steps.` },
      text: `Queue a delay notice for ${name} with their account manager, ${manager}? This adds a queued notice to the shipper notifications table. Nothing is sent to the shipper.`,
      confirmLabel: "Queue notice",
      resource,
    };
  }
  // assign_complaints
  const args = LATE_AT_RISK_ARGS;
  const [queue, owners] = await readOnly(store, principal, runId, (client) => Promise.all([
    client.call("list_complaints", args, "customers"),
    client.call("list_eligible_assignees", { team: "customer-care" }, "customers"),
  ]));
  const complaints = rowsOf(queue);
  const assignees = rowsOf(owners).map((row) => ({ id: String(row.id), label: String(row.name ?? row.id) }));
  const resource = "complaints:late-at-risk";
  if (!complaints.length) return { payload: { actionId: action.id }, text: "Every open late complaint about today's at-risk parcels already has an owner.", confirmLabel: "Back", blocked: true, resource };
  if (!assignees.length) return { payload: { actionId: action.id }, text: "Nobody in customer care can take these complaints.", confirmLabel: "Back", blocked: true, resource };
  // Shared in turn across the care team, in the order the company lists them.
  const plan = complaints.map((row, index) => ({ complaintId: String(row.id), expectedVersion: Number(row.version ?? 1), assigneeId: assignees[index % assignees.length]!.id }));
  const names = assignees.map((item) => item.label);
  return {
    payload: { actionId: action.id, plan, assignees, args },
    text: `Assign ${plan.length} open late complaints about today's at-risk parcels to ${names.join(", ")}, in turn? This changes ${plan.length} complaint records. It is not undone automatically.`,
    confirmLabel: `Assign ${plan.length} complaints`,
    resource,
  };
}

/**
 * Operations already done, so the briefing does not offer them again, as
 * `<actionId>:<recordId>` pairs:
 * - an escalated equipment fault, from the evidence behind this run's findings
 *   (content-addressed per owner, so looked up by id rather than by run);
 * - a shipper whose delay notice is already queued (get_shipper.queuedNotifications);
 * - late at-risk complaints when none is left without an owner (list_complaints).
 * The last two are read-only lookups, made only for actions this person may take.
 * A lookup that fails leaves the action offered: propose re-checks it anyway.
 */
export async function completedBriefingActions(store: RuntimeStore, principal: Principal, findings: AgentFinding[], runId: string): Promise<Set<string>> {
  const done = new Set<string>();
  const ids = new Set(findings.flatMap((finding) => finding.claims.flatMap((claim) => claim.evidenceIds)).filter((id) => id.startsWith("list_equipment_events-")));
  for (const id of ids) {
    for (const row of rowsOf(store.getEvidence(id, principal.id) ?? {})) if (row.escalatedAt) done.add(`escalate_equipment_fault:${String(row.id)}`);
  }
  const shippers = hasGrant(principal, "cap.shippers.notify")
    ? [...new Set(findings.flatMap((finding) => finding.entities.filter((entity) => entity.type === "shipper").map((entity) => entity.id)))].slice(0, 3)
    : [];
  const complaints = hasGrant(principal, "cap.complaints.assign");
  if (!shippers.length && !complaints) return done;
  try {
    await readOnly(store, principal, `done-${runId}`, async (client) => {
      for (const shipperId of shippers) {
        try {
          const evidence = await client.call("get_shipper", { shipperId }, "customers");
          const queued = ((evidence.result as { queuedNotifications?: Array<Record<string, unknown>> } | undefined)?.queuedNotifications ?? []).some((item) => item.topic === NOTIFY_TOPIC);
          if (queued) done.add(`notify_shipper:${shipperId}`);
        } catch { /* left offered */ }
      }
      if (complaints) {
        try {
          const queue = await client.call("list_complaints", LATE_AT_RISK_ARGS, "customers");
          if (!rowsOf(queue).length) done.add("assign_complaints:late-at-risk");
        } catch { /* left offered */ }
      }
    });
  } catch { /* no lookup connection: nothing more is suppressed */ }
  return done;
}

/** Propose: a new revision of the same surface with an inline confirm in place of the action row. */
/**
 * Checked before anything else about a briefing operation request, including the
 * stale-revision no-op, so a forged request is refused (403) rather than ignored:
 * proposing needs the catalog action's grant; confirming or cancelling needs a
 * proposal this person owns and still holds the grant for.
 */
export function authorizeBriefingOperation(store: RuntimeStore, principal: Principal, name: string, parameters: Record<string, unknown>) {
  if (name === "propose_action") {
    const action = catalogAction(String(parameters.actionId ?? ""));
    if (!action) throw new Error(`Unknown action ${String(parameters.actionId ?? "")}`);
    authorize(principal, action);
    return;
  }
  const proposal = store.getProposal(String(parameters.proposalId ?? ""), principal.id);
  if (!proposal) throw new Error("Not authorized: no such proposal for this person");
  if (!hasGrant(principal, proposal.capability)) throw new Error(`Not authorized: ${proposal.capability}`);
}

export async function proposeBriefingAction(input: { store: RuntimeStore; principal: Principal; threadId: string; actionId: string }): Promise<void> {
  const action = catalogAction(input.actionId);
  if (!action) throw new Error(`Unknown action ${input.actionId}`);
  authorize(input.principal, action);
  const active = activeBriefing(input.store, input.threadId);
  if (active.briefing.pending) return; // one proposal at a time; a repeat click is a no-op
  const offered = active.briefing.actions.find((item) => item.id === action.id && item.name === "propose_action");
  if (!offered) throw new Error("That action is not offered on this view");
  const prepared = await prepareBriefingAction(input.store, input.principal, action, offered.entities);
  const proposalId = prepareOperation({
    store: input.store, principal: input.principal, threadId: input.threadId, capability: action.requiredGrant,
    payload: prepared.payload, resource: prepared.resource, status: prepared.blocked ? "blocked" : "prepared",
  });
  saveBriefing(input.store, input.threadId, input.principal.id, active, {
    ...active.briefing,
    pending: { proposalId, actionId: action.id, text: prepared.text, confirmLabel: prepared.confirmLabel, ...(prepared.blocked ? { blocked: true } : {}) },
  });
}

/** Cancel (or Back): the proposal is closed and the action row returns. Nothing is written. */
export function cancelBriefingAction(input: { store: RuntimeStore; principal: Principal; threadId: string; proposalId: string }): void {
  const proposal = input.store.getProposal(input.proposalId, input.principal.id);
  if (!proposal || proposal.threadId !== input.threadId) throw new Error("Proposal not found");
  const action = catalogAction(String(proposal.payload.actionId ?? ""));
  if (!action) throw new Error("Proposal not found");
  authorize(input.principal, action);
  if (proposal.status === "prepared" || proposal.status === "blocked") {
    setProposalStatus(input.store, input.principal, proposal, "cancelled");
    audit(input.store, input.principal, "operation.cancel", action.id, "cancelled");
  }
  const active = activeBriefing(input.store, input.threadId);
  if (active.briefing.pending?.proposalId !== input.proposalId) return;
  const { pending: _closed, ...rest } = active.briefing;
  saveBriefing(input.store, input.threadId, input.principal.id, active, rest as PresentationBriefing);
}

type Receipt = NonNullable<NonNullable<PresentationBriefing["primary"]>["receipts"]>[number];

/**
 * Confirm: the MCP write (on the one writable connection), then a re-read of only
 * the affected record, then a receipt on the primary card. No replan.
 */
export async function confirmBriefingAction(input: { store: RuntimeStore; principal: Principal; threadId: string; proposalId: string }): Promise<void> {
  const { store, principal } = input;
  const proposal = store.getProposal(input.proposalId, principal.id);
  // A proposal belongs to the thread it was made on; another thread cannot confirm it.
  if (!proposal || proposal.threadId !== input.threadId) throw new Error("Proposal not found");
  const action = catalogAction(String(proposal.payload.actionId ?? ""));
  if (!action) throw new Error("Proposal not found");
  authorize(principal, action);
  if (proposal.status === "committed") return; // a duplicate confirm is a no-op
  if (proposal.status === "prepared" && Date.parse(proposal.expiresAt) < Date.now()) {
    // Expired: nothing is written. The inline confirm is cleared and the card says why,
    // rather than leaving a Confirm button that can only fail.
    setProposalStatus(store, principal, proposal, "expired");
    audit(store, principal, "operation.expire", action.id, "expired");
    closeConfirm(store, input.threadId, principal, input.proposalId, {
      operationId: "not-recorded",
      actionId: action.id,
      status: "failed",
      text: `Not done: this confirmation expired${clock(proposal.expiresAt) ? ` at ${clock(proposal.expiresAt)}` : ""} before it was confirmed. Nothing was written; propose it again to see the current state.`,
      evidenceIds: [],
    }, false);
    return;
  }
  await once(input.proposalId, async () => {
    const open = openProposal(store, principal, input.proposalId);
    const payload = open.payload;
    let receipt: Receipt;
    let succeeded = false;
    let outcome: CommitOutcome<unknown> | undefined;
    try {
      const { idempotencyKey, resource, write } = writeFor(action.id, payload, principal);
      outcome = await commitOperation({ store, principal, proposal: open, capability: action.requiredGrant, idempotencyKey, payload, resource, write });
    } catch (error) {
      const message = error instanceof Error ? error.message : "operation failed";
      if (/Not authorized/.test(message)) throw error;
      const stale = /stale|already/i.test(message);
      receipt = {
        operationId: store.getOperationByKey(writeFor(action.id, payload, principal).idempotencyKey, principal.id)?.id ?? "not-recorded",
        actionId: action.id,
        status: "failed",
        text: stale
          ? `Not done: the record changed after it was read (${message}). Nothing was written; propose it again to see the current state.`
          : `Could not confirm this was done: ${message}. Check the record before trying again.`,
        evidenceIds: [],
      };
      if (!stale) setProposalStatus(store, principal, open, "failed");
      else setProposalStatus(store, principal, open, "refused");
    }
    if (outcome) {
      // The write succeeded and the proposal is committed. The re-read only words the
      // receipt: if it fails, the receipt still says it was done, that it could not be
      // re-confirmed, and the proposal stays committed (never marked failed).
      succeeded = true;
      try {
        const committed = outcome;
        const reread = await readOnly(store, principal, `reread-${committed.operationId}`, (client) => rereadFor(action.id, payload, client));
        receipt = { operationId: committed.operationId, actionId: action.id, status: "succeeded", text: receiptText(action.id, payload, committed, reread), evidenceIds: typeof reread.evidenceId === "string" ? [reread.evidenceId] : [] };
      } catch (error) {
        const message = error instanceof Error ? error.message : "read failed";
        audit(store, principal, "operation.reread", action.id, "failed", message);
        receipt = { operationId: outcome.operationId, actionId: action.id, status: "succeeded", text: unconfirmedReceiptText(action.id, payload, outcome), evidenceIds: [] };
      }
    }
    closeConfirm(store, input.threadId, principal, input.proposalId, receipt!, succeeded);
  });
}

/** Replaces the inline confirm with a receipt on the primary card. A done action leaves the row. */
function closeConfirm(store: RuntimeStore, threadId: string, principal: Principal, proposalId: string, receipt: Receipt, done: boolean) {
  const active = activeBriefing(store, threadId);
  const actionId = receipt.actionId;
  const { pending, ...rest } = active.briefing;
  // Only this proposal's confirm is closed; a newer one on the card stays.
  const keep = pending && pending.proposalId !== proposalId ? { pending } : {};
  const primary = rest.primary ? { ...rest.primary, receipts: [...(rest.primary.receipts ?? []), receipt].slice(-3) } : rest.primary;
  saveBriefing(store, threadId, principal.id, active, {
    ...rest,
    ...keep,
    primary,
    // A done action leaves the row; a refused or expired one stays so it can be proposed again.
    actions: done ? rest.actions.filter((item) => item.id !== actionId) : rest.actions,
  } as PresentationBriefing);
}

function writeFor(id: CatalogActionId, payload: Record<string, unknown>, principal: Principal): { idempotencyKey: string; resource: string; write: (client: CompanyMcpClient) => Promise<unknown> } {
  if (id === "escalate_equipment_fault") {
    const args = { eventId: String(payload.eventId), expectedVersion: Number(payload.expectedVersion) };
    return { idempotencyKey: `escalate:${args.eventId}:${args.expectedVersion}`, resource: `equipment:${args.eventId}`, write: (client) => client.call("escalate_equipment_fault", args) };
  }
  if (id === "notify_shipper") {
    const args = { shipperId: String(payload.shipperId), topic: String(payload.topic), message: String(payload.message), idempotencyKey: String(payload.idempotencyKey), requestedBy: principal.id };
    return { idempotencyKey: args.idempotencyKey, resource: `shipper:${args.shipperId}`, write: (client) => client.call("notify_shipper", args) };
  }
  const plan = (payload.plan ?? []) as Array<{ complaintId: string; expectedVersion: number; assigneeId: string }>;
  const key = createHash("sha256").update(plan.map((item) => `${item.complaintId}:${item.expectedVersion}:${item.assigneeId}`).join("|")).digest("hex").slice(0, 24);
  return {
    idempotencyKey: `assign-late:${key}`,
    resource: "complaints:late-at-risk",
    // Each assignment is versioned on its own; one that went stale is reported, the rest stand.
    write: async (client) => {
      const done: string[] = [];
      const refused: Array<{ complaintId: string; error: string }> = [];
      for (const item of plan) {
        try {
          await client.call("commit_complaint_assignment", item);
          done.push(item.complaintId);
        } catch (error) {
          refused.push({ complaintId: item.complaintId, error: error instanceof Error ? error.message : "failed" });
        }
      }
      if (!done.length) throw new Error(refused[0]?.error ?? "No complaint could be assigned");
      return { done, refused };
    },
  };
}

function rereadFor(id: CatalogActionId, payload: Record<string, unknown>, client: CompanyMcpClient): Promise<Record<string, unknown>> {
  const domain: Record<CatalogActionId, Domain> = { escalate_equipment_fault: "network", notify_shipper: "customers", assign_complaints: "customers" };
  if (id === "escalate_equipment_fault") return client.call("list_equipment_events", { openOnly: true }, domain[id]);
  if (id === "notify_shipper") return client.call("get_shipper", { shipperId: String(payload.shipperId) }, domain[id]);
  return client.call("list_complaints", payload.args as Record<string, unknown>, domain[id]);
}

/** The receipt when the write succeeded but the follow-up read of the record did not. */
function unconfirmedReceiptText(id: CatalogActionId, payload: Record<string, unknown>, outcome: CommitOutcome<unknown>): string {
  const ref = `receipt ${shortId(outcome.operationId)}`;
  const what = id === "escalate_equipment_fault"
    ? `Escalated ${payload.equipment} to ${payload.engineerName}`
    : id === "notify_shipper"
      ? `Notice for ${payload.shipperName} queued for account manager ${payload.accountManagerName} · nothing was sent`
      : "Late complaints assigned";
  return `${what} · done, but the record could not be re-read to confirm it just now · ${ref}`;
}

function receiptText(id: CatalogActionId, payload: Record<string, unknown>, outcome: CommitOutcome<unknown>, reread: Record<string, unknown>): string {
  const ref = `receipt ${shortId(outcome.operationId)}`;
  if (id === "escalate_equipment_fault") {
    const row = rowsOf(reread).find((item) => String(item.id) === String(payload.eventId));
    const when = clock(row?.escalatedAt);
    return `Escalated ${payload.equipment} to ${row?.escalatedToName ?? payload.engineerName}${when ? ` at ${when}` : ""} · maintenance log updated · ${ref}`;
  }
  if (id === "notify_shipper") {
    const queued = ((reread.result as { queuedNotifications?: Array<Record<string, unknown>> } | undefined)?.queuedNotifications ?? []).find((item) => item.topic === payload.topic);
    const when = clock(queued?.createdAt);
    return `Notice for ${payload.shipperName} queued for account manager ${payload.accountManagerName}${when ? ` at ${when}` : ""} · nothing was sent · ${ref}`;
  }
  const result = (outcome.already ? (outcome.previous.result as { done?: string[]; refused?: unknown[] } | undefined) : outcome.result as { done?: string[]; refused?: unknown[] }) ?? {};
  const remaining = Number((reread.result as { total?: number } | undefined)?.total ?? 0);
  const names = ((payload.assignees ?? []) as Array<{ label: string }>).map((item) => item.label).join(", ");
  const refused = result.refused?.length ? ` · ${result.refused.length} changed meanwhile and were left alone` : "";
  return `Assigned ${result.done?.length ?? 0} late complaints to ${names}${refused} · ${remaining} still without an owner · ${ref}`;
}
