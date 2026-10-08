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

/** One capability per company tool, so a grant names exactly what a person may see or do. */
export const TOOL_CAPABILITIES: Record<string, CapabilityId> = {
  get_hub_status: "cap.hubs.status",
  get_hub_throughput: "cap.hubs.throughput",
  list_equipment_events: "cap.equipment.read",
  list_route_runs: "cap.routes.read",
  get_shipment: "cap.shipments.read",
  search_shipments: "cap.shipments.search",
  summarize_at_risk_shipments: "cap.shipments.at_risk",
  get_delivery_performance: "cap.performance.read",
  list_locker_sites: "cap.lockers.read",
  get_locker_site: "cap.lockers.detail",
  search_shippers: "cap.shippers.search",
  get_shipper: "cap.shippers.read",
  get_shipper_on_time: "cap.commitments.read",
  list_complaints: "cap.complaints.read",
  list_eligible_assignees: "cap.complaints.assign",
  commit_complaint_assignment: "cap.complaints.assign",
};

const NETWORK: CapabilityId[] = ["cap.hubs.status", "cap.hubs.throughput", "cap.equipment.read", "cap.routes.read"];
const SHIPMENTS: CapabilityId[] = ["cap.shipments.read", "cap.shipments.search", "cap.shipments.at_risk", "cap.performance.read"];
const LAST_MILE: CapabilityId[] = ["cap.lockers.read", "cap.lockers.detail"];
const CUSTOMERS: CapabilityId[] = ["cap.shippers.search", "cap.shippers.read", "cap.commitments.read", "cap.complaints.read"];

/** Five people at an Indian parcel carrier. What each sees follows from their grants, not their title. */
export const PERSONAS: Principal[] = [
  {
    id: DEMO_OWNER_ID,
    organizationId: ORGANIZATION_ID,
    displayName: "Ananya Reddy",
    title: "Chief Operating Officer",
    team: "operations",
    employeeId: "emp-ops",
    grants: [...NETWORK, ...SHIPMENTS, ...LAST_MILE, ...CUSTOMERS],
    deniedFields: [],
    preferences: {
      roleDescription: "Runs the whole network and answers for delivery promises to customers.",
      priorities: ["parcels at risk of missing today's promise", "hub and route disruption", "key account commitments"],
    },
  },
  {
    id: "user-hub-hyd",
    organizationId: ORGANIZATION_ID,
    displayName: "Ravi Teja Kondapalli",
    title: "Hyderabad Hub Supervisor",
    team: "hub",
    employeeId: "emp-hub-hyd",
    grants: [...NETWORK, ...SHIPMENTS],
    deniedFields: [],
    preferences: {
      roleDescription: "Keeps the Hyderabad sort floor moving and gets route runs out on time.",
      priorities: ["Hyderabad sort backlog", "equipment faults", "route departures from Hyderabad"],
    },
  },
  {
    id: "user-lastmile",
    organizationId: ORGANIZATION_ID,
    displayName: "Meenakshi Subramanian",
    title: "Last-Mile Lead",
    team: "last-mile",
    employeeId: "emp-lastmile",
    grants: [...LAST_MILE, "cap.routes.read", "cap.shipments.read", "cap.shipments.search", "cap.shipments.at_risk"],
    deniedFields: [],
    preferences: {
      roleDescription: "Owns doorstep and locker delivery across all cities.",
      priorities: ["full parcel lockers", "late or held route runs", "parcels that could not be delivered"],
    },
  },
  {
    id: "user-accounts",
    organizationId: ORGANIZATION_ID,
    displayName: "Arjun Mehta",
    title: "Key Account Manager",
    team: "accounts",
    employeeId: "emp-am-1",
    grants: [...CUSTOMERS, "cap.shipments.read", "cap.shipments.search", "cap.shipments.at_risk"],
    deniedFields: [],
    preferences: {
      roleDescription: "Looks after the largest shippers and their on-time commitments.",
      priorities: ["key accounts at risk of missing their on-time commitment", "complaints from key accounts"],
    },
  },
  {
    id: "user-care",
    organizationId: ORGANIZATION_ID,
    displayName: "Farah Siddiqui",
    title: "Customer Care Lead",
    team: "customer-care",
    employeeId: "emp-care-1",
    grants: ["cap.complaints.read", "cap.complaints.assign", "cap.shippers.search", "cap.shippers.read", "cap.shipments.read"],
    deniedFields: [],
    preferences: {
      roleDescription: "Clears the complaint queue and gives every complaint an owner.",
      priorities: ["complaints with no owner", "spikes in complaints"],
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
