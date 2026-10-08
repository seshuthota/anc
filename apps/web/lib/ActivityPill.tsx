"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { PublicState } from "./agent";

type Step = PublicState["activity"][number];

/** Who did a step, read from how the runtime words its activity. */
const ACTORS: Array<[pattern: RegExp, key: string, name: string, covers?: string]> = [
  [/^Network Agent\s+/, "network", "Network", "hubs, equipment and route runs"],
  [/^Shipments Agent\s+/, "shipments", "Shipments", "parcels promised today"],
  [/^Last-Mile Agent\s+/, "lastmile", "Last mile", "parcel lockers"],
  [/^Customers Agent\s+/, "customers", "Customers", "shippers and complaints"],
  [/^Lead Analyst\s+/, "analyst", "Lead analyst"],
  [/^UI Composer\s+/, "composer", "UI composer"],
];

export function describeStep(message: string): { actor: string; name: string; covers?: string; text: string } {
  for (const [pattern, actor, name, covers] of ACTORS) {
    if (pattern.test(message)) {
      const rest = message.replace(pattern, "").replace(/^finding:\s*/, "").replace(/^connected the findings:\s*/, "");
      return { actor, name, covers, text: rest.charAt(0).toUpperCase() + rest.slice(1) };
    }
  }
  return { actor: "system", name: "", text: message };
}

const FAILED = /failed|could not|unavailable|rejected/i;

/**
 * What is happening right now, as one short line. Never a finding's own words:
 * those carry figures that belong to the evidence drawer, not a progress line.
 */
export function liveLine(step: Step | undefined): string {
  if (!step) return "Starting…";
  const { actor, name, covers } = describeStep(step.message);
  // "Customers agent is checking…" reads as a sentence; "Customers is checking…" does not.
  const who = ["network", "shipments", "lastmile", "customers"].includes(actor) ? `${name} agent` : name;
  if (step.kind === "agent_started") return covers ? `${who} is checking ${covers}` : `${who} is working`;
  if (step.kind === "finding_discovered") return actor === "analyst" ? "Lead analyst is connecting the findings" : `${who} found something to report`;
  if (step.kind === "agent_completed") return `${who} is done`;
  if (step.kind === "investigation_completed") return "Workspace ready";
  if (/^UI Composer is designing/.test(step.message)) return "Laying out the workspace";
  if (/^Looking into your question/.test(step.message)) return "Planning who should look into this";
  return step.message;
}

export type Finding = { id: string; actor: string; name: string; text: string; failed: boolean };

/**
 * The run summarised for the pill and its popover: findings only. Started and
 * finished lines and per-finding progress lines are folded into one line per
 * specialist (what it covers and how many findings it reported).
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
    if (step.kind === "task_delegated" || step.kind === "tool_queried" || /^UI Composer is designing|^Looking into your question/.test(step.message)) continue;
    // Anything else the run reported (a specialist that could not finish, a reconciliation note) is kept.
    findings.push({ id: step.id, actor: described.actor, name: described.name, text: described.text, failed: FAILED.test(step.message) });
  }
  return { findings, agents: agents.size, lookups, seconds, done };
}

/**
 * The only trace of how an answer was worked out: one compact pill. While a run
 * is in progress it shows a single animated line of what is happening now;
 * afterwards "4 agents · 9 lookups · 2.1s ▸", which opens the findings.
 */
export function ActivityPill({ steps, working, status }: { steps: Step[]; working: boolean; status: string }) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const summary = useMemo(() => summarise(steps), [steps]);
  const latest = steps[steps.length - 1];
  const line = liveLine(latest);

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") setOpen(false); };
    const onPointer = (event: PointerEvent) => { if (root.current && !root.current.contains(event.target as Node)) setOpen(false); };
    window.addEventListener("keydown", onKey);
    window.addEventListener("pointerdown", onPointer);
    return () => { window.removeEventListener("keydown", onKey); window.removeEventListener("pointerdown", onPointer); };
  }, [open]);
  useEffect(() => { if (working) setOpen(false); }, [working]);

  const parts = [
    summary.agents ? `${summary.agents} agent${summary.agents === 1 ? "" : "s"}` : null,
    summary.lookups !== null ? `${summary.lookups} lookup${summary.lookups === 1 ? "" : "s"}` : null,
    summary.seconds !== null ? `${summary.seconds.toFixed(1)}s` : null,
  ].filter(Boolean);
  const outcome = status === "failed" ? "Could not finish" : status === "cancelled" ? "Stopped" : null;
  const idleLabel = [outcome, ...parts].filter(Boolean).join(" · ") || "Ready";
  const tone = working ? "running" : status === "failed" ? "failed" : status === "cancelled" ? "stopped" : "ready";

  return (
    <div className="activity" ref={root}>
      <button
        type="button"
        className={`activity-pill is-${tone}`}
        data-testid="activity-pill"
        aria-expanded={open}
        aria-haspopup="dialog"
        aria-label={working ? `Working: ${line}` : `How this was worked out: ${idleLabel}`}
        disabled={working}
        onClick={() => setOpen((value) => !value)}
      >
        <span className="activity-dot" aria-hidden="true" />
        {working ? (
          <span className="activity-live" aria-live="polite" data-testid="activity-live">
            <span key={line} className="activity-live-line">{line}</span>
          </span>
        ) : (
          <span className="activity-summary">{idleLabel}</span>
        )}
        {!working && summary.findings.length ? <span className="activity-chevron" aria-hidden="true">▸</span> : null}
      </button>
      {open ? (
        <div className="activity-popover" role="dialog" aria-label="How this was worked out" data-testid="activity-popover">
          <header>
            <strong>How this was worked out</strong>
            <span>{idleLabel}</span>
          </header>
          <ul>
            {summary.findings.map((item) => (
              <li key={item.id} className={`activity-finding actor-${item.actor}${item.failed ? " is-failed" : ""}`}>
                <span className="activity-finding-mark" aria-hidden="true" />
                <span>
                  {item.name ? <b>{item.name}</b> : null}
                  <span>{item.text}</span>
                </span>
              </li>
            ))}
            {summary.done ? <li className="activity-finding actor-system is-done"><span className="activity-finding-mark" aria-hidden="true" /><span><span>Workspace ready</span></span></li> : null}
          </ul>
        </div>
      ) : null}
    </div>
  );
}
