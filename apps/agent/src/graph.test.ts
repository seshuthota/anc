import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { DEFAULT_COMPANY_DB_PATH } from "@anc/database";
import { seedScenario } from "@anc/database";
import { DEFAULT_THREAD_ID } from "./windows.js";

const dir = mkdtempSync(join(tmpdir(), "anc-agent-"));
process.env.RUNTIME_DB_PATH = join(dir, "runtime.sqlite");
process.env.COMPANY_DB_PATH = DEFAULT_COMPANY_DB_PATH;
const regressionDb = DEFAULT_COMPANY_DB_PATH;
process.env.MODEL_PROVIDER = "fixture";

seedScenario(process.env.COMPANY_DB_PATH, "sync-regression");

const { cancelRun, handleAction, publicState, restoreSurface, runInvestigation, store } = await import("./runtime.js");
import { TOOL_ALLOWLISTS } from "./mcp-client.js";
import { CompanyMcpClient } from "./mcp-client.js";

afterAll(() => {
  store.close();
});

describe("morning investigation", () => {
  it("runs concurrent specialists, persists evidence, and composes an A2UI surface", async () => {
    const state = await runInvestigation({ question: "What deserves attention at the start of the day?", threadId: DEFAULT_THREAD_ID });
    expect(["completed", "partial"]).toContain(state.status);
    expect(Array.isArray(state.surface?.messages) && state.surface.messages.length > 1).toBe(true);
    expect(state.activity.some((item) => item.message.includes("Reliability"))).toBe(true);
    expect(state.activity.some((item) => item.message.includes("Product"))).toBe(true);
    const evidenceMention = JSON.stringify(state.surface?.dataModel).toLowerCase();
    expect(evidenceMention.includes("error") || evidenceMention.includes("arr") || evidenceMention.includes("usage") || evidenceMention.includes("ticket")).toBe(true);
    expect(state.activity.some((item) => item.message.includes("failed") && item.message.includes("Reliability"))).toBe(false);
  }, 60_000);

  it("restores an accepted surface without a new model call", () => {
    const history = store.listSurfaces(DEFAULT_THREAD_ID);
    expect(history.length).toBeGreaterThan(0);
    const first = history[history.length - 1]!;
    const restored = restoreSurface(DEFAULT_THREAD_ID, first.surfaceId, first.revision);
    expect(restored.surface?.surfaceId).toBe(first.surfaceId);
    expect(publicState(DEFAULT_THREAD_ID).surface?.revision).toBe(first.revision);
  });

  it("deduplicates action ids", () => {
    expect(store.rememberAction("action-dup", DEFAULT_THREAD_ID, new Date().toISOString())).toBe(true);
    expect(store.rememberAction("action-dup", DEFAULT_THREAD_ID, new Date().toISOString())).toBe(false);
  });

  it("keeps operational findings when finance fails", async () => {
    process.env.FORCE_FINANCE_FAILURE = "1";
    const state = await runInvestigation({ question: "What should I care about this morning?", threadId: "finance-timeout" });
    delete process.env.FORCE_FINANCE_FAILURE;
    expect(state.status).toBe("partial");
    expect(JSON.stringify(state.surface?.dataModel)).toMatch(/unavailable|Financial information/i);
    expect(JSON.stringify(state.surface?.dataModel).toLowerCase()).toMatch(/error|ticket|usage/);
  }, 60_000);

  it("keeps the last surface when composer output is invalid", async () => {
    const ok = await runInvestigation({ question: "What should I care about this morning?", threadId: "composer-repair" });
    const revision = ok.surface?.revision;
    process.env.FORCE_INVALID_A2UI = "1";
    const next = await runInvestigation({ question: "Why is this happening?", threadId: "composer-repair" });
    delete process.env.FORCE_INVALID_A2UI;
    expect(next.surface?.revision).toBe(revision);
    expect(next.activity.some((item) => item.message.includes("keeping last accepted surface"))).toBe(true);
  }, 60_000);

  it("does not invent a major incident on a quiet-day dataset", async () => {
    delete process.env.FORCE_FINANCE_FAILURE;
    delete process.env.FORCE_INVALID_A2UI;
    const quietPath = join(dir, "quiet.sqlite");
    seedScenario(quietPath, "quiet-day");
    const previous = process.env.COMPANY_DB_PATH;
    process.env.COMPANY_DB_PATH = quietPath;
    try {
      const state = await runInvestigation({ question: "Anything on fire this morning?", threadId: `quiet-${Date.now()}` });
      const subtitle = String((state.surface?.dataModel as { subtitle?: string } | null)?.subtitle ?? "").toLowerCase();
      expect(subtitle).toMatch(/no major|quiet|no .*anomaly/);
    } finally {
      process.env.COMPANY_DB_PATH = previous;
    }
  }, 60_000);

  it("follows unrelated-anomaly evidence instead of always blaming sync-v2", async () => {
    const path = join(dir, "unrelated.sqlite");
    seedScenario(path, "unrelated-anomaly");
    const previous = process.env.COMPANY_DB_PATH;
    process.env.COMPANY_DB_PATH = path;
    try {
      const state = await runInvestigation({ question: "What should I care about this morning?", threadId: "unrelated" });
      const blob = JSON.stringify(state.surface?.dataModel).toLowerCase();
      expect(blob).toMatch(/error|release/);
      expect(blob.includes("sync-v2 error rate is elevated") && !blob.includes("billing") && !blob.includes("sync-v1")).toBe(false);
    } finally {
      process.env.COMPANY_DB_PATH = previous;
    }
  }, 60_000);

  it("routes a narrow finance question without launching every specialist", async () => {
    const state = await runInvestigation({ question: "What is the represented ARR for the known subscriptions?", threadId: "narrow-finance" });
    const started = state.activity.filter((item) => item.message.includes("started"));
    expect(started.some((item) => item.message.includes("Finance"))).toBe(true);
    expect(started.some((item) => item.message.includes("Reliability"))).toBe(false);
  }, 60_000);

  it("keeps context for an unknown customer", async () => {
    const prior = await runInvestigation({ question: "What should I care about this morning?", threadId: "unknown-customer" });
    const next = await runInvestigation({
      question: "Inspect account customer-999",
      threadId: "unknown-customer",
      action: {
        actionId: "act-unknown",
        name: "inspect_account",
        threadId: "unknown-customer",
        investigationId: prior.investigationId ?? "inv",
        surfaceId: prior.surface?.surfaceId ?? "s",
        surfaceRevision: prior.surface?.revision ?? 1,
        entities: [{ type: "customer", id: "customer-999" }],
        parameters: {},
      },
      entities: [{ type: "customer", id: "customer-999" }],
    });
    expect(next.surface).toBeTruthy();
    expect(["completed", "partial", "failed"]).toContain(next.status);
  }, 60_000);

  it("rejects stale actions and ignores duplicate action ids", async () => {
    const state = await runInvestigation({ question: "What should I care about this morning?", threadId: "stale-action" });
    await expect(handleAction({
      actionId: "stale-1",
      name: "show_affected_accounts",
      threadId: "stale-action",
      investigationId: state.investigationId,
      surfaceId: state.surface?.surfaceId,
      surfaceRevision: (state.surface?.revision ?? 1) + 99,
      entities: [],
    })).rejects.toThrow(/stale/);
    const first = await handleAction({
      actionId: "dup-1",
      name: "show_evidence",
      threadId: "stale-action",
      investigationId: state.investigationId,
      surfaceId: state.surface?.surfaceId,
      surfaceRevision: state.surface?.revision,
      parameters: { evidenceId: "missing" },
    });
    const second = await handleAction({
      actionId: "dup-1",
      name: "show_affected_accounts",
      threadId: "stale-action",
      investigationId: state.investigationId,
      surfaceId: state.surface?.surfaceId,
      surfaceRevision: state.surface?.revision,
    });
    expect(second.surface?.revision).toBe(first.surface?.revision);
  }, 60_000);

  it("records overlap, timings, and blocks injected tool names", async () => {
    const state = await runInvestigation({ question: "What should I care about this morning?", threadId: "timing" });
    expect(state.timing?.completedMs).toBeGreaterThan(0);
    expect(state.timing?.firstActivityMs).not.toBeNull();
    const starts = state.activity.filter((item) => item.message.includes("started")).map((item) => item.timestamp);
    expect(starts.length).toBeGreaterThanOrEqual(2);
    expect(TOOL_ALLOWLISTS.customer.includes("execute_sql")).toBe(false);
    const client = new CompanyMcpClient(store, { runId: state.runId ?? "run" });
    await client.connect();
    await expect(client.call("execute_sql", { sql: "select 1" }, "customer")).rejects.toThrow(/allowlist/);
    await client.close();
  }, 60_000);

  it("exposes fixture execution mode on public state", async () => {
    const state = await runInvestigation({ question: "What should I care about this morning?", threadId: "execution-mode" });
    expect(state.execution.executionMode).toBe("fixture");
    expect(state.execution.substitutions).toEqual([]);
  }, 60_000);

  it("cancels an in-flight run before a surface is accepted", async () => {
    process.env.INVESTIGATION_STEP_DELAY_MS = "2000";
    try {
      const runId = `run-cancel-${Date.now()}`;
      const pending = runInvestigation({ question: "What should I care about this morning?", threadId: "cancel-run", runId });
      await new Promise((resolve) => setTimeout(resolve, 80));
      cancelRun(runId, "cancel-run");
      const state = await pending;
      expect(state.status).toBe("cancelled");
    } finally {
      delete process.env.INVESTIGATION_STEP_DELAY_MS;
    }
  }, 60_000);

  it("ignores a superseded run when a newer question is asked", async () => {
    process.env.INVESTIGATION_STEP_DELAY_MS = "700";
    try {
      const threadId = `late-${Date.now()}`;
      const first = runInvestigation({ question: "What should I care about this morning?", threadId, runId: `run-old-${Date.now()}` });
      await new Promise((resolve) => setTimeout(resolve, 50));
      const second = await runInvestigation({ question: "What should I care about this morning?", threadId, runId: `run-new-${Date.now()}` });
      await first;
      expect(publicState(threadId).runId).toBe(second.runId);
    } finally {
      delete process.env.INVESTIGATION_STEP_DELAY_MS;
    }
  }, 60_000);

  it("isolates two personas and denies finance data to operations", async () => {
    const { resolvePrincipal } = await import("@anc/policy");
    const ops = await runInvestigation({ question: "What needs my attention?", threadId: "session:user-ops", principal: resolvePrincipal("user-ops") });
    const finance = await runInvestigation({ question: "Compare overdue invoices by customer", threadId: "session:user-finance", principal: resolvePrincipal("user-finance") });
    expect(ops.threadId).not.toBe(finance.threadId);
    expect(["completed", "partial"]).toContain(ops.status);
    expect(JSON.stringify(ops.surface?.dataModel ?? {})).not.toMatch(/overdue invoices by customer/i);
    expect(JSON.stringify(finance.surface?.dataModel ?? {}).toLowerCase()).toMatch(/invoice|overdue|aging/);
    expect(publicState("session:user-ops", "user-finance").surface).toBeNull();
  }, 60_000);
});
