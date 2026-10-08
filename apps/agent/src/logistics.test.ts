import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import type { AgentFinding } from "@anc/contracts";
import { resolvePrincipal } from "@anc/policy";
import { prepareTestEnvironment } from "./test-env.js";

prepareTestEnvironment("anc-logistics-agent-");

const { CAPABILITIES, authorizedTools, validateRegistry } = await import("./registry.js");
const { fixturePlan, proposePlan, usePlanModel } = await import("./planner.js");
const { synthesize, useSynthesisModel } = await import("./synthesis.js");
const { handleAction, publicState, runInvestigation, store } = await import("./runtime.js");
const { validateA2UI } = await import("./a2ui-validate.js");
const { reconcileMetrics } = await import("./reconcile.js");

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
      for (const principal of [careLead, coo, hubSupervisor, accountManager]) {
        const tools = authorizedTools(principal, domain);
        for (const write of ["commit_complaint_assignment", "escalate_equipment_fault", "notify_shipper", "list_eligible_assignees"]) expect(tools).not.toContain(write);
      }
    }
    const writes = CAPABILITIES.filter((item) => item.sideEffect === "write");
    expect(writes.map((item) => item.tool).sort()).toEqual(["commit_complaint_assignment", "escalate_equipment_fault", "notify_shipper"]);
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
  const finding = (id: string, agentId: string, title: string, summary: string, metric?: AgentFinding["claims"][number]["metrics"][number], resultPath?: string): AgentFinding => ({
    findingId: id, taskId: "t", agentId, kind: "observation", title, summary, severity: "high", entities: [], createdAt: new Date().toISOString(), limitations: [],
    claims: [{ claimId: "c", statement: title, evidenceIds: ["ev"], resultPaths: resultPath ? [resultPath] : [], entities: [], metrics: metric ? [metric] : [], limitations: [], contradictoryEvidenceIds: [] }],
  });
  const findings = [
    finding("f-belt", "network", "Sorter belt B down at Hyderabad since 22:10", "Hyderabad is sorting 30 parcels an hour against a usual 163."),
    finding("f-risk", "shipments", "905 parcels promised today are not on a truck", "All 905 are in Hyderabad delivery areas.",
      { name: "Parcels at risk today", value: 905, unit: "parcels", aggregation: "count", metricId: "parcels_at_risk_today", scope: { type: "network" }, denominator: { value: 4000, metricId: "parcels_promised_today" } }, "totals.atRisk"),
    finding("f-lockers", "last_mile", "Two Chennai lockers are full", "T. Nagar and Velachery have no free compartments."),
    finding("f-godavari", "customers", "Godavari Organics has 218 parcels at risk today", "Godavari Organics would miss its commitment.",
      { name: "Parcels at risk today", value: 218, unit: "parcels", aggregation: "count", metricId: "parcels_at_risk_today", scope: { type: "shipper", id: "shipper-003" } }, "rows.0.atRiskToday"),
  ];
  const reconciled = reconcileMetrics(findings);
  const good = {
    headline: "A sorter fault at Hyderabad has left 905 parcels at risk today",
    primaryFindingId: "f-risk",
    whyItMatters: "That is 905 of 4,000 parcels promised today.",
    steps: [
      { text: "Sorter belt B has been down at Hyderabad since 22:10.", kind: "observed", findingIds: ["f-belt"] },
      { text: "That is the likely reason 905 parcels promised today are not on a truck.", kind: "inferred", findingIds: ["f-belt", "f-risk"] },
    ],
    separate: [{ text: "Two Chennai lockers are full, unrelated to Hyderabad.", findingIds: ["f-lockers"] }],
  };
  const brief = () => synthesize({ objective: "brief me", audience: "COO", findings, reconciled });

  it("uses the deterministic ranker when there is no model", async () => {
    const outcome = await brief();
    expect(outcome.briefingPlan?.quiet).toBe(false);
    expect(outcome.briefingPlan?.primary?.findingId).toBe("f-risk");
    expect(outcome.synthesis?.primaryFindingId).toBe("f-risk");
    useSynthesisModel(async () => good);
    const single = await synthesize({ objective: "brief me", audience: "COO", findings: findings.slice(0, 1) });
    expect(single.briefingPlan).toBeTruthy();
  });

  it("accepts an account about the ranked primary that cites real findings and keeps inferred links marked", async () => {
    useSynthesisModel(async () => good);
    const { synthesis, reason } = await brief();
    expect(reason).toBeUndefined();
    expect(synthesis?.primaryFindingId).toBe("f-risk");
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
      const outcome = await brief();
      expect(outcome.reason).toBeTruthy();
      expect(outcome.synthesis?.primaryFindingId).toBe("f-risk");
      expect(outcome.synthesis?.headline).not.toBe(reply.headline === good.headline ? "__never__" : reply.headline);
      expect(calls).toBe(2);
    }
  });

  it("requires the ranked primary: a missing or different primaryFindingId is rejected", async () => {
    const { primaryFindingId: _omit, ...withoutPrimary } = good;
    for (const reply of [withoutPrimary, { ...good, primaryFindingId: "f-belt" }, { ...good, primaryFindingId: "f-godavari", headline: "Godavari Organics is at risk today" }]) {
      useSynthesisModel(async () => reply);
      const outcome = await brief();
      expect(outcome.reason).toMatch(/primaryFindingId/);
      // The deterministic primary's own title stands in.
      expect(outcome.synthesis?.headline).toBe("905 parcels promised today are not on a truck");
    }
  });

  it("checks headline and whyItMatters figures against the reconciled set: 902 and 218 are refused", async () => {
    const cases = [
      { ...good, headline: "Godavari Organics has 218 parcels at risk today" },
      { ...good, whyItMatters: "Godavari Organics has 218 of them." },
      { ...good, headline: "902 parcels at risk today" },
      { ...good, steps: [{ text: "Godavari Organics accounts for 218.", kind: "observed", findingIds: ["f-godavari"] }] },
    ];
    for (const reply of cases) {
      useSynthesisModel(async () => reply);
      const outcome = await brief();
      expect(outcome.reason).toMatch(/reconciled|not in the findings/);
    }
    // 902 is refused even when a finding mentions it, once reconciliation drops it as a conflict.
    const conflicting = [...findings, finding("f-902", "customers", "902 parcels at risk", "Disagrees.",
      { name: "Parcels at risk today", value: 902, unit: "parcels", aggregation: "count", metricId: "parcels_at_risk_today", scope: { type: "network" } }, "totals.atRisk")];
    useSynthesisModel(async () => ({ ...good, headline: "902 parcels at risk today" }));
    const outcome = await synthesize({ objective: "brief me", audience: "COO", findings: conflicting, reconciled: reconcileMetrics(conflicting) });
    // With 905 vs 902 dropped, the qualitative belt fault leads; the model's 902 headline is refused.
    expect(outcome.briefingPlan?.primary?.findingId).toBe("f-belt");
    expect(outcome.reason).toMatch(/reconciled|primaryFindingId/);
    expect(outcome.synthesis?.headline).not.toMatch(/902|905|218/);
  });

  it("rejects a model chain hop that repeats the headline or carries its figure (A1)", async () => {
    for (const hop of [
      { text: "A sorter fault at Hyderabad has left 905 parcels at risk today", kind: "observed", findingIds: ["f-risk"] },
      { text: "That leaves 905 parcels off the trucks.", kind: "inferred", findingIds: ["f-belt", "f-risk"] },
    ]) {
      let calls = 0;
      useSynthesisModel(async () => { calls += 1; return { ...good, chain: [{ text: "Sorter belt B has been down since 22:10.", kind: "observed", findingIds: ["f-belt"] }, hop] }; });
      const outcome = await brief();
      expect(outcome.reason).toMatch(/repeats the headline or its figure/);
      expect(calls).toBe(2);
      // The deterministic chain stands in, and it does not repeat the headline either.
      for (const step of outcome.synthesis?.chain ?? []) expect(step.text).not.toMatch(/\b905\b/);
    }
    useSynthesisModel(async () => ({ ...good, chain: [{ text: "Sorter belt B has been down since 22:10.", kind: "observed", findingIds: ["f-belt"] }] }));
    expect((await brief()).reason).toBeUndefined();
  });

  it("gates the deterministic headline on reconciled figures and falls back to the metric label (A3)", async () => {
    // The primary's own title carries Godavari's of-which 218: not a reconciled headline figure.
    const noisy = findings.map((item) => (item.findingId === "f-risk" ? { ...item, title: "905 parcels at risk today, 218 of them Godavari's", summary: "218 belong to Godavari Organics." } : item));
    const outcome = await synthesize({ objective: "brief me", audience: "COO", findings: noisy, reconciled: reconcileMetrics(noisy) });
    expect(outcome.briefingPlan?.primary?.findingId).toBe("f-risk");
    expect(outcome.synthesis?.headline).toBe("Parcels at risk today");
    expect(outcome.synthesis?.whyItMatters).not.toMatch(/218/);
    // A clean title passes the gate unchanged.
    expect((await brief()).synthesis?.headline).toBe("905 parcels promised today are not on a truck");
  });

  it("uses the rejection as feedback for the retry", async () => {
    useSynthesisModel(async (_request, feedback) => (feedback ? good : { ...good, headline: "9,999 parcels at risk" }));
    expect((await brief()).synthesis?.headline).toBe(good.headline);
  });
});

describe("a question end to end, without a model", () => {
  it("briefs the COO from all four specialists with evidence behind every finding", async () => {
    const state = await runInvestigation({ question: "Brief me: what needs my attention this morning?", threadId: "t-brief", principal: coo });
    expect(state.status).toBe("completed");
    const started = state.activity.filter((item) => item.kind === "agent_started").map((item) => item.message).sort();
    expect(started).toEqual(["Customers Agent started", "Last-Mile Agent started", "Network Agent started", "Shipments Agent started"]);
    expect(validateA2UI(state.surface!.messages as never)).toEqual([]);
    expect(state.surface!.title).toMatch(/at risk|905|Hyderabad|sorter|fault/i);
    expect(JSON.stringify(state.activity)).not.toMatch(/Contradictory records/i);
    const components = ((state.surface!.messages as Array<Record<string, unknown>>).find((message) => "updateComponents" in message) as unknown as { updateComponents: { components: Array<{ component?: string; id?: string }> } }).updateComponents.components;
    expect(components.filter((component) => component.component === "PrimaryFinding")).toHaveLength(1);
    expect(components.filter((component) => component.component === "Stat")).toHaveLength(0);
    expect(components.filter((component) => component.component === "Card")).toHaveLength(0);
    expect(components.filter((component) => component.component === "Collapsible").length).toBeLessThanOrEqual(1);
    const briefing = (state.surface!.dataModel as { briefing: { primary: { metric: { metricId: string; value: string; denominatorLabel?: string; evidenceIds: string[] }; evidenceIds: string[] }; secondary: Record<string, { title: string; evidenceIds: string[] }> } }).briefing;
    expect(briefing.primary.metric).toMatchObject({ metricId: "parcels_at_risk_today", value: "905" });
    expect(briefing.primary.metric.denominatorLabel).toMatch(/of 4,000/);
    expect(Object.keys(briefing.secondary).length).toBeLessThanOrEqual(3);
    expect(Object.values(briefing.secondary).some((item) => /218/.test(item.title) && !/of the 905/.test(item.title))).toBe(false);
    expect(state.surface!.title).not.toMatch(/218|Godavari/);
    for (const id of [...briefing.primary.evidenceIds, ...briefing.primary.metric.evidenceIds, ...Object.values(briefing.secondary).flatMap((item) => item.evidenceIds)]) {
      expect(store.getEvidence(id, coo.id)).toBeTruthy();
    }
  }, 60_000);

  it("ranks the same primary with the same numbers across 5 runs", async () => {
    const normalize = (text: string) => text.replace(/task-([a-z_]+)-[0-9a-f]{8}/g, "task-$1").replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, "uuid");
    const snapshots: string[] = [];
    for (let run = 0; run < 5; run += 1) {
      const state = await runInvestigation({ question: "Brief me: what needs my attention this morning?", threadId: `t-determinism-${run}`, principal: coo });
      const model = state.surface!.dataModel as { title?: string; subtitle?: string; briefing?: { primary?: { findingId?: string; metric?: object }; secondary?: object } };
      snapshots.push(normalize(JSON.stringify({
        title: state.surface!.title,
        subtitle: model.subtitle,
        primaryFindingId: model.briefing?.primary?.findingId,
        metric: model.briefing?.primary?.metric,
        secondary: model.briefing?.secondary,
      })));
    }
    expect(new Set(snapshots).size).toBe(1);
    expect(snapshots[0]).toMatch(/parcels_at_risk_today/);
  }, 180_000);

  it("lets two people who fetch the same result each open their own evidence (A2)", async () => {
    const { openEvidence } = await import("./evidence-explain.js");
    const first = await runInvestigation({ question: "Brief me: what needs my attention this morning?", threadId: "t-ev-coo", principal: coo });
    const second = await runInvestigation({ question: "Brief me: what needs my attention this morning?", threadId: "t-ev-hub", principal: hubSupervisor });
    const idsOf = (state: typeof first) => (state.surface!.dataModel as { briefing: { primary: { evidenceIds: string[] } } }).briefing.primary.evidenceIds;
    const shared = idsOf(first).filter((id) => idsOf(second).includes(id));
    // Same lookup, same result, same hash id: the collision this fix is about.
    expect(shared.length).toBeGreaterThan(0);
    for (const id of shared) {
      expect(store.getEvidence(id, coo.id), id).toBeTruthy();
      expect(store.getEvidence(id, hubSupervisor.id), id).toBeTruthy();
      expect(openEvidence(store, coo, id).status, id).toBe(200);
      expect(openEvidence(store, hubSupervisor, id).status, id).toBe(200);
    }
  }, 120_000);

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
    const failedBriefing = (state.surface!.dataModel as { briefing?: { primary?: object; secondary?: object } }).briefing;
    expect(Boolean(failedBriefing?.primary) || Object.keys(failedBriefing?.secondary ?? {}).length > 0).toBe(true);
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

describe("briefing actions (P4)", () => {
  const BRIEF = "Brief me: what needs my attention this morning?";
  const act = (threadId: string, principal: typeof coo, name: string, extra: Record<string, unknown> = {}) => {
    const current = publicState(threadId, principal.id);
    return handleAction({ name, threadId, surfaceId: current.surface?.surfaceId, surfaceRevision: current.surface?.revision, ...extra }, principal);
  };
  type Briefing = { actions: Array<{ id: string; label: string; name: string; entities: Array<{ type: string; id: string }> }>; pending?: { proposalId: string; actionId: string; text: string; blocked?: boolean }; primary?: { receipts?: Array<{ status: string; text: string; actionId: string; evidenceIds: string[] }> } };
  const briefingOf = (state: Awaited<ReturnType<typeof publicState>>) => (state.surface!.dataModel as { briefing: Briefing }).briefing;
  const buttonsOf = (state: Awaited<ReturnType<typeof publicState>>) => {
    const components = ((state.surface!.messages as Array<Record<string, unknown>>).find((message) => "updateComponents" in message) as { updateComponents: { components: Array<Record<string, unknown>> } }).updateComponents.components;
    return components.filter((component) => component.component === "Button").map((component) => (component.action as { event: { name: string } }).event.name);
  };
  const companyDb = async () => {
    const { openLogisticsDatabase } = await import("@anc/logistics-db");
    return openLogisticsDatabase(process.env.LOGISTICS_DB_PATH!, true);
  };
  const snapshot = async () => {
    const db = await companyDb();
    try {
      return {
        equipment: db.prepare("SELECT id, escalated_to escalatedTo, escalated_at IS NOT NULL escalated, version FROM equipment_events ORDER BY id").all() as Array<{ id: string; escalatedTo: string | null; escalated: number; version: number }>,
        notifications: db.prepare("SELECT shipper_id shipperId, account_manager_id accountManagerId, topic, status, requested_by requestedBy FROM shipper_notifications ORDER BY id").all(),
        lateAtRisk: db.prepare(`SELECT c.id, c.assignee_id assigneeId, c.version FROM complaints c JOIN shipments s ON s.id = c.shipment_id
          WHERE c.status = 'open' AND c.category = 'late' AND substr(s.promised_by, 1, 10) = '2026-09-21' AND s.status IN ('at_hub', 'sorted') ORDER BY c.id`).all() as Array<{ id: string; assigneeId: string | null; version: number }>,
        complaints: db.prepare("SELECT COUNT(*) n, SUM(version) v FROM complaints").get() as { n: number; v: number },
      };
    } finally {
      db.close();
    }
  };

  it("offers at most three catalog actions, bound by the runtime to the records on the primary card, and only to people granted them", async () => {
    const cooState = await runInvestigation({ question: BRIEF, threadId: "t-act-offer-coo", principal: coo });
    const offered = briefingOf(cooState).actions;
    expect(offered.map((action) => [action.id, action.name, action.label])).toEqual([
      ["escalate_equipment_fault", "propose_action", "Escalate Sorter belt B fault"],
      ["notify_shipper", "propose_action", "Notify Godavari Organics"],
      ["assign_complaints", "propose_action", "Assign late complaints"],
    ]);
    expect(offered[0]!.entities).toEqual([expect.objectContaining({ type: "equipment", id: "eq-hyd-0920" })]);
    expect(offered[1]!.entities).toEqual([expect.objectContaining({ type: "shipper", id: "shipper-003" })]);
    expect(buttonsOf(cooState).filter((name) => name !== "show_evidence" && name !== "investigate")).toHaveLength(3);

    const hub = briefingOf(await runInvestigation({ question: BRIEF, threadId: "t-act-offer-hub", principal: hubSupervisor })).actions.map((action) => action.id);
    expect(hub).toEqual(["escalate_equipment_fault", "drill_primary"]);
    const accounts = briefingOf(await runInvestigation({ question: BRIEF, threadId: "t-act-offer-am", principal: accountManager })).actions.map((action) => action.id);
    expect(accounts).toEqual(["notify_shipper", "drill_primary"]);
    // Someone without the grant never sees the button, and a forged one is refused before any read.
    await expect(act("t-act-offer-am", accountManager, "propose_action", { parameters: { actionId: "escalate_equipment_fault" } })).rejects.toThrow(/Not authorized/);
    // An action the surface does not offer cannot be proposed either.
    await expect(act("t-act-offer-hub", hubSupervisor, "propose_action", { parameters: { actionId: "notify_shipper" } })).rejects.toThrow(/Not authorized/);
  }, 120_000);

  it("specialist connections cannot write: the company server refuses a write tool on a read client", async () => {
    const { CompanyMcpClient } = await import("./mcp-client.js");
    const before = await snapshot();
    const client = new CompanyMcpClient(store, { runId: "t-read-only", principalId: coo.id });
    await client.connect();
    try {
      await expect(client.call("escalate_equipment_fault", { eventId: "eq-hyd-0920", expectedVersion: 1 })).rejects.toThrow(/read-only/);
      await expect(client.call("notify_shipper", { shipperId: "shipper-003", topic: "t", message: "m", idempotencyKey: "read-only-probe", requestedBy: coo.id })).rejects.toThrow(/read-only/);
    } finally {
      await client.close();
    }
    expect(await snapshot()).toEqual(before);
  }, 60_000);

  it("cancel restores the action row and writes nothing", async () => {
    const thread = "t-act-cancel";
    const brief = await runInvestigation({ question: BRIEF, threadId: thread, principal: coo });
    const before = await snapshot();
    const proposed = await act(thread, coo, "propose_action", { parameters: { actionId: "escalate_equipment_fault" } });
    expect(proposed.surface!.surfaceId).toBe(brief.surface!.surfaceId);
    expect(proposed.surface!.revision).toBe(brief.surface!.revision + 1);
    const pending = briefingOf(proposed).pending!;
    expect(pending.text).toMatch(/Escalate Sorter belt B at Hyderabad Hub \(eq-hyd-0920\) to Venkatesh Rao/);
    expect(buttonsOf(proposed)).toEqual(expect.arrayContaining(["confirm_action", "cancel_action"]));
    expect(buttonsOf(proposed)).not.toContain("propose_action");
    const cancelled = await act(thread, coo, "cancel_action", { parameters: { proposalId: pending.proposalId } });
    expect(cancelled.surface!.revision).toBe(brief.surface!.revision + 2);
    expect(briefingOf(cancelled).pending).toBeUndefined();
    expect(briefingOf(cancelled).actions.map((action) => action.id)).toEqual(briefingOf(brief).actions.map((action) => action.id));
    expect(await snapshot()).toEqual(before);
    // The cancelled proposal cannot be confirmed.
    await expect(handleAction({ name: "confirm_action", threadId: thread, parameters: { proposalId: pending.proposalId } }, coo)).rejects.toThrow(/no longer valid/);
  }, 120_000);

  it("refuses a stale version: nothing is written and the action stays to be proposed again", async () => {
    const thread = "t-act-stale";
    await runInvestigation({ question: BRIEF, threadId: thread, principal: coo });
    const proposed = await act(thread, coo, "propose_action", { parameters: { actionId: "escalate_equipment_fault" } });
    // Someone else changes the fault between propose and confirm.
    const { openLogisticsDatabase } = await import("@anc/logistics-db");
    const writer = openLogisticsDatabase(process.env.LOGISTICS_DB_PATH!);
    writer.prepare("UPDATE equipment_events SET version = version + 1 WHERE id = 'eq-hyd-0920'").run();
    writer.close();
    const before = await snapshot();
    const refused = await act(thread, coo, "confirm_action", { parameters: { proposalId: briefingOf(proposed).pending!.proposalId } });
    expect(await snapshot()).toEqual(before);
    const receipt = briefingOf(refused).primary!.receipts!.at(-1)!;
    expect(receipt.status).toBe("failed");
    expect(receipt.text).toMatch(/Not done: the record changed after it was read \(someone else changed it first\)/);
    // Person wording: no tool name, no raw error.
    expect(receipt.text).not.toMatch(/Company tool|escalate_equipment_fault|stale/);
    expect(briefingOf(refused).actions.map((action) => action.id)).toContain("escalate_equipment_fault");
  }, 120_000);

  it("a proposal can only be confirmed on the thread it was made on (Reviewer M3)", async () => {
    const thread = "t-act-thread";
    await runInvestigation({ question: BRIEF, threadId: thread, principal: coo });
    const before = await snapshot();
    const proposed = await act(thread, coo, "propose_action", { parameters: { actionId: "escalate_equipment_fault" } });
    const proposalId = briefingOf(proposed).pending!.proposalId;
    await expect(handleAction({ name: "confirm_action", threadId: "t-act-thread-other", parameters: { proposalId } }, coo)).rejects.toThrow(/Proposal not found/);
    await expect(handleAction({ name: "cancel_action", threadId: "t-act-thread-other", parameters: { proposalId } }, coo)).rejects.toThrow(/Proposal not found/);
    expect(await snapshot()).toEqual(before);
    expect(store.getProposal(proposalId, coo.id)!.status).toBe("prepared");
    await act(thread, coo, "cancel_action", { parameters: { proposalId } });
  }, 120_000);

  it("an expired proposal clears the inline confirm and says why on the card; nothing is written (Reviewer M3)", async () => {
    const thread = "t-act-expired";
    await runInvestigation({ question: BRIEF, threadId: thread, principal: coo });
    const proposed = await act(thread, coo, "propose_action", { parameters: { actionId: "escalate_equipment_fault" } });
    const proposalId = briefingOf(proposed).pending!.proposalId;
    const proposal = store.getProposal(proposalId, coo.id)!;
    store.saveProposal({ ...proposal, ownerId: coo.id, expiresAt: "2026-09-21T01:00:00.000Z", now: new Date().toISOString() });
    const before = await snapshot();
    const after = await act(thread, coo, "confirm_action", { parameters: { proposalId } });
    expect(await snapshot()).toEqual(before);
    const briefing = briefingOf(after);
    expect(briefing.pending).toBeUndefined();
    expect(buttonsOf(after)).not.toContain("confirm_action");
    expect(briefing.primary!.receipts!.at(-1)).toMatchObject({ status: "failed", actionId: "escalate_equipment_fault" });
    expect(briefing.primary!.receipts!.at(-1)!.text).toMatch(/^Not done: this confirmation expired.*Nothing was written; propose it again/);
    expect(briefing.actions.map((action) => action.id)).toContain("escalate_equipment_fault");
    expect(store.getProposal(proposalId, coo.id)!.status).toBe("expired");
  }, 120_000);

  it("escalates the fault: propose, confirm, row changed, re-read, receipt on the same surface; a double click is a no-op", async () => {
    const thread = "t-act-escalate";
    const brief = await runInvestigation({ question: BRIEF, threadId: thread, principal: coo });
    const before = await snapshot();
    const proposed = await act(thread, coo, "propose_action", { parameters: { actionId: "escalate_equipment_fault" } });
    // A second click on the old revision does nothing.
    const again = await handleAction({ name: "propose_action", threadId: thread, surfaceId: brief.surface!.surfaceId, surfaceRevision: brief.surface!.revision, parameters: { actionId: "escalate_equipment_fault" } }, coo);
    expect(again.surface!.revision).toBe(proposed.surface!.revision);
    expect(await snapshot()).toEqual(before);
    const proposalId = briefingOf(proposed).pending!.proposalId;
    // Two confirms at once (a double click): one write.
    const [done] = await Promise.all([
      act(thread, coo, "confirm_action", { parameters: { proposalId } }),
      act(thread, coo, "confirm_action", { parameters: { proposalId } }),
    ]);
    const after = await snapshot();
    const hyd = (rows: typeof before.equipment) => rows.find((row) => row.id === "eq-hyd-0920")!;
    expect(hyd(before.equipment)).toMatchObject({ escalatedTo: null, escalated: 0 });
    expect(hyd(after.equipment)).toEqual({ ...hyd(before.equipment), escalatedTo: "emp-eng-hyd", escalated: 1, version: hyd(before.equipment).version + 1 });
    expect(after.equipment.filter((row) => row.id !== "eq-hyd-0920")).toEqual(before.equipment.filter((row) => row.id !== "eq-hyd-0920"));
    expect({ ...after, equipment: [] }).toEqual({ ...before, equipment: [] });
    const final = publicState(thread, coo.id);
    expect(final.surface!.surfaceId).toBe(brief.surface!.surfaceId);
    expect(final.surface!.revision).toBe(proposed.surface!.revision + 1);
    expect(done.surface!.revision).toBeGreaterThanOrEqual(proposed.surface!.revision);
    const briefing = briefingOf(final);
    expect(briefing.pending).toBeUndefined();
    const receipt = briefing.primary!.receipts!.at(-1)!;
    expect(receipt).toMatchObject({ status: "succeeded", actionId: "escalate_equipment_fault" });
    expect(receipt.text).toMatch(/^Escalated Sorter belt B to Venkatesh Rao at 07:00 IST · maintenance log updated · receipt op-/);
    expect(receipt.evidenceIds[0]).toMatch(/^list_equipment_events-/);
    expect(briefing.actions.map((action) => action.id)).not.toContain("escalate_equipment_fault");
    // A late duplicate confirm is a no-op too.
    await handleAction({ name: "confirm_action", threadId: thread, parameters: { proposalId } }, coo);
    expect(await snapshot()).toEqual(after);
    expect(store.listAudit(coo.id).filter((entry) => entry.action === "operation.commit" && entry.resource === "equipment:eq-hyd-0920" && entry.outcome === "succeeded")).toHaveLength(1);
    // The next briefing reads the escalation and does not offer it again.
    const next = await runInvestigation({ question: BRIEF, threadId: "t-act-after-escalate", principal: coo });
    expect(briefingOf(next).actions.map((action) => action.id)).toEqual(["notify_shipper", "assign_complaints", "drill_primary"]);
  }, 180_000);

  it("a later success clears the old \"Not done: expired\" receipt for that action", async () => {
    const { openLogisticsDatabase } = await import("@anc/logistics-db");
    const writer = openLogisticsDatabase(process.env.LOGISTICS_DB_PATH!);
    writer.prepare("UPDATE equipment_events SET escalated_to = NULL, escalated_at = NULL, version = version + 1 WHERE id = 'eq-hyd-0920'").run();
    writer.close();
    const thread = "t-act-expired-then-done";
    await runInvestigation({ question: BRIEF, threadId: thread, principal: coo });
    const first = await act(thread, coo, "propose_action", { parameters: { actionId: "escalate_equipment_fault" } });
    const lapsed = briefingOf(first).pending!.proposalId;
    store.saveProposal({ ...store.getProposal(lapsed, coo.id)!, ownerId: coo.id, expiresAt: "2026-09-21T01:00:00.000Z", now: new Date().toISOString() });
    const expired = await act(thread, coo, "confirm_action", { parameters: { proposalId: lapsed } });
    expect(briefingOf(expired).primary!.receipts!.map((item) => item.status)).toEqual(["failed"]);
    const again = await act(thread, coo, "propose_action", { parameters: { actionId: "escalate_equipment_fault" } });
    const done = await act(thread, coo, "confirm_action", { parameters: { proposalId: briefingOf(again).pending!.proposalId } });
    const receipts = briefingOf(done).primary!.receipts!;
    expect(receipts).toHaveLength(1);
    expect(receipts[0]).toMatchObject({ status: "succeeded", actionId: "escalate_equipment_fault" });
    expect(receipts.some((item) => /expired/.test(item.text))).toBe(false);
  }, 180_000);

  it("a write that succeeded but cannot be re-read still gets a succeeded receipt and stays committed (Reviewer M1)", async () => {
    // Re-open the fault the previous test escalated, so it is offered again.
    const { openLogisticsDatabase } = await import("@anc/logistics-db");
    const writer = openLogisticsDatabase(process.env.LOGISTICS_DB_PATH!);
    writer.prepare("UPDATE equipment_events SET escalated_to = NULL, escalated_at = NULL, version = version + 1 WHERE id = 'eq-hyd-0920'").run();
    writer.close();
    const thread = "t-act-reread";
    await runInvestigation({ question: BRIEF, threadId: thread, principal: coo });
    const proposed = await act(thread, coo, "propose_action", { parameters: { actionId: "escalate_equipment_fault" } });
    const proposalId = briefingOf(proposed).pending!.proposalId;
    const { CompanyMcpClient } = await import("./mcp-client.js");
    const original = CompanyMcpClient.prototype.call;
    const spy = vi.spyOn(CompanyMcpClient.prototype, "call").mockImplementation(function (this: InstanceType<typeof CompanyMcpClient>, ...args: Parameters<typeof original>) {
      const runId = (this as unknown as { ctx?: { runId?: string } }).ctx?.runId ?? "";
      if (runId.startsWith("reread-")) return Promise.reject(new Error("company server unavailable"));
      return original.apply(this, args);
    });
    try {
      const done = await act(thread, coo, "confirm_action", { parameters: { proposalId } });
      const receipt = briefingOf(done).primary!.receipts!.at(-1)!;
      expect(receipt).toMatchObject({ status: "succeeded", actionId: "escalate_equipment_fault", evidenceIds: [] });
      expect(receipt.text).toMatch(/^Escalated Sorter belt B to Venkatesh Rao · done, but the record could not be re-read to confirm it just now · receipt op-/);
      expect(briefingOf(done).pending).toBeUndefined();
      expect(briefingOf(done).actions.map((action) => action.id)).not.toContain("escalate_equipment_fault");
    } finally {
      spy.mockRestore();
    }
    expect(store.getProposal(proposalId, coo.id)!.status).toBe("committed");
    const hyd = (await snapshot()).equipment.find((row) => row.id === "eq-hyd-0920")!;
    expect(hyd).toMatchObject({ escalatedTo: "emp-eng-hyd", escalated: 1 });
  }, 180_000);

  it("queues a notice for Godavari Organics' account manager and sends nothing", async () => {
    const thread = "t-act-notify";
    await runInvestigation({ question: BRIEF, threadId: thread, principal: coo });
    const before = await snapshot();
    const proposed = await act(thread, coo, "propose_action", { parameters: { actionId: "notify_shipper" } });
    // The idempotency key's day comes from the data's "as of" date (the demo clock), not a constant (Reviewer M4).
    expect(store.getProposal(briefingOf(proposed).pending!.proposalId, coo.id)!.payload.idempotencyKey).toBe("notify:shipper-003:at-risk-today:2026-09-21");
    expect(briefingOf(proposed).pending!.text).toMatch(/Queue a delay notice for Godavari Organics with their account manager, Arjun Mehta\?.*Nothing is sent to the shipper\./);
    const done = await act(thread, coo, "confirm_action", { parameters: { proposalId: briefingOf(proposed).pending!.proposalId } });
    const after = await snapshot();
    expect(before.notifications).toEqual([]);
    expect(after.notifications).toEqual([{ shipperId: "shipper-003", accountManagerId: "emp-am-1", topic: "at-risk-today", status: "queued", requestedBy: coo.id }]);
    expect({ ...after, notifications: [] }).toEqual({ ...before, notifications: [] });
    expect(briefingOf(done).primary!.receipts!.at(-1)!.text).toMatch(/^Notice for Godavari Organics queued for account manager Arjun Mehta at 07:00 IST · nothing was sent · receipt op-/);
    // The next briefing reads the queued notice and does not offer it again (Reviewer M5),
    // and a forged propose for it is refused.
    const thread2 = "t-act-notify-2";
    const next = await runInvestigation({ question: BRIEF, threadId: thread2, principal: coo });
    expect(briefingOf(next).actions.map((action) => action.id)).not.toContain("notify_shipper");
    expect(briefingOf(next).actions.map((action) => action.id)).toContain("assign_complaints");
    await expect(act(thread2, coo, "propose_action", { parameters: { actionId: "notify_shipper" } })).rejects.toThrow(/not offered/);
  }, 180_000);

  it("assigns the open late complaints about today's at-risk parcels across the care team", async () => {
    const thread = "t-act-assign";
    await runInvestigation({ question: BRIEF, threadId: thread, principal: coo });
    const before = await snapshot();
    const open = before.lateAtRisk.filter((row) => row.assigneeId === null);
    expect(open.length).toBeGreaterThan(5);
    const proposed = await act(thread, coo, "propose_action", { parameters: { actionId: "assign_complaints" } });
    expect(briefingOf(proposed).pending!.text).toMatch(new RegExp(`^Assign ${open.length} open late complaints`));
    const done = await act(thread, coo, "confirm_action", { parameters: { proposalId: briefingOf(proposed).pending!.proposalId } });
    const after = await snapshot();
    const changed = after.lateAtRisk.filter((row) => open.some((item) => item.id === row.id));
    expect(changed.every((row) => ["emp-care-1", "emp-care-2", "emp-care-3"].includes(row.assigneeId ?? ""))).toBe(true);
    expect(changed.every((row) => row.version === open.find((item) => item.id === row.id)!.version + 1)).toBe(true);
    expect(after.complaints.v - before.complaints.v).toBe(open.length);
    expect({ ...after, lateAtRisk: [], complaints: { n: 0, v: 0 } }).toEqual({ ...before, lateAtRisk: [], complaints: { n: 0, v: 0 } });
    expect(briefingOf(done).primary!.receipts!.at(-1)!.text).toMatch(new RegExp(`^Assigned ${open.length} late complaints to Farah Siddiqui, Karthik Iyer, Sneha Kulkarni · 0 still without an owner · receipt op-`));
    // With no late at-risk complaint left unowned, the next briefing does not offer it again (Reviewer M5).
    const next = await runInvestigation({ question: BRIEF, threadId: "t-act-after-assign", principal: coo });
    expect(briefingOf(next).actions.map((action) => action.id)).not.toContain("assign_complaints");
  }, 180_000);
});

describe("follow-ups replace the body, not append (P5)", () => {
  const BRIEF = "Brief me: what needs my attention this morning?";
  type Surface = NonNullable<ReturnType<typeof publicState>["surface"]>;
  const componentsOf = (surface: Surface) => ((surface.messages as Array<Record<string, unknown>>).find((message) => "updateComponents" in message) as { updateComponents: { components: Array<Record<string, unknown>> } }).updateComponents.components;
  const count = (surface: Surface, type: string) => componentsOf(surface).filter((component) => component.component === type).length;
  const anchors = (surface: Surface) => count(surface, "PrimaryFinding") + count(surface, "ContextHeader");
  const contextOf = (surface: Surface) => (surface.dataModel as { context?: { label: string; surfaceId: string; revision: number } }).context;

  it("drills under a context header on the same surface, keeps one anchor per turn, starts a new topic fresh, and Back restores revision N", async () => {
    const thread = "t-followups";
    const brief = (await runInvestigation({ question: BRIEF, threadId: thread, principal: coo })).surface!;
    const n = brief.revision;
    expect(anchors(brief)).toBe(1);
    expect(count(brief, "PrimaryFinding")).toBe(1);
    const secondary = Object.values((brief.dataModel as { briefing: { secondary: Record<string, { title: string; question: string }> } }).briefing.secondary);
    expect(secondary.length).toBeGreaterThan(0);

    // 1: "Look into this" on a secondary item.
    const drill1 = (await runInvestigation({ question: secondary[0]!.question, threadId: thread, principal: coo })).surface!;
    expect(drill1.surfaceId).toBe(brief.surfaceId);
    expect(drill1.revision).toBe(n + 1);
    expect(count(drill1, "ContextHeader")).toBe(1);
    expect(count(drill1, "PrimaryFinding")).toBe(0);
    expect(anchors(drill1)).toBe(1);
    expect(contextOf(drill1)).toEqual({ label: secondary[0]!.title, surfaceId: brief.surfaceId, revision: n });
    expect(componentsOf(drill1).find((component) => component.id === "root")!.children).toEqual(expect.arrayContaining(["context_header"]));
    expect((componentsOf(drill1).find((component) => component.id === "root")!.children as string[])[0]).toBe("context_header");

    // 2: a typed question about a record the briefing showed: still a drill from the same briefing.
    const drill2 = (await runInvestigation({ question: "How is Godavari Organics doing on on-time delivery?", threadId: thread, principal: coo })).surface!;
    expect(drill2.revision).toBe(n + 2);
    expect(drill2.title).not.toBe("Not available");
    expect(drill1.title).not.toBe("Not available");
    expect(anchors(drill2)).toBe(1);
    expect(contextOf(drill2)).toEqual({ label: "Godavari Organics", surfaceId: brief.surfaceId, revision: n });

    // 3: a new briefing is a new topic: fresh plan, no context header.
    const again = (await runInvestigation({ question: BRIEF, threadId: thread, principal: coo })).surface!;
    expect(again.revision).toBe(n + 3);
    expect(count(again, "ContextHeader")).toBe(0);
    expect(count(again, "PrimaryFinding")).toBe(1);
    expect(count(again, "Card")).toBe(count(brief, "Card"));
    // Earlier revisions are kept, not overwritten.
    expect(store.getSurface(brief.surfaceId, n)!.title).toBe(brief.title);
    expect(store.getSurface(brief.surfaceId, n + 1)!.dataModel).toEqual(drill1.dataModel);

    // An unrelated question after a drill is a new topic too.
    const lockers = (await runInvestigation({ question: "Which parcel lockers are full?", threadId: thread, principal: coo })).surface!;
    expect(lockers.revision).toBe(n + 4);
    expect(count(lockers, "ContextHeader")).toBe(0);

    // Back from a drill restores exactly the briefing revision it came from.
    const hubBrief = (await runInvestigation({ question: BRIEF, threadId: "t-followups-back", principal: hubSupervisor })).surface!;
    const drillQuestion = ((hubBrief.dataModel as { briefing: { actions: Array<{ id: string; question?: string }> } }).briefing.actions.find((action) => action.id === "drill_primary"))!.question!;
    const drill = (await runInvestigation({ question: drillQuestion, threadId: "t-followups-back", principal: hubSupervisor })).surface!;
    expect(contextOf(drill)).toMatchObject({ surfaceId: hubBrief.surfaceId, revision: hubBrief.revision });
    const back = await handleAction({ name: "back_to_briefing", threadId: "t-followups-back", surfaceId: drill.surfaceId, surfaceRevision: drill.revision, parameters: contextOf(drill) }, hubSupervisor);
    expect(back.surface!.revision).toBe(hubBrief.revision);
    expect(count(back.surface!, "PrimaryFinding")).toBe(1);
    expect(count(back.surface!, "ContextHeader")).toBe(0);
    // Another thread's revision cannot be restored into this one.
    await expect(handleAction({ name: "back_to_briefing", threadId: "t-followups-back", parameters: { surfaceId: brief.surfaceId, revision: n } }, hubSupervisor)).rejects.toThrow(/unknown surface revision/);
  }, 240_000);

  it("ends the trace with one summary line: agents and lookups", async () => {
    const state = await runInvestigation({ question: BRIEF, threadId: "t-trace", principal: coo });
    const last = state.activity.find((item) => item.kind === "investigation_completed")!;
    expect(last.message).toMatch(/^Workspace ready · 4 agents · \d+ lookups$/);
  }, 60_000);
});
