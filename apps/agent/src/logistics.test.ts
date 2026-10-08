import { afterAll, afterEach, describe, expect, it } from "vitest";
import type { AgentFinding } from "@anc/contracts";
import { resolvePrincipal } from "@anc/policy";
import { prepareTestEnvironment } from "./test-env.js";

prepareTestEnvironment("anc-logistics-agent-");

const { CAPABILITIES, authorizedTools, validateRegistry } = await import("./registry.js");
const { fixturePlan, proposePlan, usePlanModel } = await import("./planner.js");
const { synthesize, useSynthesisModel } = await import("./synthesis.js");
const { handleAction, publicState, runInvestigation, store } = await import("./runtime.js");
const { validateA2UI } = await import("./a2ui-validate.js");

const coo = resolvePrincipal("user-coo");
const hubSupervisor = resolvePrincipal("user-hub-hyd");
const careLead = resolvePrincipal("user-care");
const accountManager = resolvePrincipal("user-accounts");

afterAll(() => store.close());
afterEach(() => {
  usePlanModel(undefined);
  useSynthesisModel(undefined);
  delete process.env.FORCE_SPECIALIST_FAILURE;
});

describe("registry", () => {
  it("covers every company tool and offers no agent a write", () => {
    expect(validateRegistry()).toEqual([]);
    for (const domain of ["network", "shipments", "last_mile", "customers"] as const) {
      const tools = authorizedTools(careLead, domain);
      expect(tools).not.toContain("commit_complaint_assignment");
      expect(tools).not.toContain("list_eligible_assignees");
    }
    expect(CAPABILITIES.filter((item) => item.sideEffect === "write").map((item) => item.tool)).toEqual(["commit_complaint_assignment"]);
  });

  it("gives each agent only its own tools, and only those the person is granted", () => {
    expect(authorizedTools(coo, "network")).toEqual(["get_hub_status", "get_hub_throughput", "list_equipment_events", "list_route_runs"]);
    expect(authorizedTools(hubSupervisor, "customers")).toEqual([]);
    expect(authorizedTools(accountManager, "network")).toEqual([]);
    expect(authorizedTools(careLead, "customers")).toEqual(["search_shippers", "get_shipper", "list_complaints"]);
  });
});

describe("planner without a model", () => {
  it("sends a briefing to every specialist the person can use", () => {
    expect(fixturePlan({ objective: "Brief me: what needs my attention this morning?", principal: coo }).tasks.map((task) => task.domain)).toEqual(["network", "shipments", "last_mile", "customers"]);
    expect(fixturePlan({ objective: "What needs my attention this morning?", principal: hubSupervisor }).tasks.map((task) => task.domain)).toEqual(["network", "shipments"]);
    expect(fixturePlan({ objective: "Brief me", principal: careLead }).tasks.map((task) => task.domain)).toEqual(["customers"]);
  });

  it("routes a specific question to the matching specialist and view", () => {
    const lockers = fixturePlan({ objective: "Which parcel lockers are full?", principal: coo });
    expect(lockers.tasks.map((task) => task.domain)).toEqual(["last_mile"]);
    expect(lockers.view).toBe("table");
    const queue = fixturePlan({ objective: "Which complaints are unassigned?", principal: careLead });
    expect(queue.tasks[0]!.capabilities).toEqual(["cap.complaints.read"]);
    expect(queue.view).toBe("queue");
    expect(fixturePlan({ objective: "Show the on-time delivery performance trend", principal: coo }).view).toBe("trend");
  });

  it("names what a person may not see instead of answering from something adjacent", () => {
    const denied = fixturePlan({ objective: "Which parcel lockers are full?", principal: careLead });
    expect(denied.tasks).toEqual([]);
    expect(denied.unsupported).toMatch(/last-mile data, which is not available to you/);
    expect(denied.unsupported).toMatch(/Customer complaints queue/);
  });

  it("refuses a write the person lacks and operations nobody has", () => {
    expect(fixturePlan({ objective: "Assign the first complaint to Karthik", principal: accountManager }).unsupported).toMatch(/not authorized to assign a complaint/);
    expect(fixturePlan({ objective: "Which complaints are unassigned?", principal: accountManager }).unsupported).toBeUndefined();
    expect(fixturePlan({ objective: "Reroute the Madhapur trucks via Bengaluru", principal: coo }).unsupported).toMatch(/cannot carry out that operation/);
  });
});

describe("planner with a model", () => {
  it("drops what the model may not schedule and keeps one task per specialist", async () => {
    usePlanModel(async (request) => {
      // The model is only ever shown what this person is granted.
      expect(request.specialists.map((item) => item.domain)).toEqual(["network", "shipments"]);
      return {
        intent: "hub check",
        view: "holographic",
        tasks: [
          { domain: "network", question: "Is Hyderabad behind?", capabilities: ["cap.hubs.status", "cap.complaints.assign", "cap.invented"] },
          { domain: "network", question: "Again?", capabilities: ["cap.hubs.status"] },
          { domain: "customers", question: "Which shippers are affected?", capabilities: ["cap.commitments.read"] },
          { domain: "finance", question: "Revenue?", capabilities: [] },
        ],
      };
    });
    const plan = await proposePlan({ objective: "Is the Hyderabad hub keeping up?", principal: hubSupervisor });
    expect(plan.source).toBe("live");
    expect(plan.view).toBe("summary");
    expect(plan.tasks).toHaveLength(1);
    expect(plan.tasks[0]).toMatchObject({ domain: "network", capabilities: ["cap.hubs.status"] });
  });

  it("never asks the model about a request the runtime refuses", async () => {
    let asked = 0;
    usePlanModel(async () => { asked += 1; return { tasks: [] }; });
    const plan = await proposePlan({ objective: "Assign complaint cmp-0041 to Sneha", principal: accountManager });
    expect(plan.unsupported).toMatch(/not authorized/);
    expect(asked).toBe(0);
  });
});

describe("lead analyst", () => {
  const finding = (id: string, agentId: string, title: string, summary: string): AgentFinding => ({
    findingId: id, taskId: "t", agentId, kind: "observation", title, summary, severity: "high", entities: [], createdAt: new Date().toISOString(), limitations: [],
    claims: [{ claimId: "c", statement: title, evidenceIds: ["ev"], resultPaths: [], entities: [], metrics: [], limitations: [], contradictoryEvidenceIds: [] }],
  });
  const findings = [
    finding("f-belt", "network", "Sorter belt B down at Hyderabad since 22:10", "Hyderabad is sorting 30 parcels an hour against a usual 163."),
    finding("f-risk", "shipments", "905 parcels promised today are not on a truck", "All 905 are in Hyderabad delivery areas."),
    finding("f-lockers", "last_mile", "Two Chennai lockers are full", "T. Nagar and Velachery have no free compartments."),
  ];
  const good = {
    headline: "A sorter fault at Hyderabad has left 905 parcels at risk today",
    steps: [
      { text: "Sorter belt B has been down at Hyderabad since 22:10.", kind: "observed", findingIds: ["f-belt"] },
      { text: "That is the likely reason 905 parcels promised today are not on a truck.", kind: "inferred", findingIds: ["f-belt", "f-risk"] },
    ],
    separate: [{ text: "Two Chennai lockers are full, unrelated to Hyderabad.", findingIds: ["f-lockers"] }],
  };

  it("uses the deterministic ranker when there is no model", async () => {
    const outcome = await synthesize({ objective: "brief me", audience: "COO", findings });
    expect(outcome.briefingPlan?.quiet).toBe(false);
    expect(outcome.synthesis?.headline || outcome.briefingPlan?.primary?.findingId).toBeTruthy();
    useSynthesisModel(async () => good);
    const single = await synthesize({ objective: "brief me", audience: "COO", findings: findings.slice(0, 1) });
    expect(single.briefingPlan).toBeTruthy();
  });

  it("accepts an account that cites real findings and keeps inferred links marked", async () => {
    useSynthesisModel(async () => good);
    const { synthesis } = await synthesize({ objective: "brief me", audience: "COO", findings });
    expect(synthesis?.steps.map((step) => step.kind)).toEqual(["observed", "inferred"]);
    expect(synthesis?.separate[0]?.findingIds).toEqual(["f-lockers"]);
  });

  it("rejects invented figures, unknown findings and unsupported steps, after one retry", async () => {
    const bad = [
      { ...good, headline: "A fault has left 1,400 parcels at risk" },
      { ...good, steps: [{ text: "The belt is down.", kind: "observed", findingIds: ["f-made-up"] }] },
      { ...good, steps: [{ text: "The belt is down.", kind: "observed", findingIds: [] }] },
      { ...good, steps: [{ text: "The belt is down.", kind: "certain", findingIds: ["f-belt"] }] },
    ];
    for (const reply of bad) {
      let calls = 0;
      useSynthesisModel(async () => { calls += 1; return reply; });
      const outcome = await synthesize({ objective: "brief me", audience: "COO", findings });
      expect(outcome.reason).toBeTruthy();
      expect(outcome.briefingPlan || outcome.synthesis).toBeTruthy();
      expect(calls).toBe(2);
    }
  });

  it("uses the rejection as feedback for the retry", async () => {
    useSynthesisModel(async (_request, feedback) => (feedback ? good : { ...good, headline: "9,999 parcels at risk" }));
    expect((await synthesize({ objective: "brief me", audience: "COO", findings })).synthesis?.headline).toBe(good.headline);
  });
});

describe("a question end to end, without a model", () => {
  it("briefs the COO from all four specialists with evidence behind every finding", async () => {
    const state = await runInvestigation({ question: "Brief me: what needs my attention this morning?", threadId: "t-brief", principal: coo });
    expect(state.status).toBe("completed");
    const started = state.activity.filter((item) => item.kind === "agent_started").map((item) => item.message).sort();
    expect(started).toEqual(["Customers Agent started", "Last-Mile Agent started", "Network Agent started", "Shipments Agent started"]);
    expect(validateA2UI(state.surface!.messages as never)).toEqual([]);
    const findings = (state.surface!.dataModel as { findings: Record<string, { evidenceIds: string[]; title?: string }> }).findings;
    expect(Object.keys(findings).length).toBeGreaterThanOrEqual(1);
    expect(Object.keys(findings).length).toBeLessThanOrEqual(4);
    expect(state.surface!.title).toMatch(/at risk|905|Hyderabad|sorter|fault/i);
    expect(JSON.stringify(state.activity)).not.toMatch(/Contradictory records/i);
    const metrics = (state.surface!.dataModel as { metrics?: Record<string, { label?: string; value?: string }> }).metrics ?? {};
    const labels = Object.values(metrics).map((metric) => metric.label ?? "");
    expect(labels.some((label) => /at risk/i.test(label))).toBe(true);
    expect(Object.values(metrics).some((metric) => String(metric.value).includes("905"))).toBe(true);
    for (const item of Object.values(findings)) {
      expect(item.evidenceIds.length).toBeGreaterThan(0);
      for (const id of item.evidenceIds) expect(store.getEvidence(id, coo.id)).toBeTruthy();
    }
  }, 60_000);

  it("builds a table from the tool's own rows for a specific question", async () => {
    const state = await runInvestigation({ question: "Which parcel lockers are full?", threadId: "t-lockers", principal: coo });
    const table = (state.surface!.dataModel as { table: { columns: string[]; rows: Array<{ cells: string[]; entityType: string }> } }).table;
    expect(table.columns).toEqual(["Locker", "Area", "Full", "Free", "Uncollected over 48h", "Arriving with no space"]);
    const velachery = table.rows.find((row) => row.cells[0] === "Velachery MRTS Station")!;
    expect(velachery.cells[2]).toBe("100.0%");
    expect(velachery.entityType).toBe("locker");
  }, 60_000);

  it("shows the rest when one specialist fails", async () => {
    process.env.FORCE_SPECIALIST_FAILURE = "customers";
    const state = await runInvestigation({ question: "Brief me: what needs my attention this morning?", threadId: "t-partial", principal: coo });
    expect(state.status).toBe("partial");
    expect(JSON.stringify(state.surface!.dataModel)).toMatch(/Customers Agent could not complete its part/);
    expect(Object.keys((state.surface!.dataModel as { findings: object }).findings).length).toBeGreaterThan(0);
  }, 60_000);

  it("refuses a locker question from someone without last-mile access, and shows no data", async () => {
    const state = await runInvestigation({ question: "Which parcel lockers are full?", threadId: "t-denied", principal: careLead });
    expect(state.surface!.title).toBe("Not available");
    expect(JSON.stringify(state.surface!.dataModel)).not.toMatch(/Velachery/);
  }, 60_000);
});

describe("assigning a complaint", () => {
  const act = (threadId: string, principal: typeof coo, name: string, extra: Record<string, unknown> = {}) => {
    const current = publicState(threadId, principal.id);
    return handleAction({ name, threadId, surfaceId: current.surface?.surfaceId, surfaceRevision: current.surface?.revision, ...extra }, principal);
  };

  it("lets the care lead pick an owner and assigns exactly once", async () => {
    const thread = "t-assign";
    const queue = await runInvestigation({ question: "Which complaints are unassigned?", threadId: thread, principal: careLead });
    const rows = (queue.surface!.dataModel as { table: { rows: Array<{ id: string; actionName?: string }> } }).table.rows;
    expect(rows.every((row) => row.actionName === "prepare_assignment")).toBe(true);
    const complaintId = rows.find((row) => row.id !== "cmp-0040")!.id;

    const form = await act(thread, careLead, "prepare_assignment", { entities: [{ type: "complaint", id: complaintId }] });
    const proposalId = (form.surface!.dataModel as { form: { id: string; fields: Array<{ options: Array<{ id: string }> }> } }).form.id;
    const chosen = await act(thread, careLead, "select_assignee", { parameters: { proposalId, assigneeId: "emp-care-3" } });
    expect(JSON.stringify(chosen.surface!.messages)).toMatch(/Assign to Sneha Kulkarni/);
    await expect(act(thread, careLead, "select_assignee", { parameters: { proposalId, assigneeId: "emp-ops" } })).rejects.toThrow(/cannot own/);

    const done = await act(thread, careLead, "commit_assignment", { parameters: { proposalId } });
    expect(JSON.stringify(done.surface!.dataModel)).toMatch(new RegExp(`Complaint ${complaintId} is now owned by Sneha Kulkarni`));
    await expect(act(thread, careLead, "commit_assignment", { parameters: { proposalId } })).rejects.toThrow(/no longer valid/);
  }, 60_000);

  it("shows the queue read-only to someone who cannot assign, and refuses the action", async () => {
    const thread = "t-readonly";
    const queue = await runInvestigation({ question: "Which complaints are unassigned?", threadId: thread, principal: accountManager });
    const rows = (queue.surface!.dataModel as { table: { rows: Array<{ id: string; actionName?: string }> } }).table.rows;
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((row) => row.actionName === undefined)).toBe(true);
    await expect(act(thread, accountManager, "prepare_assignment", { entities: [{ type: "complaint", id: rows[0]!.id }] })).rejects.toThrow(/Not authorized/);
  }, 60_000);
});
