import type { PublicState } from "./agent";

export type Step = PublicState["activity"][number];

/**
 * Person-facing wording for the activity pill. The runtime's own status lines
 * carry internals (a conflicting figure, a plan validation error, a composer
 * error, an exception message), so nothing here ever echoes `step.message`:
 * every line is mapped to fixed wording, and anything unrecognised gets a
 * generic line. The raw text is only shown in the developer details (?dev=1).
 */

/** Who did a step, read from how the runtime words its activity. */
const ACTORS: Array<[pattern: RegExp, key: string, name: string, covers?: string]> = [
  [/^Network Agent\s+/, "network", "Network", "hubs, equipment and route runs"],
  [/^Shipments Agent\s+/, "shipments", "Shipments", "parcels promised today"],
  [/^Last-Mile Agent\s+/, "lastmile", "Last mile", "parcel lockers"],
  [/^Customers Agent\s+/, "customers", "Customers", "shippers and complaints"],
  [/^Lead Analyst\s+/, "analyst", "Lead analyst"],
  [/^UI Composer\s+/, "composer", "UI composer"],
];

/** Who a step came from. Deliberately does not return the rest of the message. */
export function describeStep(message: string): { actor: string; name: string; covers?: string } {
  for (const [pattern, actor, name, covers] of ACTORS) {
    if (pattern.test(message)) return { actor, name, covers };
  }
  return { actor: "system", name: "" };
}

/** Fixed wording the web client itself puts in the activity list when a request or an action fails. */
export const REQUEST_FAILED = "This request could not be completed";
export const ACTION_FAILED = "That action could not be completed";

export const GENERIC_NOTE = "One step left a note for the team";
export const GENERIC_PROBLEM = "One step ran into a problem";
export const CONFLICT_NOTE = "Two sources disagreed on a figure; it's held back";

/** Status lines the runtime is known to write. Wording is name-free: the popover shows who in bold beside it. */
const NOTES: Array<[pattern: RegExp, text: string, failed: boolean]> = [
  [/^Reconciliation:/, CONFLICT_NOTE, false],
  [/^Plan adjusted:/, "Adjusted the plan to what you can see", false],
  [/ used the deterministic specialist\b/, "Used its standard check", false],
  [/ failed$/, "Could not finish", true],
  [/^UI Composer layout was rejected/, "Used the standard layout", false],
  [/^Composer output invalid/, "Kept the last good layout", false],
  [/^Lead Analyst ranking was replaced/, "Ranked with the standard rules", false],
  [/^Lead Analyst could not connect/, "Could not connect the findings; showing them side by side", true],
  [/^Stopped this request/, "Stopped this request", false],
  [/^Restored /, "Reopened an earlier view", false],
  [new RegExp(`^${REQUEST_FAILED}`), REQUEST_FAILED, true],
  [new RegExp(`^${ACTION_FAILED}`), ACTION_FAILED, true],
];

const FAILED = /failed|could not|unavailable|rejected|error/i;

/** A status line the runtime reported, in fixed person-facing wording. Never the raw text. */
export function noteFor(step: Step): { text: string; failed: boolean } {
  for (const [pattern, text, failed] of NOTES) {
    if (pattern.test(step.message)) return { text, failed };
  }
  return FAILED.test(step.message) ? { text: GENERIC_PROBLEM, failed: true } : { text: GENERIC_NOTE, failed: false };
}

/**
 * What is happening right now, as one short line. Never a finding's own words
 * or a status line's raw text: figures belong to the evidence drawer, and
 * internals belong to the developer details.
 */
export function liveLine(step: Step | undefined): string {
  if (!step) return "Starting…";
  const { actor, name, covers } = describeStep(step.message);
  // "Customers agent is checking…" reads as a sentence; "Customers is checking…" does not.
  const who = ["network", "shipments", "lastmile", "customers"].includes(actor) ? `${name} agent` : name;
  if (step.kind === "agent_started") return covers ? `${who} is checking ${covers}` : `${who || "A specialist"} is working`;
  if (step.kind === "finding_discovered") return actor === "analyst" ? "Lead analyst is connecting the findings" : `${who || "A specialist"} found something to report`;
  if (step.kind === "agent_completed") return `${who || "A specialist"} is done`;
  if (step.kind === "investigation_completed") return "Workspace ready";
  if (step.kind === "task_delegated" || step.kind === "tool_queried") return "Working…";
  if (/^UI Composer is designing/.test(step.message)) return "Laying out the workspace";
  if (/^Looking into your question/.test(step.message)) return "Planning who should look into this";
  if (step.kind === "action") return "Working…";
  const note = noteFor(step).text;
  return who ? `${who} ${note.charAt(0).toLowerCase()}${note.slice(1)}` : note;
}

export type Finding = { id: string; actor: string; name: string; text: string; failed: boolean };

/**
 * The run summarised for the pill and its popover: findings only. Started and
 * finished lines and per-finding progress lines are folded into one line per
 * specialist (what it covers and how many findings it reported). Any other
 * status line is kept, in fixed wording.
 */
export function summarise(steps: Step[]): { findings: Finding[]; agents: number; lookups: number | null; seconds: number | null; done: boolean } {
  const found = new Map<string, number>();
  for (const step of steps) if (step.kind === "finding_discovered") {
    const { actor } = describeStep(step.message);
    found.set(actor, (found.get(actor) ?? 0) + 1);
  }
  const agents = new Set<string>();
  const findings: Finding[] = [];
  let lookups: number | null = null;
  let seconds: number | null = null;
  let done = false;
  const started = steps[0] ? Date.parse(steps[0].timestamp) : NaN;
  for (const step of steps) {
    const described = describeStep(step.message);
    if (step.kind === "agent_started") { agents.add(described.actor); continue; }
    if (step.kind === "agent_completed") {
      const count = found.get(described.actor) ?? 0;
      findings.push({ id: step.id, actor: described.actor, name: described.name, text: `${described.covers ? `Checked ${described.covers} · ` : ""}${count ? `${count} finding${count === 1 ? "" : "s"}` : "nothing to report"}`, failed: false });
      continue;
    }
    if (step.kind === "finding_discovered") {
      if (described.actor === "analyst") findings.push({ id: step.id, actor: "analyst", name: described.name, text: "Connected the findings into one picture", failed: false });
      continue;
    }
    if (step.kind === "investigation_completed") {
      done = true;
      const counted = step.message.match(/(\d+) lookups?/);
      if (counted) lookups = Number(counted[1]);
      const ended = Date.parse(step.timestamp);
      if (Number.isFinite(started) && Number.isFinite(ended) && ended >= started) seconds = (ended - started) / 1000;
      continue;
    }
    // Plumbing, not findings.
    if (step.kind === "task_delegated" || step.kind === "tool_queried" || step.kind === "action" || /^UI Composer is designing|^Looking into your question/.test(step.message)) continue;
    // Anything else the run reported (a specialist that could not finish, a reconciliation note) is kept, in fixed wording.
    const note = noteFor(step);
    findings.push({ id: step.id, actor: described.actor, name: described.name, text: note.text, failed: note.failed });
  }
  return { findings, agents: agents.size, lookups, seconds, done };
}
