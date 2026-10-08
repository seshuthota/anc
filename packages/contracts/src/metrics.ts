/**
 * Canonical metric definitions for briefing reconciliation and display.
 * Specialists map (tool, resultPath) onto these ids; free-text metric names
 * alone are not eligible as a headline figure.
 */

export type MetricScopeType = "network" | "hub" | "shipper" | "district" | "locker";
export type MetricWindowId = "today" | "last_hour" | "commitment_13d" | "now";

export type MetricSource = {
  tool: string;
  /** Dot path into the tool evidence `result` object. */
  path: string;
  /**
   * How to read scope from the same result. Omit for network-wide totals.
   * - "row:<field>" means each row contributes a scoped value at `path` relative to the row when path starts with "rows."
   * - "arg:<name>" means scope id comes from the tool argument
   * - "field:<path>" means a single scope id at that result path
   */
  scopeFrom?: string;
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
      { tool: "summarize_at_risk_shipments", path: "totals.atRisk" },
      { tool: "get_shipper_on_time", path: "rows.atRiskToday", scopeFrom: "row:shipperId" },
    ],
  },
  {
    id: "parcels_promised_today",
    label: "Parcels promised today",
    definition: "Parcels with a delivery promise for today",
    unit: "parcels",
    scopeType: "network",
    window: "today",
    sources: [{ tool: "summarize_at_risk_shipments", path: "totals.promisedToday" }],
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
    sources: [{ tool: "list_route_runs", path: "totals.held" }],
  },
  {
    id: "parcels_left_behind_today",
    label: "Parcels left behind today",
    definition: "Parcels planned on runs that departed short-loaded",
    unit: "parcels",
    scopeType: "network",
    window: "today",
    sources: [{ tool: "list_route_runs", path: "totals.parcelsLeftBehind" }],
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

/** Resolve a canonical metric id from a tool name and a result path (exact or rows.* form). */
export function metricIdForSource(tool: string, resultPath: string): string | undefined {
  const normalized = resultPath.replace(/\[\d+\]/g, "").replace(/\.(\d+)\./g, ".").replace(/\.(\d+)$/g, "");
  const asRowField = normalized.startsWith("rows.") ? normalized.slice("rows.".length) : normalized;
  for (const def of METRIC_DEFINITIONS) {
    for (const source of def.sources) {
      if (source.tool !== tool) continue;
      if (source.path === resultPath || source.path === normalized) return def.id;
      // rows.atRiskToday matches rows.0.atRiskToday / rows[0].atRiskToday
      if (source.path.startsWith("rows.") && (asRowField === source.path.slice("rows.".length) || normalized.endsWith(`.` + source.path.slice("rows.".length)))) {
        return def.id;
      }
      if (source.path === `rows.${asRowField}`) return def.id;
    }
  }
  return undefined;
}

export function getMetricDefinition(id: string): MetricDefinition | undefined {
  return METRIC_BY_ID.get(id);
}
