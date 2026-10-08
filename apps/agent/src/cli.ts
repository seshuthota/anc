import { publicState, restoreSurface, runInvestigation, store } from "./runtime.js";
import { DEFAULT_THREAD_ID } from "./windows.js";

const [command, ...rest] = process.argv.slice(2);

async function main() {
  if (command === "investigate") {
    const question = rest.filter((item) => item !== "--").join(" ").trim() || "Brief me: what needs my attention this morning?";
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
  console.error("Usage: tsx src/cli.ts investigate [question] | replay [--run id]");
  process.exitCode = 1;
}

await main();
