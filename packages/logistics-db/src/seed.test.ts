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
});
