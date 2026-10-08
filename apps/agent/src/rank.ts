import type { AgentFinding } from "@anc/contracts";
import type { Principal } from "@anc/policy";
import { getMetricDefinition } from "@anc/contracts";
import { citedMetricIds, headlineMetrics, scopeKey, type ReconcileResult, type ReconciledMetric } from "./reconcile.js";
import { selectBriefingActions, type PlannedAction } from "./action-catalog.js";

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
  /**
   * At most three catalog operations for the primary card (R6), chosen from the
   * records on the card and the person's grants. Empty without a primary.
   */
  actions: PlannedAction[];
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
  /** `<actionId>:<recordId>` operations already done (read from this run's evidence). */
  completedActions?: ReadonlySet<string>;
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
    return { secondary: residual, quiet: true, actions: [] };
  }

  const eligible = new Set(primaryEligibleIds(findings, reconciled));
  const candidates = ranked.filter((item) => eligible.has(item.finding.findingId));
  // A finding with a reconciled headline metric leads over a qualitative one.
  const primaryPick = candidates.find((item) => item.metric) ?? candidates[0];

  if (!primaryPick) {
    const secondary = ranked.slice(0, 3).map((item) => ({ findingId: item.finding.findingId, title: item.finding.title }));
    const reason = reconciled.conflicts.length
      ? `${(reconciled.notes[0] ?? "Two sources disagree on a figure, so it's held back until resolved").replace(/^./, (first) => first.toUpperCase())}.`
      : "No single figure can headline this morning: the serious findings carry none that stands for the whole network.";
    return { secondary, quiet: false, withheld: reason, actions: [] };
  }

  const primaryId = primaryPick.finding.findingId;

  // The chain starts at the first cause, not at the headline: the primary card
  // already states the headline and its one figure, so a hop that repeats it
  // (or carries the headline figure) adds nothing and reads as a second total.
  const chain: Array<{ text: string; kind: "observed" | "inferred"; findingIds: string[] }> = [];
  const others = findings.filter((finding) => finding.findingId !== primaryId);
  const equipment = others.find((finding) => finding.entities.some((entity) => entity.type === "equipment") || /fault|sorter|belt|equipment/i.test(finding.title));
  if (equipment) chain.push({ text: equipment.title, kind: "observed", findingIds: [equipment.findingId] });
  // The observed consequence on the floor between the cause and the headline (held runs).
  const held = others.find((finding) => finding !== equipment && citedMetricIds(finding).includes("route_runs_held_today"));
  if (held) chain.push({ text: held.title, kind: "observed", findingIds: [held.findingId] });
  const account = others.find((finding) => finding.agentId === "customers" && /at risk|commitment|Godavari|shipper/i.test(finding.title));
  if (account) {
    // The hop names the account and what it means for it, not its of-which figure:
    // a shipper's slice of the headline number is not shown beside it.
    const label = account.entities.find((entity) => entity.type === "shipper")?.label;
    chain.push({ text: label ? `${label}: ${account.summary}` : account.summary, kind: "inferred", findingIds: [account.findingId] });
  }
  const headline = { text: primaryPick.finding.title, figure: primaryPick.metric?.value };
  // Keep the account hop (the "so what") when there are more than three candidates.
  const kept = chain.filter((hop) => !chainHopRepeatsHeadline(hop.text, headline));
  const trimmed = kept.length > 3 ? [...kept.slice(0, 2), kept[kept.length - 1]!] : kept;
  const onCard = new Set(trimmed.flatMap((hop) => hop.findingIds));
  // Lower-priority items are what the card does not already say: never the
  // primary, and never a finding its cause chain cites (each item shows once).
  const secondary = ranked
    .filter((item) => item.finding.findingId !== primaryId && !onCard.has(item.finding.findingId))
    .slice(0, 3)
    .map((item) => ({ findingId: item.finding.findingId, title: item.finding.title }));
  const actions = selectBriefingActions({
    primary: primaryPick.finding,
    related: findings.filter((finding) => onCard.has(finding.findingId) && finding.findingId !== primaryId),
    metricId: primaryPick.metric?.metricId,
    principal,
    completed: input.completedActions,
  });

  return {
    primary: {
      findingId: primaryId,
      metric: primaryPick.metric,
      whyItMatters: whyItMatters(primaryPick.finding, primaryPick.metric),
      confidence: primaryPick.metric && serious(primaryPick.finding) ? "high" : "medium",
      chain: trimmed,
    },
    secondary,
    quiet: false,
    actions,
  };
}

/**
 * What the primary figure means for the business, per metric: the consequence,
 * not a restatement of the figure's definition. No figures, so nothing here can
 * bring an unreconciled number onto the card.
 */
const CONSEQUENCE: Record<string, string> = {
  parcels_at_risk_today: "Each one that misses today's trucks becomes a late delivery, a likely complaint and a miss against shipper on-time commitments.",
  parcels_waiting_to_sort: "Until the backlog clears, parcels miss their linehaul and route-run departures and slip to tomorrow.",
  route_runs_held_today: "A held run leaves its parcels at the depot: every one is a promised delivery that will not arrive today.",
  complaints_open_unassigned: "Nobody is answering these customers yet; late complaints left without an owner turn into escalations.",
  parcels_left_behind_today: "These parcels miss today's promise and need rebooking on tomorrow's runs.",
  hub_sort_rate_last_hour: "At this rate the hub cannot clear its backlog before the next departures.",
  shipper_projected_on_time_rate: "Falling below the commitment puts the account's contract terms at risk.",
  locker_inbound_without_space: "Parcels that arrive with nowhere to go are turned away and travel back to the depot.",
};

const STOP = new Set(["a", "an", "and", "the", "of", "for", "to", "on", "in", "at", "is", "are", "be", "not", "yet", "with", "by", "per", "its", "it", "this", "that", "today"]);
const words = (text: string) => new Set(text.toLowerCase().replace(/[^a-z\s]/g, " ").split(/\s+/).filter((word) => word.length > 1 && !STOP.has(word)));

/**
 * True when a "why it matters" line mostly restates the figure's definition or the
 * headline (most of its words already appear there), so it adds nothing.
 */
export function restatesFigure(text: string, against: Array<string | undefined>): boolean {
  const own = words(text);
  if (!own.size) return true;
  return against.some((other) => {
    if (!other) return false;
    const theirs = words(other);
    const shared = [...own].filter((word) => theirs.has(word)).length;
    return shared / own.size >= 0.6;
  });
}

/**
 * The consequence for the business. The finding's summary stands when it adds
 * something and carries no figure other than the headline's own (other figures
 * are not on the reconciled headline list); otherwise the metric's consequence.
 */
export function whyItMatters(finding: AgentFinding, metric?: ReconciledMetric): string {
  const consequence = metric ? CONSEQUENCE[metric.metricId] : undefined;
  const own = metric ? figureTokens(String(metric.value)) : [];
  const strayFigures = figureTokens(finding.summary).some((figure) => !own.includes(figure));
  if (!restatesFigure(finding.summary, [metric?.definition, finding.title]) && !(metric && strayFigures)) return finding.summary;
  return consequence ?? finding.summary;
}

/** Numeric tokens in a text, normalized so "4,000", "4000" and "4000.0" compare equal. Clock times are skipped. */
export function figureTokens(text: string): string[] {
  return (text.match(/\d[\d,.:]*\d|\d/g) ?? [])
    .filter((token) => !token.includes(":"))
    .map((token) => token.replace(/,/g, "").replace(/\.0+$/, "").replace(/(\.\d*?)0+$/, "$1").replace(/\.$/, ""));
}

/** How a headline figure can appear in prose: the raw value, rounded, and as a percentage for a 0–1 rate. */
function headlineFigureForms(figure: number | string | undefined): Set<string> {
  const forms = new Set<string>();
  if (figure === undefined || figure === null || figure === "") return forms;
  if (typeof figure === "string") {
    for (const token of figureTokens(figure)) forms.add(token);
    return forms;
  }
  for (const value of [String(figure), figure.toFixed(0), figure.toFixed(1)]) for (const token of figureTokens(value)) forms.add(token);
  if (figure > 0 && figure < 1) for (const token of figureTokens((figure * 100).toFixed(1))) forms.add(token);
  return forms;
}

/**
 * Chain rule (applies to the deterministic chain and to a Lead Analyst's chain):
 * a hop may not equal the headline, contain the headline's text, or carry the
 * headline figure. The figure is shown once, on the primary card.
 */
export function chainHopRepeatsHeadline(hopText: string, headline: { text?: string; figure?: number | string }): boolean {
  const norm = (text: string) => text.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  const hop = norm(hopText);
  const head = headline.text ? norm(headline.text) : "";
  if (head && (hop === head || hop.includes(head))) return true;
  const forms = headlineFigureForms(headline.figure);
  if (!forms.size) return false;
  return figureTokens(hopText).some((token) => forms.has(token));
}

/** Errors for a chain that breaks the rule above, worded as review feedback. */
export function reviewChain(chain: Array<{ text: string }>, headline: { text?: string; figure?: number | string }, where = "chain"): string[] {
  return chain.flatMap((hop, index) => (chainHopRepeatsHeadline(hop.text, headline)
    ? [`${where} ${index + 1} repeats the headline or its figure${headline.figure !== undefined ? ` (${headline.figure})` : ""}; start the chain at the first cause`]
    : []));
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
