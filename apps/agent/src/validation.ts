import { RUNTIME_METRIC_FIELDS, figureMatches, readResultPath, type AgentFinding, type Metric } from "@anc/contracts";
import type { RuntimeStore } from "@anc/runtime-storage";

/** Removes the fields only the runtime may set (metricId, scope, denominator, resultPath, evidenceId). */
export function stripRuntimeMetricFields(metric: Metric): Metric {
  const copy: Record<string, unknown> = { ...metric };
  for (const field of RUNTIME_METRIC_FIELDS) delete copy[field];
  return copy as Metric;
}

/**
 * Checks a finding against stored evidence and returns the checked finding.
 *
 * - Every cited evidence id must exist (for `ownerId`, when given: evidence is
 *   stored per person, so one person's record never vouches for another's finding).
 * - A metric in a claim that names resultPaths must match the evidence at one of them
 *   (or at its own runtime-bound `resultPath`, which is then the only path accepted).
 * - A metric in a claim with no resultPaths cannot be checked. It is kept for prose,
 *   but stripped of any registry binding, so it is never eligible as a headline figure.
 */
export function validateFinding(store: Pick<RuntimeStore, "evidenceExists" | "getEvidence">, finding: AgentFinding, ownerId?: string): AgentFinding {
  for (const claim of finding.claims) {
    for (const evidenceId of claim.evidenceIds) {
      if (!store.evidenceExists(evidenceId, ownerId)) {
        throw new Error(`Finding ${finding.findingId} cites unknown evidence ${evidenceId}`);
      }
    }
    for (const metric of claim.metrics) {
      if (!claim.resultPaths.length && !metric.resultPath) continue;
      const evidenceIds = metric.evidenceId ? [metric.evidenceId] : claim.evidenceIds;
      const paths = metric.resultPath ? [metric.resultPath] : claim.resultPaths;
      if (metric.evidenceId && !claim.evidenceIds.includes(metric.evidenceId)) {
        throw new Error(`Numeric claim ${metric.name} is bound to evidence ${metric.evidenceId}, which its claim does not cite`);
      }
      const matches = evidenceIds.some((evidenceId) => {
        const evidence = store.getEvidence(evidenceId, ownerId);
        return paths.some((resultPath) => figureMatches(readResultPath(evidence?.result, resultPath), metric.value));
      });
      if (!matches) {
        throw new Error(`Numeric claim ${metric.name} does not match evidence path ${paths.join(",")}`);
      }
    }
  }
  return {
    ...finding,
    claims: finding.claims.map((claim) => ({
      ...claim,
      metrics: claim.metrics.map((metric) => (claim.resultPaths.length || metric.resultPath ? metric : stripRuntimeMetricFields(metric))),
    })),
  };
}
