import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { openRuntimeDatabase, RuntimeStore } from "./index.js";

describe("runtime store", () => {
  it("persists evidence before it can be read back", () => {
    const path = join(mkdtempSync(join(tmpdir(), "anc-runtime-")), "runtime.sqlite");
    const store = new RuntimeStore(openRuntimeDatabase(path));
    store.upsertInvestigation({ id: "inv-1", threadId: "t", objective: "q", status: "running", now: "2026-09-20T08:00:00.000Z" });
    store.insertRun({ id: "run-1", investigationId: "inv-1", threadId: "t", status: "running", now: "2026-09-20T08:00:00.000Z" });
    store.saveEvidence({ evidenceId: "ev-1", runId: "run-1", tool: "get_error_metrics", payload: { evidenceId: "ev-1", result: { ok: true } }, payloadHash: "abc", now: "2026-09-20T08:00:00.000Z" });
    expect(store.evidenceExists("ev-1")).toBe(true);
    expect(store.getEvidence("ev-1")?.evidenceId).toBe("ev-1");
    store.close();
  });

  it("restores runtime state from a backup snapshot", async () => {
    const dir = mkdtempSync(join(tmpdir(), "anc-backup-"));
    const path = join(dir, "runtime.sqlite");
    const backup = join(dir, "runtime-backup.sqlite");
    const store = new RuntimeStore(openRuntimeDatabase(path));
    store.appendAudit({ id: "audit-1", organizationId: "org-democo", actorId: "user-coo", action: "kept", outcome: "ok", now: "2026-09-20T08:00:00.000Z" });
    await store.backupTo(backup);
    store.appendAudit({ id: "audit-2", organizationId: "org-democo", actorId: "user-coo", action: "later", outcome: "ok", now: "2026-09-20T09:00:00.000Z" });
    store.close();
    const recovered = new RuntimeStore(openRuntimeDatabase(backup));
    expect(recovered.listAudit().map((item) => item.action)).toEqual(["kept"]);
    recovered.close();
  });

  it("removes an owner's evidence, surfaces, and checkpoints together", () => {
    const path = join(mkdtempSync(join(tmpdir(), "anc-purge-")), "runtime.sqlite");
    const db = openRuntimeDatabase(path);
    const store = new RuntimeStore(db);
    store.setThreadState({ threadId: "local-demo", status: "completed", now: "2026-09-20T08:00:00.000Z", ownerId: "user-coo", organizationId: "org-democo" });
    store.upsertInvestigation({ id: "inv-1", threadId: "local-demo", objective: "q", status: "completed", now: "2026-09-20T08:00:00.000Z" });
    store.insertRun({ id: "run-1", investigationId: "inv-1", threadId: "local-demo", status: "completed", now: "2026-09-20T08:00:00.000Z" });
    store.saveEvidence({ evidenceId: "ev-1", runId: "run-1", tool: "list_invoice_aging", payload: { secret: true }, payloadHash: "abc", now: "2026-09-20T08:00:00.000Z", ownerId: "user-coo" });
    store.saveSurface({ surfaceId: "s", revision: 1, threadId: "local-demo", investigationId: "inv-1", title: "Invoices", messages: [], dataModel: { rows: [1] }, findingIds: [], now: "2026-09-20T08:00:00.000Z", ownerId: "user-coo", requiredGrants: ["cap.finance.invoices"] });
    db.exec("CREATE TABLE checkpoints (thread_id TEXT, checkpoint_id TEXT)");
    db.prepare("INSERT INTO checkpoints (thread_id, checkpoint_id) VALUES ('local-demo', 'c1')").run();
    const removed = store.purgeOwner("user-coo");
    expect(removed.evidence).toBe(1);
    expect(removed.surfaces).toBe(1);
    expect(removed.checkpoints).toBe(1);
    expect(store.getEvidence("ev-1")).toBeUndefined();
    expect(store.getSurface("s", 1)).toBeUndefined();
    store.close();
  });

  it("drops saved rows older than the retention cutoff and keeps newer ones", () => {
    const path = join(mkdtempSync(join(tmpdir(), "anc-retain-")), "runtime.sqlite");
    const store = new RuntimeStore(openRuntimeDatabase(path));
    store.upsertInvestigation({ id: "inv-1", threadId: "t", objective: "q", status: "completed", now: "2026-01-01T00:00:00.000Z" });
    store.insertRun({ id: "run-old", investigationId: "inv-1", threadId: "t", status: "completed", now: "2026-01-01T00:00:00.000Z" });
    store.insertRun({ id: "run-new", investigationId: "inv-1", threadId: "t", status: "completed", now: "2026-09-20T08:00:00.000Z" });
    store.saveEvidence({ evidenceId: "old", runId: "run-old", tool: "get_customer", payload: {}, payloadHash: "a", now: "2026-01-01T00:00:00.000Z" });
    store.saveEvidence({ evidenceId: "new", runId: "run-new", tool: "get_customer", payload: {}, payloadHash: "b", now: "2026-09-20T08:00:00.000Z" });
    store.purgeOlderThan("2026-06-01T00:00:00.000Z");
    expect(store.getEvidence("old")).toBeUndefined();
    expect(store.evidenceExists("new")).toBe(true);
    store.close();
  });
});
