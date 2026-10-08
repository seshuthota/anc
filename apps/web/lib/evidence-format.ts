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

export function describeFilters(filters: Record<string, unknown>): string[] {
  const shown: string[] = [];
  for (const [key, value] of Object.entries(filters)) {
    if (HIDDEN_FILTERS.has(key) || value === undefined || value === null || value === false) continue;
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

/** A cell or filter value in person wording: IST times, dates, percentages, yes/no. */
export function formatValue(value: unknown, field = ""): string {
  if (value === null || value === undefined || value === "") return "—";
  if (typeof value === "boolean") return value ? "Yes" : "No";
  if (typeof value === "number") {
    if (/rate|target/i.test(field) && !/^hours|perhour/i.test(field) && value >= 0 && value <= 1) return `${(value * 100).toLocaleString("en-IN", { maximumFractionDigits: 1 })}%`;
    return value.toLocaleString("en-IN");
  }
  if (typeof value === "string") {
    if (ISO_TIME.test(value)) return formatIstTime(value);
    if (ISO_DATE.test(value)) return formatDate(value);
    if (/^[a-z]+(_[a-z]+)+$/.test(value)) return fieldLabel(value);
    return value;
  }
  return JSON.stringify(value);
}

/** "summarize_at_risk_shipments" → "Summarize at risk shipments". */
export function toolLabel(tool: string): string {
  const words = tool.replaceAll("_", " ");
  return words.charAt(0).toUpperCase() + words.slice(1);
}
