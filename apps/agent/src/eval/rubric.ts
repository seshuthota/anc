import type { PublicState } from "../runtime.js";

export const PARAPHRASES = [
  "What should I care about this morning?",
  "Anything I need to know at the start of the day?",
  "What's going on with the company right now?",
] as const;

export type EvalScenario = "sync-regression" | "quiet-day" | "unrelated-anomaly";

export type RubricCheck = { name: string; pass: boolean; detail: string };

export function scoreInvestigation(state: PublicState, scenario: EvalScenario): { pass: boolean; checks: RubricCheck[] } {
  const blob = JSON.stringify(state.surface?.dataModel ?? {}).toLowerCase();
  const activity = state.activity.map((item) => item.message).join(" | ");
  const specialists = ["Reliability", "Product", "Customer"].filter((name) => activity.includes(`${name} Agent`));
  const checks: RubricCheck[] = [
    { name: "surface", pass: Boolean(state.surface), detail: state.surface?.title ?? "none" },
    { name: "no_confirmed_root_cause", pass: !/root cause is confirmed|definitely caused by/.test(blob), detail: "hypothesis preserved" },
  ];
  if (scenario === "sync-regression") {
    checks.push(
      { name: "error_signal", pass: /error/.test(blob), detail: "error mentioned" },
      { name: "impact_or_arr_or_usage", pass: /arr|account|usage/.test(blob), detail: "impact present" },
      { name: "specialist_overlap", pass: specialists.length >= 2, detail: specialists.join(",") },
    );
  }
  if (scenario === "quiet-day") {
    const quiet = /no major|within the baseline|stable|no material/.test(blob) && !/concentrated synchronization problem/.test(blob);
    checks.push(
      { name: "no_invented_incident", pass: quiet, detail: String((state.surface?.dataModel as { subtitle?: string })?.subtitle ?? "") },
      { name: "no_unsupported_arr_headline", pass: !/lost \$|revenue loss/.test(blob), detail: "no loss language" },
    );
  }
  if (scenario === "unrelated-anomaly") {
    const blamesOnlySyncV2 = /sync-v2 error rate is elevated/.test(blob) && !/sync-v1|billing|invoice/.test(blob);
    checks.push(
      { name: "follows_evidence", pass: !blamesOnlySyncV2 && /error|release/.test(blob), detail: blob.slice(0, 180) },
    );
  }
  return { pass: checks.every((check) => check.pass), checks };
}

export function percentile(values: number[], p: number): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[index]!;
}
