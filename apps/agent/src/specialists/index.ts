import type { InvestigationTask, TaskResult } from "@anc/contracts";
import type { RuntimeStore } from "@anc/runtime-storage";
import { recordSubstitution } from "../execution.js";
import { resolveExecutionMode } from "../provider.js";
import { runFixtureSpecialist } from "./fixture.js";
import { runLiveSpecialist } from "./live.js";

export async function runSpecialist(store: RuntimeStore, task: InvestigationTask, runId: string, principalId?: string): Promise<TaskResult> {
  const mode = resolveExecutionMode();
  if (mode === "fixture") return runFixtureSpecialist(store, task, runId, principalId);
  try {
    const live = await runLiveSpecialist(store, task, runId, principalId);
    if (live.findings.length > 0) return live;
    throw new Error("Live specialist returned no validated findings");
  } catch (error) {
    const reason = error instanceof Error ? error.message : "live specialist failed";
    if (mode === "live-strict") throw error instanceof Error ? error : new Error(reason);
    recordSubstitution(runId, task.domain, reason);
    return runFixtureSpecialist(store, task, runId, principalId);
  }
}

export { specialistLabel } from "../registry.js";
