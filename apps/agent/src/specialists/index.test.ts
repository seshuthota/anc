import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { DEFAULT_COMPANY_DB_PATH } from "@anc/database";
import { openRuntimeDatabase, RuntimeStore } from "@anc/runtime-storage";
import { peekSubstitutions } from "../execution.js";
import { CURRENT } from "../windows.js";
import { runSpecialist } from "./index.js";

const dir = mkdtempSync(join(tmpdir(), "anc-specialist-"));
process.env.COMPANY_DB_PATH = DEFAULT_COMPANY_DB_PATH;
process.env.RUNTIME_DB_PATH = join(dir, "runtime.sqlite");
process.env.MODEL_PROVIDER = "fixture";
process.env.MODEL_EXECUTION_MODE = "fixture";

const store = new RuntimeStore(openRuntimeDatabase(process.env.RUNTIME_DB_PATH));
const task = {
  taskId: "task-reliability",
  domain: "reliability" as const,
  question: "What reliability signals should be investigated?",
  entityScope: [],
  window: { start: CURRENT.from, end: CURRENT.to, timezone: "UTC" as const, grain: "hour" as const },
  dependencies: [],
  status: "pending" as const,
  attemptCount: 0,
  capabilities: [],
};

afterAll(() => store.close());

describe("specialist execution modes", () => {
  it("uses the deterministic specialist in fixture mode", async () => {
    const result = await runSpecialist(store, { ...task, taskId: "task-fixture" }, "run-fixture-mode");
    expect(result.findings.length).toBeGreaterThan(0);
    expect(peekSubstitutions("run-fixture-mode")).toEqual([]);
  });

  it("does not substitute fixture answers in live-strict mode", async () => {
    process.env.MODEL_PROVIDER = "explabs";
    process.env.MODEL_EXECUTION_MODE = "live-strict";
    delete process.env.EXPLABS_API_KEY;
    await expect(runSpecialist(store, { ...task, taskId: "task-strict" }, "run-strict-mode")).rejects.toThrow(/API key|base URL/i);
    expect(peekSubstitutions("run-strict-mode")).toEqual([]);
    process.env.MODEL_PROVIDER = "fixture";
    process.env.MODEL_EXECUTION_MODE = "fixture";
  });

  it("records an explicit live-fallback substitution", async () => {
    process.env.MODEL_PROVIDER = "explabs";
    process.env.MODEL_EXECUTION_MODE = "live-fallback";
    delete process.env.EXPLABS_API_KEY;
    const result = await runSpecialist(store, { ...task, taskId: "task-fallback" }, "run-fallback-mode");
    expect(result.findings.length).toBeGreaterThan(0);
    expect(peekSubstitutions("run-fallback-mode")[0]?.specialist).toBe("reliability");
    process.env.MODEL_PROVIDER = "fixture";
    process.env.MODEL_EXECUTION_MODE = "fixture";
  });
});
