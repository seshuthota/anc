import { bindRegistryMetric, getMetricDefinition, readResultPath, resolveMetricSource } from "@anc/contracts";
import { hasGrant, redactForPrincipal, TOOL_CAPABILITIES, type Principal } from "@anc/policy";
import type { RuntimeStore } from "@anc/runtime-storage";
import { windowLabel } from "./briefing.js";

/**
 * Evidence explanations for the host drawer (Slice 3). Deterministic and
 * model-free: everything here is read from the stored tool envelope and the
 * metric registry, after the person's grants and field redaction are applied.
 * Nothing here is ever passed to the UI Composer.
 */

export type EvidenceAccess =
  | { status: 200; tool: string; payload: Record<string, unknown> }
  | { status: 403 | 404; error: string };

/** Capability first (403), then ownership (404); the payload comes back redacted for the person. */
export function openEvidence(store: Pick<RuntimeStore, "getEvidenceTool" | "getEvidenceRecord">, principal: Principal, evidenceId: string): EvidenceAccess {
  const tool = store.getEvidenceTool(evidenceId);
  if (!tool) return { status: 404, error: "evidence not found" };
  const capability = TOOL_CAPABILITIES[tool];
  if (!capability || !hasGrant(principal, capability)) return { status: 403, error: "Not authorized for this evidence" };
  const record = store.getEvidenceRecord(evidenceId, principal.id);
  if (!record) return { status: 404, error: "evidence not found" };
  return { status: 200, tool: record.tool, payload: redactForPrincipal(principal, record.payload) };
}

export type EvidenceExplanation = {
  evidenceId: string;
  tool: string;
  path: string | null;
  metricId: string | null;
  definition: { label: string; text: string; unit: string; scope: { type: string; id?: string } | null } | null;
  window: { id: string; label: string } | null;
  denominator: { metricId: string; label: string; value: number; share: number | null } | null;
  value: unknown;
  filters: Record<string, unknown>;
  dataAsOf: string | null;
  excerpt: {
    columns: string[];
    rows: unknown[][];
    /** Cell to highlight: excerpt row index and column name. */
    highlight: { row: number; column: string } | null;
    /** Where the excerpt was taken from in the result, and how many rows that holds. */
    from: string;
    total: number;
  };
  raw: Record<string, unknown>;
};

export class ExplainError extends Error {}

const EXCERPT_ROWS = 10;

function cell(value: unknown): unknown {
  return value === null || ["string", "number", "boolean"].includes(typeof value) ? value : JSON.stringify(value);
}

function excerptFor(result: unknown, path: string | null): EvidenceExplanation["excerpt"] {
  const parts = path ? path.replace(/\[(\d+)\]/g, ".$1").split(".").filter(Boolean) : [];
  // A row figure (`rows.3.atRiskToday`): show the rows around it and highlight that cell.
  const rowMatch = parts.length >= 3 && /^\d+$/.test(parts[parts.length - 2]!) ? parts : undefined;
  if (rowMatch) {
    const field = rowMatch[rowMatch.length - 1]!;
    const index = Number(rowMatch[rowMatch.length - 2]);
    const listPath = rowMatch.slice(0, -2).join(".");
    const list = readResultPath(result, listPath);
    if (Array.isArray(list) && list[index] && typeof list[index] === "object") {
      const start = index < EXCERPT_ROWS ? 0 : index - EXCERPT_ROWS + 1;
      const slice = list.slice(start, start + EXCERPT_ROWS) as Array<Record<string, unknown>>;
      const columns = Object.keys(list[index] as Record<string, unknown>);
      return { columns, rows: slice.map((row) => columns.map((column) => cell(row?.[column]))), highlight: { row: index - start, column: field }, from: listPath, total: list.length };
    }
  }
  // A total (`totals.atRisk`): show the fields beside it and highlight that one.
  if (parts.length >= 2) {
    const parentPath = parts.slice(0, -1).join(".");
    const parent = readResultPath(result, parentPath);
    const key = parts[parts.length - 1]!;
    if (parent && typeof parent === "object" && !Array.isArray(parent) && key in (parent as object)) {
      const entries = Object.entries(parent as Record<string, unknown>).filter(([, value]) => value === null || typeof value !== "object");
      const keyIndex = entries.findIndex(([name]) => name === key);
      const kept = keyIndex >= EXCERPT_ROWS ? [...entries.slice(0, EXCERPT_ROWS - 1), entries[keyIndex]!] : entries.slice(0, EXCERPT_ROWS);
      return {
        columns: ["field", "value"],
        rows: kept.map(([name, value]) => [name, cell(value)]),
        highlight: { row: kept.findIndex(([name]) => name === key), column: "value" },
        from: parentPath,
        total: entries.length,
      };
    }
  }
  const rows = readResultPath(result, "rows");
  if (Array.isArray(rows) && rows.length && typeof rows[0] === "object") {
    const columns = Object.keys(rows[0] as Record<string, unknown>);
    return { columns, rows: (rows.slice(0, EXCERPT_ROWS) as Array<Record<string, unknown>>).map((row) => columns.map((column) => cell(row?.[column]))), highlight: null, from: "rows", total: rows.length };
  }
  return { columns: [], rows: [], highlight: null, from: "", total: 0 };
}

/**
 * Explains one evidence record, optionally focused on the figure at `path`
 * (and checked against `metricId`). A path that is not in this record leaves
 * the figure fields empty rather than failing, so one request shape serves every
 * tab of a multi-evidence drawer. A path that names a different metric than
 * `metricId` is a caller error.
 */
export function explainEvidence(evidenceId: string, payload: Record<string, unknown>, focus: { metricId?: string | null; path?: string | null } = {}): EvidenceExplanation {
  const tool = String(payload.tool ?? "");
  const result = payload.result;
  const dataAsOf = typeof payload.dataAsOf === "string" ? payload.dataAsOf : null;
  const filters = (payload.appliedFilters ?? payload.filters ?? payload.arguments ?? {}) as Record<string, unknown>;
  const requested = focus.metricId ? getMetricDefinition(focus.metricId) : undefined;
  if (focus.metricId && !requested) throw new ExplainError(`unknown metric ${focus.metricId}`);

  let path = focus.path ?? null;
  // A metric without a path: use its only non-row source on this tool, if there is one.
  if (!path && requested) {
    const sources = requested.sources.filter((source) => source.tool === tool && !source.path.startsWith("rows."));
    if (sources.length === 1) path = sources[0]!.path;
  }
  const resolved = path ? resolveMetricSource(tool, path) : undefined;
  if (requested && resolved && resolved.definition.id !== requested.id) {
    throw new ExplainError(`${path} on ${tool} is ${resolved.definition.id}, not ${requested.id}`);
  }
  const value = path ? readResultPath(result, path) : undefined;
  const inRecord = value !== undefined;
  const binding = path && inRecord ? bindRegistryMetric({ tool, arguments: payload.arguments, dataAsOf: dataAsOf ?? undefined, result }, path) : undefined;
  const definition = resolved?.definition ?? (inRecord ? requested : undefined);
  const denominatorDef = binding?.denominator ? getMetricDefinition(binding.denominator.metricId) : undefined;

  return {
    evidenceId,
    tool,
    path: inRecord ? path : null,
    metricId: definition?.id ?? null,
    definition: definition ? { label: definition.label, text: definition.definition, unit: definition.unit, scope: binding?.scope ?? null } : null,
    window: definition ? { id: definition.window, label: windowLabel(definition.window, dataAsOf ?? undefined) } : null,
    denominator: binding?.denominator && denominatorDef
      ? { metricId: denominatorDef.id, label: denominatorDef.label, value: binding.denominator.value, share: binding.denominator.value > 0 ? Math.round((binding.value / binding.denominator.value) * 1000) / 1000 : null }
      : null,
    value: inRecord ? value : null,
    filters,
    dataAsOf,
    excerpt: excerptFor(result, inRecord ? path : null),
    raw: payload,
  };
}
