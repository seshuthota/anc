import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { openLogisticsDatabase, seedLogistics, type LogisticsScenario } from "@anc/logistics-db";
import { registerLogisticsTools, TOOL_DOMAINS, type LogisticsTool } from "./tools.js";

function harness(scenario: LogisticsScenario = "hub-fault", authorize?: (tool: LogisticsTool) => void, writable?: boolean) {
  const db = openLogisticsDatabase(join(mkdtempSync(join(tmpdir(), "anc-logistics-mcp-")), "logistics.sqlite"));
  seedLogistics(db, scenario);
  const handlers = new Map<string, (args: unknown) => unknown>();
  registerLogisticsTools({ registerTool(name: string, _meta: unknown, handler: (args: unknown) => unknown) { handlers.set(name, handler); } }, db, { authorize, writable });
  const call = (tool: LogisticsTool, args: unknown = {}) => (handlers.get(tool)!(args) as { structuredContent: { evidenceId: string; timezone: string; result: any; completeness: { complete: boolean; total?: number } } }).structuredContent;
  return { db, handlers, call };
}

describe("logistics MCP tools", () => {
  it("registers exactly the tools it assigns to an agent", () => {
    const { db, handlers } = harness();
    expect([...handlers.keys()].sort()).toEqual(Object.keys(TOOL_DOMAINS).sort());
    db.close();
  });

  it("wraps results in an evidence envelope with a stable id", () => {
    const { db, call } = harness();
    const first = call("get_hub_status");
    expect(first.evidenceId).toMatch(/^get_hub_status-[0-9a-f]{16}$/);
    expect(first.timezone).toBe("Asia/Kolkata");
    expect(call("get_hub_status").evidenceId).toBe(first.evidenceId);
    db.close();
  });

  it("shows the Hyderabad sort floor far behind its usual rate", () => {
    const { db, call } = harness();
    const rows = call("get_hub_status").result.rows as Array<{ hubId: string; parcelsWaitingToSort: number; sortedLastHour: number; usualSortRatePerHour: number; waitingPromisedToday: number }>;
    const hyderabad = rows.find((row) => row.hubId === "hub-hyd")!;
    expect(hyderabad.parcelsWaitingToSort).toBeGreaterThan(300);
    expect(hyderabad.waitingPromisedToday).toBe(hyderabad.parcelsWaitingToSort);
    expect(hyderabad.sortedLastHour).toBeLessThan(hyderabad.usualSortRatePerHour / 3);
    expect(rows.filter((row) => row.hubId !== "hub-hyd").every((row) => row.parcelsWaitingToSort === 0)).toBe(true);
    const open = call("list_equipment_events", { openOnly: true }).result.rows as Array<{ hubId: string }>;
    expect(open.map((row) => row.hubId)).toEqual(["hub-hyd"]);
    const points = call("get_hub_throughput", { hubId: "hub-hyd" }).result.points as Array<{ backlog: number }>;
    expect(points).toHaveLength(24);
    expect(points.at(-1)!.backlog).toBe(hyderabad.parcelsWaitingToSort);
    db.close();
  });

  it("reports held runs and the parcels they left behind", () => {
    const { db, call } = harness();
    const runs = call("list_route_runs", { hubId: "hub-hyd" }).result;
    expect(runs.totals.held).toBe(3);
    expect(runs.rows.filter((row: any) => row.status === "held").every((row: any) => row.minutesLate === 15 && row.parcelsLoaded === 0)).toBe(true);
    expect(call("list_route_runs", { hubId: "hub-blr" }).result.totals.held).toBe(0);
    db.close();
  });

  it("defaults route runs to today's briefing window, as of 07:00 IST", () => {
    const { db, call } = harness();
    const runs = call("list_route_runs").result;
    expect(runs.serviceDate).toBe("2026-09-21");
    expect(runs.asOf).toMatch(/^2026-09-21T07:00/);
    expect(runs.rows.every((row: any) => row.serviceDate === "2026-09-21")).toBe(true);
    expect(call("list_route_runs", { serviceDate: "2026-09-20" }).result.serviceDate).toBe("2026-09-20");
    db.close();
  });

  it("labels complaint totals: matching counts the filter, open and unassigned count open complaints only", () => {
    const { db, call } = harness();
    const all = call("list_complaints").result;
    const openCount = (db.prepare("SELECT COUNT(*) n FROM complaints WHERE status = 'open'").get() as { n: number }).n;
    const openUnassigned = (db.prepare("SELECT COUNT(*) n FROM complaints WHERE status = 'open' AND assignee_id IS NULL").get() as { n: number }).n;
    const everything = (db.prepare("SELECT COUNT(*) n FROM complaints").get() as { n: number }).n;
    expect(all.totals.matching).toBe(everything);
    expect(all.totals.open).toBe(openCount);
    expect(all.totals.unassigned).toBe(openUnassigned);
    const open = call("list_complaints", { status: "open" }).result;
    expect(open.totals).toEqual({ matching: openCount, open: openCount, unassigned: openUnassigned });
    expect(call("list_complaints", { status: "closed" }).result.totals.open).toBe(0);
    db.close();
  });

  it("agrees with itself on what is at risk, however it is grouped", () => {
    const { db, call } = harness();
    const byHub = call("summarize_at_risk_shipments", { groupBy: "hub" }).result;
    const byShipper = call("summarize_at_risk_shipments", { groupBy: "shipper" }).result;
    expect(byHub.rows).toHaveLength(1);
    expect(byShipper.totals.atRisk).toBe(byHub.totals.atRisk);
    expect(byShipper.rows[0].id).toBe("shipper-003");
    const found = call("search_shipments", { status: "at_hub", page: { limit: 5, offset: 0 } });
    expect(found.completeness.total).toBe(byHub.totals.unsorted);
    expect(found.completeness.complete).toBe(false);
    db.close();
  });

  it("flags the key account that would fall below its commitment", () => {
    const { db, call } = harness();
    const rows = call("get_shipper_on_time", { tier: "key_account" }).result.rows as Array<{ shipperId: string; meetsTargetNow: boolean; wouldMissTarget: boolean; atRiskToday: number }>;
    const exposed = rows.find((row) => row.shipperId === "shipper-003")!;
    expect(exposed.meetsTargetNow).toBe(true);
    expect(exposed.wouldMissTarget).toBe(true);
    expect(rows[0]!.shipperId).toBe("shipper-003");
    db.close();
  });

  it("finds the full lockers and today's parcels with nowhere to go", () => {
    const { db, call } = harness();
    const rows = call("list_locker_sites", { minOccupancy: 0.9 }).result.rows as Array<{ id: string; inboundWithoutSpace: number; freeCompartments: number; waitingOver48Hours: number }>;
    expect(rows.map((row) => row.id).sort()).toEqual(["lock-tnagar", "lock-velachery"]);
    expect(rows.every((row) => row.inboundWithoutSpace > 0 && row.waitingOver48Hours > 0)).toBe(true);
    expect(call("get_locker_site", { siteId: "lock-velachery" }).result.daily.length).toBeGreaterThan(3);
    db.close();
  });

  it("counts this morning's late complaints and treats a Z-offset time as the same instant", () => {
    const { db, call } = harness();
    const ist = call("list_complaints", { status: "open", since: "2026-09-21T05:00:00.000+05:30" }).result;
    const utc = call("list_complaints", { status: "open", since: "2026-09-20T23:30:00.000Z" }).result;
    expect(utc.total).toBe(ist.total);
    expect(ist.byCategory.find((row: any) => row.category === "late").complaints).toBe(11);
    db.close();
  });

  it("rejects unknown ids instead of returning empty results", () => {
    const { db, handlers } = harness();
    expect(() => handlers.get("get_shipment")!({ shipmentId: "shp-missing" })).toThrow(/Unknown shipment/);
    expect(() => handlers.get("get_hub_throughput")!({ hubId: "hub-del" })).toThrow(/Unknown hub/);
    expect(() => handlers.get("get_shipper")!({ shipperId: "shipper-999" })).toThrow(/Unknown shipper/);
    expect(() => handlers.get("get_locker_site")!({ siteId: "lock-none" })).toThrow(/Unknown locker site/);
    db.close();
  });

  it("lets the runtime refuse a tool, and never writes on a refused assignment", () => {
    const { db, handlers } = harness("hub-fault", (tool) => { if (tool === "commit_complaint_assignment" || tool === "get_shipper_on_time") throw new Error(`Not authorized to use ${tool}`); });
    expect(() => handlers.get("get_shipper_on_time")!({})).toThrow(/Not authorized/);
    const open = db.prepare("SELECT id, version FROM complaints WHERE status = 'open' AND assignee_id IS NULL LIMIT 1").get() as { id: string; version: number };
    expect(() => handlers.get("commit_complaint_assignment")!({ complaintId: open.id, assigneeId: "emp-care-1", expectedVersion: open.version })).toThrow(/Not authorized/);
    expect((db.prepare("SELECT assignee_id a FROM complaints WHERE id = ?").get(open.id) as { a: string | null }).a).toBeNull();
    db.close();
  });

  it("assigns a complaint once and refuses a stale or ineligible assignment", () => {
    const { db, call, handlers } = harness();
    const open = db.prepare("SELECT id, version FROM complaints WHERE status = 'open' AND assignee_id IS NULL LIMIT 1").get() as { id: string; version: number };
    const done = call("commit_complaint_assignment", { complaintId: open.id, assigneeId: "emp-care-2", expectedVersion: open.version }).result;
    expect(done.after.assigneeId).toBe("emp-care-2");
    expect(done.after.version).toBe(open.version + 1);
    expect(() => handlers.get("commit_complaint_assignment")!({ complaintId: open.id, assigneeId: "emp-care-3", expectedVersion: open.version })).toThrow(/stale/);
    expect(() => handlers.get("commit_complaint_assignment")!({ complaintId: open.id, assigneeId: "emp-ops", expectedVersion: open.version + 1 })).toThrow(/not eligible/);
    db.close();
  });

  it("reads tools change nothing, and a quiet day reports nothing at risk", () => {
    const { db, call } = harness("quiet-day");
    const before = JSON.stringify(db.prepare("SELECT COUNT(*) n, SUM(version) v FROM complaints").get());
    for (const tool of ["get_hub_status", "list_route_runs", "summarize_at_risk_shipments", "get_delivery_performance", "list_locker_sites", "get_shipper_on_time", "list_complaints", "list_equipment_events", "search_shippers", "list_eligible_assignees"] as const) call(tool);
    expect(JSON.stringify(db.prepare("SELECT COUNT(*) n, SUM(version) v FROM complaints").get())).toBe(before);
    expect(call("summarize_at_risk_shipments").result.totals.atRisk).toBe(0);
    expect(call("list_locker_sites", { minOccupancy: 0.9 }).result.rows).toHaveLength(0);
    expect(call("get_delivery_performance").result.totals.onTimeRate).toBeGreaterThan(0.95);
    db.close();
  });

  it("escalates an open fault once, to the on-call engineer, and refuses a stale or repeated escalation (P4)", () => {
    const { db, call, handlers } = harness();
    const row = () => db.prepare("SELECT escalated_to, escalated_at IS NOT NULL escalated, version FROM equipment_events WHERE id = 'eq-hyd-0920'").get();
    const open = (call("list_equipment_events", { hubId: "hub-hyd", openOnly: true }).result.rows as Array<Record<string, unknown>>)[0]!;
    expect(open).toMatchObject({ id: "eq-hyd-0920", escalatedAt: null, version: 1, onCallEngineerId: "emp-eng-hyd" });
    expect(row()).toEqual({ escalated_to: null, escalated: 0, version: 1 });
    const others = JSON.stringify(db.prepare("SELECT * FROM equipment_events WHERE id <> 'eq-hyd-0920' ORDER BY id").all());
    expect(() => handlers.get("escalate_equipment_fault")!({ eventId: "eq-hyd-0920", expectedVersion: 7 })).toThrow(/stale/);
    expect(row()).toEqual({ escalated_to: null, escalated: 0, version: 1 });
    const done = call("escalate_equipment_fault", { eventId: "eq-hyd-0920", expectedVersion: 1 }).result;
    expect(done.before).toMatchObject({ escalatedTo: null, version: 1 });
    expect(done.after).toMatchObject({ escalatedTo: "emp-eng-hyd", version: 2 });
    expect(row()).toEqual({ escalated_to: "emp-eng-hyd", escalated: 1, version: 2 });
    expect(JSON.stringify(db.prepare("SELECT * FROM equipment_events WHERE id <> 'eq-hyd-0920' ORDER BY id").all())).toBe(others);
    expect(() => handlers.get("escalate_equipment_fault")!({ eventId: "eq-hyd-0920", expectedVersion: 2 })).toThrow(/already escalated/);
    expect(() => handlers.get("escalate_equipment_fault")!({ eventId: "eq-blr-0917", expectedVersion: 1 })).toThrow(/already cleared/);
    const reread = (call("list_equipment_events", { hubId: "hub-hyd", openOnly: true }).result.rows as Array<Record<string, unknown>>)[0]!;
    expect(reread).toMatchObject({ escalatedTo: "emp-eng-hyd", escalatedToName: "Venkatesh Rao", version: 2 });
    db.close();
  });

  it("queues a shipper notice for the account manager, once per key, and sends nothing (P4)", () => {
    const { db, call } = harness();
    const count = () => (db.prepare("SELECT COUNT(*) n FROM shipper_notifications").get() as { n: number }).n;
    expect(count()).toBe(0);
    const args = { shipperId: "shipper-003", topic: "at-risk-today", message: "Parcels promised today may be late.", idempotencyKey: "notify:shipper-003:at-risk-today:2026-09-21", requestedBy: "user-coo" };
    const first = call("notify_shipper", args).result;
    expect(first.created).toBe(true);
    expect(first.after).toMatchObject({ shipperId: "shipper-003", accountManagerId: "emp-am-1", status: "queued" });
    const again = call("notify_shipper", args).result;
    expect(again.created).toBe(false);
    expect(again.after.id).toBe(first.after.id);
    expect(count()).toBe(1);
    const shipper = call("get_shipper", { shipperId: "shipper-003" }).result;
    expect(shipper.queuedNotifications).toEqual([expect.objectContaining({ id: first.after.id, status: "queued", accountManagerId: "emp-am-1" })]);
    db.close();
  });

  it("finds the 11 open late complaints about parcels at risk today (P4)", () => {
    const { db, call } = harness();
    const result = call("list_complaints", { status: "open", category: "late", unassignedOnly: true, atRiskOnly: true, page: { limit: 100, offset: 0 } }).result;
    expect(result.total).toBe(11);
    expect(result.rows.every((row: { assigneeId: string | null; category: string }) => row.assigneeId === null && row.category === "late")).toBe(true);
    db.close();
  });

  it("refuses every write on a read-only connection before touching the database (P4)", () => {
    const { db, handlers } = harness("hub-fault", undefined, false);
    const before = JSON.stringify([db.prepare("SELECT * FROM equipment_events ORDER BY id").all(), db.prepare("SELECT COUNT(*) n, SUM(version) v FROM complaints").get(), db.prepare("SELECT COUNT(*) n FROM shipper_notifications").get()]);
    expect(() => handlers.get("escalate_equipment_fault")!({ eventId: "eq-hyd-0920", expectedVersion: 1 })).toThrow(/read-only/);
    expect(() => handlers.get("notify_shipper")!({ shipperId: "shipper-003", topic: "t", message: "m", idempotencyKey: "key-12345", requestedBy: "user-coo" })).toThrow(/read-only/);
    const open = db.prepare("SELECT id, version FROM complaints WHERE status = 'open' AND assignee_id IS NULL LIMIT 1").get() as { id: string; version: number };
    expect(() => handlers.get("commit_complaint_assignment")!({ complaintId: open.id, assigneeId: "emp-care-1", expectedVersion: open.version })).toThrow(/read-only/);
    expect(JSON.stringify([db.prepare("SELECT * FROM equipment_events ORDER BY id").all(), db.prepare("SELECT COUNT(*) n, SUM(version) v FROM complaints").get(), db.prepare("SELECT COUNT(*) n FROM shipper_notifications").get()])).toBe(before);
    db.close();
  });
});
