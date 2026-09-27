import { publicState, restoreSurface, runInvestigation, store } from "./runtime.js";
import { DEFAULT_THREAD_ID } from "./windows.js";

const [command, ...rest] = process.argv.slice(2);

async function main() {
  if (command === "investigate") {
    const question = rest.filter((item) => item !== "--").join(" ").trim() || "What should I care about this morning?";
    const state = await runInvestigation({ question, threadId: DEFAULT_THREAD_ID });
    console.log(JSON.stringify({ status: state.status, investigationId: state.investigationId, runId: state.runId, surface: state.surface?.title, activity: state.activity.slice(0, 12) }, null, 2));
    return;
  }
  if (command === "replay") {
    const runFlag = rest.indexOf("--run");
    const threadId = DEFAULT_THREAD_ID;
    const history = store.listSurfaces(threadId);
    const target = runFlag >= 0 ? history.find((item) => item.surfaceId.includes(String(rest[runFlag + 1]))) ?? history[0] : history[0];
    if (!target) {
      console.error("No saved surface to replay.");
      process.exitCode = 1;
      return;
    }
    const state = restoreSurface(threadId, target.surfaceId, target.revision);
    console.log(JSON.stringify({ replayed: target, surface: state.surface?.title, status: state.status }, null, 2));
    return;
  }
  if (command === "eval" || command === "eval-live") {
    const live = command === "eval-live";
    if (live) {
      const { resolveModelConfig } = await import("./provider.js");
      if (!process.env.MODEL_PROVIDER || process.env.MODEL_PROVIDER === "fixture") {
        process.env.MODEL_PROVIDER = process.env.EXPLABS_API_KEY ? "explabs" : process.env.XAI_API_KEY ? "xai" : "openai";
      }
      if (!process.env.MODEL_EXECUTION_MODE) process.env.MODEL_EXECUTION_MODE = "live-strict";
      if (!resolveModelConfig().apiKey) {
        console.error("eval:live requires EXPLABS_API_KEY (or XAI_API_KEY / MODEL_API_KEY)");
        process.exitCode = 2;
        return;
      }
    }
    const repeats = Number(process.env.EVAL_REPEATS ?? 3);
    const { runEvalSuite } = await import("./eval/suite.js");
    const report = await runEvalSuite({ repeats, live });
    console.log(JSON.stringify({
      live: report.live,
      provider: report.provider,
      executionMode: report.executionMode,
      total: report.total,
      passed: report.passed,
      passedWithoutSubstitution: report.passedWithoutSubstitution,
      substitutedRuns: report.substitutedRuns,
      rate: report.rate,
      strictRate: report.strictRate,
      latency: report.latency,
      tokens: report.tokens,
      failed: report.rows.filter((row) => !row.pass).map((row) => ({ scenario: row.scenario, paraphrase: row.paraphrase, repeat: row.repeat, checks: row.checks })),
    }, null, 2));
    if (live && report.executionMode === "live-strict" && report.strictRate < 0.9) process.exitCode = 1;
    else if (live && report.rate < 0.9) process.exitCode = 1;
    return;
  }
  console.log(JSON.stringify(publicState(), null, 2));
}

await main();
