import { randomUUID } from "node:crypto";
import type { AgentFinding, Domain, InvestigationTask, TaskResult } from "@anc/contracts";
import type { RuntimeStore } from "@anc/runtime-storage";
import { CompanyMcpClient } from "../mcp-client.js";
import { CAPABILITIES } from "../registry.js";
import { BASELINE, CURRENT, RELEASE_WINDOW, TREND_WINDOW } from "../windows.js";
import { validateFinding } from "../validation.js";

type Row = Record<string, unknown>;
const rowsOf = (value: Record<string, unknown>) => ((value.result as { rows?: Row[] } | undefined)?.rows ?? []);
const idOf = (value: Record<string, unknown>) => String(value.evidenceId);
const now = () => new Date().toISOString();

function finding(partial: Omit<AgentFinding, "createdAt" | "claims"> & { claims: AgentFinding["claims"] }): AgentFinding {
  return { ...partial, createdAt: now() };
}

export async function runFixtureSpecialist(store: RuntimeStore, task: InvestigationTask, runId: string, principalId?: string): Promise<TaskResult> {
  const client = new CompanyMcpClient(store, { runId, taskId: task.taskId, principalId });
  await client.connect();
  try {
    const findings = await investigate(client, store, task, runId);
    for (const item of findings) validateFinding(store, item);
    for (const item of findings) store.saveFinding({ findingId: item.findingId, runId, taskId: task.taskId, payload: item, now: now() });
    return {
      taskId: task.taskId,
      status: findings.length ? "completed" : "partial",
      findingIds: findings.map((item) => item.findingId),
      findings,
      unresolvedQuestions: findings.length ? [] : ["No verified observations in this domain"],
      suggestedFollowUps: [],
    };
  } catch (error) {
    return {
      taskId: task.taskId,
      status: "failed",
      findingIds: [],
      findings: [],
      unresolvedQuestions: [],
      suggestedFollowUps: [],
      error: error instanceof Error ? error.message : "specialist failed",
    };
  } finally {
    await client.close();
  }
}

const CLASSIC: Record<string, string[]> = {
  reliability: ["cap.service.health", "cap.service.errors", "cap.releases.read", "cap.customers.impact"],
  product: ["cap.usage.read"],
  customer: ["cap.customers.read", "cap.tickets.read"],
  finance: ["cap.finance.arr"],
};

async function investigate(client: CompanyMcpClient, store: RuntimeStore, task: InvestigationTask, runId: string): Promise<AgentFinding[]> {
  const customerId = task.entityScope.find((entity) => entity.type === "customer")?.id;
  const releaseId = task.entityScope.find((entity) => entity.type === "release")?.id;
  const knownCustomers = task.entityScope.filter((entity) => entity.type === "customer").map((entity) => entity.id);
  const caps = task.capabilities ?? [];
  const classic = CLASSIC[task.domain] ?? [];
  const useClassic = !caps.length || classic.every((item) => caps.includes(item));
  const extras = caps.filter((item) => !classic.includes(item));
  const findings: AgentFinding[] = [];
  if (useClassic) {
    if (task.domain === "reliability") findings.push(...await reliability(client, task, releaseId));
    else if (task.domain === "product") findings.push(...await product(client, task, knownCustomers, customerId));
    else if (task.domain === "customer") findings.push(...await customer(client, task, customerId));
    else if (task.domain === "finance") findings.push(...await finance(client, task, knownCustomers, customerId));
  }
  const genericCaps = useClassic ? extras : caps;
  if (genericCaps.length) findings.push(...await runCapabilities(client, store, task, runId, genericCaps));
  return findings;
}

function defaultArgs(tool: string, task: InvestigationTask): Record<string, unknown> | undefined {
  const customerId = task.entityScope.find((entity) => entity.type === "customer")?.id;
  const knownCustomers = task.entityScope.filter((entity) => entity.type === "customer").map((entity) => entity.id);
  if (tool === "get_customer" || tool === "get_subscription" || tool === "get_customer_feature_usage" || tool === "get_customer_support_history") {
    if (!customerId) return undefined;
  }
  if (tool === "calculate_account_exposure" && !knownCustomers.length) return undefined;
  switch (tool) {
    case "get_service_health":
    case "get_error_metrics":
    case "list_impacted_customers":
      return { service: "sync-service", window: CURRENT };
    case "get_service_health_series":
      return { service: "sync-service", window: TREND_WINDOW, metric: "errorRate" };
    case "get_recent_releases":
      return { window: RELEASE_WINDOW };
    case "compare_usage_periods":
      return { feature: "synchronization", current: CURRENT, baseline: BASELINE, customerIds: knownCustomers.length ? knownCustomers : undefined };
    case "get_feature_usage":
      return { feature: "synchronization", window: CURRENT };
    case "get_customer":
      return { customerId };
    case "get_subscription":
      return { customerId };
    case "get_customer_feature_usage":
      return { customerId, feature: "synchronization", window: CURRENT };
    case "get_customer_support_history":
      return { customerId, window: CURRENT };
    case "search_support_tickets":
      return { window: CURRENT, page: { limit: 100, offset: 0 } };
    case "list_unassigned_escalations":
      return { page: { limit: 25, offset: 0 } };
    case "list_eligible_assignees":
      return { team: "support" };
    case "list_invoice_aging":
      return {};
    case "list_open_incidents":
      return {};
    case "calculate_account_exposure":
      return { customerIds: knownCustomers, definition: "Accounts in the current task scope." };
    default:
      return {};
  }
}

/**
 * Formats a cell for display only. Raw values stay available through the
 * evidence envelope; sorting uses the unformatted numeric `sortValues`.
 */
function displayCell(column: string, value: unknown): string {
  if (value === undefined || value === null) return "";
  if (/minor/i.test(column) && typeof value === "number") {
    return `$${(value / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  }
  if (typeof value === "number" && /rate|ratio/i.test(column) && value > 0 && value <= 1) {
    return `${(value * 100).toFixed(2)}%`;
  }
  if (typeof value === "string" && /^\d{4}-\d{2}-\d{2}T/.test(value)) return value.slice(0, 16).replace("T", " ");
  return String(value);
}

/**
 * Resolves the entity a row refers to. The row's own `id` is only correct when
 * it already is the entity id: an invoice row carries `id = inv-...` while its
 * entity type is `customer`, so the type must drive the lookup.
 */
function entityIdFor(entityType: string, row: Record<string, unknown>, index: number): string {
  if (entityType === "customer") return String(row.customerId ?? row.id ?? index);
  if (entityType === "ticket") return String(row.id ?? row.ticketId ?? index);
  if (entityType === "incident") return String(row.id ?? row.incidentId ?? index);
  if (entityType === "release") return String(row.id ?? row.releaseId ?? index);
  return String(row.id ?? row[`${entityType}Id`] ?? index);
}

async function runCapabilities(client: CompanyMcpClient, store: RuntimeStore, task: InvestigationTask, runId: string, capabilityIds: string[]): Promise<AgentFinding[]> {  const findings: AgentFinding[] = [];
  for (const capabilityId of capabilityIds) {
    const def = CAPABILITIES.find((item) => item.id === capabilityId);
    if (!def || def.sideEffect === "write") continue;
    const args = defaultArgs(def.tool, task);
    if (args === undefined) continue;
    const evidence = await client.call(def.tool, args, task.domain);
    const rows = rowsOf(evidence);
    const result = evidence.result as Record<string, unknown> | undefined;
    if (def.series) {
      const points = (result?.points as Array<Record<string, unknown>> | undefined) ?? [];
      const usable = points
        .map((point) => ({ label: String(point.bucket ?? ""), value: Number(point[def.series!] ?? 0) }))
        .filter((point) => point.label && Number.isFinite(point.value));
      if (usable.length >= 2) {
        store.saveArtifact({
          id: `artifact-${task.taskId}-${def.tool}`,
          threadId: "pending",
          runId,
          ownerId: "pending",
          kind: "series",
          payload: {
            title: def.description,
            unit: def.series === "errorRate" ? "ratio" : "count",
            metric: def.series,
            points: usable,
          },
          now: now(),
        });
      }
    }
    if (rows.length && def.rowEntity) {
      const rowEntity = def.rowEntity;
      const columns = Object.keys(rows[0] ?? {}).slice(0, 4);
      // Deterministic totals come from the tool's own arithmetic, never from the
      // model, so the comparison footer is reproducible from the same query.
      const toolTotals = (result as { totals?: Record<string, unknown> } | undefined)?.totals;
      const totals = toolTotals
        ? [
          `Total (${toolTotals.count ?? rows.length} records)`,
          ...columns.slice(1).map((column) => (toolTotals[column] === undefined ? "" : displayCell(column, toolTotals[column]))),
        ]
        : undefined;
      store.saveArtifact({
        id: `artifact-${task.taskId}-${def.tool}`,
        threadId: "pending",
        runId,
        ownerId: "pending",
        kind: "table",
        payload: {
          title: def.description,
          columns,
          rows: rows.map((row, index) => ({
            id: String(row.id ?? row.customerId ?? index),
            cells: columns.map((column) => displayCell(column, row[column])),
            // Numeric hints so the renderer sorts currency and counts by
            // magnitude rather than lexically.
            sortValues: columns.map((column) => {
              const value = row[column];
              const numeric = typeof value === "number" ? value : Number(value);
              return Number.isFinite(numeric) ? numeric : Number.NaN;
            }),
            entityType: rowEntity,
            entityId: entityIdFor(rowEntity, row, index),
          })),
          totals,
          completeness: rows.length >= 25 ? "partial" : "complete",
          rowAction: def.rowAction ? { name: def.rowAction.name, label: "Assign" } : undefined,
        },
        now: now(),
      });
    }
    const count = rows.length || Number((result as { totals?: { count?: number } } | undefined)?.totals?.count ?? 0);
    // A single-record tool (get_customer) has no row list, so fall back to the
    // task's entity scope. That keeps the finding grounded in the record that
    // was actually retrieved rather than dropping the entity entirely.
    const rowEntities = rows.slice(0, 14).map((row, index) => ({ type: (def.rowEntity ?? "service") as AgentFinding["entities"][number]["type"], id: entityIdFor(def.rowEntity ?? "service", row, index) }));
    const entities = rowEntities.length ? rowEntities : task.entityScope;
    findings.push(finding({
      findingId: `finding-${task.taskId}-${def.tool}`,
      taskId: task.taskId,
      agentId: task.domain,
      kind: "observation",
      title: def.description,
      summary: count ? `${def.description}: ${count} records.` : `${def.description} returned no rows.`,
      severity: count ? "medium" : "info",
      entities,
      claims: [{
        claimId: randomUUID(),
        statement: def.description,
        evidenceIds: [idOf(evidence)],
        resultPaths: [],
        metrics: [{ name: "record_count", value: count, unit: "count", aggregation: "count" }],
        entities: [],
        limitations: [],
        contradictoryEvidenceIds: [],
      }],
      limitations: [],
    }));
  }
  return findings;
}

async function reliability(client: CompanyMcpClient, task: InvestigationTask, releaseId?: string): Promise<AgentFinding[]> {
  const [health, errors, impacted, releases] = await Promise.all([
    client.call("get_service_health", { service: "sync-service", window: CURRENT }, "reliability"),
    client.call("get_error_metrics", { service: "sync-service", window: CURRENT }, "reliability"),
    client.call("list_impacted_customers", { service: "sync-service", window: CURRENT, minErrorRate: 0.05 }, "reliability"),
    client.call("get_recent_releases", { window: RELEASE_WINDOW }, "reliability"),
  ]);
  const healthRow = rowsOf(health)[0] ?? {};
  const errorRows = rowsOf(errors);
  const errorRow = [...errorRows].sort((a, b) => Number(b.errorRate ?? 0) - Number(a.errorRate ?? 0))[0] ?? {};
  const customerIds = ((impacted.result as { customerIds?: string[] } | undefined)?.customerIds ?? []).map(String);
  const releaseRows = rowsOf(releases);
  const targetRelease = releaseId ?? String((releaseRows[0] as { id?: string } | undefined)?.id ?? "");
  const details = targetRelease
    ? await client.call("get_release_details", { releaseId: targetRelease }, "reliability")
    : undefined;
  const errorRate = Number(errorRow.errorRate ?? healthRow.errorRate ?? 0);
  const cohort = String(errorRow.cohort ?? "unknown");
  const releaseRecord = details ? (details.result as { release?: { service?: string; component?: string } }).release : undefined;
  return [
    finding({
      findingId: `finding-${task.taskId}-errors`,
      taskId: task.taskId,
      agentId: "reliability",
      kind: "observation",
      title: errorRate >= 0.05 ? `${cohort} error rate is elevated in the current window` : "Service error rate is within the baseline range",
      summary: `Highest cohort error rate is ${(errorRate * 100).toFixed(1)}% (${cohort}) with ${customerIds.length} accounts above the investigation threshold.`,
      severity: errorRate >= 0.05 ? "high" : "info",
      entities: customerIds.slice(0, 14).map((id) => ({ type: "customer" as const, id })),
      claims: [{
        claimId: randomUUID(),
        statement: "Highest weighted error rate among observed cohorts in the current window.",
        evidenceIds: [idOf(errors)],
        resultPaths: errorRow.errorRate === undefined ? [] : ["rows.0.errorRate"],
        metrics: [{ name: "error_rate", value: errorRate, unit: "ratio", aggregation: "rate" }],
        entities: [],
        limitations: ["This is a weighted rate, not an average of percentages."],
        contradictoryEvidenceIds: [],
      }, {
        claimId: randomUUID(),
        statement: "Accounts whose weighted error rate exceeded the investigation threshold.",
        evidenceIds: [idOf(impacted)],
        resultPaths: [],
        metrics: [{ name: "impacted_accounts", value: customerIds.length, unit: "count", aggregation: "distinct_count" }],
        entities: customerIds.map((id) => ({ type: "customer" as const, id })),
        limitations: ["Thresholded from telemetry, not from ticket complainants."],
        contradictoryEvidenceIds: [],
      }],
      limitations: [],
    }),
    finding({
      findingId: `finding-${task.taskId}-release`,
      taskId: task.taskId,
      agentId: "reliability",
      kind: errorRate >= 0.05 ? "hypothesis" : "observation",
      title: targetRelease
        ? (errorRate >= 0.05 ? `${targetRelease} is temporally relevant` : `${targetRelease} is present without a verified error spike`)
        : "No recent release was found in the investigation window",
      summary: errorRate >= 0.05
        ? `A recent ${releaseRecord?.component ?? "component"} release (${releaseRecord?.service ?? "unknown service"}) is in the same window as the error increase. Timing is not proof of causation.`
        : "A recent release may exist in the window, but current telemetry does not show a concentrated error spike.",
      severity: errorRate >= 0.05 ? "medium" : "info",
      entities: targetRelease ? [{ type: "release", id: targetRelease, label: targetRelease }] : [],
      claims: [{
        claimId: randomUUID(),
        statement: "A recent release is in the investigation window.",
        evidenceIds: details ? [idOf(details), idOf(releases)] : [idOf(releases)],
        resultPaths: [],
        metrics: [],
        entities: targetRelease ? [{ type: "release", id: targetRelease }] : [],
        limitations: ["Temporal correlation is not root cause."],
        contradictoryEvidenceIds: [],
      }],
      limitations: ["Root cause remains a hypothesis until additional confirmatory evidence is collected."],
    }),
  ];
}

async function product(client: CompanyMcpClient, task: InvestigationTask, knownCustomers: string[], customerId?: string): Promise<AgentFinding[]> {
  if (customerId) {
    const usage = await client.call("get_customer_feature_usage", { customerId, feature: "synchronization", window: CURRENT }, "product");
    const total = rowsOf(usage).reduce((sum, row) => sum + Number(row.usageCount ?? 0), 0);
    return [finding({
      findingId: `finding-${task.taskId}-account-usage`,
      taskId: task.taskId,
      agentId: "product",
      kind: "observation",
      title: `Synchronization usage for ${customerId}`,
      summary: `Recorded ${total} synchronization events in the current window.`,
      severity: "medium",
      entities: [{ type: "customer", id: customerId }],
      claims: [{
        claimId: randomUUID(),
        statement: "Account-level synchronization usage in the current window.",
        evidenceIds: [idOf(usage)],
        resultPaths: [],
        metrics: [{ name: "usage_count", value: total, unit: "count", aggregation: "sum" }],
        entities: [{ type: "customer", id: customerId }],
        limitations: [],
        contradictoryEvidenceIds: [],
      }],
      limitations: [],
    })];
  }
  const usage = await client.call("compare_usage_periods", {
    feature: "synchronization",
    current: CURRENT,
    baseline: BASELINE,
    customerIds: knownCustomers.length ? knownCustomers : undefined,
  }, "product");
  const result = usage.result as { current?: { usageCount?: number }; baseline?: { usageCount?: number } };
  const currentUsage = Number(result.current?.usageCount ?? 0);
  const baselineUsage = Number(result.baseline?.usageCount ?? 0);
  const change = baselineUsage === 0 ? 0 : ((currentUsage - baselineUsage) / baselineUsage) * 100;
  return [finding({
    findingId: `finding-${task.taskId}-usage`,
    taskId: task.taskId,
    agentId: "product",
    kind: "observation",
    title: Math.abs(change) >= 10 ? "Synchronization usage changed versus the equal prior period" : "Synchronization usage is stable versus the equal prior period",
    summary: `Usage changed ${change.toFixed(0)}% versus an equal-length baseline.`,
    severity: change <= -10 ? "high" : "info",
    entities: knownCustomers.map((id) => ({ type: "customer" as const, id })),
    claims: [{
      claimId: randomUUID(),
      statement: "Current and baseline synchronization usage counts.",
      evidenceIds: [idOf(usage)],
      resultPaths: ["current.usageCount"],
      metrics: [{ name: "current_usage", value: currentUsage, unit: "count", aggregation: "sum" }],
      entities: [],
      limitations: ["Comparison uses equal duration windows and the supplied cohort."],
      contradictoryEvidenceIds: [],
    }, {
      claimId: randomUUID(),
      statement: "Usage change is a deterministic derivation from the two equal-length counts.",
      evidenceIds: [idOf(usage)],
      resultPaths: [],
      metrics: [{ name: "usage_change_pct", value: change, unit: "percent", aggregation: "average" }],
      entities: [],
      limitations: ["Derived as (current-baseline)/baseline."],
      contradictoryEvidenceIds: [],
    }],
    limitations: [],
  })];
}

async function customer(client: CompanyMcpClient, task: InvestigationTask, customerId?: string): Promise<AgentFinding[]> {
  if (customerId) {
    const [detail, tickets] = await Promise.all([
      client.call("get_customer", { customerId }, "customer"),
      client.call("get_customer_support_history", { customerId, window: CURRENT }, "customer"),
    ]);
    const ticketCount = rowsOf(tickets).length;
    const record = detail.result as { customer?: { name?: string; segment?: string } };
    return [finding({
      findingId: `finding-${task.taskId}-account`,
      taskId: task.taskId,
      agentId: "customer",
      kind: "observation",
      title: `${record.customer?.name ?? customerId} account context`,
      summary: `${ticketCount} current-window tickets. Segment: ${record.customer?.segment ?? "unknown"}.`,
      severity: ticketCount > 0 ? "medium" : "info",
      entities: [{ type: "customer", id: customerId, label: record.customer?.name }],
      claims: [{
        claimId: randomUUID(),
        statement: "Account identity and current-window support history.",
        evidenceIds: [idOf(detail), idOf(tickets)],
        resultPaths: [],
        metrics: [{ name: "ticket_count", value: ticketCount, unit: "count", aggregation: "count" }],
        entities: [{ type: "customer", id: customerId }],
        limitations: ["Ticket text is untrusted customer-provided data."],
        contradictoryEvidenceIds: [],
      }],
      limitations: ["Ticket complainants are not automatically the full affected population."],
    })];
  }
  const tickets = await client.call("search_support_tickets", { category: "sync_failure", window: CURRENT, page: { limit: 100, offset: 0 } }, "customer");
  const ticketRows = rowsOf(tickets);
  return [finding({
    findingId: `finding-${task.taskId}-tickets`,
    taskId: task.taskId,
    agentId: "customer",
    kind: "observation",
    title: ticketRows.length > 5 ? "Sync-related support volume in the current window" : "No material sync-related support volume in the current window",
    summary: `${ticketRows.length} sync_failure tickets were retrieved for the current window.`,
    severity: ticketRows.length > 5 ? "high" : "info",
    entities: [],
    claims: [{
      claimId: randomUUID(),
      statement: "Count of sync_failure tickets in the current window.",
      evidenceIds: [idOf(tickets)],
      resultPaths: [],
      metrics: [{ name: "ticket_count", value: ticketRows.length, unit: "count", aggregation: "count" }],
      entities: [],
      limitations: ["Support volume is corroboration, not the affected-account definition."],
      contradictoryEvidenceIds: [],
    }],
    limitations: [],
  })];
}

async function finance(client: CompanyMcpClient, task: InvestigationTask, knownCustomers: string[], customerId?: string): Promise<AgentFinding[]> {
  const ids = customerId ? [customerId] : knownCustomers;
  if (!ids.length) {
    return [];
  }
  const exposure = await client.call("calculate_account_exposure", {
    customerIds: ids,
    definition: "Accounts in the technically impacted set for the current investigation window.",
  }, "finance");
  const result = exposure.result as { affectedAccounts?: number; arrMinorUnits?: number };
  const arr = Number(result.arrMinorUnits ?? 0);
  return [finding({
    findingId: `finding-${task.taskId}-arr`,
    taskId: task.taskId,
    agentId: "finance",
    kind: "observation",
    title: "Represented ARR of the affected-account set",
    summary: `${result.affectedAccounts ?? ids.length} accounts represent $${(arr / 100).toLocaleString("en-US")} ARR. This is exposure, not proven revenue loss.`,
    severity: "high",
    entities: ids.map((id) => ({ type: "customer" as const, id })),
    claims: [{
      claimId: randomUUID(),
      statement: "Sum of ARR once per affected account.",
      evidenceIds: [idOf(exposure)],
      resultPaths: ["arrMinorUnits"],
      metrics: [{ name: "arr_minor_units", value: arr, unit: "minor_units", aggregation: "sum" }],
      entities: ids.map((id) => ({ type: "customer" as const, id })),
      limitations: ["ARR represented is not revenue loss or renewal risk."],
      contradictoryEvidenceIds: [],
    }],
    limitations: ["Do not infer churn or loss from represented ARR."],
  })];
}

export function specialistLabel(domain: Domain): string {
  return `${domain[0]?.toUpperCase()}${domain.slice(1)} Agent`;
}
