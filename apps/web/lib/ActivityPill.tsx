"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { liveLine, summarise, type Step } from "./activity-text";

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
