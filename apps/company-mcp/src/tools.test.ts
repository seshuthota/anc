import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { openCompanyDatabase } from "@anc/database";
import { seedDatabase } from "@anc/database";
import { registerCompanyTools } from "./tools.js";

const CURRENT = { from: "2026-09-19T09:00:00.000Z", to: "2026-09-20T08:00:00.000Z" };

function harness() {
  const path = join(mkdtempSync(join(tmpdir(), "anc-mcp-")), "company.sqlite");
  const db = openCompanyDatabase(path);
  seedDatabase(db, "sync-regression");
  const handlers = new Map<string, (args: unknown) => unknown>();
  registerCompanyTools({ registerTool(name: string, _meta: unknown, handler: (args: unknown) => unknown) { handlers.set(name, handler); } }, db);
  return { db, handlers };
}

describe("company MCP tools", () => {
  it("returns evidence envelopes and rejects unknown ids", async () => {
    const { db, handlers } = harness();
    const health = await handlers.get("get_service_health")!({ service: "sync-service", window: CURRENT }) as { structuredContent: { evidenceId: string; result: { rows: unknown[] } } };
    expect(health.structuredContent.evidenceId).toMatch(/^get_service_health-/);
    expect(health.structuredContent.result.rows.length).toBeGreaterThan(0);
    const impacted = await handlers.get("list_impacted_customers")!({ service: "sync-service", window: CURRENT, cohort: "sync-v2", minErrorRate: 0.05 }) as { structuredContent: { result: { customerIds: string[] } } };
    expect(impacted.structuredContent.result.customerIds).toHaveLength(14);
    const page = await handlers.get("search_customers")!({ page: { limit: 10, offset: 0 } }) as { structuredContent: { completeness: { total: number } } };
    expect(page.structuredContent.completeness.total).toBe(100);
    expect(() => handlers.get("get_customer")!({ customerId: "customer-999" })).toThrow(/Unknown customer/);
    expect(() => handlers.get("get_release_details")!({ releaseId: "missing" })).toThrow(/Unknown release/);
    db.close();
  });

  it("lists overdue invoices and blocks unauthorized tools", async () => {
    const { db, handlers } = harness();
    const aging = await handlers.get("list_invoice_aging")!({}) as { structuredContent: { result: { rows: unknown[]; totals: { count: number } } } };
    expect(aging.structuredContent.result.totals.count).toBeGreaterThan(0);
    const previous = process.env.ANC_PRINCIPAL_ID;
    process.env.ANC_PRINCIPAL_ID = "user-ops";
    expect(() => handlers.get("list_invoice_aging")!({})).toThrow(/Not authorized/);
    process.env.ANC_PRINCIPAL_ID = "user-support";
    const queue = await handlers.get("list_unassigned_escalations")!({ page: { limit: 10, offset: 0 } }) as { structuredContent: { result: { rows: unknown[] } } };
    expect(queue.structuredContent.result.rows.length).toBeGreaterThan(0);
    if (previous === undefined) delete process.env.ANC_PRINCIPAL_ID;
    else process.env.ANC_PRINCIPAL_ID = previous;
    db.close();
  });

  it("does not mutate company rows", async () => {
    const { db, handlers } = harness();
    const before = db.prepare("SELECT COUNT(*) n FROM service_metrics").get() as { n: number };
    await handlers.get("get_error_metrics")!({ service: "sync-service", window: CURRENT, cohort: "sync-v2" });
    const after = db.prepare("SELECT COUNT(*) n FROM service_metrics").get() as { n: number };
    expect(after.n).toBe(before.n);
    db.close();
  });
});
