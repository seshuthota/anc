import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { AgentFinding } from "@anc/contracts";
import { reconcileMetrics } from "./reconcile.js";

function load(name: string): AgentFinding[] {
  const path = fileURLToPath(new URL(`./__fixtures__/briefing/${name}.json`, import.meta.url));
  return JSON.parse(readFileSync(path, "utf8")) as AgentFinding[];
}

describe("reconcileMetrics", () => {
  it("keeps network 905 and marks shipper 218 as of-which", () => {
    const result = reconcileMetrics(load("scope-905-vs-218"));
    const network = result.metrics.find((metric) => metric.metricId === "parcels_at_risk_today" && metric.scope.type === "network");
    const shipper = result.metrics.find((metric) => metric.metricId === "parcels_at_risk_today" && metric.scope.type === "shipper");
    expect(network?.value).toBe(905);
    expect(network?.denominator?.value).toBe(4000);
    expect(network?.definition).toMatch(/not yet on a truck/i);
    expect(shipper?.value).toBe(218);
    expect(shipper?.ofWhichOf).toContain("parcels_at_risk_today");
    expect(result.conflicts).toEqual([]);
  });

  it("drops conflicting network values with a note", () => {
    const result = reconcileMetrics(load("conflict-905-vs-902"));
    expect(result.metrics.filter((metric) => metric.metricId === "parcels_at_risk_today")).toEqual([]);
    expect(result.conflicts).toHaveLength(1);
    expect(result.notes[0]).toMatch(/905/);
    expect(result.notes[0]).toMatch(/902/);
  });

  it("returns no headline metrics on a quiet day", () => {
    const result = reconcileMetrics(load("quiet-day"));
    expect(result.metrics).toEqual([]);
    expect(result.conflicts).toEqual([]);
  });
});
