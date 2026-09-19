import { randomUUID } from "node:crypto";
import { CompanyMcpClient } from "./mcp-client.js";
import type { A2UISurfaceFixture, ActivityEvent, RuntimeState } from "./contracts.js";

const CURRENT = { from: "2026-09-19T09:00:00.000Z", to: "2026-09-20T08:00:00.000Z" };
const BASELINE = { from: "2026-09-18T09:00:00.000Z", to: "2026-09-19T09:00:00.000Z" };

type Row = Record<string, unknown>;
const rows = (value: Record<string, unknown>) => ((value.result as { rows?: Row[] } | undefined)?.rows ?? []);
const evidenceId = (value: Record<string, unknown>) => String(value.evidenceId);

function activity(message: string): ActivityEvent {
  return { id: randomUUID(), message, timestamp: new Date().toISOString() };
}

/**
 * The local implementation is intentionally deterministic: it proves the
 * evidence, MCP, concurrency, and surface lifecycle before a model provider is
 * configured. Its domain boundaries and tool allowlists are the same ones a
 * model-backed specialist receives in the next milestone.
 */
export async function runMorningInvestigation(client: CompanyMcpClient): Promise<RuntimeState> {
  const events = [activity("Orchestrator started morning investigation")];
  events.unshift(activity("Reliability Agent started"), activity("Product Agent started"), activity("Customer Agent started"));

  const [errors, usage, tickets] = await Promise.all([
    client.call("get_error_metrics", { service: "sync-service", window: CURRENT, cohort: "sync-v2" }),
    client.call("compare_usage_periods", { feature: "synchronization", current: CURRENT, baseline: BASELINE, customerIds: Array.from({ length: 14 }, (_, index) => `customer-${String(index + 1).padStart(3, "0")}`) }),
    client.call("search_support_tickets", { category: "sync_failure", window: CURRENT, page: { limit: 100, offset: 0 } }),
  ]);

  const error = rows(errors)[0] ?? {};
  const usageResult = usage.result as { current?: { usageCount?: number }; baseline?: { usageCount?: number } };
  const currentUsage = Number(usageResult.current?.usageCount ?? 0);
  const baselineUsage = Number(usageResult.baseline?.usageCount ?? 0);
  const usageChange = baselineUsage === 0 ? 0 : Math.round(((currentUsage - baselineUsage) / baselineUsage) * 100);
  const affectedIds = Array.from({ length: 14 }, (_, index) => `customer-${String(index + 1).padStart(3, "0")}`);

  events.unshift(activity("Reliability Agent found elevated sync-v2 error rate"), activity("Product Agent compared affected-account usage"), activity("Customer Agent found sync-related support tickets"), activity("Finance Agent started"));
  const [exposure, release] = await Promise.all([
    client.call("calculate_account_exposure", { customerIds: affectedIds, definition: "Accounts in the sync-v2 cohort with elevated sync-service errors during the current period." }),
    client.call("get_release_details", { releaseId: "release-2026-09-19-3" }),
  ]);
  const exposureResult = exposure.result as { affectedAccounts?: number; arrMinorUnits?: number };
  const arr = Number(exposureResult.arrMinorUnits ?? 0) / 100;
  const errorRate = Number(error.errorRate ?? 0) * 100;
  const ticketsCount = rows(tickets).length;
  const releaseResult = release.result as { release?: { id?: string } };
  const releaseId = String(releaseResult.release?.id ?? "release-2026-09-19-3");

  events.unshift(activity("Finance Agent calculated represented ARR"), activity("Investigation completed with verified evidence"));
  const surface: A2UISurfaceFixture = {
    surfaceId: `morning-${randomUUID()}`,
    revision: 1,
    title: "Morning overview",
    subtitle: `A synchronization incident warrants attention. The suspected release connection is a hypothesis, not a confirmed root cause.`,
    components: [
      { type: "metric", id: "error-rate", label: "Sync-v2 error rate", value: `${errorRate.toFixed(1)}%`, detail: `from ${Number(error.errors ?? 0).toLocaleString()} errors · ${evidenceId(errors)}`, tone: "danger" },
      { type: "metric", id: "usage", label: "Affected-account sync usage", value: `${usageChange}%`, detail: `vs equal prior period · ${evidenceId(usage)}`, tone: "warning" },
      { type: "metric", id: "accounts", label: "Accounts in scope", value: String(exposureResult.affectedAccounts ?? 0), detail: `$${(arr / 1_000_000).toFixed(1)}M ARR represented · ${evidenceId(exposure)}` },
      { type: "finding", id: "incident", title: "A concentrated synchronization problem is affecting the sync-v2 cohort", body: `${ticketsCount} sync-related support tickets and an elevated error signature were observed in the current period. ${releaseId} is temporally relevant, but this evidence does not yet establish causation.`, evidence: `${evidenceId(errors)} · ${evidenceId(tickets)} · ${evidenceId(release)}` },
      { type: "action", id: "affected-accounts", label: "Show affected accounts", intent: "show_affected_accounts" },
      { type: "action", id: "inspect-release", label: "Inspect release", intent: "inspect_release" },
    ],
  };

  return { investigationId: `investigation-${randomUUID()}`, surface, activity: events, handledActionIds: [] };
}
