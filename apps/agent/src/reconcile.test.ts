import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { AgentFinding } from "@anc/contracts";
import { headlineMetrics, reconcileMetrics } from "./reconcile.js";

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
    // The figures stay in the conflict for developers; the note shown to people has none.
    expect(result.conflicts[0]!.values).toEqual([905, 902]);
    expect(result.notes[0]).toBe("Two sources disagree on parcels at risk today, so it's held back until resolved");
    expect(result.notes[0]).not.toMatch(/\d/);
  });

  it("returns no headline metrics on a quiet day", () => {
    const result = reconcileMetrics(load("quiet-day"));
    expect(result.metrics).toEqual([]);
    expect(result.conflicts).toEqual([]);
  });
});

describe("orphaned child scopes (P1 review)", () => {
  it("keeps Godavari's 218 non-headline when the network parent conflicts", () => {
    const godavari = load("scope-905-vs-218").filter((finding) => finding.findingId === "f-ship");
    const result = reconcileMetrics([...load("conflict-905-vs-902"), ...godavari]);
    const shipper = result.metrics.find((metric) => metric.scope.type === "shipper");
    expect(shipper?.value).toBe(218);
    expect(shipper?.headlineEligible).toBe(false);
    expect(shipper?.orphaned).toBe("parent_conflicted");
    expect(headlineMetrics(result)).toEqual([]);
  });

  it("keeps a shipper child non-headline when no network parent was reported", () => {
    const godavari = load("scope-905-vs-218").filter((finding) => finding.findingId === "f-ship");
    const result = reconcileMetrics(godavari);
    expect(result.metrics[0]?.orphaned).toBe("parent_missing");
    expect(headlineMetrics(result)).toEqual([]);
  });

  it("ignores a registry metric that has no evidence path", () => {
    const [network] = load("scope-905-vs-218");
    const unpathed = { ...network!, claims: network!.claims.map((claim) => ({ ...claim, resultPaths: [] })) };
    expect(reconcileMetrics([unpathed]).metrics).toEqual([]);
  });
});
