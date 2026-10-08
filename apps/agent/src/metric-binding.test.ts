import { describe, expect, it } from "vitest";
import type { Metric } from "@anc/contracts";
import { bindClaimMetric } from "./metric-binding.js";
import { validateFinding } from "./validation.js";

const AS_OF = "2026-09-21T07:00:00.000+05:30";
const EVIDENCE: Record<string, Record<string, unknown>> = {
  "ev-risk": { tool: "summarize_at_risk_shipments", arguments: { groupBy: "district" }, dataAsOf: AS_OF, result: { rows: [], totals: { atRisk: 905, unsorted: 595, sortedNotLoaded: 310, promisedToday: 4000 } } },
  "ev-risk-hyd": { tool: "summarize_at_risk_shipments", arguments: { groupBy: "hub", hubId: "hub-hyd" }, dataAsOf: AS_OF, result: { rows: [], totals: { atRisk: 905, promisedToday: 1500 } } },
  "ev-shippers": { tool: "get_shipper_on_time", arguments: { onlyAtRisk: true }, dataAsOf: AS_OF, result: { rows: [{ shipperId: "shipper-003", name: "Godavari Organics", atRiskToday: 218 }] } },
  "ev-runs-yesterday": { tool: "list_route_runs", arguments: { serviceDate: "2026-09-20" }, dataAsOf: AS_OF, result: { serviceDate: "2026-09-20", rows: [], totals: { held: 2 } } },
  "ev-runs-today": { tool: "list_route_runs", arguments: {}, dataAsOf: AS_OF, result: { serviceDate: "2026-09-21", rows: [], totals: { held: 3 } } },
};
const store = {
  getEvidence: (id: string) => EVIDENCE[id],
  evidenceExists: (id: string) => id in EVIDENCE,
};
const figure = (value: number, extra: Partial<Metric> = {}): Metric => ({ name: "model label", value, unit: "things", aggregation: "count", ...extra });

describe("live metric binding from (tool, resultPath)", () => {
  it("pairs each figure with the path holding its value, not the first mappable path", () => {
    const claim = { evidenceIds: ["ev-risk"], resultPaths: ["totals.promisedToday", "totals.atRisk"] };
    const atRisk = bindClaimMetric(store, claim, figure(905));
    const promised = bindClaimMetric(store, claim, figure(4000));
    expect(atRisk).toMatchObject({ metricId: "parcels_at_risk_today", resultPath: "totals.atRisk", evidenceId: "ev-risk", scope: { type: "network" } });
    expect(promised).toMatchObject({ metricId: "parcels_promised_today", resultPath: "totals.promisedToday" });
    expect(atRisk.name).toBe("Parcels at risk today");
  });

  it("derives the denominator from the registry and the same evidence (905 of 4,000)", () => {
    const bound = bindClaimMetric(store, { evidenceIds: ["ev-risk"], resultPaths: ["totals.atRisk"] }, figure(905));
    expect(bound.denominator).toEqual({ value: 4000, metricId: "parcels_promised_today" });
  });

  it("derives scope from the source's scopeFrom, not the definition's scope type", () => {
    const bound = bindClaimMetric(store, { evidenceIds: ["ev-shippers"], resultPaths: ["rows.0.atRiskToday"] }, figure(218));
    expect(bound).toMatchObject({ metricId: "parcels_at_risk_today", scope: { type: "shipper", id: "shipper-003" } });
    const hub = bindClaimMetric(store, { evidenceIds: ["ev-risk-hyd"], resultPaths: ["totals.atRisk"] }, figure(905));
    expect(hub.scope).toEqual({ type: "hub", id: "hub-hyd" });
    expect(hub.denominator).toEqual({ value: 1500, metricId: "parcels_promised_today" });
  });

  it("strips a model's own metricId, scope and denominator and maps only from evidence", () => {
    const forged = figure(218, { metricId: "parcels_at_risk_today", scope: { type: "network" }, denominator: { value: 4000 } });
    const bound = bindClaimMetric(store, { evidenceIds: ["ev-shippers"], resultPaths: ["rows.0.atRiskToday"] }, forged);
    expect(bound.scope).toEqual({ type: "shipper", id: "shipper-003" });
    expect(bound.denominator).toBeUndefined();
    const unpathed = bindClaimMetric(store, { evidenceIds: ["ev-risk"], resultPaths: [] }, figure(905, { metricId: "parcels_at_risk_today", scope: { type: "network" } }));
    expect(unpathed.metricId).toBeUndefined();
    expect(unpathed.scope).toBeUndefined();
  });

  it("leaves a figure unbound when no registry path holds that value", () => {
    const bound = bindClaimMetric(store, { evidenceIds: ["ev-risk"], resultPaths: ["totals.promisedToday"] }, figure(905));
    expect(bound.metricId).toBeUndefined();
  });

  it("binds route-run totals to today only for today's service date", () => {
    expect(bindClaimMetric(store, { evidenceIds: ["ev-runs-today"], resultPaths: ["totals.held"] }, figure(3)).metricId).toBe("route_runs_held_today");
    expect(bindClaimMetric(store, { evidenceIds: ["ev-runs-yesterday"], resultPaths: ["totals.held"] }, figure(2)).metricId).toBeUndefined();
  });
});

describe("validateFinding", () => {
  it("strips the registry binding from a metric whose claim has no resultPaths", () => {
    const finding = {
      findingId: "f", taskId: "t", agentId: "shipments", kind: "observation" as const, title: "t", summary: "s", severity: "high" as const,
      entities: [], createdAt: AS_OF, limitations: [],
      claims: [{ claimId: "c", statement: "s", evidenceIds: ["ev-risk"], resultPaths: [], entities: [], limitations: [], contradictoryEvidenceIds: [],
        metrics: [figure(905, { metricId: "parcels_at_risk_today", scope: { type: "network" } })] }],
    };
    const checked = validateFinding(store as never, finding);
    expect(checked.claims[0]!.metrics[0]!.metricId).toBeUndefined();
    expect(checked.claims[0]!.metrics[0]!.value).toBe(905);
  });
});
