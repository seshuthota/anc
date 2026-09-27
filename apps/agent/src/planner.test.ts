import { afterEach, describe, expect, it } from "vitest";
import { resolvePrincipal } from "@anc/policy";
import { peekSubstitutions } from "./execution.js";
import { proposePlan, usePlanModel } from "./planner.js";

const savedEnv = {
  provider: process.env.MODEL_PROVIDER,
  mode: process.env.MODEL_EXECUTION_MODE,
  key: process.env.MODEL_API_KEY,
};

afterEach(() => {
  usePlanModel(undefined);
  if (savedEnv.provider === undefined) delete process.env.MODEL_PROVIDER;
  else process.env.MODEL_PROVIDER = savedEnv.provider;
  if (savedEnv.mode === undefined) delete process.env.MODEL_EXECUTION_MODE;
  else process.env.MODEL_EXECUTION_MODE = savedEnv.mode;
  if (savedEnv.key === undefined) delete process.env.MODEL_API_KEY;
  else process.env.MODEL_API_KEY = savedEnv.key;
});

describe("capability-grounded planner", () => {
  it("builds different plans for finance, support, and operations", async () => {
    const finance = await proposePlan({ objective: "What needs my attention?", principal: resolvePrincipal("user-finance") });
    const support = await proposePlan({ objective: "What needs my attention?", principal: resolvePrincipal("user-support") });
    const ops = await proposePlan({ objective: "What needs my attention?", principal: resolvePrincipal("user-ops") });
    expect(finance.tasks.some((item) => item.domain === "finance")).toBe(true);
    expect(finance.tasks.some((item) => item.domain === "reliability")).toBe(false);
    expect(support.tasks.some((item) => item.domain === "customer")).toBe(true);
    expect(ops.tasks.some((item) => item.domain === "reliability")).toBe(true);
    expect(ops.source).toBe("fixture");
    expect(ops.deterministic).toBe(true);
  });

  it("stops honestly on unsupported operations", async () => {
    const plan = await proposePlan({ objective: "Refund every overdue invoice by wire transfer", principal: resolvePrincipal("user-coo") });
    expect(plan.unsupported).toBeTruthy();
    expect(plan.tasks).toEqual([]);
  });

  it("does not need a new branch for a paraphrase", async () => {
    const a = await proposePlan({ objective: "Compare overdue invoices by customer", principal: resolvePrincipal("user-finance") });
    const b = await proposePlan({ objective: "Show me aging on past-due invoices", principal: resolvePrincipal("user-finance") });
    expect(a.tasks.map((item) => item.domain).sort()).toEqual(b.tasks.map((item) => item.domain).sort());
    expect(a.tasks.some((item) => item.capabilities.includes("cap.finance.invoices"))).toBe(true);
  });

  it("selects a new registry capability from its description", async () => {
    const plan = await proposePlan({ objective: "What open incidents should I know about?", principal: resolvePrincipal("user-ops") });
    expect(plan.tasks.some((item) => item.capabilities.includes("cap.incidents.read"))).toBe(true);
    expect(plan.tasks.some((item) => item.capabilities.includes("cap.finance.invoices"))).toBe(false);
  });

  it("drops unauthorized and write capabilities from a live-shaped plan", async () => {
    const { sanitizePlan } = await import("./planner.js");
    const plan = sanitizePlan({
      intent: "work",
      view: "summary",
      deterministic: false,
      source: "live",
      tasks: [
        { domain: "finance", question: "Refund invoices", capabilities: ["cap.finance.invoices", "cap.tickets.assign"] },
        { domain: "reliability", question: "Open incidents", capabilities: ["cap.incidents.read"] },
      ],
    }, resolvePrincipal("user-ops"));
    expect(plan.tasks.some((item) => item.domain === "finance")).toBe(false);
    expect(plan.tasks.some((item) => item.capabilities.includes("cap.incidents.read"))).toBe(true);
    expect(plan.tasks.some((item) => item.capabilities.includes("cap.tickets.assign"))).toBe(false);
  });

  it("uses the model plan in live mode instead of fixture rules", async () => {
    process.env.MODEL_PROVIDER = "openai";
    process.env.MODEL_EXECUTION_MODE = "live-strict";
    process.env.MODEL_API_KEY = "test-key";
    usePlanModel(async (request) => {
      expect(request.objective).toMatch(/this morning/);
      expect(request.user.id).toBe("user-ops");
      expect(request.capabilities.some((item) => item.inputSchema && item.id === "cap.service.health")).toBe(true);
      expect(request.capabilities.some((item) => item.sideEffect === "write")).toBe(false);
      return {
        intent: "work",
        view: "table",
        tasks: [{ domain: "reliability", question: "List open maintenance windows", capabilities: ["cap.maintenance.read", "cap.tickets.assign"] }],
      };
    });
    const plan = await proposePlan({ objective: "What should I care about this morning?", principal: resolvePrincipal("user-ops") });
    expect(plan.source).toBe("live");
    expect(plan.deterministic).toBe(false);
    expect(plan.tasks.map((item) => item.domain)).toEqual(["reliability"]);
    expect(plan.tasks[0]?.capabilities).toEqual(["cap.maintenance.read"]);
  });

  it("records a planner substitution only when live fallback is explicit", async () => {
    process.env.MODEL_PROVIDER = "openai";
    process.env.MODEL_EXECUTION_MODE = "live-fallback";
    process.env.MODEL_API_KEY = "test-key";
    usePlanModel(async () => {
      throw new Error("model unavailable");
    });
    const plan = await proposePlan({ objective: "Compare overdue invoices by customer", principal: resolvePrincipal("user-finance"), runId: "run-plan-fallback" });
    expect(plan.source).toBe("fixture");
    expect(plan.tasks.some((item) => item.capabilities.includes("cap.finance.invoices"))).toBe(true);
    expect(peekSubstitutions("run-plan-fallback").some((item) => item.specialist === "planner")).toBe(true);
  });

  it("keeps a clarification distinguishable from a permission denial", async () => {
    const { sanitizePlan } = await import("./planner.js");
    const plan = sanitizePlan({
      intent: "work",
      view: "summary",
      deterministic: false,
      source: "live",
      tasks: [],
      clarification: "Which account should this cover?",
    }, resolvePrincipal("user-finance"));
    expect(plan.intent).toBe("clarification");
    expect(plan.clarification).toBe("Which account should this cover?");
    expect(plan.unsupported).toBeUndefined();
  });

  it("still reports a genuine authorization failure as unsupported", async () => {
    const { sanitizePlan } = await import("./planner.js");
    const plan = sanitizePlan({
      intent: "work",
      view: "summary",
      deterministic: false,
      source: "live",
      tasks: [{ domain: "finance", question: "Invoices", capabilities: ["cap.finance.invoices"] }],
    }, resolvePrincipal("user-support"));
    expect(plan.intent).toBe("unsupported");
    expect(plan.unsupported).toMatch(/not authorized/i);
  });

  it("asks which account a draft should cover instead of guessing", async () => {
    const plan = await proposePlan({ objective: "Draft an onboarding checklist for these accounts", principal: resolvePrincipal("user-coo") });
    expect(plan.intent).toBe("clarification");
    expect(plan.clarification).toBeTruthy();
    expect(plan.unsupported).toBeUndefined();
  });

  it("schedules the series capability and a trend view for a trend request", async () => {
    const plan = await proposePlan({ objective: "Show me the error rate trend over the past week", principal: resolvePrincipal("user-ops") });
    expect(plan.view).toBe("trend");
    expect(plan.tasks.some((item) => item.capabilities.includes("cap.service.trend"))).toBe(true);
  });

  it("refuses a trend request when telemetry is not granted", async () => {
    const plan = await proposePlan({ objective: "Show me the error rate trend over the past week", principal: resolvePrincipal("user-finance") });
    expect(plan.tasks.some((item) => item.capabilities.includes("cap.service.trend"))).toBe(false);
  });

  it("asks for a comparison view on an invoice comparison request", async () => {
    const plan = await proposePlan({ objective: "Compare overdue invoices by customer", principal: resolvePrincipal("user-finance") });
    expect(plan.view).toBe("comparison");
  });

  it("keeps the queue view for an unassigned escalation request", async () => {
    const plan = await proposePlan({ objective: "Show unassigned escalations", principal: resolvePrincipal("user-support") });
    expect(plan.view).toBe("queue");
  });
});
