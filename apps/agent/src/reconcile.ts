import type { AgentFinding, Metric } from "@anc/contracts";
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

function scopeKey(scope: { type: MetricScopeType; id?: string }): string {
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
        const scope = metric.scope ?? { type: def.scopeType };
        out.push({
          metricId,
          value: metric.value,
          scope: { type: scope.type, id: scope.id },
          window: def.window,
          denominator: metric.denominator,
          evidenceIds: [...claim.evidenceIds],
          resultPaths: [...claim.resultPaths],
          findingId: finding.findingId,
        });
      }
    }
  }
  return out;
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

  const notes: string[] = [];
  const conflicts: ReconcileResult["conflicts"] = [];
  const merged: ReconciledMetric[] = [];

  for (const [key, items] of byGroup) {
    const values = [...new Set(items.map((item) => item.value))];
    const sample = items[0]!;
    const def = getMetricDefinition(sample.metricId)!;
    if (values.length > 1) {
      const note = `${def.label} disagree (${values.map((value) => value.toLocaleString("en-IN")).join(" vs ")}); not shown until resolved`;
      notes.push(note);
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
    });
  }

  // Child scopes of a parent with the same metricId become of-which only.
  for (const metric of merged) {
    const parent = merged.find((other) =>
      other !== metric
      && other.metricId === metric.metricId
      && other.window === metric.window
      && isChildScope(metric.scope, other.scope),
    );
    if (parent) metric.ofWhichOf = `${parent.metricId}|${scopeKey(parent.scope)}|${parent.window}`;
  }

  return { metrics: merged, conflicts, notes };
}

/** Metrics eligible for the primary headline number (registry-backed, not of-which children, not conflicted). */
export function headlineMetrics(result: ReconcileResult): ReconciledMetric[] {
  return result.metrics.filter((metric) => !metric.ofWhichOf);
}
