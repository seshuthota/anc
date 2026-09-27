import { randomUUID } from "node:crypto";
import type { Principal } from "@anc/policy";
import { hasGrant } from "@anc/policy";
import { CompanyMcpClient } from "./mcp-client.js";
import type { PresentationInput } from "@anc/contracts";
import { composeA2UI } from "./composer.js";
import { validateA2UI } from "./a2ui-validate.js";
import type { RuntimeStore } from "@anc/runtime-storage";

export async function prepareTicketAssignment(input: {
  store: RuntimeStore;
  principal: Principal;
  threadId: string;
  ticketId: string;
}): Promise<void> {
  if (!hasGrant(input.principal, "cap.tickets.assign")) throw new Error("Not authorized to assign tickets");
  const client = new CompanyMcpClient(input.store, { runId: `prep-${randomUUID()}`, principalId: input.principal.id });
  await client.connect();
  try {
    const [queue, owners] = await Promise.all([
      client.call("list_unassigned_escalations", { page: { limit: 50, offset: 0 } }, "customer"),
      client.call("list_eligible_assignees", { team: "support" }, "customer"),
    ]);
    const tickets = ((queue.result as { rows?: Array<Record<string, unknown>> })?.rows ?? []);
    const ticket = tickets.find((row) => String(row.id) === input.ticketId) ?? tickets[0];
    if (!ticket) throw new Error("No unassigned ticket to assign");
    const assignees = ((owners.result as { rows?: Array<Record<string, unknown>> })?.rows ?? []).map((row) => ({
      id: String(row.id),
      label: String(row.name ?? row.id),
    }));
    const proposalId = `proposal-${randomUUID()}`;
    const payload = {
      ticketId: String(ticket.id),
      expectedVersion: Number(ticket.version ?? 1),
      assigneeId: assignees[0]?.id,
      preview: `Assign ${ticket.id} to ${assignees[0]?.label ?? "an eligible owner"}`,
    };
    input.store.saveProposal({
      id: proposalId,
      threadId: input.threadId,
      ownerId: input.principal.id,
      capability: "cap.tickets.assign",
      revision: 1,
      payload,
      expiresAt: new Date(Date.now() + 15 * 60 * 1000).toISOString(),
      status: "prepared",
      now: new Date().toISOString(),
    });
    const presentation = {
      title: "Assign ticket",
      subtitle: payload.preview,
      metrics: [],
      findings: [],
      form: {
        id: proposalId,
        fields: [{ id: "assignee", label: "Owner", name: "assigneeId", value: payload.assigneeId, options: assignees }],
        submitLabel: "Confirm assignment",
        submitAction: "commit_assignment",
      },
      actions: [],
      limitations: ["Confirming writes to the mutable operations copy. This does not roll back automatically."],
    };
    saveGeneratedSurface(input.store, input.threadId, input.principal.id, presentation);
  } finally {
    await client.close();
  }
}

export async function commitTicketAssignment(input: {
  store: RuntimeStore;
  principal: Principal;
  threadId: string;
  proposalId: string;
  assigneeId?: string;
}): Promise<void> {
  if (!hasGrant(input.principal, "cap.tickets.assign")) throw new Error("Not authorized to assign tickets");
  const proposal = input.store.getProposal(input.proposalId, input.principal.id);
  if (!proposal) throw new Error("Assignment proposal not found");
  if (proposal.status !== "prepared") throw new Error("Proposal is no longer valid");
  if (Date.parse(proposal.expiresAt) < Date.now()) throw new Error("Proposal expired");
  const ticketId = String(proposal.payload.ticketId);
  const expectedVersion = Number(proposal.payload.expectedVersion);
  const assigneeId = input.assigneeId ?? String(proposal.payload.assigneeId ?? "");
  if (input.assigneeId && input.assigneeId !== proposal.payload.assigneeId) {
    input.store.saveProposal({ ...proposal, ownerId: input.principal.id, payload: { ...proposal.payload, assigneeId }, status: "invalidated", expiresAt: proposal.expiresAt, now: new Date().toISOString() });
    throw new Error("Assignee change requires a new proposal");
  }
  const idempotencyKey = `${ticketId}:${expectedVersion}:${assigneeId}`;
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
    capability: "cap.tickets.assign",
    proposalId: proposal.id,
    status: "pending",
    payload: { ticketId, assigneeId, expectedVersion },
    now: new Date().toISOString(),
  });
  const client = new CompanyMcpClient(input.store, { runId: operationId, principalId: input.principal.id });
  await client.connect();
  try {
    const result = await client.call("commit_ticket_assignment", { ticketId, assigneeId, expectedVersion });
    input.store.saveOperation({
      id: operationId,
      idempotencyKey,
      ownerId: input.principal.id,
      capability: "cap.tickets.assign",
      proposalId: proposal.id,
      status: "succeeded",
      payload: { ticketId, assigneeId, expectedVersion, result },
      now: new Date().toISOString(),
    });
    input.store.saveProposal({ ...proposal, ownerId: input.principal.id, payload: proposal.payload, status: "committed", expiresAt: proposal.expiresAt, now: new Date().toISOString() });
    receiptSurface(input.store, input.threadId, input.principal.id, operationId, "succeeded", `Ticket ${ticketId} is assigned to ${assigneeId}.`);
  } catch (error) {
    const message = error instanceof Error ? error.message : "assignment failed";
    const status = /stale/i.test(message) ? "failed" : "unknown";
    input.store.saveOperation({
      id: operationId,
      idempotencyKey,
      ownerId: input.principal.id,
      capability: "cap.tickets.assign",
      proposalId: proposal.id,
      status,
      payload: { ticketId, assigneeId, expectedVersion, error: message },
      now: new Date().toISOString(),
    });
    throw error;
  } finally {
    await client.close();
  }
}

function receiptSurface(store: RuntimeStore, threadId: string, ownerId: string, operationId: string, status: string, summary: string) {
  saveGeneratedSurface(store, threadId, ownerId, {
    title: "Assignment receipt",
    subtitle: summary,
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
    requiredGrants: ["cap.tickets.assign"],
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
