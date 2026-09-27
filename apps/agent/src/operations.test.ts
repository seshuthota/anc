import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DEFAULT_COMPANY_DB_PATH, seedScenario } from "@anc/database";
import { resolvePrincipal } from "@anc/policy";

const dir = mkdtempSync(join(tmpdir(), "anc-ops-"));
process.env.RUNTIME_DB_PATH = join(dir, "runtime.sqlite");
process.env.COMPANY_DB_PATH = DEFAULT_COMPANY_DB_PATH;
process.env.MODEL_PROVIDER = "fixture";
process.env.VITEST = "true";
seedScenario(process.env.COMPANY_DB_PATH, "sync-regression");

const { handleAction, runInvestigation, store } = await import("./runtime.js");

describe("ticket assignment", () => {
  it("assigns through generated prepare/commit and rejects unauthorized users", async () => {
    const support = resolvePrincipal("user-support");
    const queue = await runInvestigation({ question: "Show unassigned escalations", threadId: "session:user-support", principal: support });
    expect(queue.surface?.title ?? queue.status).toMatch(/Unassigned|Partial|Incomplete/i);
    expect(queue.surface).toBeTruthy();
    const prepared = await handleAction({
      actionId: "prep-1",
      name: "prepare_assignment",
      threadId: "session:user-support",
      investigationId: queue.investigationId,
      surfaceId: queue.surface?.surfaceId,
      surfaceRevision: queue.surface?.revision,
      entities: [{ type: "ticket", id: "ticket-esc-001" }],
    }, support);
    expect(prepared.surface?.title).toMatch(/Assign ticket/i);
    const proposalId = String((prepared.surface?.dataModel as { form?: { id?: string } } | null)?.form?.id ?? "");
    expect(proposalId).toMatch(/^proposal-/);
    const committed = await handleAction({
      actionId: "commit-1",
      name: "commit_assignment",
      threadId: "session:user-support",
      investigationId: prepared.investigationId,
      surfaceId: prepared.surface?.surfaceId,
      surfaceRevision: prepared.surface?.revision,
      parameters: { proposalId },
    }, support);
    expect(committed.surface?.title).toMatch(/receipt/i);
    await expect(handleAction({
      actionId: "prep-ops",
      name: "prepare_assignment",
      threadId: "session:user-ops",
      investigationId: "x",
      surfaceId: "s",
      surfaceRevision: 1,
      entities: [{ type: "ticket", id: "ticket-esc-001" }],
    }, resolvePrincipal("user-ops"))).rejects.toThrow(/Not authorized/);
    store.close();
  }, 60_000);
});
