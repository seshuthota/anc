/**
 * Person-facing formatting for the evidence drawer: times in IST, human field
 * labels, and the tool's plumbing (paging, grouping, ids) kept out of sight.
 * The raw record is only shown to developers (?dev=1).
 */

const IST = "Asia/Kolkata";
const ISO_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function parts(ms: number) {
  const format = new Intl.DateTimeFormat("en-US", { timeZone: IST, weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
  return Object.fromEntries(format.formatToParts(new Date(ms)).map((part) => [part.type, part.value])) as Record<string, string>;
}

/** "07:00 IST, Mon 21 Sep" for any instant, whatever offset it was written with. */
export function formatIstTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return iso;
  const p = parts(ms);
  return `${p.hour}:${p.minute} IST, ${p.weekday} ${p.day} ${p.month}`;
}

/** "Mon 21 Sep" for a calendar date. */
export function formatDate(date: string): string {
  const p = parts(Date.parse(`${date}T12:00:00+05:30`));
  return `${p.weekday} ${p.day} ${p.month}`;
}

const LABELS: Record<string, string> = {
  atRisk: "At risk",
  atRiskToday: "At risk today",
  unsorted: "Not yet sorted",
  sortedNotLoaded: "Sorted, not loaded",
  promisedToday: "Promised today",
  dueToday: "Due today",
  onTime: "On time",
  onTimeRate: "On-time rate",
  onTimeTarget: "On-time commitment",
  projectedRateIfAtRiskArriveLate: "On-time rate if today's at-risk parcels arrive late",
  meetsTargetNow: "Meets commitment now",
  wouldMissTarget: "Would miss commitment",
  shippersThatWouldMissTarget: "Shippers that would miss their commitment",
  parcelsWaitingToSort: "Waiting to sort",
  sortedLastHour: "Sorted last hour",
  usualSortRatePerHour: "Usual per hour",
  hoursToClearAtCurrentRate: "Hours to clear",
  parcelsPlanned: "Parcels planned",
  parcelsLoaded: "Parcels loaded",
  parcelsLeftBehind: "Parcels left behind",
  minutesLate: "Minutes late",
  scheduledDeparture: "Scheduled departure",
  actualDeparture: "Actual departure",
  startedAt: "Started",
  endedAt: "Ended",
  escalatedAt: "Escalated",
  escalatedToName: "Escalated to",
  onCallEngineerName: "Engineer on call",
  hubName: "Hub",
  districtName: "District",
  driverName: "Driver",
  serviceDate: "Service date",
  summary: "What happened",
  name: "Name",
  tier: "Tier",
  held: "Held",
  matching: "Matching",
  open: "Open",
  unassigned: "Without an owner",
  openOnly: "Open only",
  onlyAtRisk: "Only shippers with parcels at risk",
  unassignedOnly: "Only without an owner",
  atRiskOnly: "Only about parcels at risk today",
};

/** "sortedNotLoaded" → "Sorted, not loaded"; unknown names become a sentence. */
export function fieldLabel(name: string, context: { groupBy?: unknown } = {}): string {
  if (name === "count") return typeof context.groupBy === "string" ? `Groups (one per ${context.groupBy})` : "Records";
  if (LABELS[name]) return LABELS[name]!;
  const words = name.replace(/_/g, " ").replace(/([a-z0-9])([A-Z])/g, "$1 $2").toLowerCase().trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** Internal columns (keys, versions, raw ids) are hidden unless developer view is on. */
export function isInternalField(name: string): boolean {
  return name === "id" || name === "version" || /Id$/.test(name) || name === "escalatedTo";
}

/** Plumbing a person does not need: how the tool was paged or grouped. */
const HIDDEN_FILTERS = new Set(["groupBy", "page", "limit", "offset", "idempotencyKey", "requestedBy"]);

/** Names for ids, from the runtime's explanation (`labels`). */
export type Labels = Record<string, string>;

/** Looks like a record key ("hub-hyd", "lock-velachery", "shipper-003"), not words. */
export function looksLikeId(value: string): boolean {
  return /^[a-z]+(-[a-z0-9]+)+$/.test(value);
}

/**
 * The filters a tool was asked with, in words. An id filter shows its name
 * ("Hub: Hyderabad Hub"); one with no known name is dropped outside developer view.
 */
export function describeFilters(filters: Record<string, unknown>, labels: Labels = {}, developer = false): string[] {
  const shown: string[] = [];
  for (const [key, value] of Object.entries(filters)) {
    if (HIDDEN_FILTERS.has(key) || value === undefined || value === null || value === false) continue;
    if (/.Id$/.test(key) || (typeof value === "string" && looksLikeId(value))) {
      const label = fieldLabel(/.Id$/.test(key) ? key.slice(0, -2) : key);
      const name = typeof value === "string" ? labels[value] : undefined;
      if (name) shown.push(`${label}: ${name}`);
      else if (developer) shown.push(`${label}: ${String(value)}`);
      continue;
    }
    if (key === "window" && value && typeof value === "object") {
      const window = value as { from?: string; to?: string };
      shown.push(`From ${formatIstTime(window.from)} to ${formatIstTime(window.to)}`);
      continue;
    }
    if (value === true) { shown.push(fieldLabel(key)); continue; }
    shown.push(`${fieldLabel(key)}: ${formatValue(value, key)}`);
  }
  return shown;
}

/** Where a metric applies: the named hub or locker, "whole network", or nothing when only an id is known. */
export function scopeLabel(scope: { type: string; id?: string } | null | undefined, labels: Labels = {}, developer = false): string | null {
  if (!scope) return null;
  if (!scope.id) return scope.type === "network" ? "whole network" : null;
  if (labels[scope.id]) return labels[scope.id]!;
  return developer ? `${scope.type}: ${scope.id}` : null;
}

/** A cell or filter value in person wording: IST times, dates, percentages, yes/no, named ids, capitalised codes. */
export function formatValue(value: unknown, field = "", labels: Labels = {}): string {
  if (value === null || value === undefined || value === "") return "—";
  if (typeof value === "boolean") return value ? "Yes" : "No";
  if (typeof value === "number") {
    if (/rate|target/i.test(field) && !/^hours|perhour/i.test(field) && value >= 0 && value <= 1) return `${(value * 100).toLocaleString("en-IN", { maximumFractionDigits: 1 })}%`;
    return value.toLocaleString("en-IN");
  }
  if (typeof value === "string") {
    if (ISO_TIME.test(value)) return formatIstTime(value);
    if (ISO_DATE.test(value)) return formatDate(value);
    if (labels[value]) return labels[value]!;
    if (/^[a-z]+(_[a-z]+)+$/.test(value)) return fieldLabel(value);
    // A one-word code from the company system ("high", "departed", "standard").
    if (/^[a-z]+$/.test(value)) return value.charAt(0).toUpperCase() + value.slice(1);
    return value;
  }
  return JSON.stringify(value);
}

/** "summarize_at_risk_shipments" → "Summarize at risk shipments" (developer view only). */
export function toolLabel(tool: string): string {
  const words = tool.replaceAll("_", " ");
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** What each company tool reads, in words: the drawer's "From" line and tab titles. */
const SOURCES: Record<string, string> = {
  get_hub_status: "hub sort floors right now",
  get_hub_throughput: "hour-by-hour hub throughput",
  list_equipment_events: "equipment events in the hub maintenance log",
  list_route_runs: "today's delivery route runs",
  get_shipment: "the parcel's record",
  search_shipments: "parcel records",
  summarize_at_risk_shipments: "shipments promised today",
  get_delivery_performance: "delivery performance against promise",
  list_locker_sites: "parcel locker sites",
  get_locker_site: "the locker site's record",
  search_shippers: "shipper accounts",
  get_shipper: "the shipper's account",
  get_shipper_on_time: "shippers' on-time commitments",
  list_complaints: "customer complaints",
  list_eligible_assignees: "the customer-care team",
};

/** "shipments promised today"; an unmapped tool becomes "company records". */
export function sourceLabel(tool: string): string {
  return SOURCES[tool] ?? "company records";
}

/** A tab title, sentence case to match the body: "Shipments promised today". */
export function sourceTitle(tool: string): string {
  const label = sourceLabel(tool);
  return label.charAt(0).toUpperCase() + label.slice(1);
}
