import { describe, expect, it } from "vitest";
import { resolvePrincipal, type Principal } from "@anc/policy";
import { explainEvidence, openEvidence } from "./evidence-explain.js";

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
});
