import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { AgentFinding } from "@anc/contracts";
import { PERSONAS } from "@anc/policy";
import { chainHopRepeatsHeadline, figureTokens, rankBriefing, reviewChain, reviewLeadAnalystRanking } from "./rank.js";
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
    // The body says what is held back without printing the figures it withholds.
    expect(plan.withheld).toBe("Two sources disagree on parcels at risk today, so it's held back until resolved.");
    expect(plan.withheld).not.toMatch(/\d/);
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

describe("cause chain (P4 quick fix A1)", () => {
  it("starts at the first cause and never repeats the headline or its figure", () => {
    const findings = load("hub-fault-findings");
    const plan = rankBriefing({ findings, reconciled: reconcileMetrics(findings) });
    const primary = findings.find((finding) => finding.findingId === plan.primary?.findingId)!;
    const chain = plan.primary!.chain;
    expect(chain.length).toBeGreaterThan(0);
    expect(chain.length).toBeLessThanOrEqual(3);
    expect(chain[0]!.findingIds).toEqual(["f-equipment"]);
    expect(chain.flatMap((hop) => hop.findingIds)).not.toContain(primary.findingId);
    for (const hop of chain) {
      expect(hop.text).not.toBe(primary.title);
      expect(figureTokens(hop.text)).not.toContain(String(plan.primary!.metric!.value));
      expect(chainHopRepeatsHeadline(hop.text, { text: primary.title, figure: plan.primary!.metric!.value })).toBe(false);
    }
  });

  it("flags a hop that equals the headline, contains it, or carries the headline figure in any form", () => {
    const headline = { text: "905 parcels at risk of missing today's promise", figure: 905 };
    expect(chainHopRepeatsHeadline("905 parcels at risk of missing today's promise", headline)).toBe(true);
    expect(chainHopRepeatsHeadline("So: 905 parcels at risk of missing today's promise.", headline)).toBe(true);
    expect(chainHopRepeatsHeadline("That leaves 905 parcels off the trucks", headline)).toBe(true);
    expect(chainHopRepeatsHeadline("That leaves 905.0 parcels off the trucks", headline)).toBe(true);
    expect(chainHopRepeatsHeadline("Network total 4,000", { text: "x", figure: 4000 })).toBe(true);
    expect(chainHopRepeatsHeadline("Sorter belt B down since 22:10", headline)).toBe(false);
    expect(chainHopRepeatsHeadline("3 route runs held today", headline)).toBe(false);
    expect(reviewChain([{ text: "Sorter belt B is down" }, { text: "So 905 parcels miss today" }], headline)).toEqual([
      expect.stringMatching(/chain 2 repeats the headline or its figure \(905\)/),
    ]);
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

describe("each finding shows once on the card (pre-demo review)", () => {
  it("never lists a finding the chain cites as a lower-priority item, for any persona", () => {
    const findings = load("hub-fault-findings");
    const reconciled = reconcileMetrics(findings);
    for (const principal of PERSONAS) {
      const plan = rankBriefing({ findings, reconciled, principal });
      if (!plan.primary) continue;
      const onCard = new Set([plan.primary.findingId, ...plan.primary.chain.flatMap((hop) => hop.findingIds)]);
      expect(plan.secondary.filter((item) => onCard.has(item.findingId)), principal.id).toEqual([]);
    }
  });

  it("drops a chain-cited item from the briefing even when the chain came from elsewhere, and drills on the scoped title", async () => {
    const { buildBriefing } = await import("./briefing.js");
    const findings = load("scope-905-vs-218");
    const reconciled = reconcileMetrics(findings);
    const plan = rankBriefing({ findings, reconciled });
    expect(plan.primary?.findingId).toBe("f-net");
    // Godavari offered as a lower-priority item with nothing on the chain: scoped title, drill asks about it.
    const loose = buildBriefing({ plan: { ...plan, primary: { ...plan.primary!, chain: [] }, secondary: [{ findingId: "f-ship", title: "raw" }] }, findings, checkedDomains: [], reconciled });
    const item = loose.secondary.find((entry) => entry.id === "f-ship")!;
    expect(item.title).toMatch(/of the 905/);
    expect(item.question).toBe(`Look into: ${item.title}`);
    // The same finding cited by the chain is not repeated below it.
    const cited = buildBriefing({ plan: { ...plan, primary: { ...plan.primary!, chain: [{ text: "Godavari Organics", kind: "inferred", findingIds: ["f-ship"] }] }, secondary: [{ findingId: "f-ship", title: "raw" }] }, findings, checkedDomains: [], reconciled });
    expect(cited.primary?.chain[0]?.findingIds).toEqual(["f-ship"]);
    expect(cited.secondary.map((entry) => entry.id)).not.toContain("f-ship");
  });
});
