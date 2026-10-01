import { afterEach, describe, expect, it } from "vitest";
import { resolvePrincipal } from "@anc/policy";
import { peekSubstitutions } from "./execution.js";
import { extractPlanObject, proposePlan, usePlanModel } from "./planner.js";

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
    delete process.env.MODEL_PROVIDER;
    delete process.env.MODEL_EXECUTION_MODE;
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
      expect(request.capabilities.some((item) => item.id === "cap.service.health" && item.granted)).toBe(true);
      expect(request.capabilities.some((item) => item.id === "cap.finance.invoices" && !item.granted)).toBe(true);
      expect(request.capabilities.some((item) => item.sideEffect === "write")).toBe(true);
      expect(request.capabilities.filter((item) => item.sideEffect === "write").every((item) => !item.granted)).toBe(true);
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

  it("coerces boolean unsupported from live model JSON into a string", async () => {
    process.env.MODEL_PROVIDER = "openai";
    process.env.MODEL_EXECUTION_MODE = "live-strict";
    process.env.MODEL_API_KEY = "test-key";
    usePlanModel(async () => ({
      intent: "unsupported",
      view: "summary",
      tasks: [],
      unsupported: true,
    }));
    const plan = await proposePlan({ objective: "Anything interesting overnight?", principal: resolvePrincipal("user-coo") });
    expect(typeof plan.unsupported).toBe("string");
    expect(plan.unsupported!.length).toBeGreaterThan(0);
    expect(plan.intent).toBe("unsupported");
    expect(plan.source).toBe("live");
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

  it("blocks unsupported write ops under live-strict before calling the model", async () => {
    process.env.MODEL_PROVIDER = "openai";
    process.env.MODEL_EXECUTION_MODE = "live-strict";
    process.env.MODEL_API_KEY = "test-key";
    let called = 0;
    usePlanModel(async () => {
      called += 1;
      return { intent: "work", view: "summary", tasks: [] };
    });
    const plan = await proposePlan({
      objective: "Refund every overdue invoice by wire transfer",
      principal: resolvePrincipal("user-coo"),
    });
    expect(called).toBe(0);
    expect(plan.source).toBe("live");
    expect(plan.unsupported).toMatch(/cannot perform that business operation/i);
    expect(plan.tasks).toEqual([]);
  });

  it("blocks persona grant denials under live-strict before calling the model", async () => {
    process.env.MODEL_PROVIDER = "openai";
    process.env.MODEL_EXECUTION_MODE = "live-strict";
    process.env.MODEL_API_KEY = "test-key";
    let called = 0;
    usePlanModel(async () => {
      called += 1;
      return { intent: "work", view: "summary", tasks: [] };
    });
    const plan = await proposePlan({
      objective: "Compare overdue invoices by customer",
      principal: resolvePrincipal("user-support"),
    });
    expect(called).toBe(0);
    expect(plan.source).toBe("live");
    expect(plan.unsupported).toMatch(/finance/i);
    expect(plan.tasks).toEqual([]);
  });

  it("blocks write-intent without grant under live-strict before calling the model", async () => {
    process.env.MODEL_PROVIDER = "openai";
    process.env.MODEL_EXECUTION_MODE = "live-strict";
    process.env.MODEL_API_KEY = "test-key";
    let called = 0;
    usePlanModel(async () => {
      called += 1;
      return { intent: "work", view: "summary", tasks: [] };
    });
    const plan = await proposePlan({
      objective: "Assign the first unassigned escalation to me",
      principal: resolvePrincipal("user-finance"),
    });
    expect(called).toBe(0);
    expect(plan.source).toBe("live");
    expect(plan.unsupported).toMatch(/not authorized/i);
    expect(plan.tasks).toEqual([]);
  });

  it("schedules multi-domain morning work from mock live JSON", async () => {
    process.env.MODEL_PROVIDER = "openai";
    process.env.MODEL_EXECUTION_MODE = "live-strict";
    process.env.MODEL_API_KEY = "test-key";
    usePlanModel(async () => ({
      intent: "work",
      view: "summary",
      tasks: [
        { domain: "reliability", question: "Reliability signals", capabilities: ["cap.service.health", "cap.releases.read"] },
        { domain: "customer", question: "Support evidence", capabilities: ["cap.tickets.read"] },
        { domain: "finance", question: "Invoice exposure", capabilities: ["cap.finance.invoices"] },
      ],
    }));
    const plan = await proposePlan({
      objective: "What do I need to know this morning?",
      principal: resolvePrincipal("user-coo"),
    });
    const domains = new Set(plan.tasks.map((item) => item.domain));
    expect(domains.size).toBeGreaterThanOrEqual(2);
    expect(plan.source).toBe("live");
    expect(plan.view).toBe("summary");
  });

  it("maps mock live trend JSON to cap.service.trend and trend view", async () => {
    process.env.MODEL_PROVIDER = "openai";
    process.env.MODEL_EXECUTION_MODE = "live-strict";
    process.env.MODEL_API_KEY = "test-key";
    usePlanModel(async () => ({
      intent: "work",
      view: "summary",
      tasks: [{ domain: "reliability", question: "Error rate trend", capabilities: ["cap.service.trend"] }],
    }));
    const plan = await proposePlan({
      objective: "Show me the error rate trend over the past week",
      principal: resolvePrincipal("user-ops"),
    });
    expect(plan.tasks.some((item) => item.capabilities.includes("cap.service.trend"))).toBe(true);
    expect(plan.view).toBe("trend");
  });

  it("maps mock live draft JSON to form view", async () => {
    process.env.MODEL_PROVIDER = "openai";
    process.env.MODEL_EXECUTION_MODE = "live-strict";
    process.env.MODEL_API_KEY = "test-key";
    usePlanModel(async () => ({
      intent: "draft",
      view: "form",
      tasks: [{
        domain: "customer",
        question: "Retrieve account context",
        capabilities: ["cap.customers.read", "cap.tickets.read"],
        entities: [{ type: "customer", id: "customer-001" }],
      }],
    }));
    const plan = await proposePlan({
      objective: "Draft an onboarding checklist for customer-001",
      principal: resolvePrincipal("user-coo"),
    });
    expect(plan.view).toBe("form");
    expect(plan.intent).toBe("draft");
    expect(plan.tasks.some((item) => item.capabilities.includes("cap.customers.read"))).toBe(true);
  });

  it("maps mock live invoice JSON to finance comparison", async () => {
    process.env.MODEL_PROVIDER = "openai";
    process.env.MODEL_EXECUTION_MODE = "live-strict";
    process.env.MODEL_API_KEY = "test-key";
    usePlanModel(async () => ({
      intent: "work",
      view: "table",
      tasks: [{ domain: "finance", question: "Invoice aging", capabilities: ["cap.finance.invoices"] }],
    }));
    const plan = await proposePlan({
      objective: "Compare overdue invoices by customer",
      principal: resolvePrincipal("user-finance"),
    });
    expect(plan.tasks.some((item) => item.capabilities.includes("cap.finance.invoices"))).toBe(true);
    expect(plan.view).toBe("comparison");
  });

  it("does not turn empty live {} into a misleading auth denial when grants exist", async () => {
    process.env.MODEL_PROVIDER = "openai";
    process.env.MODEL_EXECUTION_MODE = "live-strict";
    process.env.MODEL_API_KEY = "test-key";
    let calls = 0;
    usePlanModel(async (request) => {
      calls += 1;
      if (calls === 1) {
        expect(request.repairReason).toBeUndefined();
        return {};
      }
      expect(request.repairReason).toBeTruthy();
      return {};
    });
    const plan = await proposePlan({
      objective: "What should I care about this morning?",
      principal: resolvePrincipal("user-coo"),
    });
    expect(calls).toBe(2);
    expect(plan.tasks).toEqual([]);
    expect(plan.unsupported ?? "").not.toMatch(/not authorized/i);
    expect(plan.clarification || plan.unsupported).toBeTruthy();
    expect(plan.source).toBe("live");
  });

  it("repairs a premature live clarification on a productive morning ask", async () => {
    process.env.MODEL_PROVIDER = "openai";
    process.env.MODEL_EXECUTION_MODE = "live-strict";
    process.env.MODEL_API_KEY = "test-key";
    let calls = 0;
    usePlanModel(async (request) => {
      calls += 1;
      if (calls === 1) {
        return { intent: "clarification", view: "summary", tasks: [], clarification: "Need more detail." };
      }
      expect(request.repairReason).toBeTruthy();
      return {
        intent: "work",
        view: "summary",
        tasks: [
          { domain: "reliability", question: "Reliability", capabilities: ["cap.service.health"] },
          { domain: "finance", question: "Finance", capabilities: ["cap.finance.invoices"] },
        ],
      };
    });
    const plan = await proposePlan({
      objective: "What should I care about this morning?",
      principal: resolvePrincipal("user-coo"),
    });
    expect(calls).toBe(2);
    expect(plan.tasks.length).toBeGreaterThanOrEqual(2);
    expect(plan.clarification).toBeUndefined();
    expect(plan.source).toBe("live");
  });

  it("does not repair when live already returned a non-empty unsupported string", async () => {
    process.env.MODEL_PROVIDER = "openai";
    process.env.MODEL_EXECUTION_MODE = "live-strict";
    process.env.MODEL_API_KEY = "test-key";
    let calls = 0;
    usePlanModel(async () => {
      calls += 1;
      return {
        intent: "unsupported",
        view: "summary",
        tasks: [],
        unsupported: "Finance data is not available for this persona.",
      };
    });
    const plan = await proposePlan({
      objective: "What should I care about this morning?",
      principal: resolvePrincipal("user-coo"),
    });
    expect(calls).toBe(1);
    expect(plan.tasks).toEqual([]);
    expect(plan.unsupported).toMatch(/Finance data/i);
    expect(plan.source).toBe("live");
  });

  it("unwraps gpt-oss final{ wrappers so morning tasks survive", async () => {
    process.env.MODEL_PROVIDER = "openai";
    process.env.MODEL_EXECUTION_MODE = "live-strict";
    process.env.MODEL_API_KEY = "test-key";
    usePlanModel(async () => ({
      "final{": {
        intent: "work",
        view: "summary",
        tasks: [
          { domain: "reliability", question: "Reliability", capabilities: ["cap.service.health", "cap.releases.read"] },
          { domain: "customer", question: "Support", capabilities: ["cap.tickets.read"] },
          { domain: "finance", question: "Invoices", capabilities: ["cap.finance.invoices"] },
        ],
      },
    }));
    const plan = await proposePlan({
      objective: "What should I care about this morning?",
      principal: resolvePrincipal("user-coo"),
    });
    expect(plan.tasks.length).toBeGreaterThanOrEqual(2);
    expect(plan.view).toBe("summary");
    expect(plan.clarification).toBeUndefined();
    expect(plan.source).toBe("live");
  });

  it("maps mock live queue JSON to cap.tickets.read and queue view", async () => {
    process.env.MODEL_PROVIDER = "openai";
    process.env.MODEL_EXECUTION_MODE = "live-strict";
    process.env.MODEL_API_KEY = "test-key";
    usePlanModel(async () => ({
      intent: "work",
      view: "summary",
      tasks: [{ domain: "customer", question: "Unassigned escalations", capabilities: ["cap.tickets.read"] }],
    }));
    const plan = await proposePlan({
      objective: "Show unassigned escalations",
      principal: resolvePrincipal("user-support"),
    });
    expect(plan.tasks.some((item) => item.capabilities.includes("cap.tickets.read"))).toBe(true);
    expect(plan.view).toBe("queue");
    expect(plan.source).toBe("live");
  });

  it("coerces wrong task domains to registry domains so sanitize keeps caps", async () => {
    process.env.MODEL_PROVIDER = "openai";
    process.env.MODEL_EXECUTION_MODE = "live-strict";
    process.env.MODEL_API_KEY = "test-key";
    usePlanModel(async () => ({
      intent: "work",
      view: "comparison",
      tasks: [
        { domain: "ops", question: "Health", capabilities: ["cap.service.health"] },
        { domain: "billing", question: "Invoices", capabilities: ["cap.finance.invoices"] },
      ],
    }));
    const plan = await proposePlan({
      objective: "Compare overdue invoices by customer",
      principal: resolvePrincipal("user-coo"),
    });
    // finance ask with COO grants: coerced finance task must survive; ops→reliability may also survive
    expect(plan.tasks.some((item) => item.domain === "finance" && item.capabilities.includes("cap.finance.invoices"))).toBe(true);
    expect(plan.view).toBe("comparison");
    expect(plan.source).toBe("live");
  });

  it("repairs empty live plan on invoice paraphrase with granted finance caps", async () => {
    process.env.MODEL_PROVIDER = "openai";
    process.env.MODEL_EXECUTION_MODE = "live-strict";
    process.env.MODEL_API_KEY = "test-key";
    let calls = 0;
    usePlanModel(async (request) => {
      calls += 1;
      if (calls === 1) return { "final{": 0 };
      expect(request.repairReason).toMatch(/cap\.finance\.invoices/);
      return {
        intent: "work",
        view: "comparison",
        tasks: [{ domain: "finance", question: "Invoice aging", capabilities: ["cap.finance.invoices"] }],
      };
    });
    const plan = await proposePlan({
      objective: "Compare overdue invoices by customer",
      principal: resolvePrincipal("user-finance"),
    });
    expect(calls).toBe(2);
    expect(plan.tasks.some((item) => item.capabilities.includes("cap.finance.invoices"))).toBe(true);
    expect(plan.view).toBe("comparison");
  });

  it("repairs empty live plan on draft paraphrase with customer entity", async () => {
    process.env.MODEL_PROVIDER = "openai";
    process.env.MODEL_EXECUTION_MODE = "live-strict";
    process.env.MODEL_API_KEY = "test-key";
    let calls = 0;
    usePlanModel(async (request) => {
      calls += 1;
      if (calls === 1) return {};
      expect(request.repairReason).toMatch(/draft|cap\.customers\.read/i);
      return {
        intent: "draft",
        view: "form",
        tasks: [{
          domain: "customer",
          question: "Retrieve account context",
          capabilities: ["cap.customers.read", "cap.tickets.read"],
          entities: [{ type: "customer", id: "customer-001" }],
        }],
      };
    });
    const plan = await proposePlan({
      objective: "Draft an onboarding checklist for customer-001",
      principal: resolvePrincipal("user-coo"),
    });
    expect(calls).toBe(2);
    expect(plan.intent).toBe("draft");
    expect(plan.view).toBe("form");
    expect(plan.tasks.some((item) => item.capabilities.includes("cap.customers.read"))).toBe(true);
  });

  it("repairs when unknown capability ids leave an empty live plan (no fixture substitution)", async () => {
    process.env.MODEL_PROVIDER = "openai";
    process.env.MODEL_EXECUTION_MODE = "live-strict";
    process.env.MODEL_API_KEY = "test-key";
    let calls = 0;
    usePlanModel(async (request) => {
      calls += 1;
      if (calls === 1) {
        // Unknown domain + unknown caps → coerce drops the task → empty plan → repair.
        return {
          intent: "work",
          view: "summary",
          tasks: [{ domain: "ops", question: "Nope", capabilities: ["cap.not.real", "cap.also.fake"] }],
        };
      }
      expect(request.repairReason).toBeTruthy();
      return {
        intent: "work",
        view: "summary",
        tasks: [
          { domain: "reliability", question: "Reliability", capabilities: ["cap.service.health"] },
          { domain: "finance", question: "Finance", capabilities: ["cap.finance.invoices"] },
        ],
      };
    });
    const plan = await proposePlan({
      objective: "What should I care about this morning?",
      principal: resolvePrincipal("user-coo"),
    });
    expect(calls).toBe(2);
    expect(plan.tasks.some((item) => item.capabilities.includes("cap.service.health"))).toBe(true);
    expect(plan.tasks.every((item) => item.capabilities.every((id) => !id.includes("fake") && !id.includes("not.real")))).toBe(true);
    expect(plan.source).toBe("live");
  });

  it("extractPlanObject recovers nested final{ plans from raw strings", () => {
    const wrapped = JSON.stringify({
      "final{": {
        intent: "work",
        view: "queue",
        tasks: [{ domain: "customer", question: "Queue", capabilities: ["cap.tickets.read"] }],
      },
    });
    const extracted = extractPlanObject(wrapped);
    expect(Array.isArray(extracted.tasks)).toBe(true);
    expect((extracted.tasks as Array<{ capabilities: string[] }>)[0]?.capabilities).toEqual(["cap.tickets.read"]);
  });

});
