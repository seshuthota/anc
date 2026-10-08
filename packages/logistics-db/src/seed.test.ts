import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { openLogisticsDatabase } from "./index.js";
import { EXPOSED_SHIPPER, FAULTED_HUB, seedLogistics, type LogisticsScenario } from "./seed.js";

function openSeeded(scenario: LogisticsScenario) {
  const db = openLogisticsDatabase(join(mkdtempSync(join(tmpdir(), "anc-logistics-")), `${scenario}.sqlite`));
  seedLogistics(db, scenario);
  return db;
}
const count = (db: ReturnType<typeof openSeeded>, sql: string, ...params: unknown[]) => (db.prepare(sql).get(...params) as { n: number }).n;

describe("logistics seed", () => {
  it("produces identical rows on every seed", () => {
    const dump = (db: ReturnType<typeof openSeeded>) => JSON.stringify({
      shipments: db.prepare("SELECT status, COUNT(*) n, MIN(id) a, MAX(sorted_at) b FROM shipments GROUP BY status ORDER BY status").all(),
      runs: db.prepare("SELECT * FROM route_runs ORDER BY id").all(),
      complaints: db.prepare("SELECT * FROM complaints ORDER BY id").all(),
    });
    const a = openSeeded("hub-fault");
    const b = openSeeded("hub-fault");
    expect(dump(a)).toBe(dump(b));
    a.close();
    b.close();
  });

  it("stores every timestamp as IST text so text comparison is time comparison", () => {
    const db = openSeeded("hub-fault");
    expect(count(db, "SELECT COUNT(*) n FROM shipments WHERE created_at NOT LIKE '%+05:30' OR promised_by NOT LIKE '%+05:30'")).toBe(0);
    expect(count(db, "SELECT COUNT(*) n FROM hub_hourly WHERE hour NOT LIKE '%:00:00.000+05:30'")).toBe(0);
    db.close();
  });

  it("confines the sort backlog and the held runs to the faulted hub", () => {
    const db = openSeeded("hub-fault");
    const stuck = db.prepare("SELECT hub_id hub, COUNT(*) n FROM shipments WHERE status = 'at_hub' GROUP BY hub_id").all() as Array<{ hub: string; n: number }>;
    expect(stuck).toHaveLength(1);
    expect(stuck[0]!.hub).toBe(FAULTED_HUB);
    expect(stuck[0]!.n).toBeGreaterThan(300);
    const held = db.prepare("SELECT DISTINCT hub_id hub FROM route_runs WHERE status = 'held'").all() as Array<{ hub: string }>;
    expect(held).toEqual([{ hub: FAULTED_HUB }]);
    expect(count(db, "SELECT COUNT(*) n FROM route_runs WHERE status = 'held'")).toBe(3);
    expect(count(db, "SELECT COUNT(*) n FROM equipment_events WHERE ended_at IS NULL AND hub_id = ?", FAULTED_HUB)).toBe(1);
    // The hourly sort-floor log must agree with the parcels themselves.
    const last = db.prepare("SELECT backlog FROM hub_hourly WHERE hub_id = ? ORDER BY hour DESC LIMIT 1").get(FAULTED_HUB) as { backlog: number };
    expect(last.backlog).toBe(stuck[0]!.n);
    db.close();
  });

  it("concentrates the stuck parcels on one key account without stating why", () => {
    const db = openSeeded("hub-fault");
    const top = db.prepare("SELECT shipper_id id, COUNT(*) n FROM shipments WHERE status = 'at_hub' GROUP BY shipper_id ORDER BY n DESC LIMIT 2").all() as Array<{ id: string; n: number }>;
    expect(top[0]!.id).toBe(EXPOSED_SHIPPER);
    expect(top[0]!.n).toBeGreaterThan(top[1]!.n * 2);
    // No record links the equipment fault to shippers, runs or complaints.
    const columns = db.prepare("SELECT name FROM pragma_table_info('equipment_events')").all() as Array<{ name: string }>;
    expect(columns.map((column) => column.name)).not.toContain("shipper_id");
    db.close();
  });

  it("fills two lockers in another city, independently of the fault", () => {
    const db = openSeeded("hub-fault");
    const full = db.prepare(`SELECT l.id, l.compartments, COUNT(s.id) occupied, d.hub_id hub FROM locker_sites l JOIN districts d ON d.id = l.district_id
      LEFT JOIN shipments s ON s.locker_site_id = l.id AND s.status = 'in_locker' GROUP BY l.id HAVING occupied >= l.compartments * 0.9`).all() as Array<{ id: string; compartments: number; occupied: number; hub: string }>;
    expect(full.map((site) => site.id).sort()).toEqual(["lock-tnagar", "lock-velachery"]);
    for (const site of full) {
      expect(site.occupied).toBeLessThanOrEqual(site.compartments);
      expect(site.hub).not.toBe(FAULTED_HUB);
    }
    expect(count(db, "SELECT COUNT(*) n FROM shipments WHERE status = 'exception'")).toBeGreaterThan(0);
    db.close();
  });

  it("has nothing wrong on a quiet day", () => {
    const db = openSeeded("quiet-day");
    expect(count(db, "SELECT COUNT(*) n FROM shipments WHERE status IN ('at_hub', 'exception')")).toBe(0);
    expect(count(db, "SELECT COUNT(*) n FROM route_runs WHERE status = 'held'")).toBe(0);
    expect(count(db, "SELECT COUNT(*) n FROM equipment_events WHERE ended_at IS NULL")).toBe(0);
    expect(count(db, "SELECT COUNT(*) n FROM complaints WHERE status = 'open' AND category = 'late'")).toBe(0);
    db.close();
  });

  it("migrates a database seeded before schema v2 without changing its rows (P4)", async () => {
    const Database = (await import("better-sqlite3")).default;
    const { ensureLogisticsSchema, logisticsSchemaOutdated } = await import("./index.js");
    const path = join(mkdtempSync(join(tmpdir(), "anc-logistics-")), "old.sqlite");
    const old = new Database(path);
    old.exec("CREATE TABLE hubs (id TEXT PRIMARY KEY, name TEXT NOT NULL, city TEXT NOT NULL, sort_capacity_per_hour INTEGER NOT NULL); CREATE TABLE employees (id TEXT PRIMARY KEY, name TEXT NOT NULL, team TEXT NOT NULL, title TEXT NOT NULL); CREATE TABLE equipment_events (id TEXT PRIMARY KEY, hub_id TEXT NOT NULL, equipment TEXT NOT NULL, started_at TEXT NOT NULL, ended_at TEXT, severity TEXT NOT NULL, summary TEXT NOT NULL);");
    old.prepare("INSERT INTO equipment_events VALUES ('eq-1','hub-hyd','Belt','2026-09-20T22:10:00.000+05:30',NULL,'high','down')").run();
    expect(logisticsSchemaOutdated(old)).toBe(true);
    old.close();
    ensureLogisticsSchema(path);
    const db = new Database(path, { readonly: true });
    expect(logisticsSchemaOutdated(db)).toBe(false);
    expect(db.prepare("SELECT id, escalated_to, escalated_at, version FROM equipment_events").all()).toEqual([{ id: "eq-1", escalated_to: null, escalated_at: null, version: 1 }]);
    db.close();
  });

  it("seeds the on-call engineer and an empty notification queue (P4)", () => {
    const db = openSeeded("hub-fault");
    expect(db.prepare("SELECT engineer_id e FROM hub_on_call WHERE hub_id = ?").get(FAULTED_HUB)).toEqual({ e: "emp-eng-hyd" });
    expect(count(db, "SELECT COUNT(*) n FROM shipper_notifications")).toBe(0);
    expect(count(db, "SELECT COUNT(*) n FROM equipment_events WHERE escalated_at IS NOT NULL")).toBe(0);
    db.close();
  });
});
