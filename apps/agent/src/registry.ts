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
  }),
  cap("get_hub_throughput", "network", "Hourly sorting throughput and backlog trend over time for one hub", {
    series: { pointsField: "points", labelField: "hour", valueField: "backlog", unit: "parcels waiting" },
    defaults: (scope) => (scope.hub ? { hubId: scope.hub } : undefined),
  }),
  cap("list_equipment_events", "network", "Equipment faults, breakdowns and stoppages at hubs", {
    core: true, rowEntity: { type: "equipment", idField: "id" }, defaults: () => ({ openOnly: true }),
    columns: [["hubName", "Hub"], ["equipment", "Equipment"], ["startedAt", "Since"], ["severity", "Severity"], ["summary", "What happened"]],
  }),
  cap("list_route_runs", "network", "Delivery route runs today: truck departures, delays, held runs and parcels left behind", {
    core: true, rowEntity: { type: "route_run", idField: "id" }, defaults: () => ({ status: "held" }),
    columns: [["districtName", "Area"], ["wave", "Wave"], ["status", "Status"], ["minutesLate", "Minutes late"], ["parcelsPlanned", "Planned"], ["parcelsLoaded", "Loaded"]],
  }),
  cap("get_shipment", "shipments", "One parcel's tracking record", { defaults: (scope) => (scope.shipment ? { shipmentId: scope.shipment } : undefined) }),
  cap("search_shipments", "shipments", "Search individual parcels by status, hub, area, shipper or promised date", {
    rowEntity: { type: "shipment", idField: "id" }, defaults: (scope) => ({ status: "at_hub", hubId: scope.hub, shipperId: scope.shipper }),
    columns: [["id", "Parcel"], ["shipperName", "Shipper"], ["districtName", "Area"], ["serviceLevel", "Service"], ["promisedBy", "Promised by"], ["status", "Status"]],
  }),
  cap("summarize_at_risk_shipments", "shipments", "Parcels promised today at risk of missing delivery or arriving late, by hub, area or shipper", {
    core: true, rowEntity: { type: "district", idField: "id" }, defaults: () => ({ groupBy: "district" }),
    columns: [["name", "Area"], ["atRisk", "At risk"], ["unsorted", "Not yet sorted"], ["sortedNotLoaded", "Sorted, not loaded"], ["expressDueByNoon", "Express due by noon"]],
  }),
  cap("get_delivery_performance", "shipments", "On-time delivery performance trend by day, hub or area", {
    series: { pointsField: "rows", labelField: "id", valueField: "onTimeRate", unit: "on-time rate" }, defaults: () => ({ groupBy: "day" }),
  }),
  cap("list_locker_sites", "last_mile", "Parcel locker sites: occupancy, full lockers, uncollected parcels and arrivals with no space", {
    core: true, rowEntity: { type: "locker", idField: "id" },
    columns: [["name", "Locker"], ["districtName", "Area"], ["occupancy", "Full"], ["freeCompartments", "Free"], ["waitingOver48Hours", "Uncollected over 48h"], ["inboundWithoutSpace", "Arriving with no space"]],
  }),
  cap("get_locker_site", "last_mile", "One parcel locker site in detail with daily deposits and collections", { defaults: (scope) => (scope.locker ? { siteId: scope.locker } : undefined) }),
  cap("search_shippers", "customers", "Search shippers, the business customers who send parcels", {
    rowEntity: { type: "shipper", idField: "id" }, columns: [["name", "Shipper"], ["tier", "Tier"], ["onTimeTarget", "On-time commitment"]],
  }),
  cap("get_shipper", "customers", "One shipper's account, manager and open parcels", { defaults: (scope) => (scope.shipper ? { shipperId: scope.shipper } : undefined) }),
  cap("get_shipper_on_time", "customers", "Shipper on-time delivery rate against commitment; key accounts at risk of missing their commitment", {
    core: true, rowEntity: { type: "shipper", idField: "shipperId" }, defaults: () => ({ onlyAtRisk: true }),
    columns: [["name", "Shipper"], ["tier", "Tier"], ["atRiskToday", "At risk today"], ["onTimeRate", "On time now"], ["projectedRateIfAtRiskArriveLate", "If these arrive late"], ["onTimeTarget", "Commitment"]],
  }),
  cap("list_complaints", "customers", "Customer complaints queue: open complaints, unassigned complaints with no owner, by category", {
    core: true, rowEntity: { type: "complaint", idField: "id" }, defaults: () => ({ status: "open" }),
    rowAction: { name: "prepare_assignment", requiredGrant: "cap.complaints.assign" },
    columns: [["id", "Complaint"], ["shipperName", "Shipper"], ["category", "About"], ["subject", "Subject"], ["createdAt", "Raised"]],
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
