import { randomUUID } from "node:crypto";
import type { Principal } from "@anc/policy";
import { hasGrant } from "@anc/policy";
import { CompanyMcpClient } from "./mcp-client.js";
import type { PresentationInput } from "@anc/contracts";
import { composeA2UI } from "./composer.js";
import { validateA2UI } from "./a2ui-validate.js";
import type { RuntimeStore } from "@anc/runtime-storage";

export async function prepareComplaintAssignment(input: {
  store: RuntimeStore;
  principal: Principal;
  threadId: string;
  complaintId: string;
}): Promise<void> {
  if (!hasGrant(input.principal, "cap.complaints.assign")) throw new Error("Not authorized to assign complaints");
  const client = new CompanyMcpClient(input.store, { runId: `prep-${randomUUID()}`, principalId: input.principal.id });
  await client.connect();
  try {
    const [queue, owners] = await Promise.all([
      client.call("list_complaints", { status: "open", unassignedOnly: true, page: { limit: 100, offset: 0 } }, "customers"),
      client.call("list_eligible_assignees", { team: "customer-care" }, "customers"),
    ]);
    const complaints = ((queue.result as { rows?: Array<Record<string, unknown>> })?.rows ?? []);
    const complaint = complaints.find((row) => String(row.id) === input.complaintId);
    if (!complaint) throw new Error("That complaint is not open and unassigned");
    const assignees = ((owners.result as { rows?: Array<Record<string, unknown>> })?.rows ?? []).map((row) => ({
      id: String(row.id),
      label: String(row.name ?? row.id),
    }));
    const proposalId = `proposal-${randomUUID()}`;
    const payload = {
      complaintId: String(complaint.id),
      expectedVersion: Number(complaint.version ?? 1),
      assigneeId: assignees[0]?.id,
      assignees,
      preview: `${complaint.shipperName ?? complaint.shipperId}: "${complaint.subject}". Choose who should own it.`,
    };
    input.store.saveProposal({
      id: proposalId,
      threadId: input.threadId,
      ownerId: input.principal.id,
      capability: "cap.complaints.assign",
      revision: 1,
      payload,
      expiresAt: new Date(Date.now() + 15 * 60 * 1000).toISOString(),
      status: "prepared",
      now: new Date().toISOString(),
    });
    const presentation = assignmentForm(proposalId, payload);
    saveGeneratedSurface(input.store, input.threadId, input.principal.id, presentation);
  } finally {
    await client.close();
  }
}

export async function commitComplaintAssignment(input: {
  store: RuntimeStore;
  principal: Principal;
  threadId: string;
  proposalId: string;
  assigneeId?: string;
}): Promise<void> {
  if (!hasGrant(input.principal, "cap.complaints.assign")) throw new Error("Not authorized to assign complaints");
  const proposal = input.store.getProposal(input.proposalId, input.principal.id);
  if (!proposal) throw new Error("Assignment proposal not found");
  if (proposal.status !== "prepared") throw new Error("Proposal is no longer valid");
  if (Date.parse(proposal.expiresAt) < Date.now()) throw new Error("Proposal expired");
  const complaintId = String(proposal.payload.complaintId);
  const expectedVersion = Number(proposal.payload.expectedVersion);
  const assigneeId = input.assigneeId ?? String(proposal.payload.assigneeId ?? "");
  const offered = (proposal.payload.assignees ?? []) as Array<{ id: string; label: string }>;
  const chosen = offered.find((item) => item.id === assigneeId);
  // Only someone the form offered can be chosen, whatever the request says.
  if (!chosen) throw new Error("That person cannot own this complaint");
  const assigneeName = chosen.label;
  const idempotencyKey = `${complaintId}:${expectedVersion}:${assigneeId}`;
  const existing = input.store.getOperationByKey(idempotencyKey, input.principal.id);
  if (existing?.status === "succeeded") {
    receiptSurface(input.store, input.threadId, input.principal.id, existing.id, "succeeded", "This assignment was already completed.");
    return;
  }
  const operationId = existing?.id ?? `op-${randomUUID()}`;
  input.store.saveOperation({
    id: operationId,
    idempotencyKey,
    ownerId: input.principal.id,
    capability: "cap.complaints.assign",
    proposalId: proposal.id,
    status: "pending",
    payload: { complaintId, assigneeId, expectedVersion },
    now: new Date().toISOString(),
  });
  const client = new CompanyMcpClient(input.store, { runId: operationId, principalId: input.principal.id });
  await client.connect();
  try {
    const result = await client.call("commit_complaint_assignment", { complaintId, assigneeId, expectedVersion });
    input.store.saveOperation({
      id: operationId,
      idempotencyKey,
      ownerId: input.principal.id,
      capability: "cap.complaints.assign",
      proposalId: proposal.id,
      status: "succeeded",
      payload: { complaintId, assigneeId, expectedVersion, result },
      now: new Date().toISOString(),
    });
    input.store.saveProposal({ ...proposal, ownerId: input.principal.id, payload: proposal.payload, status: "committed", expiresAt: proposal.expiresAt, now: new Date().toISOString() });
    receiptSurface(input.store, input.threadId, input.principal.id, operationId, "succeeded", `Complaint ${complaintId} is now owned by ${assigneeName}.`);
  } catch (error) {
    const message = error instanceof Error ? error.message : "assignment failed";
    const status = /stale/i.test(message) ? "failed" : "unknown";
    input.store.saveOperation({
      id: operationId,
      idempotencyKey,
      ownerId: input.principal.id,
      capability: "cap.complaints.assign",
      proposalId: proposal.id,
      status,
      payload: { complaintId, assigneeId, expectedVersion, error: message },
      now: new Date().toISOString(),
    });
    throw error;
  } finally {
    await client.close();
  }
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
  saveGeneratedSurface(input.store, input.threadId, input.principal.id, assignmentForm(proposal.id, next));
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
  });
}

function saveGeneratedSurface(store: RuntimeStore, threadId: string, ownerId: string, presentation: PresentationInput) {
  const thread = store.getThreadState(threadId);
  const surfaceId = thread?.activeSurfaceId ?? `surface-${threadId}`;
  const revision = (thread?.activeSurfaceRevision ?? 0) + 1;
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
    findingIds: [],
    now: new Date().toISOString(),
    ownerId,
    requiredGrants: ["cap.complaints.assign"],
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
