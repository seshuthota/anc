import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { AgentFinding } from "@anc/contracts";
import { PERSONAS } from "@anc/policy";
import { rankBriefing, reviewLeadAnalystRanking } from "./rank.js";
import { reconcileMetrics } from "./reconcile.js";

function load(name: string): AgentFinding[] {
  const path = fileURLToPath(new URL(`./__fixtures__/briefing/${name}.json`, import.meta.url));
  return JSON.parse(readFileSync(path, "utf8")) as AgentFinding[];
}

describe("rankBriefing", () => {
  it("picks parcels_at_risk_today 905 as primary on hub-fault", () => {
    const findings = load("hub-fault-findings");
    const reconciled = reconcileMetrics(findings);
    const coo = PERSONAS.find((persona) => persona.id === "user-coo")!;
    const plan = rankBriefing({ findings, reconciled, principal: coo });
    expect(plan.quiet).toBe(false);
    expect(plan.primary?.metric?.metricId).toBe("parcels_at_risk_today");
    expect(plan.primary?.metric?.value).toBe(905);
    expect(plan.primary?.metric?.definition).toMatch(/not yet on a truck/i);
    expect(plan.primary?.metric?.denominator?.value).toBe(4000);
    expect(plan.primary?.findingId).toBe("f-at-risk");
    expect(plan.secondary.length).toBeLessThanOrEqual(3);
    // 218 is not a sibling primary metric
    expect(plan.primary?.metric?.scope.type).toBe("network");
  });

  it("is quiet when there is no serious finding; residual stays secondary", () => {
    const findings = load("quiet-day");
    const reconciled = reconcileMetrics(findings);
    const plan = rankBriefing({ findings, reconciled });
    expect(plan.quiet).toBe(true);
    expect(plan.primary).toBeUndefined();
    expect(plan.secondary.length).toBeLessThanOrEqual(3);
  });

  it("does not promote a conflicted metric to primary", () => {
    const findings = load("conflict-905-vs-902");
    const reconciled = reconcileMetrics(findings);
    const plan = rankBriefing({ findings, reconciled });
    expect(plan.primary?.metric?.metricId).not.toBe("parcels_at_risk_today");
  });
});

describe("rankBriefing after P1 review", () => {
  const godavari = () => load("scope-905-vs-218").filter((finding) => finding.findingId === "f-ship");

  it("never promotes Godavari's 218 to primary when the network figure conflicts (905 vs 902)", () => {
    const findings = [...load("conflict-905-vs-902"), ...godavari()];
    const plan = rankBriefing({ findings, reconciled: reconcileMetrics(findings) });
    expect(plan.primary?.findingId).not.toBe("f-ship");
    expect(plan.primary).toBeUndefined();
    expect(plan.quiet).toBe(false);
    expect(plan.withheld).toMatch(/905 vs 902/);
    // The conflicted findings are not offered as secondary lines either.
    expect(plan.secondary.map((item) => item.findingId)).not.toContain("f-905");
    expect(plan.secondary.map((item) => item.findingId)).not.toContain("f-902");
  });

  it("never promotes an orphaned shipper child when the network parent is missing", () => {
    const findings = godavari();
    const plan = rankBriefing({ findings, reconciled: reconcileMetrics(findings) });
    expect(plan.primary).toBeUndefined();
  });

  it("has high confidence for a critical primary with a reconciled metric", () => {
    const findings = load("hub-fault-findings").map((finding) => (finding.findingId === "f-at-risk" ? { ...finding, severity: "critical" as const } : finding));
    const plan = rankBriefing({ findings, reconciled: reconcileMetrics(findings) });
    expect(plan.primary?.findingId).toBe("f-at-risk");
    expect(plan.primary?.confidence).toBe("high");
  });

  it("keeps the shipper figure out of the chain", () => {
    const findings = load("hub-fault-findings");
    const plan = rankBriefing({ findings, reconciled: reconcileMetrics(findings) });
    expect(JSON.stringify(plan.primary?.chain)).not.toMatch(/218/);
  });

  it("rejects a Lead Analyst primary that differs from the ranked primary, or is missing", () => {
    const findings = load("hub-fault-findings");
    const reconciled = reconcileMetrics(findings);
    expect(reviewLeadAnalystRanking({ primaryFindingId: "f-at-risk", findings, reconciled })).toEqual([]);
    expect(reviewLeadAnalystRanking({ primaryFindingId: "f-shipper", findings, reconciled })[0]).toMatch(/differs from the ranked primary f-at-risk/);
    expect(reviewLeadAnalystRanking({ findings, reconciled })[0]).toMatch(/required/);
  });
});

describe("determinism", () => {
  it("reconciles and ranks the same whatever order the specialists finish in", () => {
    const findings = load("hub-fault-findings");
    const coo = PERSONAS.find((persona) => persona.id === "user-coo")!;
    const baseline = JSON.stringify([reconcileMetrics(findings), rankBriefing({ findings, reconciled: reconcileMetrics(findings), principal: coo })]);
    for (let run = 0; run < 5; run += 1) {
      const turned = run % 2 ? [...findings].reverse() : [...findings];
      const shuffled = [...turned.slice(run + 1), ...turned.slice(0, run + 1)];
      const reconciled = reconcileMetrics(shuffled);
      expect(JSON.stringify([reconciled, rankBriefing({ findings: shuffled, reconciled, principal: coo })])).toBe(baseline);
    }
  });
});
