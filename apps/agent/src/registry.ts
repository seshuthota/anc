import type { Domain } from "@anc/contracts";
import { TOOL_CAPABILITIES, type CapabilityId, type Principal, hasGrant } from "@anc/policy";
import { TOOL_ALLOWLISTS } from "./mcp-client.js";

/** A column shown when a tool's rows are presented as a table: the row field, then its heading. */
type Column = readonly [field: string, heading: string];

export type CapabilityDefinition = {
  id: CapabilityId;
  tool: string;
  domain: Domain;
  /** Plain words a planner matches a question against. */
  description: string;
  sideEffect: "read" | "write";
  /** Part of a morning briefing for anyone granted it. */
  core?: boolean;
  /** Used only inside an operation, never scheduled as an investigation. */
  internal?: boolean;
  /** The kind of record each row is, with the field holding its id. */
  rowEntity?: { type: "hub" | "district" | "route_run" | "shipment" | "shipper" | "locker" | "complaint" | "equipment"; idField: string };
  columns?: readonly Column[];
  rowAction?: { name: string; requiredGrant: CapabilityId };
  /** Marks a result that is a series over time, and where its points are. */
  series?: { pointsField: string; labelField: string; valueField: string; unit: string };
  /** Arguments used when no model is choosing them. `undefined` means the tool needs a record that is not in scope. */
  defaults?: (scope: Record<string, string | undefined>) => Record<string, unknown> | undefined;
  /**
   * Fixture (and deterministic) headline: which figure in the tool result is the
   * finding's figure, how severe it is, and how to title it. The metric id, scope
   * and denominator are not declared here: they are bound from (tool, path) through
   * the metric registry (`bindRegistryMetric`), exactly as for live specialists.
   */
  headline?: {
    /** The registry metric the path is expected to bind to (checked in tests). */
    metricId?: string;
    /** Dot path into evidence.result for the primary figure. Empty for qualitative findings. */
    path: string;
    /** Pick the row that headlines when the path is under rows.*. */
    pickRow?: (rows: Array<Record<string, unknown>>) => Record<string, unknown> | undefined;
    title: (ctx: { value: number; row?: Record<string, unknown>; result: Record<string, unknown> }) => string;
    summary: (ctx: { value: number; row?: Record<string, unknown>; result: Record<string, unknown> }) => string;
    severity: (value: number, result: Record<string, unknown>, row?: Record<string, unknown>) => "info" | "low" | "medium" | "high" | "critical";
  };
};

export type SpecialistDefinition = {
  id: Domain;
  label: string;
  responsibilities: string;
  budget: { maxToolCalls: number };
};

const cap = (tool: string, domain: Domain, description: string, extra: Partial<CapabilityDefinition> = {}): CapabilityDefinition => ({
  id: TOOL_CAPABILITIES[tool]!, tool, domain, description, sideEffect: "read", ...extra,
});

export const CAPABILITIES: CapabilityDefinition[] = [
  cap("get_hub_status", "network", "Hub sort floor status: parcels waiting to be sorted, backlog and sorting rate", {
    core: true, rowEntity: { type: "hub", idField: "hubId" },
    columns: [["name", "Hub"], ["parcelsWaitingToSort", "Waiting to sort"], ["sortedLastHour", "Sorted last hour"], ["usualSortRatePerHour", "Usual per hour"], ["hoursToClearAtCurrentRate", "Hours to clear"]],
    headline: {
      metricId: "parcels_waiting_to_sort",
      path: "rows.parcelsWaitingToSort",
      pickRow: (rows) => [...rows].sort((a, b) => Number(b.parcelsWaitingToSort ?? 0) - Number(a.parcelsWaitingToSort ?? 0))[0],
      title: ({ value, row }) => `${row?.name ?? "Hub"} has ${value.toLocaleString("en-IN")} parcels waiting to sort`,
      summary: ({ value, row }) => `Sorted ${Number(row?.sortedLastHour ?? 0).toLocaleString("en-IN")} in the last hour against a usual ${Number(row?.usualSortRatePerHour ?? 0).toLocaleString("en-IN")} per hour.`,
      severity: (value) => (value > 0 ? "high" : "info"),
    },
  }),
  cap("get_hub_throughput", "network", "Hourly sorting throughput and backlog trend over time for one hub", {
    series: { pointsField: "points", labelField: "hour", valueField: "backlog", unit: "parcels waiting" },
    defaults: (scope) => (scope.hub ? { hubId: scope.hub } : undefined),
  }),
  cap("list_equipment_events", "network", "Equipment faults, breakdowns and stoppages at hubs", {
    core: true, rowEntity: { type: "equipment", idField: "id" }, defaults: () => ({ openOnly: true }),
    columns: [["hubName", "Hub"], ["equipment", "Equipment"], ["startedAt", "Since"], ["severity", "Severity"], ["summary", "What happened"]],
    headline: {
      path: "",
      pickRow: (rows) => rows.find((row) => String(row.severity) === "high") ?? rows[0],
      title: ({ row }) => row ? `${row.hubName ?? "Hub"}: ${row.equipment ?? "equipment"} fault` : "No open equipment faults",
      summary: ({ row }) => String(row?.summary ?? "No open equipment faults."),
      severity: (_value, _result, row) => (!row ? "info" : String(row.severity) === "high" ? "high" : String(row.severity) === "critical" ? "critical" : "medium"),
    },
  }),
  cap("list_route_runs", "network", "Delivery route runs today: truck departures, delays, held runs and parcels left behind", {
    core: true, rowEntity: { type: "route_run", idField: "id" }, defaults: () => ({}),
    columns: [["districtName", "Area"], ["wave", "Wave"], ["status", "Status"], ["minutesLate", "Minutes late"], ["parcelsPlanned", "Planned"], ["parcelsLoaded", "Loaded"]],
    headline: {
      metricId: "route_runs_held_today",
      path: "totals.held",
      title: ({ value }) => value ? `${value} route run${value === 1 ? "" : "s"} held today` : "No route runs held",
      summary: ({ value, result }) => value ? `${Number((result.totals as { parcelsPlanned?: number } | undefined)?.parcelsPlanned ?? 0).toLocaleString("en-IN")} parcels sit on held runs.` : "Departures are moving.",
      severity: (value) => (value > 0 ? "high" : "info"),
    },
  }),
  cap("get_shipment", "shipments", "One parcel's tracking record", { defaults: (scope) => (scope.shipment ? { shipmentId: scope.shipment } : undefined) }),
  cap("search_shipments", "shipments", "Search individual parcels by status, hub, area, shipper or promised date", {
    rowEntity: { type: "shipment", idField: "id" }, defaults: (scope) => ({ status: "at_hub", hubId: scope.hub, shipperId: scope.shipper }),
    columns: [["id", "Parcel"], ["shipperName", "Shipper"], ["districtName", "Area"], ["serviceLevel", "Service"], ["promisedBy", "Promised by"], ["status", "Status"]],
  }),
  cap("summarize_at_risk_shipments", "shipments", "Parcels promised today at risk of missing delivery or arriving late, by hub, area or shipper", {
    core: true, rowEntity: { type: "district", idField: "id" }, defaults: () => ({ groupBy: "district" }),
    columns: [["name", "Area"], ["atRisk", "At risk"], ["unsorted", "Not yet sorted"], ["sortedNotLoaded", "Sorted, not loaded"], ["expressDueByNoon", "Express due by noon"]],
    headline: {
      metricId: "parcels_at_risk_today",
      path: "totals.atRisk",
      title: ({ value }) => value ? `${value.toLocaleString("en-IN")} parcels at risk of missing today's promise` : "No parcels at risk today",
      summary: ({ value, result }) => {
        const promised = Number((result.totals as { promisedToday?: number } | undefined)?.promisedToday ?? 0);
        return value ? `Promised for delivery today and not yet on a truck${promised ? `, of ${promised.toLocaleString("en-IN")} promised` : ""}.` : "Every promised parcel is on a truck or already delivered.";
      },
      severity: (value) => (value > 0 ? "high" : "info"),
    },
  }),
  cap("get_delivery_performance", "shipments", "On-time delivery performance trend by day, hub or area", {
    series: { pointsField: "rows", labelField: "id", valueField: "onTimeRate", unit: "on-time rate" }, defaults: () => ({ groupBy: "day" }),
  }),
  cap("list_locker_sites", "last_mile", "Parcel locker sites: occupancy, full lockers, uncollected parcels and arrivals with no space", {
    core: true, rowEntity: { type: "locker", idField: "id" },
    columns: [["name", "Locker"], ["districtName", "Area"], ["occupancy", "Full"], ["freeCompartments", "Free"], ["waitingOver48Hours", "Uncollected over 48h"], ["inboundWithoutSpace", "Arriving with no space"]],
    headline: {
      metricId: "locker_inbound_without_space",
      path: "rows.inboundWithoutSpace",
      pickRow: (rows) => [...rows].sort((a, b) => Number(b.inboundWithoutSpace ?? 0) - Number(a.inboundWithoutSpace ?? 0))[0],
      title: ({ value, row }) => value ? `${row?.name ?? "Locker"}: ${value.toLocaleString("en-IN")} arrivals with no space` : "Locker sites have free space",
      summary: ({ value, row }) => value ? `${row?.districtName ?? "Area"} locker pressure for today's inbound.` : "No inbound without space.",
      severity: (value) => (value > 0 ? "medium" : "info"),
    },
  }),
  cap("get_locker_site", "last_mile", "One parcel locker site in detail with daily deposits and collections", { defaults: (scope) => (scope.locker ? { siteId: scope.locker } : undefined) }),
  cap("search_shippers", "customers", "Search shippers, the business customers who send parcels", {
    rowEntity: { type: "shipper", idField: "id" }, columns: [["name", "Shipper"], ["tier", "Tier"], ["onTimeTarget", "On-time commitment"]],
  }),
  cap("get_shipper", "customers", "One shipper's account, manager and open parcels", { defaults: (scope) => (scope.shipper ? { shipperId: scope.shipper } : undefined) }),
  cap("get_shipper_on_time", "customers", "Shipper on-time delivery rate against commitment; key accounts at risk of missing their commitment", {
    core: true, rowEntity: { type: "shipper", idField: "shipperId" }, defaults: () => ({ onlyAtRisk: true }),
    columns: [["name", "Shipper"], ["tier", "Tier"], ["atRiskToday", "At risk today"], ["onTimeRate", "On time now"], ["projectedRateIfAtRiskArriveLate", "If these arrive late"], ["onTimeTarget", "Commitment"]],
    headline: {
      metricId: "parcels_at_risk_today",
      path: "rows.atRiskToday",
      pickRow: (rows) => {
        const miss = rows.filter((row) => row.wouldMissTarget);
        const pool = miss.length ? miss : rows;
        return [...pool].sort((a, b) => Number(b.atRiskToday ?? 0) - Number(a.atRiskToday ?? 0))[0];
      },
      title: ({ value, row }) => `${row?.name ?? "Shipper"} has ${value.toLocaleString("en-IN")} parcels at risk today`,
      summary: ({ row }) => row?.wouldMissTarget
        ? `Projected on-time ${Number(row.projectedRateIfAtRiskArriveLate ?? 0).toLocaleString("en-IN", { style: "percent", maximumFractionDigits: 1 })} would miss the ${Number(row.onTimeTarget ?? 0).toLocaleString("en-IN", { style: "percent", maximumFractionDigits: 0 })} commitment.`
        : `At-risk parcels for this shipper; commitment still in reach.`,
      severity: (_value, _result, row) => (row?.wouldMissTarget ? "high" : Number(row?.atRiskToday ?? 0) > 0 ? "medium" : "info"),
    },
  }),
  cap("list_complaints", "customers", "Customer complaints queue: open complaints, unassigned complaints with no owner, by category", {
    core: true, rowEntity: { type: "complaint", idField: "id" }, defaults: () => ({ status: "open" }),
    rowAction: { name: "prepare_assignment", requiredGrant: "cap.complaints.assign" },
    columns: [["id", "Complaint"], ["shipperName", "Shipper"], ["category", "About"], ["subject", "Subject"], ["createdAt", "Raised"]],
    headline: {
      metricId: "complaints_open_unassigned",
      path: "totals.unassigned",
      title: ({ value }) => value ? `${value} complaint${value === 1 ? "" : "s"} need an owner` : "No unassigned complaints",
      summary: ({ value }) => value ? "Open complaints with no assignee in the care queue." : "Every open complaint has an owner.",
      severity: (value) => (value > 0 ? "medium" : "info"),
    },
  }),
  cap("list_eligible_assignees", "customers", "People who can own a complaint", { internal: true }),
  cap("commit_complaint_assignment", "customers", "Assign a complaint to an owner", { sideEffect: "write" }),
];

export const SPECIALISTS: SpecialistDefinition[] = [
  { id: "network", label: "Network Agent", responsibilities: "Hubs, sort floors, equipment faults and route departures.", budget: { maxToolCalls: 6 } },
  { id: "shipments", label: "Shipments Agent", responsibilities: "Parcels, what is at risk of missing its promise, and delivery performance.", budget: { maxToolCalls: 6 } },
  { id: "last_mile", label: "Last-Mile Agent", responsibilities: "Parcel lockers and doorstep delivery.", budget: { maxToolCalls: 6 } },
  { id: "customers", label: "Customers Agent", responsibilities: "Shippers, their on-time commitments, and complaints.", budget: { maxToolCalls: 6 } },
];

export function specialistLabel(domain: Domain): string {
  return SPECIALISTS.find((item) => item.id === domain)?.label ?? `${domain} agent`;
}

export function capabilityForTool(tool: string): CapabilityDefinition | undefined {
  return CAPABILITIES.find((item) => item.tool === tool);
}

export function validateRegistry() {
  const errors: string[] = [];
  for (const capability of CAPABILITIES) {
    if (TOOL_CAPABILITIES[capability.tool] !== capability.id) errors.push(`capability ${capability.id} is not bound to tool metadata`);
    if (!TOOL_ALLOWLISTS[capability.domain].includes(capability.tool)) errors.push(`tool ${capability.tool} is not offered to the ${capability.domain} agent by the company server`);
  }
  for (const tool of Object.values(TOOL_ALLOWLISTS).flat()) {
    if (!CAPABILITIES.some((item) => item.tool === tool)) errors.push(`company tool ${tool} has no capability definition`);
  }
  return errors;
}

/** Tools a specialist may use for a task: in its domain, granted to the person, and not a write. */
export function authorizedTools(principal: Principal, domain: Domain, capabilityIds?: string[]): string[] {
  return TOOL_ALLOWLISTS[domain].filter((tool) => {
    const definition = capabilityForTool(tool);
    if (!definition || definition.sideEffect === "write" || definition.internal) return false;
    if (!hasGrant(principal, definition.id)) return false;
    return capabilityIds?.length ? capabilityIds.includes(definition.id) : true;
  });
}

/** Capabilities a planner may schedule for this person. */
export function authorizedCapabilities(principal: Principal): CapabilityDefinition[] {
  return CAPABILITIES.filter((item) => !item.internal && hasGrant(principal, item.id));
}
