import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import Database from "better-sqlite3";
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

  it("keeps a proposal's created_at and owner when its status changes", () => {
    const path = join(mkdtempSync(join(tmpdir(), "anc-runtime-")), "runtime.sqlite");
    const store = new RuntimeStore(openRuntimeDatabase(path));
    const proposal = { id: "prop-1", threadId: "t", ownerId: "user-coo", capability: "cap.equipment.escalate", revision: 3, payload: { actionId: "escalate_equipment_fault" }, expiresAt: "2026-09-21T01:45:00.000Z" };
    store.saveProposal({ ...proposal, status: "prepared", now: "2026-09-21T01:30:00.000Z" });
    store.saveProposal({ ...proposal, status: "committed", now: "2026-09-21T01:40:00.000Z" });
    // Someone else's save under the same id changes nothing.
    store.saveProposal({ ...proposal, ownerId: "user-hub-hyd", status: "cancelled", now: "2026-09-21T01:41:00.000Z" });
    expect(store.getProposal("prop-1", "user-coo")?.status).toBe("committed");
    expect(store.getProposal("prop-1", "user-hub-hyd")).toBeUndefined();
    store.close();
    const db = new Database(path, { readonly: true });
    expect(db.prepare("SELECT created_at, owner_id FROM action_proposals WHERE id = 'prop-1'").get()).toEqual({ created_at: "2026-09-21T01:30:00.000Z", owner_id: "user-coo" });
    db.close();
  });

  it("keeps one evidence row per owner when two people get the same evidence id", () => {
    const path = join(mkdtempSync(join(tmpdir(), "anc-ev-owner-")), "runtime.sqlite");
    const store = new RuntimeStore(openRuntimeDatabase(path));
    const save = (ownerId: string, runId: string) => store.saveEvidence({ evidenceId: "summarize_at_risk_shipments-abc", runId, tool: "summarize_at_risk_shipments", payload: { evidenceId: "summarize_at_risk_shipments-abc", owner: ownerId }, payloadHash: "abc", now: "2026-09-21T01:30:00.000Z", ownerId });
    save("user-coo", "run-a");
    save("user-hub-hyd", "run-b");
    save("user-hub-hyd", "run-c");
    expect(store.evidenceExists("summarize_at_risk_shipments-abc", "user-coo")).toBe(true);
    expect(store.evidenceExists("summarize_at_risk_shipments-abc", "user-hub-hyd")).toBe(true);
    expect(store.evidenceExists("summarize_at_risk_shipments-abc", "user-care")).toBe(false);
    expect(store.getEvidence("summarize_at_risk_shipments-abc", "user-hub-hyd")?.owner).toBe("user-hub-hyd");
    expect(store.getEvidenceRecord("summarize_at_risk_shipments-abc", "user-coo")?.payload.owner).toBe("user-coo");
    expect(store.getEvidenceTool("summarize_at_risk_shipments-abc", "user-hub-hyd")).toBe("summarize_at_risk_shipments");
    expect(store.findEvidenceByToolArgs("summarize_at_risk_shipments", undefined, "run-b", "user-coo")).toBeUndefined();
    store.close();
  });

  it("migrates a v3 evidence table (keyed by evidence id alone) to the per-owner key, keeping rows", () => {
    const path = join(mkdtempSync(join(tmpdir(), "anc-ev-migrate-")), "runtime.sqlite");
    const old = new Database(path);
    old.exec("CREATE TABLE evidence (evidence_id TEXT PRIMARY KEY, run_id TEXT NOT NULL, task_id TEXT, tool TEXT NOT NULL, payload TEXT NOT NULL, payload_hash TEXT NOT NULL, created_at TEXT NOT NULL)");
    old.prepare("INSERT INTO evidence VALUES ('ev-old', 'run-1', NULL, 'get_hub_status', '{\"evidenceId\":\"ev-old\"}', 'h', '2026-09-20T08:00:00.000Z')").run();
    old.close();
    const db = openRuntimeDatabase(path);
    const keyed = (db.prepare("PRAGMA table_info(evidence)").all() as Array<{ name: string; pk: number }>).filter((column) => column.pk > 0).map((column) => column.name).sort();
    expect(keyed).toEqual(["evidence_id", "owner_id"]);
    const store = new RuntimeStore(db);
    expect(store.getEvidence("ev-old", "user-coo")?.evidenceId).toBe("ev-old");
    store.saveEvidence({ evidenceId: "ev-old", runId: "run-2", tool: "get_hub_status", payload: { evidenceId: "ev-old" }, payloadHash: "h", now: "2026-09-21T08:00:00.000Z", ownerId: "user-hub-hyd" });
    expect(store.evidenceExists("ev-old", "user-hub-hyd")).toBe(true);
    store.close();
    // Opening again is a no-op.
    const again = new RuntimeStore(openRuntimeDatabase(path));
    expect(again.evidenceExists("ev-old", "user-coo")).toBe(true);
    again.close();
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
