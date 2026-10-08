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
  const tool = store.getEvidenceTool(evidenceId, principal.id);
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
    /** Rows the briefing's figure is made of (e.g. the held runs) come first: how many, and what they are. */
    cited?: { count: number; label: string; noun: string };
  };
  /** Names for the ids this explanation shows (scope, filters, cells), so people see "Hyderabad Hub", not "hub-hyd". */
  labels: Record<string, string>;
  raw: Record<string, unknown>;
};

export class ExplainError extends Error {}

const EXCERPT_ROWS = 10;

function cell(value: unknown): unknown {
  return value === null || ["string", "number", "boolean"].includes(typeof value) ? value : JSON.stringify(value);
}

type Row = Record<string, unknown>;

/**
 * The rows a total is made of, per tool. When a record of this tool is shown as
 * rows, these come first, so the drawer shows what the briefing cites (the 3
 * held runs) rather than the first rows in table order. The first entry is the
 * default when no figure on this record was clicked.
 */
const CITED_ROWS: Record<string, Array<{ path: string | null; label: string; noun: string; test: (row: Row) => boolean }>> = {
  list_route_runs: [
    { path: "totals.held", label: "held", noun: "run", test: (row) => row.status === "held" },
    { path: "totals.parcelsLeftBehind", label: "short-loaded", noun: "run", test: (row) => row.status === "departed" && Number(row.parcelsLeftBehind) > 0 },
  ],
  list_equipment_events: [{ path: null, label: "still open", noun: "fault", test: (row) => row.endedAt === null || row.endedAt === undefined }],
};

function citedRows(tool: string, list: Row[], path: string | null): EvidenceExplanation["excerpt"] {
  const rules = CITED_ROWS[tool] ?? [];
  const rule = rules.find((item) => item.path !== null && item.path === path) ?? rules[0];
  const columns = Object.keys(list[0] ?? {});
  const cited = rule ? list.filter((row) => rule.test(row)) : [];
  const others = rule ? list.filter((row) => !rule.test(row)) : list;
  // Every cited row is shown (up to 25), then others up to the usual excerpt size.
  const shownCited = cited.slice(0, 25);
  const ordered = [...shownCited, ...others.slice(0, Math.max(0, EXCERPT_ROWS - shownCited.length))];
  return {
    columns,
    rows: ordered.map((row) => columns.map((column) => cell(row?.[column]))),
    highlight: null,
    from: "rows",
    total: list.length,
    ...(rule && cited.length ? { cited: { count: cited.length, label: rule.label, noun: rule.noun } } : {}),
  };
}

function excerptFor(result: unknown, path: string | null, tool = ""): EvidenceExplanation["excerpt"] {
  const parts = path ? path.replace(/\[(\d+)\]/g, ".$1").split(".").filter(Boolean) : [];
  // A total that is made of rows (route runs held): show those rows, cited first.
  const listForTotal = readResultPath(result, "rows");
  if (path && CITED_ROWS[tool]?.some((rule) => rule.path === path) && Array.isArray(listForTotal) && listForTotal.length) {
    return citedRows(tool, listForTotal as Row[], path);
  }
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
  if (Array.isArray(rows) && rows.length && typeof rows[0] === "object") return citedRows(tool, rows as Row[], null);
  return { columns: [], rows: [], highlight: null, from: "", total: 0 };
}

/**
 * Names for the ids a tool result carries: `{ id, name }` rows, `xId` beside
 * `xName`, and a row's single `xId` beside its `name` (a hub status row).
 */
export function harvestNames(value: unknown, into: Map<string, string> = new Map(), depth = 0): Map<string, string> {
  if (depth > 5 || value === null || typeof value !== "object") return into;
  if (Array.isArray(value)) {
    for (const item of value.slice(0, 500)) harvestNames(item, into, depth + 1);
    return into;
  }
  const row = value as Row;
  const text = (key: string) => (typeof row[key] === "string" && (row[key] as string).trim() ? (row[key] as string) : undefined);
  if (text("id") && text("name")) into.set(text("id")!, text("name")!);
  const idKeys = Object.keys(row).filter((key) => /.Id$/.test(key) && text(key));
  for (const key of idKeys) {
    const name = text(`${key.slice(0, -2)}Name`);
    if (name) into.set(text(key)!, name);
  }
  if (!text("id") && idKeys.length === 1 && text("name") && !into.has(text(idKeys[0]!)!)) into.set(text(idKeys[0]!)!, text("name")!);
  for (const child of Object.values(row)) if (child && typeof child === "object") harvestNames(child, into, depth + 1);
  return into;
}

function referencedIds(explanation: Omit<EvidenceExplanation, "labels">): Set<string> {
  const ids = new Set<string>();
  const add = (value: unknown) => { if (typeof value === "string" && value) ids.add(value); };
  add(explanation.definition?.scope?.id);
  for (const value of Object.values(explanation.filters ?? {})) Array.isArray(value) ? value.forEach(add) : add(value);
  for (const row of explanation.excerpt.rows) row.forEach(add);
  return ids;
}

/**
 * Explains one evidence record, optionally focused on the figure at `path`
 * (and checked against `metricId`). A path that is not in this record leaves
 * the figure fields empty rather than failing, so one request shape serves every
 * tab of a multi-evidence drawer. A path that names a different metric than
 * `metricId` is a caller error.
 */
export function explainEvidence(evidenceId: string, payload: Record<string, unknown>, focus: { metricId?: string | null; path?: string | null; names?: Map<string, string> } = {}): EvidenceExplanation {
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

  const explanation: Omit<EvidenceExplanation, "labels"> = {
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
    excerpt: excerptFor(result, inRecord ? path : null, tool),
    raw: payload,
  };
  // This record's own names first, then names from the person's other records (already grant-checked).
  const names = new Map([...(focus.names ?? new Map<string, string>()), ...harvestNames(result)]);
  const labels: Record<string, string> = {};
  for (const id of referencedIds(explanation)) {
    const name = names.get(id);
    if (name && name !== id) labels[id] = name;
  }
  return { ...explanation, labels };
}

/**
 * Names from the person's other evidence (same run first), each opened through the
 * same grant check and redaction as the drawer itself. Read-only; no company call.
 */
export function namesFromOwnEvidence(store: Pick<RuntimeStore, "listEvidenceNear">, principal: Principal, evidenceId: string): Map<string, string> {
  const names = new Map<string, string>();
  for (const record of store.listEvidenceNear(evidenceId, principal.id).reverse()) {
    const capability = TOOL_CAPABILITIES[record.tool];
    if (!capability || !hasGrant(principal, capability)) continue;
    harvestNames(redactForPrincipal(principal, record.payload).result, names);
  }
  return names;
}
