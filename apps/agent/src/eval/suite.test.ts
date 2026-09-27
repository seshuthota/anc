import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const dir = mkdtempSync(join(tmpdir(), "anc-eval-test-"));
process.env.RUNTIME_DB_PATH = join(dir, "runtime.sqlite");
process.env.MODEL_PROVIDER = "fixture";
process.env.VITEST = "true";

const { runEvalSuite } = await import("./suite.js");

describe("opening-query evaluation", () => {
  it("scores three paraphrases across three datasets", async () => {
    const report = await runEvalSuite({ repeats: 3, live: false });
    expect(report.total).toBe(27);
    expect(report.executionMode).toBe("fixture");
    expect(report.substitutedRuns).toBe(0);
    expect(report.rate).toBeGreaterThanOrEqual(0.9);
    expect(report.latency.completedMs.median).toBeGreaterThan(0);
  }, 180_000);
});
