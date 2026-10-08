import { randomUUID } from "node:crypto";
import type { AgentFinding, InvestigationTask, TaskResult } from "@anc/contracts";
import type { RuntimeStore } from "@anc/runtime-storage";
import { saveCapabilityArtifacts } from "../artifacts.js";
import { CompanyMcpClient } from "../mcp-client.js";
import { CAPABILITIES } from "../registry.js";
import { validateFinding } from "../validation.js";

/**
 * The specialist used when no model is configured. It calls each capability a
 * task names with fixed arguments and reports how many records came back. It
 * exists so the pipeline can be run and tested without a model; it does not
 * interpret anything.
 */
export async function runFixtureSpecialist(store: RuntimeStore, task: InvestigationTask, runId: string, principalId?: string): Promise<TaskResult> {
  const client = new CompanyMcpClient(store, { runId, taskId: task.taskId, principalId });
  await client.connect();
  try {
    const scope = Object.fromEntries(task.entityScope.map((entity) => [entity.type, entity.id]));
    const findings: AgentFinding[] = [];
    for (const capabilityId of task.capabilities) {
      const def = CAPABILITIES.find((item) => item.id === capabilityId && item.sideEffect === "read" && !item.internal);
      if (!def) continue;
      const args = def.defaults ? def.defaults(scope) : {};
      if (args === undefined) continue;
      const evidence = await client.call(def.tool, Object.fromEntries(Object.entries(args).filter(([, value]) => value !== undefined)), task.domain);
      saveCapabilityArtifacts(store, task, runId, def, evidence);
      const result = (evidence.result ?? {}) as { rows?: Array<Record<string, unknown>>; points?: unknown[] };
      const rows = result.rows ?? [];
      const count = rows.length || result.points?.length || 0;
      const rowEntity = def.rowEntity;
      const findingId = `finding-${task.taskId}-${def.tool}`;
      findings.push({
        findingId,
        taskId: task.taskId,
        agentId: task.domain,
        kind: "observation",
        title: def.description.split(":")[0]!,
        summary: count ? `${count} record${count === 1 ? "" : "s"} returned.` : "Nothing was returned.",
        severity: count ? "medium" : "info",
        entities: rowEntity ? rows.slice(0, 12).map((row) => ({ type: rowEntity.type, id: String(row[rowEntity.idField]) })) : task.entityScope,
        claims: [{
          claimId: randomUUID(),
          statement: def.description,
          evidenceIds: [String(evidence.evidenceId)],
          resultPaths: [],
          metrics: [{ name: "records", value: count, unit: "count", aggregation: "count" }],
          entities: [],
          limitations: [],
          contradictoryEvidenceIds: [],
        }],
        createdAt: new Date().toISOString(),
        limitations: [],
      });
    }
    for (const item of findings) validateFinding(store, item);
    for (const item of findings) store.saveFinding({ findingId: item.findingId, runId, taskId: task.taskId, payload: item, now: new Date().toISOString() });
    return {
      taskId: task.taskId,
      status: findings.length ? "completed" : "partial",
      findingIds: findings.map((item) => item.findingId),
      findings,
      unresolvedQuestions: findings.length ? [] : ["Nothing could be looked up for this task"],
      suggestedFollowUps: [],
    };
  } catch (error) {
    return { taskId: task.taskId, status: "failed", findingIds: [], findings: [], unresolvedQuestions: [], suggestedFollowUps: [], error: error instanceof Error ? error.message : "specialist failed" };
  } finally {
    await client.close();
  }
}
