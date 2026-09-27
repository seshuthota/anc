import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { seedScenario, type SeedScenario } from "@anc/database";
import { resolvePrincipal } from "@anc/policy";
import { PARAPHRASES, buildEvalCases, percentile, scoreCase, scoreInvestigation, type EvalCase, type EvalScenario } from "./rubric.js";
import { resolveExecutionMode } from "../provider.js";
import type { PublicState } from "../runtime.js";

export const SCENARIOS: EvalScenario[] = ["sync-regression", "quiet-day", "unrelated-anomaly"];

type Row = {
  suite: "investigation" | "matrix";
  case: string;
  persona?: string;
  family?: string;
  paraphrase: string;
  repeat: number;
  pass: boolean;
  substituted: boolean;
  checks: unknown;
  timing?: PublicState["timing"];
  usage?: PublicState["usage"];
  execution?: PublicState["execution"];
};

function summarize(rows: Row[], timings: number[], findings: number[], activity: number[]) {
  const passed = rows.filter((row) => row.pass).length;
  const substitutedRuns = rows.filter((row) => row.substituted).length;
  return {
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
  };
}

/**
 * Two suites, reported separately because they answer different questions.
 *
 * `investigation` preserves the original morning-investigation regression over
 * three seeded datasets. `matrix` is the acceptance matrix: 4 personas x 3 task
 * families x 3 paraphrases per repeat, including the requests each persona is
 * supposed to be denied.
 */
export async function runEvalSuite(options: { repeats: number; live: boolean; matrix?: boolean; matrixRepeats?: number }) {
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

  const rows: Row[] = [];
  const record = (row: Row) => {
    rows.push(row);
    return row;
  };

  for (const scenario of SCENARIOS) {
    const companyPath = join(dir, `${scenario}.sqlite`);
    seedScenario(companyPath, scenario as SeedScenario);
    process.env.COMPANY_DB_PATH = companyPath;
    for (const paraphrase of PARAPHRASES) {
      for (let repeat = 1; repeat <= options.repeats; repeat += 1) {
        const state = await runInvestigation({ question: paraphrase, threadId: `${scenario}-${repeat}-${paraphrase.slice(0, 12)}` });
        const scored = scoreInvestigation(state, scenario);
        record({
          suite: "investigation",
          case: scenario,
          paraphrase,
          repeat,
          pass: scored.pass,
          substituted: (state.execution?.substitutions.length ?? 0) > 0,
          checks: scored.checks,
          timing: state.timing,
          usage: state.usage,
          execution: state.execution,
        });
      }
    }
  }

  if (options.matrix !== false) {
    const companyPath = join(dir, "matrix.sqlite");
    seedScenario(companyPath, "sync-regression");
    process.env.COMPANY_DB_PATH = companyPath;
    // 60 cells per repeat. Separated from `repeats` so the investigation
    // regression can be repeated more often than the acceptance matrix.
    const matrixRepeats = options.matrixRepeats ?? 1;
    for (const testCase of buildEvalCases()) {
      const principal = resolvePrincipal(testCase.persona);
      for (let repeat = 1; repeat <= matrixRepeats; repeat += 1) {
        const threadId = `matrix-${testCase.id}-${repeat}`;
        // A follow-up case only means something with a prior turn to resolve
        // "these accounts" against.
        if (testCase.setup) {
          await runInvestigation({ question: testCase.setup, threadId, principal });
        }
        const state = await runInvestigation({ question: testCase.question, threadId, principal });
        const scored = scoreCase(state, testCase satisfies EvalCase);
        record({
          suite: "matrix",
          case: testCase.id,
          persona: testCase.persona,
          family: testCase.family,
          paraphrase: testCase.question,
          repeat,
          pass: scored.pass,
          substituted: (state.execution?.substitutions.length ?? 0) > 0,
          checks: scored.checks,
          timing: state.timing,
          usage: state.usage,
          execution: state.execution,
        });
      }
    }
  }

  const pick = (suite: Row["suite"]) => rows.filter((row) => row.suite === suite);
  const stats = (subset: Row[]) => summarize(
    subset,
    subset.map((row) => row.timing?.completedMs ?? 0),
    subset.map((row) => row.timing?.firstFindingMs ?? 0),
    subset.map((row) => row.timing?.firstActivityMs ?? 0),
  );

  const matrixRows = pick("matrix");
  const byFamily = new Map<string, { total: number; passed: number }>();
  for (const row of matrixRows) {
    const key = `${row.persona}/${row.family}`;
    const entry = byFamily.get(key) ?? { total: 0, passed: 0 };
    entry.total += 1;
    if (row.pass) entry.passed += 1;
    byFamily.set(key, entry);
  }

  return {
    live: options.live,
    provider: process.env.MODEL_PROVIDER,
    executionMode: resolveExecutionMode(),
    ...stats(rows),
    suites: {
      investigation: stats(pick("investigation")),
      matrix: stats(matrixRows),
    },
    matrixByCell: Object.fromEntries([...byFamily.entries()].map(([key, value]) => [key, { ...value, rate: value.total ? value.passed / value.total : 0 }])),
    failedRows: rows.filter((row) => !row.pass).map((row) => ({ suite: row.suite, case: row.case, repeat: row.repeat, checks: row.checks })),
    rows,
  };
}
