import { randomUUID } from "node:crypto";
import type { AgentFinding, InvestigationTask, Metric, TaskResult } from "@anc/contracts";
import { bindRegistryMetric, readResultPath, type EvidenceLike } from "@anc/contracts";
import type { RuntimeStore } from "@anc/runtime-storage";
import { saveCapabilityArtifacts } from "../artifacts.js";
import { CompanyMcpClient } from "../mcp-client.js";
import { CAPABILITIES } from "../registry.js";
import { validateFinding } from "../validation.js";


/**
 * The specialist used when no model is configured. It calls each capability a
 * task names with fixed arguments and turns registry headline specs into
 * titled findings with real metrics — so fixture briefings can be ranked.
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
      const result = (evidence.result ?? {}) as Record<string, unknown>;
      const rows = (Array.isArray(result.rows) ? result.rows : []) as Array<Record<string, unknown>>;
      const headline = def.headline;
      const row = headline?.pickRow ? headline.pickRow(rows) : rows[0];
      const path = headline?.path ?? "";
      let value: number | undefined;
      let resultPath = path;
      if (path.startsWith("rows.") && row) {
        const field = path.slice("rows.".length);
        const raw = row[field];
        if (typeof raw === "number" && Number.isFinite(raw)) {
          value = raw;
          const index = rows.indexOf(row);
          resultPath = `rows.${Math.max(0, index)}.${field}`;
        }
      } else if (path) {
        const raw = readResultPath(result, path);
        if (typeof raw === "number" && Number.isFinite(raw)) {
          value = raw;
          resultPath = path;
        }
      }

      // Qualitative equipment-style headline with no numeric path.
      if (headline && !path) {
        if (!row && rows.length === 0) continue;
        const severity = headline.severity(0, result, row);
        if (severity === "info") continue;
        const findingId = `finding-${task.taskId}-${def.tool}`;
        findings.push({
          findingId,
          taskId: task.taskId,
          agentId: task.domain,
          kind: "observation",
          title: headline.title({ value: 0, row, result }),
          summary: headline.summary({ value: 0, row, result }),
          severity,
          entities: row && def.rowEntity ? [{ type: def.rowEntity.type, id: String(row[def.rowEntity.idField]), label: typeof row.name === "string" ? row.name : typeof row.hubName === "string" ? row.hubName : undefined }] : task.entityScope,
          claims: [{
            claimId: randomUUID(),
            statement: headline.summary({ value: 0, row, result }),
            evidenceIds: [String(evidence.evidenceId)],
            resultPaths: [],
            metrics: [],
            entities: [],
            limitations: [],
            contradictoryEvidenceIds: [],
          }],
          createdAt: new Date().toISOString(),
          limitations: [],
        });
        continue;
      }

      if (value === undefined) {
        // Nothing numeric to report for this capability on a quiet day.
        continue;
      }

      const severity = headline ? headline.severity(value, result, row) : (value > 0 ? "medium" : "info");
      if (severity === "info" && value === 0) continue;

      // Metric id, scope and denominator come from the registry binding of (tool, path),
      // the same runtime mapping a live specialist's figures go through.
      const bound = bindRegistryMetric(evidence as EvidenceLike, resultPath, value);
      const binding = bound && (!headline?.metricId || bound.metricId === headline.metricId) ? bound : undefined;
      const metrics: Metric[] = [binding ? {
        name: binding.definition.label,
        value,
        unit: binding.definition.unit,
        aggregation: "count",
        metricId: binding.metricId,
        scope: binding.scope,
        denominator: binding.denominator,
        resultPath,
        evidenceId: String(evidence.evidenceId),
      } : {
        name: "value",
        value,
        unit: "count",
        aggregation: "count",
      }];

      const findingId = `finding-${task.taskId}-${def.tool}`;
      const title = headline ? headline.title({ value, row, result }) : def.description.split(":")[0]!;
      const summary = headline ? headline.summary({ value, row, result }) : `${value} recorded.`;
      findings.push({
        findingId,
        taskId: task.taskId,
        agentId: task.domain,
        kind: "observation",
        title,
        summary,
        severity,
        entities: row && def.rowEntity ? [{ type: def.rowEntity.type, id: String(row[def.rowEntity.idField]), label: typeof row.name === "string" ? row.name : typeof row.hubName === "string" ? row.hubName : undefined }] : task.entityScope,
        claims: [{
          claimId: randomUUID(),
          statement: summary,
          evidenceIds: [String(evidence.evidenceId)],
          resultPaths: resultPath ? [resultPath] : [],
          metrics,
          entities: [],
          limitations: [],
          contradictoryEvidenceIds: [],
        }],
        createdAt: new Date().toISOString(),
        limitations: [],
      });
    }
    const checked = findings.map((item) => validateFinding(store, item));
    for (const item of checked) store.saveFinding({ findingId: item.findingId, runId, taskId: task.taskId, payload: item, now: new Date().toISOString() });
    return {
      taskId: task.taskId,
      status: checked.length ? "completed" : "partial",
      findingIds: checked.map((item) => item.findingId),
      findings: checked,
      unresolvedQuestions: checked.length ? [] : ["Nothing could be looked up for this task"],
      suggestedFollowUps: [],
    };
  } catch (error) {
    return { taskId: task.taskId, status: "failed", findingIds: [], findings: [], unresolvedQuestions: [], suggestedFollowUps: [], error: error instanceof Error ? error.message : "specialist failed" };
  } finally {
    await client.close();
  }
}
