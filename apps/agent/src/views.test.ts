import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { DEFAULT_COMPANY_DB_PATH, seedScenario } from "@anc/database";
import { resolvePrincipal } from "@anc/policy";

const here = dirname(fileURLToPath(import.meta.url));
const dir = mkdtempSync(join(tmpdir(), "anc-views-"));
process.env.RUNTIME_DB_PATH = join(dir, "runtime.sqlite");
process.env.COMPANY_DB_PATH = DEFAULT_COMPANY_DB_PATH;
process.env.MODEL_PROVIDER = "fixture";
process.env.MODEL_EXECUTION_MODE = "fixture";
process.env.VITEST = "true";
seedScenario(process.env.COMPANY_DB_PATH, "sync-regression");

const { runInvestigation, handleAction, store } = await import("./runtime.js");

type DataModel = {
  view?: string;
  chart?: { title?: string; unit?: string; points?: Array<{ label: string; value: number }> };
  table?: { columns?: string[]; rows?: Array<{ cells: string[]; entityId?: string; actionName?: string; sortValues?: number[] }>; totals?: string[] };
  draft?: { title?: string; steps?: Array<{ id: string; text: string }>; assumptions?: string[]; status?: string };
  selection?: { selected?: string[]; options?: Record<string, unknown> };
  limitations?: string;
  receipt?: string;
};

function modelOf(state: { surface?: { dataModel?: unknown } | null }): DataModel {
  return (state.surface?.dataModel ?? {}) as DataModel;
}

describe("generated views reach the workspace", () => {
  it("composes a trend chart from authorized telemetry", async () => {
    const state = await runInvestigation({
      question: "Show me the error rate trend over the past week",
      threadId: "session:user-ops-trend",
      principal: resolvePrincipal("user-ops"),
    });
    const model = modelOf(state);
    expect(model.view).toBe("trend");
    expect(model.chart?.points?.length).toBeGreaterThanOrEqual(2);
    const values = model.chart!.points!.map((point) => point.value);
    expect(Math.max(...values)).toBeGreaterThan(0);
  }, 60_000);

  it("composes a sortable comparison with deterministic totals and customer entity ids", async () => {
    const state = await runInvestigation({
      question: "Compare overdue invoices by customer",
      threadId: "session:user-finance-compare",
      principal: resolvePrincipal("user-finance"),
    });
    const model = modelOf(state);
    expect(model.view).toBe("comparison");
    const rows = model.table!.rows!;
    expect(rows.length).toBeGreaterThan(1);
    // A row whose entity type is `customer` must carry a customer id, not the
    // invoice id, or every row action and selection targets the wrong record.
    for (const row of rows) {
      expect(row.entityId).toMatch(/^customer-/);
      expect(row.actionName).toBe("inspect_account");
    }
    expect(rows.some((row) => row.cells.some((cell) => cell.includes("$")))).toBe(true);
    expect(model.table!.totals?.some((cell) => cell.includes("$"))).toBe(true);
  }, 60_000);

  it("offers a selection that carries a customer id into the follow-up", async () => {
    await runInvestigation({
      question: "Compare overdue invoices by customer",
      threadId: "session:user-finance-select",
      principal: resolvePrincipal("user-finance"),
    });
    const before = modelOf(await handleAction({
      name: "show_evidence",
      threadId: "session:user-finance-select",
    }, resolvePrincipal("user-finance")));
    expect(before).toBeTruthy();
    const options = Object.keys(modelOf({ surface: { dataModel: (store.getSurface(
      (store.listSurfaces("session:user-finance-select")[0]?.surfaceId ?? ""),
      store.listSurfaces("session:user-finance-select")[0]?.revision ?? 1,
    )?.dataModel ?? {}) as DataModel } }).selection?.options ?? {});
    expect(options.length).toBeGreaterThan(1);
    expect(options.every((id) => id.startsWith("customer-"))).toBe(true);
  }, 60_000);

  it("presents a draft as a proposal with explicit assumptions and no findings", async () => {
    const state = await runInvestigation({
      question: "Draft an onboarding checklist for customer-001",
      threadId: "session:user-coo-draft",
      principal: resolvePrincipal("user-coo"),
    });
    const model = modelOf(state);
    expect(model.draft?.steps?.length).toBeGreaterThan(0);
    expect(model.draft?.status).toBe("proposed");
    expect(model.draft?.assumptions?.length).toBeGreaterThan(0);
    // A draft must never read as an observed fact or a completed operation.
    expect(model.limitations).toMatch(/model-authored/i);
    expect(model.draft?.status).toBe("proposed");
    expect(model.receipt ?? "").toBe("");
  }, 60_000);

  it("asks which account rather than reporting a permission failure", async () => {
    const state = await runInvestigation({
      question: "Draft an onboarding checklist for these accounts",
      threadId: "session:user-coo-clarify",
      principal: resolvePrincipal("user-coo"),
    });
    const blob = JSON.stringify(state.surface?.dataModel ?? {});
    expect(blob).toMatch(/which account/i);
    expect(blob).not.toMatch(/not authorized/i);
  }, 60_000);

  it("composes a queue for unassigned escalations", async () => {
    const state = await runInvestigation({
      question: "Show unassigned escalations",
      threadId: "session:user-support-queue",
      principal: resolvePrincipal("user-support"),
    });
    const model = modelOf(state);
    expect(model.view).toBe("queue");
    expect(model.table?.rows?.length).toBeGreaterThan(0);
  }, 60_000);
});
