import { describe, expect, it } from "vitest";
import type { AgentFinding } from "@anc/contracts";
import { resolvePrincipal } from "@anc/policy";
import { applyActionOrder, reviewActionOrder, selectBriefingActions } from "./action-catalog.js";
import { businessDate } from "./operations.js";

const finding = (findingId: string, title: string, entities: AgentFinding["entities"]): AgentFinding => ({
  findingId, taskId: "t", agentId: "a", kind: "observation", title, summary: title, severity: "high", createdAt: "2026-09-21T03:00:00.000Z", limitations: [], entities,
  claims: [{ claimId: "c", statement: title, evidenceIds: ["e-1"], resultPaths: [], entities: [], metrics: [], limitations: [], contradictoryEvidenceIds: [] }],
});

const atRisk = finding("f-risk", "905 parcels at risk today", [{ type: "hub", id: "hub-hyd" }]);
const fault = finding("f-fault", "Hyderabad Hub: Sorter belt B fault", [{ type: "equipment", id: "eq-hyd-0920" }]);
const shipper = finding("f-shipper", "Godavari Organics: 140 parcels at risk", [{ type: "shipper", id: "shipper-003", label: "Godavari Organics" }]);
const coo = resolvePrincipal("user-coo");

describe("briefing action catalog (R6)", () => {
  it("binds each action to the first record of its type on the primary card, in catalog order, at most three", () => {
    const actions = selectBriefingActions({ primary: atRisk, related: [fault, shipper], metricId: "parcels_at_risk_today", principal: coo });
    expect(actions).toEqual([
      { id: "escalate_equipment_fault", label: "Escalate Sorter belt B fault", entities: [{ type: "equipment", id: "eq-hyd-0920", label: "Sorter belt B" }] },
      { id: "notify_shipper", label: "Notify Godavari Organics", entities: [{ type: "shipper", id: "shipper-003", label: "Godavari Organics" }] },
      { id: "assign_complaints", label: "Assign late complaints", entities: [] },
    ]);
  });

  it("offers nothing for records that are not on the card, actions not granted, or work already done", () => {
    expect(selectBriefingActions({ primary: atRisk, related: [], metricId: "hub_backlog", principal: coo })).toEqual([]);
    expect(selectBriefingActions({ primary: atRisk, related: [fault, shipper], metricId: "parcels_at_risk_today", principal: resolvePrincipal("user-accounts") }).map((action) => action.id)).toEqual(["notify_shipper"]);
    expect(selectBriefingActions({ primary: atRisk, related: [fault, shipper], metricId: "parcels_at_risk_today", principal: resolvePrincipal("user-care") }).map((action) => action.id)).toEqual(["assign_complaints"]);
    expect(selectBriefingActions({ primary: atRisk, related: [fault], principal: coo, completed: new Set(["escalate_equipment_fault:eq-hyd-0920"]) })).toEqual([]);    expect(selectBriefingActions({ primary: atRisk, related: [fault, shipper], metricId: "parcels_at_risk_today", principal: coo, completed: new Set(["notify_shipper:shipper-003", "assign_complaints:late-at-risk"]) }).map((action) => action.id)).toEqual(["escalate_equipment_fault"]);
  });

  it("offers nothing when there is no principal: no principal means no grants (Reviewer M6)", () => {
    expect(selectBriefingActions({ primary: atRisk, related: [fault, shipper], metricId: "parcels_at_risk_today" })).toEqual([]);
  });

  it("dates notify idempotency keys from the data's as-of date, else the demo clock (Reviewer M4)", () => {
    expect(businessDate("2026-09-22T07:00:00.000+05:30")).toBe("2026-09-22");
    expect(businessDate(undefined)).toBe("2026-09-21");
    expect(businessDate("yesterday")).toBe("2026-09-21");
  });

  it("lets the Lead Analyst reorder the actions but not add, drop or repeat one", () => {
    const planned = selectBriefingActions({ primary: atRisk, related: [fault, shipper], metricId: "parcels_at_risk_today", principal: coo });
    const order = ["notify_shipper", "escalate_equipment_fault", "assign_complaints"];
    expect(reviewActionOrder(order, planned)).toEqual([]);
    expect(applyActionOrder(planned, order).map((action) => action.id)).toEqual(order);
    expect(reviewActionOrder(undefined, planned)).toEqual([]);
    expect(reviewActionOrder([...order, "reroute_parcels"], planned).join(" ")).toMatch(/reroute_parcels, which is not one of the plan's actions/);
    expect(reviewActionOrder(["notify_shipper", "assign_complaints"], planned).join(" ")).toMatch(/escalate_equipment_fault is missing/);
    expect(reviewActionOrder([...order, "notify_shipper"], planned).join(" ")).toMatch(/repeats/);
  });
});
