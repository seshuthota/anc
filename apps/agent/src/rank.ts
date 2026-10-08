import type { AgentFinding } from "@anc/contracts";
import type { Principal } from "@anc/policy";
import { headlineMetrics, type ReconcileResult, type ReconciledMetric } from "./reconcile.js";

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

/**
 * R1 deterministic ranker. Pure: no I/O. Picks at most one primary finding that
 * has a reconciled headline metric (or a high-severity qualitative finding when
 * no metric applies), up to three secondary, and quiet when nothing qualifies.
 */
export function rankBriefing(input: {
  findings: AgentFinding[];
  reconciled: ReconcileResult;
  principal?: Principal;
}): BriefingPlan {
  const { findings, reconciled, principal } = input;
  const headlines = headlineMetrics(reconciled);
  const metricByFinding = new Map<string, ReconciledMetric>();
  for (const metric of headlines) {
    for (const findingId of metric.findingIds) {
      const current = metricByFinding.get(findingId);
      // Prefer network-scope / larger breadth when a finding cites several.
      if (!current || breadth(metric) > breadth(current) || (breadth(metric) === breadth(current) && metric.scope.type === "network" && current.scope.type !== "network")) {
        metricByFinding.set(findingId, metric);
      }
    }
  }

  const eligible = findings
    .filter((finding) => finding.severity === "high" || finding.severity === "critical" || metricByFinding.has(finding.findingId))
    .map((finding) => ({ finding, metric: metricByFinding.get(finding.findingId), score: scoreFinding(finding, metricByFinding.get(finding.findingId), principal) }))
    .sort((left, right) => {
      if (right.score !== left.score) return right.score - left.score;
      // Prefer findings that own a network-scoped headline metric.
      const leftNet = left.metric?.scope.type === "network" ? 1 : 0;
      const rightNet = right.metric?.scope.type === "network" ? 1 : 0;
      if (rightNet !== leftNet) return rightNet - leftNet;
      if (domainRank(left.finding) !== domainRank(right.finding)) return domainRank(left.finding) - domainRank(right.finding);
      return left.finding.findingId.localeCompare(right.finding.findingId);
    });

  // Quiet unless something is high or critical. Medium noise (e.g. residual
  // locker pressure on an otherwise calm day) must not become the morning primary.
  const serious = findings.some((finding) => finding.severity === "high" || finding.severity === "critical");
  if (!serious) {
    return { secondary: [], quiet: true, suggestedActions: [] };
  }

  // Primary must have a reconciled metric when one exists among headlines;
  // otherwise a high-severity qualitative finding may still lead.
  const withMetric = eligible.filter((item) => item.metric && (item.finding.severity === "high" || item.finding.severity === "critical"));
  const primaryPick = withMetric[0] ?? eligible.find((item) => item.finding.severity === "high" || item.finding.severity === "critical");

  if (!primaryPick) {
    return { secondary: [], quiet: true, suggestedActions: [] };
  }

  const primaryId = primaryPick.finding.findingId;
  const secondary = eligible
    .filter((item) => item.finding.findingId !== primaryId)
    .slice(0, 3)
    .map((item) => ({ findingId: item.finding.findingId, title: item.finding.title }));

  const chain: Array<{ text: string; kind: "observed" | "inferred"; findingIds: string[] }> = [];
  const equipment = findings.find((finding) => /fault|sorter|belt|equipment/i.test(finding.title) && finding.findingId !== primaryId);
  if (equipment) chain.push({ text: equipment.title, kind: "observed", findingIds: [equipment.findingId] });
  chain.push({ text: primaryPick.finding.title, kind: "observed", findingIds: [primaryId] });
  const account = findings.find((finding) => finding.agentId === "customers" && finding.findingId !== primaryId && /at risk|commitment|Godavari|shipper/i.test(finding.title));
  if (account && chain.length < 3) chain.push({ text: account.title, kind: "inferred", findingIds: [account.findingId] });

  return {
    primary: {
      findingId: primaryId,
      metric: primaryPick.metric,
      whyItMatters: primaryPick.finding.summary,
      confidence: primaryPick.metric && primaryPick.finding.severity === "high" ? "high" : "medium",
      chain: chain.slice(0, 3),
    },
    secondary,
    quiet: false,
    suggestedActions: [],
  };
}

/** Review a model Lead Analyst ranking against the deterministic eligible set. */
export function reviewLeadAnalystRanking(input: {
  primaryFindingId?: string;
  secondaryFindingIds?: string[];
  findings: AgentFinding[];
  reconciled: ReconcileResult;
}): string[] {
  const errors: string[] = [];
  const plan = rankBriefing({ findings: input.findings, reconciled: input.reconciled });
  const eligibleIds = new Set([
    ...(plan.primary ? [plan.primary.findingId] : []),
    ...plan.secondary.map((item) => item.findingId),
    ...input.findings.filter((finding) => finding.severity === "high" || finding.severity === "critical").map((finding) => finding.findingId),
    ...headlineMetrics(input.reconciled).flatMap((metric) => metric.findingIds),
  ]);
  if (input.primaryFindingId) {
    if (!findingFor(input.findings, input.primaryFindingId)) errors.push(`primaryFindingId ${input.primaryFindingId} is unknown`);
    else if (!eligibleIds.has(input.primaryFindingId)) errors.push(`primaryFindingId ${input.primaryFindingId} is not eligible`);
    const metric = headlineMetrics(input.reconciled).find((item) => item.findingIds.includes(input.primaryFindingId!));
    if (!metric && input.findings.find((finding) => finding.findingId === input.primaryFindingId)?.severity !== "high"
      && input.findings.find((finding) => finding.findingId === input.primaryFindingId)?.severity !== "critical") {
      errors.push("primary finding has no reconciled headline metric");
    }
  }
  for (const id of input.secondaryFindingIds ?? []) {
    if (!findingFor(input.findings, id)) errors.push(`secondaryFindingId ${id} is unknown`);
  }
  if ((input.secondaryFindingIds?.length ?? 0) > 3) errors.push("at most three secondary findings");
  return errors;
}
