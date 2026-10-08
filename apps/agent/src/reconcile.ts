import type { AgentFinding } from "@anc/contracts";
import { getMetricDefinition, type MetricScopeType, type MetricWindowId } from "@anc/contracts";

export type ReconciledMetric = {
  metricId: string;
  label: string;
  definition: string;
  value: number;
  unit: string;
  window: MetricWindowId;
  scope: { type: MetricScopeType; id?: string };
  denominator?: { value: number; metricId?: string };
  evidenceIds: string[];
  resultPaths: string[];
  findingIds: string[];
  /** Present when this is a child scope of another reconciled metric with the same metricId. */
  ofWhichOf?: string;
  /**
   * Present when this is narrower than the metric's canonical scope but no parent
   * survived reconciliation (the parent conflicted, or no parent was reported).
   * Such a child is still never a headline: an orphaned shipper figure must not be
   * promoted to stand in for the network figure.
   */
  orphaned?: "parent_conflicted" | "parent_missing";
  /** Only a canonical-scope, unconflicted, evidence-path-bound metric may be the headline number. */
  headlineEligible: boolean;
};

export type ReconcileResult = {
  metrics: ReconciledMetric[];
  conflicts: Array<{ metricId: string; scopeKey: string; values: number[]; note: string }>;
  notes: string[];
};

type Candidate = {
  metricId: string;
  value: number;
  scope: { type: MetricScopeType; id?: string };
  window: MetricWindowId;
  denominator?: { value: number; metricId?: string };
  evidenceIds: string[];
  resultPaths: string[];
  findingId: string;
};

const SCOPE_RANK: Record<MetricScopeType, number> = {
  network: 0,
  hub: 1,
  district: 2,
  shipper: 2,
  locker: 2,
};

export function scopeKey(scope: { type: MetricScopeType; id?: string }): string {
  return scope.id ? `${scope.type}:${scope.id}` : scope.type;
}

function groupKey(item: Candidate): string {
  return `${item.metricId}|${scopeKey(item.scope)}|${item.window}`;
}

function isChildScope(child: { type: MetricScopeType; id?: string }, parent: { type: MetricScopeType; id?: string }): boolean {
  if (parent.type === "network" && child.type !== "network") return true;
  return SCOPE_RANK[child.type] > SCOPE_RANK[parent.type];
}

function collect(findings: AgentFinding[]): Candidate[] {
  const out: Candidate[] = [];
  for (const finding of findings) {
    for (const claim of finding.claims) {
      for (const metric of claim.metrics) {
        const metricId = metric.metricId;
        if (!metricId) continue;
        const def = getMetricDefinition(metricId);
        if (!def) continue;
        // A registry id must come with the evidence path it was read from; otherwise
        // the figure was never checked and is prose only.
        const resultPaths = metric.resultPath ? [metric.resultPath] : claim.resultPaths;
        if (!resultPaths.length) continue;
        const scope = metric.scope ?? { type: def.scopeType };
        out.push({
          metricId,
          value: metric.value,
          scope: { type: scope.type, id: scope.id },
          window: def.window,
          denominator: metric.denominator,
          evidenceIds: metric.evidenceId ? [metric.evidenceId] : [...claim.evidenceIds],
          resultPaths: [...resultPaths],
          findingId: finding.findingId,
        });
      }
    }
  }
  return out;
}

/** Narrower than the scope the metric is defined at (for example a shipper slice of a network metric). */
function isBelowCanonical(metricId: string, scope: { type: MetricScopeType }): boolean {
  const def = getMetricDefinition(metricId);
  return Boolean(def && scope.type !== def.scopeType && isChildScope(scope, { type: def.scopeType }));
}

/**
 * R2: reconcile display metrics before ranking or composition.
 * Pure: no I/O. Groups by (metricId, scope, window); merges equal values;
 * drops conflicting values with a note; marks child scopes as of-which only.
 */
export function reconcileMetrics(findings: AgentFinding[]): ReconcileResult {
  const candidates = collect(findings);
  const byGroup = new Map<string, Candidate[]>();
  for (const item of candidates) {
    const key = groupKey(item);
    const list = byGroup.get(key) ?? [];
    list.push(item);
    byGroup.set(key, list);
  }

  const conflicts: ReconcileResult["conflicts"] = [];
  const merged: ReconciledMetric[] = [];

  for (const [key, items] of byGroup) {
    const values = [...new Set(items.map((item) => item.value))].sort((a, b) => b - a);
    const sample = items[0]!;
    const def = getMetricDefinition(sample.metricId)!;
    if (values.length > 1) {
      const note = `${def.label} disagree (${values.map((value) => value.toLocaleString("en-IN")).join(" vs ")}); not shown until resolved`;
      conflicts.push({ metricId: sample.metricId, scopeKey: scopeKey(sample.scope), values, note });
      continue;
    }
    merged.push({
      metricId: sample.metricId,
      label: def.label,
      definition: def.definition,
      value: sample.value,
      unit: def.unit,
      window: sample.window,
      scope: sample.scope,
      denominator: items.find((item) => item.denominator)?.denominator,
      evidenceIds: [...new Set(items.flatMap((item) => item.evidenceIds))],
      resultPaths: [...new Set(items.flatMap((item) => item.resultPaths))],
      findingIds: [...new Set(items.map((item) => item.findingId))],
      headlineEligible: true,
    });
  }

  // Child scopes of a parent with the same metricId become of-which only. A child
  // below the metric's canonical scope stays non-headline even when its parent is
  // gone: dropped as a conflict, or never reported.
  for (const metric of merged) {
    const parent = merged.find((other) =>
      other !== metric
      && other.metricId === metric.metricId
      && other.window === metric.window
      && isChildScope(metric.scope, other.scope),
    );
    if (parent) {
      metric.ofWhichOf = `${parent.metricId}|${scopeKey(parent.scope)}|${parent.window}`;
      metric.headlineEligible = false;
      continue;
    }
    if (isBelowCanonical(metric.metricId, metric.scope)) {
      const parentConflicted = conflicts.some((conflict) => conflict.metricId === metric.metricId);
      metric.orphaned = parentConflicted ? "parent_conflicted" : "parent_missing";
      metric.headlineEligible = false;
    }
  }

  // Pure and order-independent: specialists finish in any order, so sort by group key.
  const keyOf = (metric: ReconciledMetric) => `${metric.metricId}|${scopeKey(metric.scope)}|${metric.window}`;
  merged.sort((left, right) => keyOf(left).localeCompare(keyOf(right)));
  for (const metric of merged) {
    metric.evidenceIds.sort();
    metric.resultPaths.sort();
    metric.findingIds.sort();
  }
  conflicts.sort((left, right) => `${left.metricId}|${left.scopeKey}`.localeCompare(`${right.metricId}|${right.scopeKey}`));
  return { metrics: merged, conflicts, notes: conflicts.map((conflict) => conflict.note) };
}

/** Metrics eligible for the primary headline number (registry-backed, canonical scope, not of-which children, not conflicted). */
export function headlineMetrics(result: ReconcileResult): ReconciledMetric[] {
  return result.metrics.filter((metric) => metric.headlineEligible && !metric.ofWhichOf);
}

/** Every registry metric id a finding cites with a checked evidence path, whether or not it survived reconciliation. */
export function citedMetricIds(finding: AgentFinding): string[] {
  return [...new Set(finding.claims.flatMap((claim) => claim.metrics
    .filter((metric) => metric.metricId && getMetricDefinition(metric.metricId) && (metric.resultPath || claim.resultPaths.length))
    .map((metric) => metric.metricId!)))];
}
