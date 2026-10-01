import type { InvestigationTask } from "@anc/contracts";
import type { RuntimeStore } from "@anc/runtime-storage";
import { CAPABILITIES } from "../registry.js";

type Row = Record<string, unknown>;

const rowsOf = (value: Record<string, unknown>) =>
  ((value.result as { rows?: Row[] } | undefined)?.rows ?? []);

/**
 * Formats a cell for display only. Raw values stay on the evidence envelope;
 * sorting uses the unformatted numeric `sortValues`.
 */
export function displayCell(column: string, value: unknown): string {
  if (value === undefined || value === null) return "";
  if (/minor/i.test(column) && typeof value === "number") {
    return `$${(value / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  }
  if (typeof value === "number" && /rate|ratio/i.test(column) && value > 0 && value <= 1) {
    return `${(value * 100).toFixed(2)}%`;
  }
  if (typeof value === "string" && /^\d{4}-\d{2}-\d{2}T/.test(value)) {
    return value.slice(0, 16).replace("T", " ");
  }
  return String(value);
}

/**
 * Resolves the entity a row refers to. The row's own `id` is only correct when
 * it already is the entity id: an invoice row carries `id = inv-...` while its
 * entity type is `customer`, so the type must drive the lookup.
 */
export function entityIdFor(entityType: string, row: Record<string, unknown>, index: number): string {
  if (entityType === "customer") return String(row.customerId ?? row.id ?? index);
  if (entityType === "ticket") return String(row.id ?? row.ticketId ?? index);
  if (entityType === "incident") return String(row.id ?? row.incidentId ?? index);
  if (entityType === "release") return String(row.id ?? row.releaseId ?? index);
  return String(row.id ?? row[`${entityType}Id`] ?? index);
}

export type MaterializeToolArtifactsInput = {
  store: RuntimeStore;
  runId: string;
  task: InvestigationTask;
  tool: string;
  evidence: Record<string, unknown>;
  /** Optional; fixture uses "pending" and compose claimArtifacts rewrites. */
  threadId?: string;
  ownerId?: string;
  now?: string;
};

/**
 * After a successful MCP tool result, materialize series/table artifacts the
 * compose path reads. Never invents findings — only persists tool-backed shapes.
 */
export function materializeToolArtifacts(input: MaterializeToolArtifactsInput): void {
  const def = CAPABILITIES.find((item) => item.tool === input.tool);
  if (!def || def.sideEffect === "write") return;

  const threadId = input.threadId ?? "pending";
  const ownerId = input.ownerId ?? "pending";
  const now = input.now ?? new Date().toISOString();
  const result = input.evidence.result as Record<string, unknown> | undefined;
  const rows = rowsOf(input.evidence);

  if (def.series) {
    const points = (result?.points as Array<Record<string, unknown>> | undefined) ?? [];
    const usable = points
      .map((point) => ({
        label: String(point.bucket ?? ""),
        value: Number(point[def.series!] ?? 0),
      }))
      .filter((point) => point.label && Number.isFinite(point.value));
    if (usable.length >= 2) {
      input.store.saveArtifact({
        id: `artifact-${input.task.taskId}-${def.tool}`,
        threadId,
        runId: input.runId,
        ownerId,
        kind: "series",
        payload: {
          title: def.description,
          unit: def.series === "errorRate" ? "ratio" : "count",
          metric: def.series,
          points: usable,
        },
        now,
      });
    }
  }

  if (rows.length && def.rowEntity) {
    const rowEntity = def.rowEntity;
    const columns = Object.keys(rows[0] ?? {}).slice(0, 4);
    const toolTotals = (result as { totals?: Record<string, unknown> } | undefined)?.totals;
    const totals = toolTotals
      ? [
          `Total (${toolTotals.count ?? rows.length} records)`,
          ...columns.slice(1).map((column) =>
            toolTotals[column] === undefined ? "" : displayCell(column, toolTotals[column]),
          ),
        ]
      : undefined;
    input.store.saveArtifact({
      id: `artifact-${input.task.taskId}-${def.tool}`,
      threadId,
      runId: input.runId,
      ownerId,
      kind: "table",
      payload: {
        title: def.description,
        columns,
        rows: rows.map((row, index) => ({
          id: String(row.id ?? row.customerId ?? index),
          cells: columns.map((column) => displayCell(column, row[column])),
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
      now,
    });
  }
}
