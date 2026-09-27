import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { seedScenario, type SeedScenario } from "@anc/database";
import { PARAPHRASES, percentile, scoreInvestigation, type EvalScenario } from "./rubric.js";
import { resolveExecutionMode } from "../provider.js";
import type { PublicState } from "../runtime.js";

export const SCENARIOS: EvalScenario[] = ["sync-regression", "quiet-day", "unrelated-anomaly"];

export async function runEvalSuite(options: { repeats: number; live: boolean }) {
  const dir = mkdtempSync(join(tmpdir(), "anc-eval-"));
  if (!options.live) {
    process.env.MODEL_PROVIDER = "fixture";
    process.env.MODEL_EXECUTION_MODE = "fixture";
  } else if (!process.env.MODEL_PROVIDER || process.env.MODEL_PROVIDER === "fixture") {
    process.env.MODEL_PROVIDER = "explabs";
  }
  if (options.live && !process.env.MODEL_EXECUTION_MODE) process.env.MODEL_EXECUTION_MODE = "live-strict";
  if (!process.env.RUNTIME_DB_PATH) process.env.RUNTIME_DB_PATH = join(dir, "runtime.sqlite");
  const { runInvestigation } = await import("../runtime.js");
  const rows: Array<{
    scenario: EvalScenario;
    paraphrase: string;
    repeat: number;
    pass: boolean;
    substituted: boolean;
    checks: unknown;
    timing?: PublicState["timing"];
    usage?: PublicState["usage"];
    execution?: PublicState["execution"];
  }> = [];
  for (const scenario of SCENARIOS) {
    const companyPath = join(dir, `${scenario}.sqlite`);
    seedScenario(companyPath, scenario as SeedScenario);
    process.env.COMPANY_DB_PATH = companyPath;
    for (const paraphrase of PARAPHRASES) {
      for (let repeat = 1; repeat <= options.repeats; repeat += 1) {
        const state = await runInvestigation({ question: paraphrase, threadId: `${scenario}-${repeat}-${paraphrase.slice(0, 12)}` });
        const scored = scoreInvestigation(state, scenario);
        const substituted = (state.execution?.substitutions.length ?? 0) > 0;
        rows.push({
          scenario,
          paraphrase,
          repeat,
          pass: scored.pass,
          substituted,
          checks: scored.checks,
          timing: state.timing,
          usage: state.usage,
          execution: state.execution,
        });
      }
    }
  }
  const passed = rows.filter((row) => row.pass).length;
  const timings = rows.map((row) => row.timing?.completedMs ?? 0);
  const findings = rows.map((row) => row.timing?.firstFindingMs ?? 0);
  const activity = rows.map((row) => row.timing?.firstActivityMs ?? 0);
  const substitutedRuns = rows.filter((row) => row.substituted).length;
  return {
    live: options.live,
    provider: process.env.MODEL_PROVIDER,
    executionMode: resolveExecutionMode(),
    total: rows.length,
    passed,
    passedWithoutSubstitution: rows.filter((row) => row.pass && !row.substituted).length,
    substitutedRuns,
    rate: rows.length ? passed / rows.length : 0,
    strictRate: rows.length ? rows.filter((row) => row.pass && !row.substituted).length / rows.length : 0,
    latency: {
      firstActivityMs: { median: percentile(activity, 50), p95: percentile(activity, 95) },
      firstFindingMs: { median: percentile(findings, 50), p95: percentile(findings, 95) },
      completedMs: { median: percentile(timings, 50), p95: percentile(timings, 95) },
    },
    tokens: {
      total: rows.reduce((sum, row) => sum + (row.usage?.totalTokens ?? 0), 0),
      calls: rows.reduce((sum, row) => sum + (row.usage?.calls ?? 0), 0),
      estimatedCostUsd: rows.every((row) => row.usage?.costStatus === "known" && row.usage.estimatedCostUsd !== null)
        ? rows.reduce((sum, row) => sum + (row.usage?.estimatedCostUsd ?? 0), 0)
        : null,
      costStatus: rows.every((row) => row.usage?.costStatus === "known") ? "known" : "unknown",
    },
    rows,
  };
}
