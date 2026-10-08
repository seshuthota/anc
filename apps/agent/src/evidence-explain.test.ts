import { describe, expect, it } from "vitest";
import { resolvePrincipal, type Principal } from "@anc/policy";
import { explainEvidence, harvestNames, namesFromOwnEvidence, openEvidence } from "./evidence-explain.js";

const payload = {
  evidenceId: "get_shipper_on_time-x",
  tool: "get_shipper_on_time",
  arguments: {},
  appliedFilters: { window: "commitment_13d" },
  dataAsOf: "2026-09-21T07:00:00.000+05:30",
  result: {
    rows: Array.from({ length: 14 }, (_, index) => ({ shipperId: `shipper-${index}`, atRiskToday: index * 10, onTimeTarget: 0.96 })),
  },
};

function fakeStore(record = payload, ownerId = "user-coo") {
  return {
    getEvidenceTool: (id: string) => (id === record.evidenceId ? record.tool : undefined),
    getEvidenceRecord: (id: string, owner: string) => (id === record.evidenceId && owner === ownerId ? { tool: record.tool, payload: record as Record<string, unknown> } : undefined),
  };
}

describe("evidence explain", () => {
  it("highlights a row figure inside a window of at most ten rows", () => {
    const explained = explainEvidence(payload.evidenceId, payload, { metricId: "parcels_at_risk_today", path: "rows.12.atRiskToday" });
    expect(explained.value).toBe(120);
    expect(explained.definition?.scope).toEqual({ type: "shipper", id: "shipper-12" });
    expect(explained.excerpt.rows).toHaveLength(10);
    expect(explained.excerpt.total).toBe(14);
    const row = explained.excerpt.rows[explained.excerpt.highlight!.row]!;
    expect(row[explained.excerpt.columns.indexOf(explained.excerpt.highlight!.column)]).toBe(120);
    expect(explained.filters).toEqual({ window: "commitment_13d" });
  });

  it("leaves the figure empty when the path is not in this record", () => {
    const explained = explainEvidence(payload.evidenceId, payload, { metricId: "parcels_at_risk_today", path: "totals.atRisk" });
    expect(explained.value).toBeNull();
    expect(explained.path).toBeNull();
    expect(explained.definition).toBeNull();
    expect(explained.excerpt.highlight).toBeNull();
  });

  it("checks the grant before ownership and redacts denied fields", () => {
    const care = resolvePrincipal("user-care");
    expect(openEvidence(fakeStore(payload, "user-care"), care, payload.evidenceId).status).toBe(403);
    const coo = resolvePrincipal("user-coo");
    expect(openEvidence(fakeStore(payload, "user-other"), coo, payload.evidenceId).status).toBe(404);
    const restricted: Principal = { ...coo, deniedFields: ["onTimeTarget"] };
    const opened = openEvidence(fakeStore(), restricted, payload.evidenceId);
    expect(opened.status).toBe(200);
    expect(JSON.stringify(opened)).not.toContain("onTimeTarget");
  });

  it("puts the rows a cited total is made of first: the held runs, not the first ten departed ones", () => {
    const rows = Array.from({ length: 24 }, (_, index) => ({ id: `run-${index}`, hubId: "hub-hyd", districtName: `District ${index}`, status: index >= 21 ? "held" : "departed", parcelsLeftBehind: index === 2 ? 14 : 0 }));
    const routeRuns = { evidenceId: "list_route_runs-x", tool: "list_route_runs", arguments: { hubId: "hub-hyd" }, appliedFilters: { serviceDate: "2026-09-21", hubId: "hub-hyd" }, dataAsOf: "2026-09-21T07:00:00.000+05:30", result: { asOf: "2026-09-21T07:00:00.000+05:30", serviceDate: "2026-09-21", rows, totals: { runs: 24, held: 3, parcelsLeftBehind: 14 } } };
    const status = (explained: ReturnType<typeof explainEvidence>) => explained.excerpt.rows.map((row) => row[explained.excerpt.columns.indexOf("status")]);
    // Opened from another figure (path not in this record): held runs first.
    const tab = explainEvidence(routeRuns.evidenceId, routeRuns, { path: "totals.atRisk" });
    expect(status(tab).slice(0, 3)).toEqual(["held", "held", "held"]);
    expect(tab.excerpt.rows).toHaveLength(10);
    expect(tab.excerpt.cited).toEqual({ count: 3, label: "held", noun: "run" });
    // Opened on the held figure itself: the same rows, and the figure is still explained.
    const held = explainEvidence(routeRuns.evidenceId, routeRuns, { metricId: "route_runs_held_today", path: "totals.held" });
    expect(held.value).toBe(3);
    expect(status(held).slice(0, 3)).toEqual(["held", "held", "held"]);
    // Opened on parcels left behind: the short-loaded run first.
    const short = explainEvidence(routeRuns.evidenceId, routeRuns, { path: "totals.parcelsLeftBehind" });
    expect(short.excerpt.rows[0]![short.excerpt.columns.indexOf("id")]).toBe("run-2");
    expect(short.excerpt.cited).toEqual({ count: 1, label: "short-loaded", noun: "run" });
    // The hub id in scope and filters is named from the person's other records.
    const named = explainEvidence(routeRuns.evidenceId, routeRuns, { metricId: "route_runs_held_today", path: "totals.held", names: new Map([["hub-hyd", "Hyderabad Hub"]]) });
    expect(named.definition?.scope).toEqual({ type: "hub", id: "hub-hyd" });
    expect(named.labels).toEqual({ "hub-hyd": "Hyderabad Hub" });
  });

  it("harvests names from id/name rows, xId beside xName, and a hub status row", () => {
    const names = harvestNames({
      rows: [
        { id: "lock-velachery", name: "Velachery MRTS Station", districtId: "dist-velachery", districtName: "Velachery" },
        { hubId: "hub-hyd", name: "Hyderabad Hub", city: "Hyderabad" },
        { id: "eq-1", hubId: "hub-blr", hubName: "Bengaluru Hub", equipment: "Sorter" },
      ],
    });
    expect(Object.fromEntries(names)).toEqual({
      "lock-velachery": "Velachery MRTS Station",
      "dist-velachery": "Velachery",
      "hub-hyd": "Hyderabad Hub",
      "hub-blr": "Bengaluru Hub",
    });
  });

  it("names ids only from records the person may open", () => {
    const records = [
      { tool: "get_hub_status", payload: { result: { rows: [{ hubId: "hub-hyd", name: "Hyderabad Hub" }] } } },
      { tool: "list_locker_sites", payload: { result: { rows: [{ id: "lock-velachery", name: "Velachery MRTS Station" }] } } },
    ];
    const store = { listEvidenceNear: () => records.map((record) => ({ ...record })) };
    const care = Object.fromEntries(namesFromOwnEvidence(store, resolvePrincipal("user-care"), "x"));
    expect(care["lock-velachery"]).toBeUndefined();
    const lastMile = Object.fromEntries(namesFromOwnEvidence(store, resolvePrincipal("user-lastmile"), "x"));
    expect(lastMile["lock-velachery"]).toBe("Velachery MRTS Station");
  });
});
