import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { openCompanyDatabase } from "./index.js";
import { seedDatabase } from "./seed.js";

const CURRENT = { from: "2026-09-19T09:00:00.000Z", to: "2026-09-20T08:00:00.000Z" };
const BASELINE = { from: "2026-09-18T09:00:00.000Z", to: "2026-09-19T09:00:00.000Z" };

function openSeeded(scenario: "sync-regression" | "quiet-day" | "unrelated-anomaly") {
  const path = join(mkdtempSync(join(tmpdir(), "anc-db-")), `${scenario}.sqlite`);
  const db = openCompanyDatabase(path);
  seedDatabase(db, scenario);
  return db;
}

describe("deterministic seed", () => {
  it("repeats identical business rows", () => {
    const a = openSeeded("sync-regression");
    const b = openSeeded("sync-regression");
    const dump = (db: ReturnType<typeof openSeeded>) => JSON.stringify({
      customers: db.prepare("SELECT * FROM customers ORDER BY id").all(),
      subs: db.prepare("SELECT * FROM subscriptions ORDER BY id").all(),
      metrics: db.prepare("SELECT COUNT(*) n, SUM(errors) e, SUM(requests) r FROM service_metrics").get(),
    });
    expect(dump(a)).toBe(dump(b));
    a.close();
    b.close();
  });

  it("computes impacted cohort, weighted error rate, usage comparison, and ARR from raw rows", () => {
    const db = openSeeded("sync-regression");
    const impacted = db.prepare("SELECT customer_id FROM customer_config_history WHERE config_key = 'sync_engine' AND config_value = 'v2' ORDER BY customer_id").all() as Array<{ customer_id: string }>;
    expect(impacted.map((row) => row.customer_id)).toEqual(Array.from({ length: 14 }, (_, i) => `customer-${String(i + 1).padStart(3, "0")}`));
    const rate = db.prepare(`SELECT SUM(errors) errors, SUM(requests) requests FROM service_metrics WHERE cohort = 'sync-v2' AND bucket >= ? AND bucket < ?`).get(CURRENT.from, CURRENT.to) as { errors: number; requests: number };
    expect(rate.requests).toBeGreaterThan(0);
    expect(rate.errors / rate.requests).toBeGreaterThan(0.05);
    const arr = db.prepare(`SELECT SUM(arr_minor_units) arr FROM subscriptions WHERE customer_id IN (${impacted.map(() => "?").join(",")})`).get(...impacted.map((row) => row.customer_id)) as { arr: number };
    expect(arr.arr).toBe(14 * 15_000_000);
    const usage = db.prepare(`SELECT SUM(usage_count) n FROM feature_usage WHERE feature = 'synchronization' AND customer_id IN (${impacted.map(() => "?").join(",")}) AND bucket >= ? AND bucket < ?`);
    const current = usage.get(...impacted.map((row) => row.customer_id), CURRENT.from, CURRENT.to) as { n: number };
    const baseline = usage.get(...impacted.map((row) => row.customer_id), BASELINE.from, BASELINE.to) as { n: number };
    expect(current.n).toBeLessThan(baseline.n);
    const explanation = db.prepare("SELECT sql FROM sqlite_master").all() as Array<{ sql: string }>;
    expect(explanation.some((row) => /root cause|sync-worker regression caused/i.test(row.sql ?? ""))).toBe(false);
    db.close();
  });

  it("quiet-day does not create the sync-v2 error spike", () => {
    const db = openSeeded("quiet-day");
    const rate = db.prepare(`SELECT SUM(errors)*1.0/SUM(requests) rate FROM service_metrics WHERE cohort = 'sync-v2' AND bucket >= ? AND bucket < ?`).get(CURRENT.from, CURRENT.to) as { rate: number };
    expect(rate.rate).toBeLessThan(0.05);
    db.close();
  });
});
