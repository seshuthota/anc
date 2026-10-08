import type { Domain } from "@anc/contracts";
import { TOOL_CAPABILITIES, type CapabilityId, type Principal, hasGrant } from "@anc/policy";
import { TOOL_ALLOWLISTS } from "./mcp-client.js";

export type CapabilityDefinition = {
  id: CapabilityId;
  tool: string;
  domain: Domain;
  description: string;
  sideEffect: "read" | "write";
  core?: boolean;
  rowEntity?: string;
  rowAction?: { name: string; requiredGrant: CapabilityId };
  /** Marks a capability whose result is a time series, which composes as a trend view. */
  series?: string;
  inputSchema: Record<string, unknown>;
};

export type SpecialistDefinition = {
  id: Domain;
  responsibilities: string;
  capabilities: CapabilityId[];
  budget: { maxToolCalls: number };
};

const jsonObject = (properties: Record<string, unknown>, required: string[] = []): Record<string, unknown> => ({
  type: "object",
  additionalProperties: false,
  properties,
  required,
});

/** Mirrors the company MCP tools' window argument, so a model sees the real shape. */
/** Optional filters say so, because a model otherwise fills them with a guess that matches nothing. */
const SERVICE = { type: "string", description: "Service name, for example sync-service. Omit to use the default." };
const optionalFilter = (what: string) => ({ type: "string", description: `Optional ${what} filter. Omit it to include everything; never pass an empty or guessed value.` });
const WINDOW = jsonObject({ from: { type: "string", format: "date-time" }, to: { type: "string", format: "date-time" } }, ["from", "to"]);

export const CAPABILITIES: CapabilityDefinition[] = [
  { id: "cap.service.health", tool: "get_service_health", domain: "reliability", description: "Service health metrics", sideEffect: "read", core: true, inputSchema: jsonObject({ service: SERVICE, window: WINDOW }, ["window"]) },
  { id: "cap.service.trend", tool: "get_service_health_series", domain: "reliability", description: "Service error-rate trend over time", sideEffect: "read", series: "errorRate", inputSchema: jsonObject({ service: SERVICE, window: WINDOW, metric: { type: "string", enum: ["errorRate", "requests", "errors"] } }, ["window"]) },
  { id: "cap.service.errors", tool: "get_error_metrics", domain: "reliability", description: "Error metrics by signature", sideEffect: "read", core: true, inputSchema: jsonObject({ service: SERVICE, window: WINDOW, cohort: optionalFilter("rollout cohort") }, ["window"]) },
  { id: "cap.releases.read", tool: "get_recent_releases", domain: "reliability", description: "Recent releases", sideEffect: "read", core: true, inputSchema: jsonObject({ window: WINDOW, service: SERVICE }, ["window"]) },
  { id: "cap.customers.impact", tool: "list_impacted_customers", domain: "reliability", description: "Impacted customers from telemetry", sideEffect: "read", core: true, inputSchema: jsonObject({ service: SERVICE, window: WINDOW }, ["window"]) },
  { id: "cap.incidents.read", tool: "list_open_incidents", domain: "reliability", description: "Currently open incidents", sideEffect: "read", rowEntity: "incident", inputSchema: jsonObject({ service: SERVICE }) },
  { id: "cap.maintenance.read", tool: "list_maintenance_windows", domain: "reliability", description: "Open maintenance windows", sideEffect: "read", rowEntity: "service", inputSchema: jsonObject({ service: SERVICE }) },
  { id: "cap.usage.read", tool: "compare_usage_periods", domain: "product", description: "Usage period comparison", sideEffect: "read", core: true, inputSchema: jsonObject({ feature: { type: "string" }, current: WINDOW, baseline: WINDOW }, ["current", "baseline"]) },
  { id: "cap.customers.read", tool: "get_customer", domain: "customer", description: "Customer record", sideEffect: "read", inputSchema: jsonObject({ customerId: { type: "string" } }, ["customerId"]) },
  { id: "cap.tickets.read", tool: "list_unassigned_escalations", domain: "customer", description: "Unassigned support queue", sideEffect: "read", core: true, rowEntity: "ticket", rowAction: { name: "prepare_assignment", requiredGrant: "cap.tickets.assign" }, inputSchema: jsonObject({ category: optionalFilter("ticket category") }) },
  { id: "cap.tickets.assign", tool: "commit_ticket_assignment", domain: "customer", description: "Assign a support ticket", sideEffect: "write", inputSchema: jsonObject({ ticketId: { type: "string" }, assigneeId: { type: "string" }, expectedVersion: { type: "number" } }, ["ticketId", "assigneeId", "expectedVersion"]) },
  { id: "cap.finance.arr", tool: "calculate_account_exposure", domain: "finance", description: "Represented ARR for accounts", sideEffect: "read", inputSchema: jsonObject({ customerIds: { type: "array", items: { type: "string" } }, definition: { type: "string" } }, ["customerIds", "definition"]) },
  { id: "cap.finance.invoices", tool: "list_invoice_aging", domain: "finance", description: "Invoice aging comparison for overdue past-due receivables", sideEffect: "read", core: true, rowEntity: "customer", inputSchema: jsonObject({ asOf: { type: "string" }, customerIds: { type: "array", items: { type: "string" } } }) },
];

export const SPECIALISTS: SpecialistDefinition[] = [
  { id: "reliability", responsibilities: "Service health, errors, releases, incidents, maintenance windows, and impacted accounts.", capabilities: ["cap.service.health", "cap.service.errors", "cap.releases.read", "cap.customers.impact", "cap.incidents.read", "cap.maintenance.read"], budget: { maxToolCalls: 6 } },
  { id: "product", responsibilities: "Feature usage comparisons.", capabilities: ["cap.usage.read"], budget: { maxToolCalls: 6 } },
  { id: "customer", responsibilities: "Customers, tickets, and assignment preparation.", capabilities: ["cap.customers.read", "cap.tickets.read", "cap.tickets.assign"], budget: { maxToolCalls: 6 } },
  { id: "finance", responsibilities: "ARR exposure and invoice aging.", capabilities: ["cap.finance.arr", "cap.finance.invoices"], budget: { maxToolCalls: 6 } },
];

export function validateRegistry() {
  const errors: string[] = [];
  for (const capability of CAPABILITIES) {
    if (TOOL_CAPABILITIES[capability.tool] !== capability.id) errors.push(`capability ${capability.id} is not bound to tool metadata`);
  }
  for (const specialist of SPECIALISTS) {
    for (const capabilityId of specialist.capabilities) {
      if (!CAPABILITIES.some((item) => item.id === capabilityId)) errors.push(`specialist ${specialist.id} references missing ${capabilityId}`);
    }
  }
  return errors;
}

export function authorizedTools(principal: Principal, domain: Domain, capabilityIds?: string[]): string[] {
  return [...(TOOL_ALLOWLISTS[domain] ?? [])].filter((tool) => {
    const capability = TOOL_CAPABILITIES[tool];
    if (!capability || !hasGrant(principal, capability)) return false;
    if (capabilityIds?.length) return capabilityIds.includes(capability);
    return true;
  });
}

export function authorizedCapabilities(principal: Principal): CapabilityDefinition[] {
  return CAPABILITIES.filter((item) => hasGrant(principal, item.id));
}

export function toolJsonSchema(tool: string): Record<string, unknown> {
  return CAPABILITIES.find((item) => item.tool === tool)?.inputSchema ?? { type: "object", additionalProperties: true };
}

export function missingCapabilities(requested: CapabilityId[], principal: Principal): CapabilityId[] {
  return requested.filter((item) => !hasGrant(principal, item));
}
