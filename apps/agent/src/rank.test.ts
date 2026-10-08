import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { AgentFinding } from "@anc/contracts";
import { PERSONAS } from "@anc/policy";
import { rankBriefing } from "./rank.js";
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

  it("is quiet when there is no serious finding", () => {
    const findings = load("quiet-day");
    const reconciled = reconcileMetrics(findings);
    const plan = rankBriefing({ findings, reconciled });
    expect(plan.quiet).toBe(true);
    expect(plan.primary).toBeUndefined();
  });

  it("does not promote a conflicted metric to primary", () => {
    const findings = load("conflict-905-vs-902");
    const reconciled = reconcileMetrics(findings);
    const plan = rankBriefing({ findings, reconciled });
    expect(plan.primary?.metric?.metricId).not.toBe("parcels_at_risk_today");
  });
});
