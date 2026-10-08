import { bindRegistryMetric, type EvidenceLike, type Metric, type MetricBinding } from "@anc/contracts";
import type { RuntimeStore } from "@anc/runtime-storage";
import { stripRuntimeMetricFields } from "./validation.js";

/**
 * Binds one stated figure to the metric registry. The model's own metricId, scope
 * and denominator were stripped on parse; here they are derived only from the
 * (tool, resultPath) whose evidence value matches the figure. When the claim cites
 * several paths, each figure is paired with the path holding its value, so 905
 * (`totals.atRisk`) and 4,000 (`totals.promisedToday`) never both become the same
 * metric. A figure that matches no registry source, or two different ones, stays an
 * unbound prose figure and is not eligible as a headline.
 */
export function bindClaimMetric(store: Pick<RuntimeStore, "getEvidence">, claim: { evidenceIds: string[]; resultPaths: string[] }, metric: Metric): Metric {
  const plain = stripRuntimeMetricFields(metric);
  if (!claim.resultPaths.length) return plain;
  const found: Array<{ binding: MetricBinding; evidenceId: string }> = [];
  for (const evidenceId of claim.evidenceIds) {
    const evidence = store.getEvidence(evidenceId) as EvidenceLike | undefined;
    if (!evidence) continue;
    for (const path of claim.resultPaths) {
      const binding = bindRegistryMetric(evidence, path, metric.value);
      if (binding) found.push({ binding, evidenceId });
    }
  }
  const distinct = new Set(found.map(({ binding }) => `${binding.metricId}|${binding.scope.type}|${binding.scope.id ?? ""}|${binding.value}`));
  if (distinct.size !== 1) return plain;
  const { binding, evidenceId } = found[0]!;
  return {
    ...plain,
    name: binding.definition.label,
    unit: binding.definition.unit,
    value: binding.value,
    metricId: binding.metricId,
    scope: binding.scope,
    denominator: binding.denominator,
    resultPath: binding.resultPath,
    evidenceId,
  };
}

