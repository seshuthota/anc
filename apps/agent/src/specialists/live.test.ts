import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import type { InvestigationTask } from "@anc/contracts";
import { openRuntimeDatabase, RuntimeStore } from "@anc/runtime-storage";
import { validateFinding } from "../validation.js";
import { CURRENT } from "../windows.js";
import {
  coerceStatus,
  normalizeFinding,
  parseResult,
  repairChatParams,
  shouldRepairFindings,
} from "./live.js";

const task: InvestigationTask = {
  taskId: "task-reliability",
  domain: "reliability",
  question: "What reliability signals should be investigated?",
  entityScope: [],
  window: { start: CURRENT.from, end: CURRENT.to, timezone: "UTC", grain: "hour" },
  dependencies: [],
  status: "pending",
  attemptCount: 0,
  capabilities: ["cap.service.health"],
};

const now = "2026-09-20T08:00:00.000Z";

const sampleFinding = {
  findingId: "finding-task-reliability-errors",
  taskId: "task-reliability",
  agentId: "reliability",
  kind: "observation" as const,
  title: "Elevated error rate",
  summary: "sync-service error rate rose in the current window.",
  severity: "high" as const,
  entities: [{ type: "service" as const, id: "sync-service" }],
  claims: [
    {
      claimId: "claim-1",
      statement: "Error rate is elevated for sync-service",
      evidenceIds: ["ev-errors-1"],
      resultPaths: [],
      entities: [],
      metrics: [{ name: "error_rate", value: 0.12, unit: "rate", aggregation: "rate" as const }],
      limitations: [],
      contradictoryEvidenceIds: [],
    },
  ],
  createdAt: "2026-09-20T08:00:00.000Z",
  limitations: [],
};

const validResult = {
  status: "completed" as const,
  summary: "Reliability signals reviewed.",
  findings: [sampleFinding],
  unresolvedQuestions: [],
  suggestedFollowUps: [],
};

const dir = mkdtempSync(join(tmpdir(), "anc-live-coerce-"));
const store = new RuntimeStore(openRuntimeDatabase(join(dir, "runtime.sqlite")));
afterAll(() => store.close());

describe("live specialist parseResult unwrap", () => {
  it("recovers findings from mangled final{ string wrappers", () => {
    const wrapped = JSON.stringify({
      "final{": JSON.stringify(validResult),
    });
    const parsed = parseResult(wrapped, task, now);
    expect(parsed.findings).toHaveLength(1);
    expect(parsed.findings[0]?.findingId).toBe(sampleFinding.findingId);
    expect(parsed.status).toBe("completed");
    expect(parsed.findingIds).toEqual([sampleFinding.findingId]);
  });

  it("recovers findings from mangled final{ object wrappers", () => {
    const wrapped = JSON.stringify({
      "final{": validResult,
    });
    const parsed = parseResult(wrapped, task, now);
    expect(parsed.findings).toHaveLength(1);
    expect(parsed.findings[0]?.title).toBe(sampleFinding.title);
    expect(parsed.status).toBe("completed");
  });

  it("recovers findings from fenced JSON", () => {
    const fenced = `Here is the result:\n\`\`\`json\n${JSON.stringify(validResult, null, 2)}\n\`\`\`\n`;
    const parsed = parseResult(fenced, task, now);
    expect(parsed.findings).toHaveLength(1);
    expect(parsed.findings[0]?.findingId).toBe(sampleFinding.findingId);
    expect(parsed.summary).toBe(validResult.summary);
  });

  it("returns honest partial empty findings for unparseable content", () => {
    const parsed = parseResult("not json at all", task, now);
    expect(parsed.findings).toEqual([]);
    expect(parsed.status).toBe("partial");
    expect(parsed.draftFindingCount).toBe(0);
    expect(parsed.unresolvedQuestions[0]).toMatch(/not valid structured JSON/i);
  });
});

describe("live specialist coerce + normalize", () => {
  it("coerces loose status enums", () => {
    expect(coerceStatus("complete")).toBe("completed");
    expect(coerceStatus("success")).toBe("completed");
    expect(coerceStatus("NoActionRequired")).toBe("completed");
    expect(coerceStatus("incomplete")).toBe("partial");
    expect(coerceStatus("needs_attention")).toBe("partial");
    expect(coerceStatus("failed")).toBe("failed");
    expect(coerceStatus(123)).toBe("partial");
  });

  it("injects missing createdAt/taskId/agentId so findings still validate after coerce", () => {
    const parsed = parseResult(
      JSON.stringify({
        status: "complete",
        summary: "Signals reviewed",
        findings: [
          {
            findingId: "finding-missing-inject",
            kind: "observation",
            title: "Elevated error rate",
            summary: "Error rate rose for sync-service",
            severity: "high",
            claims: [
              {
                claimId: "claim-1",
                statement: "Error rate is elevated",
                evidenceIds: ["ev-real-1"],
              },
            ],
          },
        ],
      }),
      task,
      now,
    );
    expect(parsed.status).toBe("completed");
    expect(parsed.findings).toHaveLength(1);
    expect(parsed.findings[0]?.taskId).toBe(task.taskId);
    expect(parsed.findings[0]?.agentId).toBe(task.domain);
    expect(parsed.findings[0]?.createdAt).toBe(now);
    expect(parsed.draftFindingCount).toBe(1);
  });

  it("normalizes observation/detail/description + evidenceId into claim text", () => {
    const observation = normalizeFinding(
      { observation: "Attempt to fetch service health returned an error.", evidenceId: "ev-health-1" },
      task,
      0,
      now,
    );
    expect(observation?.kind).toBe("observation");
    expect(observation?.claims[0]?.statement).toMatch(/service health/i);
    expect(observation?.claims[0]?.evidenceIds).toEqual(["ev-health-1"]);
    expect(observation?.taskId).toBe(task.taskId);
    expect(observation?.agentId).toBe("reliability");
    expect(observation?.createdAt).toBe(now);

    const detail = normalizeFinding(
      {
        evidenceId: "search_support_tickets-abc",
        detail: "Open tickets: ticket-0117 for customer-060",
      },
      { ...task, taskId: "task-customer", domain: "customer" },
      1,
      now,
    );
    expect(detail?.summary).toMatch(/ticket-0117/);
    expect(detail?.claims[0]?.evidenceIds).toEqual(["search_support_tickets-abc"]);
    expect(detail?.agentId).toBe("customer");

    const description = normalizeFinding(
      {
        evidenceId: "list_invoice_aging-xyz",
        description: "Eight overdue invoices totalling $300,000 USD",
      },
      { ...task, taskId: "task-finance", domain: "finance" },
      0,
      now,
    );
    expect(description?.title).toMatch(/overdue invoices/i);
    expect(description?.claims[0]?.evidenceIds).toEqual(["list_invoice_aging-xyz"]);
  });

  it("normalizes description + evidence array alias into claims", () => {
    const finding = normalizeFinding(
      {
        description: "Eight overdue invoices totalling $300,000 USD",
        evidence: ["list_invoice_aging-abc"],
      },
      { ...task, taskId: "task-finance", domain: "finance" },
      0,
      now,
    );
    expect(finding?.claims[0]?.evidenceIds).toEqual(["list_invoice_aging-abc"]);
    expect(finding?.summary).toMatch(/overdue invoices/i);
  });

  it("normalizes observation + evidenceIds array and hypothesis kind", () => {
    const finding = normalizeFinding(
      {
        hypothesis: "Release may have caused the spike",
        evidenceIds: ["ev-a", "ev-b"],
      },
      task,
      2,
      now,
    );
    expect(finding?.kind).toBe("hypothesis");
    expect(finding?.claims[0]?.evidenceIds).toEqual(["ev-a", "ev-b"]);
  });

  it("drops individual bad findings while keeping valid siblings", () => {
    const parsed = parseResult(
      JSON.stringify({
        status: "partial",
        summary: "Mixed draft",
        findings: [
          { observation: "Valid observation", evidenceId: "ev-ok" },
          { observation: "No evidence at all" },
          { detail: "Another valid row", evidenceId: "ev-ok-2" },
        ],
      }),
      task,
      now,
    );
    expect(parsed.draftFindingCount).toBe(3);
    expect(parsed.findings).toHaveLength(2);
    expect(parsed.findings.map((f) => f.claims[0]?.evidenceIds[0])).toEqual(["ev-ok", "ev-ok-2"]);
  });

  it("still rejects invented evidence ids via validateFinding", () => {
    store.saveEvidence({
      evidenceId: "ev-known",
      runId: "run-coerce",
      taskId: task.taskId,
      tool: "get_error_metrics",
      payload: { ok: true },
      payloadHash: "hash-known",
      now,
    });
    const parsed = parseResult(
      JSON.stringify({
        status: "completed",
        summary: "Invented id",
        findings: [{ observation: "Elevated errors", evidenceId: "ev-invented-E1" }],
      }),
      task,
      now,
    );
    expect(parsed.findings).toHaveLength(1);
    expect(() =>
      validateFinding(store, {
        ...parsed.findings[0]!,
        taskId: task.taskId,
        agentId: task.domain,
      }),
    ).toThrow(/unknown evidence/i);

    const known = parseResult(
      JSON.stringify({
        status: "completed",
        summary: "Known id",
        findings: [{ observation: "Elevated errors", evidenceId: "ev-known" }],
      }),
      task,
      now,
    );
    expect(
      validateFinding(store, {
        ...known.findings[0]!,
        taskId: task.taskId,
        agentId: task.domain,
      }).claims[0]?.evidenceIds,
    ).toEqual(["ev-known"]);
  });

  it("flags repair when schema would have emptied draft findings", () => {
    // Draft finding-shaped objects with no evidence → coerce drops all → repair should still run
    const emptied = parseResult(
      JSON.stringify({
        status: "incomplete",
        summary: "Could not structure findings",
        findings: [{ observation: "Something happened but no evidence cited" }, { detail: "Also no ids" }],
      }),
      task,
      now,
    );
    expect(emptied.findings).toHaveLength(0);
    expect(emptied.draftFindingCount).toBe(2);
    expect(shouldRepairFindings(emptied, 0)).toBe(true);

    // Schema-valid draft that fails validateFinding also triggers repair
    const schemaOk = parseResult(
      JSON.stringify({
        status: "completed",
        summary: "Has findings",
        findings: [{ observation: "Elevated", evidenceId: "ev-invented" }],
      }),
      task,
      now,
    );
    expect(schemaOk.findings).toHaveLength(1);
    expect(shouldRepairFindings(schemaOk, 0)).toBe(true);

    // Empty draft → no repair
    const empty = parseResult(
      JSON.stringify({ status: "partial", summary: "Nothing", findings: [] }),
      task,
      now,
    );
    expect(shouldRepairFindings(empty, 0)).toBe(false);
  });
});

describe("live specialist repair path", () => {
  it("does not request response_format json_object", () => {
    const params = repairChatParams("gpt-oss-120b", [
      { role: "system", content: "test" },
      { role: "user", content: "repair" },
    ]);
    expect(params).toEqual({
      model: "gpt-oss-120b",
      messages: [
        { role: "system", content: "test" },
        { role: "user", content: "repair" },
      ],
    });
    expect(params).not.toHaveProperty("response_format");
    expect(JSON.stringify(params)).not.toMatch(/json_object/);
  });
});

describe("withFilledToolArgs series window", () => {
  it("fills missing series window from TREND_WINDOW when task window is short", async () => {
    const { withFilledToolArgs, isValidToolWindow } = await import("./live.js");
    const filled = withFilledToolArgs("get_service_health_series", { service: "sync-service" }, task);
    expect(isValidToolWindow(filled.window)).toBe(true);
    expect(filled.metric).toBe("errorRate");
    const w = filled.window as { from: string; to: string };
    expect(Date.parse(w.to) - Date.parse(w.from)).toBeGreaterThanOrEqual(2 * 24 * 60 * 60 * 1000);
  });

  it("keeps a valid model-provided series window", async () => {
    const { withFilledToolArgs } = await import("./live.js");
    const window = { from: "2026-09-10T00:00:00.000Z", to: "2026-09-20T08:00:00.000Z" };
    const filled = withFilledToolArgs(
      "get_service_health_series",
      { service: "sync-service", window, metric: "errors" },
      task,
    );
    expect(filled.window).toEqual(window);
    expect(filled.metric).toBe("errors");
  });

  it("replaces inverted or incomplete windows", async () => {
    const { withFilledToolArgs, isValidToolWindow } = await import("./live.js");
    const filled = withFilledToolArgs(
      "get_service_health_series",
      { window: { from: "2026-09-20T08:00:00.000Z", to: "2026-09-10T00:00:00.000Z" } },
      task,
    );
    expect(isValidToolWindow(filled.window)).toBe(true);
  });
});

describe("withFilledToolArgs queue category", () => {
  it("drops unknown category filters on list_unassigned_escalations", async () => {
    const { withFilledToolArgs } = await import("./live.js");
    const filled = withFilledToolArgs(
      "list_unassigned_escalations",
      { category: "unassigned", page: { limit: 10, offset: 0 } },
      { ...task, domain: "customer", capabilities: ["cap.tickets.read"] },
    );
    expect(filled.category).toBeUndefined();
    expect(filled.page).toEqual({ limit: 10, offset: 0 });
  });

  it("keeps known escalation category", async () => {
    const { withFilledToolArgs } = await import("./live.js");
    const filled = withFilledToolArgs(
      "list_unassigned_escalations",
      { category: "escalation" },
      { ...task, domain: "customer", capabilities: ["cap.tickets.read"] },
    );
    expect(filled.category).toBe("escalation");
    expect(filled.page).toEqual({ limit: 25, offset: 0 });
  });
});
