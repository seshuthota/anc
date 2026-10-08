import type { AgentFinding } from "@anc/contracts";
import type { Principal } from "@anc/policy";
import { getMetricDefinition } from "@anc/contracts";
import { citedMetricIds, headlineMetrics, scopeKey, type ReconcileResult, type ReconciledMetric } from "./reconcile.js";

export type BriefingPlan = {
  primary?: {
    findingId: string;
    metric?: ReconciledMetric;
    whyItMatters: string;
    confidence: "high" | "medium" | "low";
    chain: Array<{ text: string; kind: "observed" | "inferred"; findingIds: string[] }>;
  };
  secondary: Array<{ findingId: string; title: string }>;
  quiet: boolean;
  /**
   * Set when something serious was found but no finding can honestly lead (for
   * example its figure conflicted and was dropped). The surface then has no
   * primary, but it is not a quiet day either.
   */
  withheld?: string;
  suggestedActions: [];
};

const SEVERITY_WEIGHT: Record<string, number> = {
  critical: 100,
  high: 80,
  medium: 40,
  low: 15,
  info: 0,
};

/** Fixed domain order for tie-breaks. */
const DOMAIN_ORDER = ["shipments", "network", "customers", "last_mile"];

function findingFor(findings: AgentFinding[], id: string): AgentFinding | undefined {
  return findings.find((item) => item.findingId === id);
}

function priorityMatch(finding: AgentFinding, principal?: Principal): number {
  const priorities = principal?.preferences.priorities ?? [];
  if (!priorities.length) return 0;
  const haystack = `${finding.title} ${finding.summary}`.toLowerCase();
  let score = 0;
  for (const priority of priorities) {
    const words = priority.toLowerCase().split(/\W+/).filter((word) => word.length > 3);
    const hits = words.filter((word) => haystack.includes(word)).length;
    score += hits * 8;
  }
  return Math.min(40, score);
}

function breadth(metric: ReconciledMetric | undefined): number {
  if (!metric) return 0;
  if (metric.value <= 0) return 0;
  return Math.min(30, Math.log10(metric.value + 1) * 12);
}

function rootCauseBonus(finding: AgentFinding): number {
  if (/fault|sorter|belt|equipment|breakdown/i.test(`${finding.title} ${finding.summary}`)) return 12;
  if (finding.kind === "hypothesis") return 4;
  return 0;
}

function scoreFinding(finding: AgentFinding, metric: ReconciledMetric | undefined, principal?: Principal): number {
  return (SEVERITY_WEIGHT[finding.severity] ?? 0) + priorityMatch(finding, principal) + breadth(metric) + rootCauseBonus(finding);
}

function domainRank(finding: AgentFinding): number {
  const index = DOMAIN_ORDER.indexOf(finding.agentId);
  return index === -1 ? DOMAIN_ORDER.length : index;
}

const serious = (finding: AgentFinding) => finding.severity === "high" || finding.severity === "critical";

function headlineMetricByFinding(reconciled: ReconcileResult): Map<string, ReconciledMetric> {
  const metricByFinding = new Map<string, ReconciledMetric>();
  for (const metric of headlineMetrics(reconciled)) {
    for (const findingId of metric.findingIds) {
      const current = metricByFinding.get(findingId);
      // Prefer network-scope / larger breadth when a finding cites several.
      if (!current || breadth(metric) > breadth(current) || (breadth(metric) === breadth(current) && metric.scope.type === "network" && current.scope.type !== "network")) {
        metricByFinding.set(findingId, metric);
      }
    }
  }
  return metricByFinding;
}

/**
 * How a finding stands after reconciliation:
 * - "headline": it owns a headline-eligible reconciled metric;
 * - "qualitative": it cites no registry metric at all (an equipment fault, say);
 * - "conflicted": a registry figure it cites was dropped as a conflict;
 * - "demoted": its registry figures are only of-which children (or orphans of a dropped parent).
 * Only "headline" and serious "qualitative" findings may be the primary.
 */
export function findingStanding(finding: AgentFinding, reconciled: ReconcileResult, metricByFinding = headlineMetricByFinding(reconciled)): "headline" | "qualitative" | "conflicted" | "demoted" {
  if (metricByFinding.has(finding.findingId)) return "headline";
  const cited = citedMetricIds(finding);
  if (!cited.length) return "qualitative";
  const conflicted = new Set(reconciled.conflicts.map((conflict) => `${conflict.metricId}|${conflict.scopeKey}`));
  const conflictedHere = finding.claims.some((claim) => claim.metrics.some((metric) => {
    const def = metric.metricId ? getMetricDefinition(metric.metricId) : undefined;
    return def ? conflicted.has(`${def.id}|${scopeKey(metric.scope ?? { type: def.scopeType })}`) : false;
  }));
  return conflictedHere ? "conflicted" : "demoted";
}

/** Findings that may be the one primary: serious, and either own a headline metric or are qualitative. */
export function primaryEligibleIds(findings: AgentFinding[], reconciled: ReconcileResult): string[] {
  const metricByFinding = headlineMetricByFinding(reconciled);
  return findings
    .filter((finding) => serious(finding))
    .filter((finding) => {
      const standing = findingStanding(finding, reconciled, metricByFinding);
      return standing === "headline" || standing === "qualitative";
    })
    .map((finding) => finding.findingId);
}

/**
 * R1 deterministic ranker. Pure: no I/O. Picks at most one primary finding that
 * owns a reconciled headline metric (or a serious qualitative finding when none
 * does), up to three secondary, and quiet when nothing is serious. A finding whose
 * only figures are of-which children (Godavari's 218 of the network's 905) or were
 * dropped as conflicts never leads, even when its parent figure is gone.
 */
export function rankBriefing(input: {
  findings: AgentFinding[];
  reconciled: ReconcileResult;
  principal?: Principal;
}): BriefingPlan {
  const { reconciled, principal } = input;
  // Order-independent: specialists finish in any order.
  const findings = [...input.findings].sort((left, right) => domainRank(left) - domainRank(right) || left.title.localeCompare(right.title) || left.findingId.localeCompare(right.findingId));
  const metricByFinding = headlineMetricByFinding(reconciled);
  const standing = new Map(findings.map((finding) => [finding.findingId, findingStanding(finding, reconciled, metricByFinding)]));

  const ranked = findings
    // Conflicted findings carry a figure that is withheld until resolved; a limitation note covers them.
    .filter((finding) => standing.get(finding.findingId) !== "conflicted")
    .filter((finding) => serious(finding) || metricByFinding.has(finding.findingId))
    .map((finding) => ({ finding, metric: metricByFinding.get(finding.findingId), score: scoreFinding(finding, metricByFinding.get(finding.findingId), principal) }))
    .sort((left, right) => {
      if (right.score !== left.score) return right.score - left.score;
      // Prefer findings that own a network-scoped headline metric.
      const leftNet = left.metric?.scope.type === "network" ? 1 : 0;
      const rightNet = right.metric?.scope.type === "network" ? 1 : 0;
      if (rightNet !== leftNet) return rightNet - leftNet;
      if (domainRank(left.finding) !== domainRank(right.finding)) return domainRank(left.finding) - domainRank(right.finding);
      return left.finding.title.localeCompare(right.finding.title) || left.finding.findingId.localeCompare(right.finding.findingId);
    });

  // Quiet unless something is high or critical. Medium noise (e.g. residual
  // locker pressure on an otherwise calm day) must not become the morning primary.
  if (!findings.some(serious)) {
    // A quiet day can still carry minor residue (a locker filling up). It stays
    // secondary, collapsed under the calm line, never the primary.
    const residual = findings
      .filter((finding) => finding.severity !== "info" && standing.get(finding.findingId) !== "conflicted")
      .sort((left, right) => (SEVERITY_WEIGHT[right.severity] ?? 0) - (SEVERITY_WEIGHT[left.severity] ?? 0))
      .slice(0, 3)
      .map((finding) => ({ findingId: finding.findingId, title: finding.title }));
    return { secondary: residual, quiet: true, suggestedActions: [] };
  }

  const eligible = new Set(primaryEligibleIds(findings, reconciled));
  const candidates = ranked.filter((item) => eligible.has(item.finding.findingId));
  // A finding with a reconciled headline metric leads over a qualitative one.
  const primaryPick = candidates.find((item) => item.metric) ?? candidates[0];

  if (!primaryPick) {
    const secondary = ranked.slice(0, 3).map((item) => ({ findingId: item.finding.findingId, title: item.finding.title }));
    const reason = reconciled.conflicts.length
      ? `No single headline: ${reconciled.notes[0] ?? "the specialists' figures disagree"}`
      : "No single headline: the serious findings carry no figure that can stand for the whole network";
    return { secondary, quiet: false, withheld: reason, suggestedActions: [] };
  }

  const primaryId = primaryPick.finding.findingId;
  const secondary = ranked
    .filter((item) => item.finding.findingId !== primaryId)
    .slice(0, 3)
    .map((item) => ({ findingId: item.finding.findingId, title: item.finding.title }));

  const chain: Array<{ text: string; kind: "observed" | "inferred"; findingIds: string[] }> = [];
  const equipment = findings.find((finding) => /fault|sorter|belt|equipment/i.test(finding.title) && finding.findingId !== primaryId);
  if (equipment) chain.push({ text: equipment.title, kind: "observed", findingIds: [equipment.findingId] });
  chain.push({ text: primaryPick.finding.title, kind: "observed", findingIds: [primaryId] });
  const account = findings.find((finding) => finding.agentId === "customers" && finding.findingId !== primaryId && /at risk|commitment|Godavari|shipper/i.test(finding.title));
  if (account && chain.length < 3) {
    // The hop names the account and what it means for it, not its of-which figure:
    // a shipper's slice of the headline number is not shown beside it.
    const label = account.entities.find((entity) => entity.type === "shipper")?.label;
    chain.push({ text: label ? `${label}: ${account.summary}` : account.summary, kind: "inferred", findingIds: [account.findingId] });
  }

  return {
    primary: {
      findingId: primaryId,
      metric: primaryPick.metric,
      whyItMatters: primaryPick.finding.summary,
      confidence: primaryPick.metric && serious(primaryPick.finding) ? "high" : "medium",
      chain: chain.slice(0, 3),
    },
    secondary,
    quiet: false,
    suggestedActions: [],
  };
}

/** Review a model Lead Analyst ranking against the deterministic plan. The model may not pick a different primary. */
export function reviewLeadAnalystRanking(input: {
  primaryFindingId?: string;
  secondaryFindingIds?: string[];
  findings: AgentFinding[];
  reconciled: ReconcileResult;
  /** The deterministic plan the model's answer must agree with. */
  ranked?: BriefingPlan;
}): string[] {
  const errors: string[] = [];
  const plan = input.ranked ?? rankBriefing({ findings: input.findings, reconciled: input.reconciled });
  const deterministicPrimary = plan.primary?.findingId;
  if (deterministicPrimary) {
    if (!input.primaryFindingId) errors.push(`primaryFindingId is required; the primary finding is ${deterministicPrimary}`);
    else if (!findingFor(input.findings, input.primaryFindingId)) errors.push(`primaryFindingId ${input.primaryFindingId} is unknown`);
    else if (input.primaryFindingId !== deterministicPrimary) errors.push(`primaryFindingId ${input.primaryFindingId} differs from the ranked primary ${deterministicPrimary}`);
  } else if (input.primaryFindingId) {
    errors.push(`primaryFindingId ${input.primaryFindingId} given, but nothing qualifies as the primary`);
  }
  for (const id of input.secondaryFindingIds ?? []) {
    if (!findingFor(input.findings, id)) errors.push(`secondaryFindingId ${id} is unknown`);
    else if (id === deterministicPrimary) errors.push(`secondaryFindingId ${id} is the primary`);
  }
  if ((input.secondaryFindingIds?.length ?? 0) > 3) errors.push("at most three secondary findings");
  return errors;
}
