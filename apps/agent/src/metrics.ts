const latencies: number[] = [];
let requests = 0;
let errors = 0;

export function recordOutcome(latencyMs: number, ok: boolean) {
  requests += 1;
  latencies.push(latencyMs);
  if (latencies.length > 200) latencies.shift();
  if (!ok) errors += 1;
}

export function outcomeSnapshot() {
  const sorted = [...latencies].sort((left, right) => left - right);
  const pick = (ratio: number) => sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(ratio * (sorted.length - 1)))] ?? null : null;
  return {
    requests,
    errors,
    latencyMs: { p50: pick(0.5), p95: pick(0.95) },
  };
}
