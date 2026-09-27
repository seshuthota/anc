import type { AgentFinding } from "@anc/contracts";
import type { RuntimeStore } from "@anc/runtime-storage";

function readPath(value: unknown, path: string): unknown {
  return path.split(".").reduce<unknown>((current, part) => {
    if (current && typeof current === "object" && part in (current as object)) {
      return (current as Record<string, unknown>)[part];
    }
    return undefined;
  }, value);
}

export function validateFinding(store: RuntimeStore, finding: AgentFinding): AgentFinding {
  for (const claim of finding.claims) {
    for (const evidenceId of claim.evidenceIds) {
      if (!store.evidenceExists(evidenceId)) {
        throw new Error(`Finding ${finding.findingId} cites unknown evidence ${evidenceId}`);
      }
    }
    for (const metric of claim.metrics) {
      if (!claim.resultPaths.length) continue;
      const matches = claim.evidenceIds.some((evidenceId) => {
        const evidence = store.getEvidence(evidenceId);
        return claim.resultPaths.some((resultPath) => {
          const observed = readPath(evidence?.result, resultPath);
          if (typeof observed !== "number" || !Number.isFinite(observed)) return false;
          if (Math.abs(observed - metric.value) <= 1e-6) return true;
          if (observed <= 1 && metric.value > 1 && Math.abs(observed * 100 - metric.value) <= 0.15) return true;
          return false;
        });
      });
      if (!matches) {
        throw new Error(`Numeric claim ${metric.name} does not match evidence path ${claim.resultPaths.join(",")}`);
      }
    }
  }
  return finding;
}
