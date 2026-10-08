/**
 * Canonical metric definitions for briefing reconciliation and display.
 * Specialists map (tool, resultPath) onto these ids; free-text metric names
 * alone are not eligible as a headline figure.
 */

export type MetricScopeType = "network" | "hub" | "shipper" | "district" | "locker";
export type MetricWindowId = "today" | "last_hour" | "commitment_13d" | "now";

export type MetricSource = {
  tool: string;
  /** Dot path into the tool evidence `result` object. `rows.<field>` means "that field of one row". */
  path: string;
  /**
   * How to read scope from the same evidence. Omit for network-wide totals.
   * - "row:<field>" reads the scope id from the cited row (`rows.<n>.<field>`)
   * - "arg:<name>" reads the scope id from the tool argument
   * - "field:<path>" reads the scope id at that result path
   */
  scopeFrom?: string;
  /** Scope type this source yields. Defaults to the definition's scopeType. */
  scopeType?: MetricScopeType;
  /** For "arg:" scopes: the scope used when the argument was not given (for example a network-wide total). */
  unscopedType?: MetricScopeType;
  /**
   * Result field holding the service date the figure is for. The figure binds to a
   * "today" window only when that date is the evidence's own as-of day.
   */
  dayField?: string;
};

export type MetricDefinition = {
  id: string;
  label: string;
  definition: string;
  unit: string;
  scopeType: MetricScopeType;
  window: MetricWindowId;
  denominatorId?: string;
  sources: MetricSource[];
};

export const METRIC_DEFINITIONS: MetricDefinition[] = [
  {
    id: "parcels_at_risk_today",
    label: "Parcels at risk today",
    definition: "Promised for delivery today, not yet on a truck",
    unit: "parcels",
    scopeType: "network",
    window: "today",
    denominatorId: "parcels_promised_today",
    sources: [
      { tool: "summarize_at_risk_shipments", path: "totals.atRisk", scopeFrom: "arg:hubId", scopeType: "hub", unscopedType: "network" },
      { tool: "get_shipper_on_time", path: "rows.atRiskToday", scopeFrom: "row:shipperId", scopeType: "shipper" },
    ],
  },
  {
    id: "parcels_promised_today",
    label: "Parcels promised today",
    definition: "Parcels with a delivery promise for today",
    unit: "parcels",
    scopeType: "network",
    window: "today",
    sources: [{ tool: "summarize_at_risk_shipments", path: "totals.promisedToday", scopeFrom: "arg:hubId", scopeType: "hub", unscopedType: "network" }],
  },
  {
    id: "parcels_waiting_to_sort",
    label: "Parcels waiting to sort",
    definition: "Parcels at the hub still waiting on the sort floor",
    unit: "parcels",
    scopeType: "hub",
    window: "now",
    sources: [{ tool: "get_hub_status", path: "rows.parcelsWaitingToSort", scopeFrom: "row:hubId" }],
  },
  {
    id: "hub_sort_rate_last_hour",
    label: "Sort rate last hour",
    definition: "Parcels sorted at the hub in the last hour",
    unit: "parcels/hour",
    scopeType: "hub",
    window: "last_hour",
    sources: [{ tool: "get_hub_status", path: "rows.sortedLastHour", scopeFrom: "row:hubId" }],
  },
  {
    id: "hub_usual_sort_rate",
    label: "Usual sort rate",
    definition: "Usual overnight sort rate for the hub",
    unit: "parcels/hour",
    scopeType: "hub",
    window: "now",
    sources: [{ tool: "get_hub_status", path: "rows.usualSortRatePerHour", scopeFrom: "row:hubId" }],
  },
  {
    id: "route_runs_held_today",
    label: "Route runs held today",
    definition: "Delivery route runs that have not left",
    unit: "runs",
    scopeType: "network",
    window: "today",
    sources: [{ tool: "list_route_runs", path: "totals.held", scopeFrom: "arg:hubId", scopeType: "hub", unscopedType: "network", dayField: "serviceDate" }],
  },
  {
    id: "parcels_left_behind_today",
    label: "Parcels left behind today",
    definition: "Parcels planned on runs that departed short-loaded",
    unit: "parcels",
    scopeType: "network",
    window: "today",
    sources: [{ tool: "list_route_runs", path: "totals.parcelsLeftBehind", scopeFrom: "arg:hubId", scopeType: "hub", unscopedType: "network", dayField: "serviceDate" }],
  },
  {
    id: "shipper_projected_on_time_rate",
    label: "Projected on-time rate",
    definition: "On-time rate if today's at-risk parcels arrive late",
    unit: "rate",
    scopeType: "shipper",
    window: "commitment_13d",
    sources: [{ tool: "get_shipper_on_time", path: "rows.projectedRateIfAtRiskArriveLate", scopeFrom: "row:shipperId" }],
  },
  {
    id: "locker_inbound_without_space",
    label: "Inbound without locker space",
    definition: "Parcels arriving today at lockers with no free compartment",
    unit: "parcels",
    scopeType: "locker",
    window: "today",
    sources: [{ tool: "list_locker_sites", path: "rows.inboundWithoutSpace", scopeFrom: "row:id" }],
  },
  {
    id: "complaints_open_unassigned",
    label: "Open unassigned complaints",
    definition: "Open complaints with no owner",
    unit: "complaints",
    scopeType: "network",
    window: "now",
    sources: [{ tool: "list_complaints", path: "totals.unassigned" }],
  },
];

export const METRIC_BY_ID: ReadonlyMap<string, MetricDefinition> = new Map(
  METRIC_DEFINITIONS.map((item) => [item.id, item]),
);

/** Resolve a canonical metric id from a tool name and an exact result path (`totals.atRisk`, `rows.3.atRiskToday`). */
export function metricIdForSource(tool: string, resultPath: string): string | undefined {
  return resolveMetricSource(tool, resultPath)?.definition.id;
}

export function getMetricDefinition(id: string): MetricDefinition | undefined {
  return METRIC_BY_ID.get(id);
}

/** Reads `a.b.0.c` or `a.b[0].c` from a tool result. */
export function readResultPath(value: unknown, path: string): unknown {
  if (!path) return undefined;
  return path.replace(/\[(\d+)\]/g, ".$1").split(".").filter(Boolean).reduce<unknown>((current, part) => {
    if (current && typeof current === "object" && part in (current as object)) {
      return (current as Record<string, unknown>)[part];
    }
    return undefined;
  }, value);
}

/** True when an observed evidence number and a stated figure are the same (allowing a 0-1 ratio written as a percentage). */
export function figureMatches(observed: unknown, stated: number): boolean {
  if (typeof observed !== "number" || !Number.isFinite(observed)) return false;
  if (Math.abs(observed - stated) <= 1e-6) return true;
  return observed <= 1 && stated > 1 && Math.abs(observed * 100 - stated) <= 0.15;
}

export type EvidenceLike = { tool?: string; arguments?: unknown; dataAsOf?: string; result?: unknown };

export type MetricBinding = {
  metricId: string;
  definition: MetricDefinition;
  source: MetricSource;
  resultPath: string;
  value: number;
  scope: { type: MetricScopeType; id?: string };
  denominator?: { value: number; metricId: string };
};

function splitRowPath(resultPath: string): { index: number; field: string } | undefined {
  const match = resultPath.replace(/\[(\d+)\]/g, ".$1").match(/^rows\.(\d+)\.([A-Za-z0-9_]+)$/);
  return match ? { index: Number(match[1]), field: match[2]! } : undefined;
}

/** The registry source a (tool, resultPath) pair is, matched on the exact shape the source names. */
export function resolveMetricSource(tool: string, resultPath: string): { definition: MetricDefinition; source: MetricSource; rowIndex?: number } | undefined {
  const row = splitRowPath(resultPath);
  for (const definition of METRIC_DEFINITIONS) {
    for (const source of definition.sources) {
      if (source.tool !== tool) continue;
      if (source.path.startsWith("rows.")) {
        if (row && source.path === `rows.${row.field}`) return { definition, source, rowIndex: row.index };
      } else if (source.path === resultPath) {
        return { definition, source };
      }
    }
  }
  return undefined;
}

function scopeOf(source: MetricSource, definition: MetricDefinition, evidence: EvidenceLike, rowIndex?: number): { type: MetricScopeType; id?: string } | undefined {
  const type = source.scopeType ?? definition.scopeType;
  if (!source.scopeFrom) return { type };
  const [kind, ...rest] = source.scopeFrom.split(":");
  const key = rest.join(":");
  let id: unknown;
  if (kind === "row") {
    if (rowIndex === undefined) return undefined;
    const rows = (evidence.result as { rows?: unknown } | undefined)?.rows;
    const row = Array.isArray(rows) ? rows[rowIndex] as Record<string, unknown> | undefined : undefined;
    id = row?.[key];
  } else if (kind === "arg") {
    id = (evidence.arguments as Record<string, unknown> | undefined)?.[key];
    if (id === undefined || id === null || id === "") return source.unscopedType ? { type: source.unscopedType } : undefined;
  } else if (kind === "field") {
    id = readResultPath(evidence.result, key);
  }
  return typeof id === "string" && id ? { type, id } : undefined;
}

/**
 * Binds a figure to the metric registry from where it was read, never from what a
 * model called it: the (tool, resultPath) pair picks the definition, the scope comes
 * from the source's `scopeFrom`, and the denominator is read from the same evidence.
 * Returns undefined when the path is not a registry source, the value there is not
 * a number (or not `expected`), or the scope or day cannot be established.
 */
export function bindRegistryMetric(evidence: EvidenceLike, resultPath: string, expected?: number): MetricBinding | undefined {
  if (!evidence.tool) return undefined;
  const resolved = resolveMetricSource(evidence.tool, resultPath);
  if (!resolved) return undefined;
  const { definition, source, rowIndex } = resolved;
  const observed = readResultPath(evidence.result, resultPath);
  if (typeof observed !== "number" || !Number.isFinite(observed)) return undefined;
  if (expected !== undefined && !figureMatches(observed, expected)) return undefined;
  if (source.dayField && definition.window === "today") {
    const day = readResultPath(evidence.result, source.dayField);
    if (!evidence.dataAsOf || typeof day !== "string" || day !== evidence.dataAsOf.slice(0, 10)) return undefined;
  }
  const scope = scopeOf(source, definition, evidence, rowIndex);
  if (!scope) return undefined;
  let denominator: MetricBinding["denominator"];
  const denominatorDef = definition.denominatorId ? getMetricDefinition(definition.denominatorId) : undefined;
  if (denominatorDef) {
    for (const candidate of denominatorDef.sources) {
      if (candidate.tool !== evidence.tool) continue;
      const path = candidate.path.startsWith("rows.")
        ? (rowIndex === undefined ? undefined : `rows.${rowIndex}.${candidate.path.slice("rows.".length)}`)
        : candidate.path;
      const value = path ? readResultPath(evidence.result, path) : undefined;
      const denominatorScope = scopeOf(candidate, denominatorDef, evidence, rowIndex);
      if (typeof value === "number" && Number.isFinite(value) && denominatorScope?.type === scope.type && denominatorScope.id === scope.id) {
        denominator = { value, metricId: denominatorDef.id };
        break;
      }
    }
  }
  return { metricId: definition.id, definition, source, resultPath, value: observed, scope, ...(denominator ? { denominator } : {}) };
}
