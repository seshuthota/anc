export type ModelUsage = {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  calls: number;
};

const usageByRun = new Map<string, ModelUsage>();

export function recordUsage(runId: string, usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number; input_tokens?: number; output_tokens?: number } | null) {
  const current = usageByRun.get(runId) ?? { promptTokens: 0, completionTokens: 0, totalTokens: 0, calls: 0 };
  const prompt = usage?.prompt_tokens ?? usage?.input_tokens ?? 0;
  const completion = usage?.completion_tokens ?? usage?.output_tokens ?? 0;
  current.promptTokens += prompt;
  current.completionTokens += completion;
  current.totalTokens += usage?.total_tokens ?? prompt + completion;
  current.calls += 1;
  usageByRun.set(runId, current);
}

export function peekUsage(runId: string): ModelUsage {
  return usageByRun.get(runId) ?? { promptTokens: 0, completionTokens: 0, totalTokens: 0, calls: 0 };
}

export function takeUsage(runId: string): ModelUsage {
  const usage = peekUsage(runId);
  usageByRun.delete(runId);
  return usage;
}

export function configuredUsdPerMillion(env: NodeJS.ProcessEnv = process.env): number | null {
  const raw = env.MODEL_USD_PER_MILLION;
  if (raw === undefined || raw.trim() === "") return null;
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? value : null;
}

export function priceCost(usage: ModelUsage, env: NodeJS.ProcessEnv = process.env): { estimatedCostUsd: number | null; costStatus: "known" | "unknown" } {
  const usdPerMillion = configuredUsdPerMillion(env);
  if (usdPerMillion === null) return { estimatedCostUsd: null, costStatus: "unknown" };
  return { estimatedCostUsd: Number(((usage.totalTokens / 1_000_000) * usdPerMillion).toFixed(6)), costStatus: "known" };
}

export function estimateCostUsd(usage: ModelUsage, usdPerMillion = configuredUsdPerMillion() ?? 0): number | null {
  if (!usdPerMillion) return null;
  return Number(((usage.totalTokens / 1_000_000) * usdPerMillion).toFixed(6));
}

export function assertUsdBudgetCanBeEnforced(env: NodeJS.ProcessEnv = process.env) {
  const budget = env.MODEL_USD_BUDGET;
  if (budget === undefined || budget.trim() === "") return;
  if (configuredUsdPerMillion(env) === null) {
    throw new Error("A USD budget is set, but the model price is not configured. Cost is unknown, not zero.");
  }
}
