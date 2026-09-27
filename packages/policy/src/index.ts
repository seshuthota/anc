export const ORGANIZATION_ID = "org-democo";
export const DEMO_OWNER_ID = "user-coo";
export const PRINCIPAL_HEADER = "x-anc-principal";

export type CapabilityId = string;

export type Principal = {
  id: string;
  organizationId: string;
  displayName: string;
  title: string;
  team: string;
  employeeId: string;
  grants: CapabilityId[];
  deniedFields: string[];
  preferences: {
    roleDescription: string;
    priorities: string[];
  };
};

export const TOOL_CAPABILITIES: Record<string, CapabilityId> = {
  get_service_health: "cap.service.health",
  get_service_health_series: "cap.service.trend",
  get_error_metrics: "cap.service.errors",
  get_recent_releases: "cap.releases.read",
  get_release_details: "cap.releases.read",
  list_impacted_customers: "cap.customers.impact",
  get_feature_usage: "cap.usage.read",
  compare_usage_periods: "cap.usage.read",
  get_customer_feature_usage: "cap.usage.read",
  search_customers: "cap.customers.read",
  get_customer: "cap.customers.read",
  search_support_tickets: "cap.tickets.read",
  get_customer_support_history: "cap.tickets.read",
  list_unassigned_escalations: "cap.tickets.read",
  list_eligible_assignees: "cap.tickets.assign",
  commit_ticket_assignment: "cap.tickets.assign",
  calculate_account_exposure: "cap.finance.arr",
  get_subscription: "cap.finance.arr",
  list_invoice_aging: "cap.finance.invoices",
  list_open_incidents: "cap.incidents.read",
  list_maintenance_windows: "cap.maintenance.read",
};

const READS: CapabilityId[] = [
  "cap.service.health",
  "cap.service.trend",
  "cap.service.errors",
  "cap.releases.read",
  "cap.customers.impact",
  "cap.usage.read",
  "cap.customers.read",
  "cap.tickets.read",
  "cap.finance.arr",
  "cap.finance.invoices",
  "cap.incidents.read",
  "cap.maintenance.read",
];

export const PERSONAS: Principal[] = [
  {
    id: "user-ops",
    organizationId: ORGANIZATION_ID,
    displayName: "Alex Rivera",
    title: "Head of Operations",
    team: "operations",
    employeeId: "emp-ops",
    grants: [
      "cap.service.health",
      "cap.service.trend",
      "cap.service.errors",
      "cap.releases.read",
      "cap.customers.impact",
      "cap.usage.read",
      "cap.customers.read",
      "cap.tickets.read",
      "cap.incidents.read",
      "cap.maintenance.read",
    ],
    deniedFields: ["arr_minor_units", "arrMinorUnits", "amount_minor_units", "amountMinorUnits"],
    preferences: {
      roleDescription: "Keeps service reliability and recent changes in view.",
      priorities: ["service health", "releases", "impacted customers"],
    },
  },
  {
    id: "user-finance",
    organizationId: ORGANIZATION_ID,
    displayName: "Priya Shah",
    title: "Head of Finance",
    team: "finance",
    employeeId: "emp-finance",
    grants: ["cap.customers.read", "cap.finance.arr", "cap.finance.invoices"],
    deniedFields: [],
    preferences: {
      roleDescription: "Tracks receivables, exposure, and overdue invoices.",
      priorities: ["invoice aging", "represented ARR"],
    },
  },
  {
    id: "user-support",
    organizationId: ORGANIZATION_ID,
    displayName: "Sam Okonkwo",
    title: "Head of Support",
    team: "support",
    employeeId: "emp-support-1",
    grants: ["cap.customers.read", "cap.tickets.read", "cap.tickets.assign"],
    deniedFields: ["arr_minor_units", "arrMinorUnits", "amount_minor_units", "amountMinorUnits"],
    preferences: {
      roleDescription: "Clears escalations and assigns owners.",
      priorities: ["unassigned escalations", "customer tickets"],
    },
  },
  {
    id: DEMO_OWNER_ID,
    organizationId: ORGANIZATION_ID,
    displayName: "Casey Nguyen",
    title: "Chief Operating Officer",
    team: "office-of-the-coo",
    employeeId: "emp-coo",
    grants: [...READS],
    deniedFields: [],
    preferences: {
      roleDescription: "Coordinates across operations, finance, and support.",
      priorities: ["cross-domain attention", "customer impact"],
    },
  },
];

export function listPersonas(): Principal[] {
  return PERSONAS;
}

export function resolvePrincipal(id?: string | null): Principal {
  const normalized = id && id !== "undefined" && id !== "null" ? id : undefined;
  const match = PERSONAS.find((item) => item.id === normalized);
  if (normalized && !match) throw new Error(`Unknown principal: ${normalized}`);
  return match ?? PERSONAS.find((item) => item.id === DEMO_OWNER_ID)!;
}

export function sessionThreadId(principalId: string): string {
  return principalId === DEMO_OWNER_ID ? "local-demo" : `session:${principalId}`;
}

export function hasGrant(principal: Principal, capability: CapabilityId): boolean {
  return principal.grants.includes(capability);
}

export function canUseTool(principal: Principal, tool: string): boolean {
  const capability = TOOL_CAPABILITIES[tool];
  if (!capability) return false;
  return hasGrant(principal, capability);
}

export function assertToolAllowed(principal: Principal, tool: string) {
  if (!canUseTool(principal, tool)) {
    throw new Error(`Not authorized to use ${tool}`);
  }
}

function redactValue(value: unknown, denied: Set<string>): unknown {
  if (Array.isArray(value)) return value.map((item) => redactValue(item, denied));
  if (!value || typeof value !== "object") return value;
  const output: Record<string, unknown> = {};
  for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
    if (denied.has(key)) continue;
    output[key] = redactValue(nested, denied);
  }
  return output;
}

export function redactForPrincipal<T>(principal: Principal, value: T): T {
  if (!principal.deniedFields.length) return value;
  return redactValue(value, new Set(principal.deniedFields)) as T;
}

export function isDemoMode(env: NodeJS.ProcessEnv = process.env): boolean {
  return (env.DEMO_MODE ?? "true") !== "false";
}

export function authMode(env: NodeJS.ProcessEnv = process.env): "demo" | "oidc" {
  if (env.AUTH_MODE === "oidc" || env.AUTH_MODE === "demo") return env.AUTH_MODE;
  return isDemoMode(env) ? "demo" : "oidc";
}

export function withoutGrants(principal: Principal, revoked: readonly string[]): Principal {
  if (!revoked.length) return principal;
  const denied = new Set(revoked);
  return { ...principal, grants: principal.grants.filter((grant) => !denied.has(grant)) };
}

export function deploymentProblems(env: NodeJS.ProcessEnv = process.env): string[] {
  if (authMode(env) !== "oidc") return [];
  return ["SESSION_SECRET", "OIDC_ISSUER", "OIDC_CLIENT_ID", "OIDC_CLIENT_SECRET", "OIDC_SUBJECT_MAP", "ALLOWED_ORIGINS", "AUDIT_ACCESS_TOKEN"]
    .filter((key) => !env[key]);
}

export {
  authorizationUrl,
  createPkce,
  endpointsFromDiscovery,
  principalIdFromClaims,
  signHop,
  signSession,
  verifyHop,
  verifyOidcIdToken,
  verifySession,
} from "./session.js";
export type { OidcIdentity, SessionClaims } from "./session.js";
