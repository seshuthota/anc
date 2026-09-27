import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const dir = mkdtempSync(join(tmpdir(), "anc-eval-test-"));
process.env.RUNTIME_DB_PATH = join(dir, "runtime.sqlite");
process.env.MODEL_PROVIDER = "fixture";
process.env.VITEST = "true";

const { runEvalSuite } = await import("./suite.js");
const { buildEvalCases, EVAL_FAMILIES, EVAL_PERSONAS } = await import("./rubric.js");

describe("opening-query evaluation", () => {
  it("scores three paraphrases across three datasets", async () => {
    const report = await runEvalSuite({ repeats: 3, live: false, matrix: false });
    expect(report.suites.investigation.total).toBe(27);
    expect(report.executionMode).toBe("fixture");
    expect(report.substitutedRuns).toBe(0);
    expect(report.rate).toBeGreaterThanOrEqual(0.9);
    expect(report.latency.completedMs.median).toBeGreaterThan(0);
  }, 300_000);
});

describe("acceptance matrix", () => {
  it("covers every persona and task family", () => {
    const cases = buildEvalCases();
    expect(cases.length).toBe(66);
    for (const persona of EVAL_PERSONAS) {
      for (const family of EVAL_FAMILIES) {
        expect(cases.some((item) => item.persona === persona && item.family === family)).toBe(true);
      }
    }
    // Every family must contain a promised refusal, or a grant leak passes silently.
    for (const family of EVAL_FAMILIES) {
      expect(cases.some((item) => item.family === family && item.expect === "denied")).toBe(true);
    }
    expect(cases.filter((item) => item.expect === "denied").length).toBeGreaterThanOrEqual(24);
  });

  it("passes the matrix end to end without fixture substitution", async () => {
    const report = await runEvalSuite({ repeats: 1, live: false, matrix: true, matrixRepeats: 1 });
    const matrix = report.suites.matrix;
    expect(matrix.total).toBe(66);
    expect(matrix.substitutedRuns).toBe(0);
    expect(report.failedRows.filter((row) => row.suite === "matrix")).toEqual([]);
    expect(matrix.rate).toBeGreaterThanOrEqual(0.9);
    for (const [cell, value] of Object.entries(report.matrixByCell)) {
      expect(value.rate, `cell ${cell} below threshold`).toBeGreaterThanOrEqual(0.9);
    }
  }, 600_000);
});
