import type { InvestigationTask } from "@anc/contracts";
import type { RuntimeStore } from "@anc/runtime-storage";
import type { CapabilityDefinition } from "./registry.js";

type Row = Record<string, unknown>;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "2026-09-21T06:45:21.127+05:30" → "21 Sep, 06:45". Timestamps are already local wall-clock text. */
export function displayTime(value: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}:\d{2}))?/.exec(value);
  if (!match) return value;
  const day = `${Number(match[3])} ${MONTHS[Number(match[2]) - 1]}`;
  return match[4] ? `${day}, ${match[4]}` : day;
}

/** Formats a cell for reading. The raw value stays in the evidence record. */
export function displayCell(field: string, value: unknown): string {
  // Durations in hours ("hoursToClearAtCurrentRate") are hours, not a rate: checked
  // before the rate rule, which their name would otherwise match. An empty hub (0)
  // or one that is not sorting at all (null) has nothing to clear at a rate: a dash.
  if (/^hours/i.test(field)) return typeof value === "number" && value > 0 ? `${value.toLocaleString("en-IN", { minimumFractionDigits: 1, maximumFractionDigits: 1 })} h` : "—";
  if (value === undefined || value === null) return "";
  if (typeof value === "number" && /rate|occupancy|target/i.test(field) && value >= 0 && value <= 1) return `${(value * 100).toFixed(1)}%`;
  if (typeof value === "number") return value.toLocaleString("en-IN");
  if (typeof value === "string" && /^\d{4}-\d{2}-\d{2}/.test(value)) return displayTime(value);
  if (typeof value === "string") return value.replaceAll("_", " ");
  return String(value);
}

/**
 * Saves the table and chart a tool result supports. Rows and points are copied
 * from the tool's own output, so what is drawn is the same whether a fixture or
 * a model chose to make the call, and no figure in it comes from a model.
 */
export function saveCapabilityArtifacts(store: RuntimeStore, task: InvestigationTask, runId: string, def: CapabilityDefinition, evidence: Record<string, unknown>) {
  const result = (evidence.result ?? {}) as Record<string, unknown>;
  const now = new Date().toISOString();
  if (def.series) {
    const series = def.series;
    const points = (Array.isArray(result[series.pointsField]) ? result[series.pointsField] as Row[] : [])
      .map((point) => ({ label: displayCell(series.labelField, point[series.labelField]), value: Number(point[series.valueField]) }))
      .filter((point) => point.label && Number.isFinite(point.value));
    if (points.length >= 2) {
      store.saveArtifact({ id: `artifact-${task.taskId}-${def.tool}`, threadId: "pending", runId, ownerId: "pending", kind: "series", payload: { title: def.description, unit: series.unit, points, evidenceId: evidence.evidenceId }, now });
    }
  }
  const rows = Array.isArray(result.rows) ? result.rows as Row[] : [];
  if (!rows.length || !def.rowEntity || !def.columns) return;
  const entity = def.rowEntity;
  const columns = def.columns;
  store.saveArtifact({
    id: `artifact-${task.taskId}-${def.tool}`,
    threadId: "pending",
    runId,
    ownerId: "pending",
    kind: "table",
    payload: {
      title: def.description,
      columns: columns.map(([, heading]) => heading),
      rows: rows.map((row, index) => ({
        id: String(row[entity.idField] ?? index),
        cells: columns.map(([field]) => displayCell(field, row[field])),
        // Numeric hints so the table sorts by magnitude rather than as text.
        sortValues: columns.map(([field]) => (typeof row[field] === "number" ? row[field] as number : Number.NaN)),
        entityType: entity.type,
        entityId: String(row[entity.idField] ?? index),
      })),
      completeness: (evidence.completeness as { complete?: boolean } | undefined)?.complete === false ? "partial" : "complete",
      rowAction: def.rowAction ? { name: def.rowAction.name, label: "Assign" } : undefined,
      evidenceId: evidence.evidenceId,
    },
    now,
  });
}
