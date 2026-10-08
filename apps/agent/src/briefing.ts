import { getMetricDefinition, type AgentFinding, type Domain, type PresentationBriefing } from "@anc/contracts";
import { chainHopRepeatsHeadline, type BriefingPlan } from "./rank.js";
import type { ReconcileResult, ReconciledMetric } from "./reconcile.js";
import type { Synthesis } from "./synthesis.js";
import { DEMO_CLOCK } from "./windows.js";

/** What each specialist covers, in the words of the calm line. */
const CHECKED: Record<Domain, string> = {
  network: "hubs",
  shipments: "parcels",
  last_mile: "lockers",
  customers: "shippers, complaints",
};
const DOMAIN_ORDER: Domain[] = ["network", "shipments", "last_mile", "customers"];

const asOfLabel = (asOf: string = DEMO_CLOCK) => `${asOf.slice(11, 16)} IST`;

/** How a metric window reads to a person, at the data's as-of time. */
export function windowLabel(window: string, asOf?: string): string {
  switch (window) {
    case "today": return `Today · as of ${asOfLabel(asOf)}`;
    case "last_hour": return `Last hour to ${asOfLabel(asOf)}`;
    case "commitment_13d": return "Commitment period: the 13 days before today";
    default: return `As of ${asOfLabel(asOf)}`;
  }
}

export function formatMetricValue(metric: Pick<ReconciledMetric, "value" | "unit">): string {
  const ratio = /ratio|rate|percent|share/i.test(metric.unit) && metric.value >= 0 && metric.value <= 1;
  if (ratio) return `${(metric.value * 100).toFixed(1)}%`;
  return metric.value.toLocaleString("en-IN", { maximumFractionDigits: 1 });
}

function denominatorLabel(metric: ReconciledMetric): string | undefined {
  if (!metric.denominator) return undefined;
  const label = metric.denominator.metricId ? getMetricDefinition(metric.denominator.metricId)?.label.toLowerCase() : undefined;
  const share = metric.denominator.value > 0 ? ` (${((metric.value / metric.denominator.value) * 100).toFixed(1)}%)` : "";
  return `of ${metric.denominator.value.toLocaleString("en-IN")}${label ? ` ${label}` : ""}${share}`;
}

/**
 * A secondary finding whose figure is an of-which part of the primary's figure is
 * titled by its scope ("Godavari Organics: 218 of the 905 parcels at risk today"),
 * so it never reads as a rival total.
 */
function scopedTitle(finding: AgentFinding, parent: ReconciledMetric | undefined, reconciled?: ReconcileResult): string | undefined {
  if (!parent || !reconciled) return undefined;
  const parentKey = `${parent.metricId}|${parent.scope.id ? `${parent.scope.type}:${parent.scope.id}` : parent.scope.type}|${parent.window}`;
  const child = reconciled.metrics.find((metric) => metric.findingIds.includes(finding.findingId) && metric.ofWhichOf === parentKey);
  if (!child) return undefined;
  const scopeName = finding.entities.find((entity) => entity.id === child.scope.id)?.label ?? child.scope.id ?? child.scope.type;
  return `${scopeName}: ${formatMetricValue(child)} of the ${formatMetricValue(parent)} ${parent.label.toLowerCase()}`;
}

const evidenceOf = (findings: AgentFinding[], ids: string[]) =>
  [...new Set(findings.filter((finding) => ids.includes(finding.findingId)).flatMap((finding) => finding.claims.flatMap((claim) => claim.evidenceIds)))];

/**
 * The briefing plan a composer lays out, built only from the ranked plan, the
 * reconciled metric and checked findings. Pure: no I/O and nothing authored
 * except fixed labels. Exactly one primary (none on a quiet day or when the
 * headline is withheld), at most three collapsed secondary items, at most three actions.
 */
export function buildBriefing(input: {
  plan: BriefingPlan;
  findings: AgentFinding[];
  synthesis?: Synthesis;
  checkedDomains: Domain[];
  reconciled?: ReconcileResult;
}): PresentationBriefing {
  const { plan, findings, synthesis, reconciled } = input;
  const byId = new Map(findings.map((finding) => [finding.findingId, finding]));
  const primaryFinding = plan.primary ? byId.get(plan.primary.findingId) : undefined;
  // The Lead Analyst's wording stands only when it is about the ranked primary.
  const analyst = synthesis && plan.primary && synthesis.primaryFindingId === plan.primary.findingId ? synthesis : undefined;

  let primary: PresentationBriefing["primary"];
  if (plan.primary && primaryFinding) {
    const metric = plan.primary.metric;
    const chainSource = analyst?.chain?.length ? analyst.chain : plan.primary.chain;
    const headline = analyst?.headline ?? primaryFinding.title;
    // Chain rule, enforced again where the composer's data is built: no hop repeats
    // the headline or carries its figure, whoever wrote the chain.
    const chain = chainSource.filter((hop) => !chainHopRepeatsHeadline(hop.text, { text: headline, figure: metric?.value })).slice(0, 3).map((hop) => ({ text: hop.text, kind: hop.kind, evidenceIds: evidenceOf(findings, hop.findingIds) }));
    const evidenceIds = [...new Set([...(metric?.evidenceIds ?? []), ...evidenceOf(findings, [primaryFinding.findingId]), ...chain.flatMap((hop) => hop.evidenceIds)])];
    primary = {
      findingId: primaryFinding.findingId,
      headline,
      metric: metric ? {
        metricId: metric.metricId,
        value: formatMetricValue(metric),
        label: metric.label,
        definition: metric.definition,
        windowLabel: windowLabel(metric.window),
        ...(denominatorLabel(metric) ? { denominatorLabel: denominatorLabel(metric)! } : {}),
        evidenceIds: metric.evidenceIds,
        resultPath: metric.resultPaths[0] ?? "",
      } : undefined,
      whyItMatters: analyst?.whyItMatters || plan.primary.whyItMatters,
      chain,
      confidence: analyst?.confidence ?? plan.primary.confidence,
      evidenceIds,
    };
    if (primary.metric && !primary.metric.resultPath) primary.metric = undefined;
  }

  const secondary = plan.secondary.slice(0, 3).flatMap((item) => {
    const finding = byId.get(item.findingId);
    if (!finding) return [];
    const evidenceIds = evidenceOf(findings, [finding.findingId]);
    if (!evidenceIds.length) return [];
    const bound = finding.claims.flatMap((claim) => claim.metrics).find((metric) => metric.metricId && metric.resultPath);
    return [{
      id: finding.findingId,
      title: scopedTitle(finding, plan.primary?.metric, reconciled) ?? finding.title,
      evidenceIds,
      ...(bound?.metricId ? { metricId: bound.metricId } : {}),
      ...(bound?.resultPath ? { resultPath: bound.resultPath } : {}),
      question: `Look into: ${finding.title}`,
    }];
  });

  const shown = new Set([...(primary ? [primary.findingId] : []), ...secondary.map((item) => item.id)]);
  const rest = findings.filter((finding) => !shown.has(finding.findingId)).length;
  const checked = DOMAIN_ORDER.filter((domain) => input.checkedDomains.includes(domain)).map((domain) => CHECKED[domain]).join(", ");
  const calm = plan.quiet
    ? `Nothing needs your attention this morning.${checked ? ` Checked: ${checked}.` : ""}`
    : primary
      ? "Everything else is running to plan."
      : plan.withheld ?? "No single figure can headline this morning yet.";
  const restLabel = secondary.length
    ? `${secondary.length} ${plan.quiet ? "minor" : "lower-priority"} item${secondary.length === 1 ? "" : "s"} · ${plan.quiet ? "none needs action" : "everything else is running to plan"}`
    : undefined;

  // R6: catalog operations first (proposed, then confirmed on this surface), bound to
  // the records the ranker chose. "Look into this" fills a free slot; at most three in all.
  const operations = (plan.actions ?? []).map((action) => ({
    id: action.id,
    label: action.label,
    name: "propose_action",
    entities: action.entities.map((entity) => ({ type: entity.type, id: entity.id, ...(entity.label ? { label: entity.label } : {}) })),
  }));
  const actions = primary ? [...operations, {
    id: "drill_primary",
    label: "Look into this",
    name: "investigate",
    entities: primaryFinding!.entities.map((entity) => ({ type: entity.type, id: entity.id, ...(entity.label ? { label: entity.label } : {}) })),
    question: `What is behind this: ${primaryFinding!.title}?`,
  }].slice(0, 3) : [];

  return {
    ...(primary ? { primary } : {}),
    secondary,
    quiet: { label: calm, count: rest },
    ...(restLabel ? { restLabel } : {}),
    actions,
  };
}
