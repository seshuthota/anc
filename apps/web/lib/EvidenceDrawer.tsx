"use client";

import { useState } from "react";

/** What `GET /runtime/evidence/:id/explain` returns (see apps/agent/src/evidence-explain.ts). */
export type EvidenceExplanation = {
  evidenceId: string;
  tool: string;
  path: string | null;
  metricId: string | null;
  definition: { label: string; text: string; unit: string; scope: { type: string; id?: string } | null } | null;
  window: { id: string; label: string } | null;
  denominator: { metricId: string; label: string; value: number; share: number | null } | null;
  value: unknown;
  filters: Record<string, unknown>;
  dataAsOf: string | null;
  excerpt: { columns: string[]; rows: unknown[][]; highlight: { row: number; column: string } | null; from: string; total: number };
  raw: Record<string, unknown>;
};

export type EvidenceItem = { evidenceId: string; explanation?: EvidenceExplanation; raw?: Record<string, unknown>; error?: string };
export type EvidenceDrawerState = { items: EvidenceItem[]; metricId?: string; resultPath?: string };

const toolLabel = (tool: string) => tool.replaceAll("_", " ");
const show = (value: unknown) => (typeof value === "number" ? value.toLocaleString("en-IN") : value === null || value === undefined ? "—" : String(value));

/**
 * The evidence drawer is a host component, not part of the A2UI surface: the
 * model never authors it, opening it does not change the surface revision, and
 * every record in it has passed the runtime's grant check and redaction.
 */
export function EvidenceDrawer({ state, onClose }: { state: EvidenceDrawerState; onClose: () => void }) {
  // Open on the record that holds the figure that was clicked, if there is one.
  const focused = Math.max(0, state.items.findIndex((item) => item.explanation?.path && item.explanation.value !== null));
  const [active, setActive] = useState(focused);
  const item = state.items[active] ?? state.items[0];
  return (
    <div className="drawer" role="dialog" aria-modal="true" aria-label="Supporting evidence">
      <div className="drawer-card" data-testid="evidence-drawer">
        <div className="workspace-heading">
          <div><h2>Where this came from</h2><p className="muted">{state.items.length === 1 ? "1 record" : `${state.items.length} records`} from company tools</p></div>
          <button className="ghost" type="button" autoFocus onClick={onClose}>Close</button>
        </div>
        {state.items.length > 1 ? (
          <div className="ev-tabs" role="tablist" aria-label="Evidence records">
            {state.items.map((entry, index) => (
              <button
                key={entry.evidenceId}
                type="button"
                role="tab"
                aria-selected={index === active}
                className={index === active ? "ev-tab is-active" : "ev-tab"}
                onClick={() => setActive(index)}
              >
                {toolLabel(entry.explanation?.tool ?? String(entry.raw?.tool ?? entry.evidenceId))}
              </button>
            ))}
          </div>
        ) : null}
        {item ? <EvidencePanel item={item} /> : null}
      </div>
    </div>
  );
}

function EvidencePanel({ item }: { item: EvidenceItem }) {
  if (item.error) return <p className="ev-error" role="alert">{item.error}</p>;
  const explained = item.explanation;
  if (!explained) {
    return (
      <div role="tabpanel">
        <p className="muted">{item.evidenceId}</p>
        <pre>{JSON.stringify(item.raw ?? {}, null, 2)}</pre>
      </div>
    );
  }
  const { excerpt } = explained;
  const filters = Object.entries(explained.filters ?? {});
  return (
    <div role="tabpanel" className="ev-panel">
      {explained.definition ? (
        <header className="ev-definition">
          <p className="ev-label">{explained.definition.label}</p>
          <p className="ev-value" data-path={explained.path ?? ""}><mark>{show(explained.value)}</mark></p>
          <p className="ev-text">{explained.definition.text}</p>
          <p className="muted">
            {[explained.window?.label, explained.denominator ? `of ${show(explained.denominator.value)} ${explained.denominator.label.toLowerCase()}${explained.denominator.share !== null ? ` (${(explained.denominator.share * 100).toFixed(1)}%)` : ""}` : null, explained.definition.scope?.id ? `${explained.definition.scope.type}: ${explained.definition.scope.id}` : explained.definition.scope?.type]
              .filter(Boolean).join(" · ")}
          </p>
        </header>
      ) : null}
      <dl className="ev-meta">
        <div><dt>Company tool</dt><dd>{toolLabel(explained.tool)}</dd></div>
        <div><dt>Data as of</dt><dd>{explained.dataAsOf ?? "—"}</dd></div>
        {explained.path ? <div><dt>Read from</dt><dd><code>{explained.path}</code></dd></div> : null}
        <div><dt>Filters</dt><dd>{filters.length ? filters.map(([key, value]) => `${key}: ${typeof value === "object" ? JSON.stringify(value) : String(value)}`).join(", ") : "none"}</dd></div>
      </dl>
      {excerpt.rows.length ? (
        <div className="ev-excerpt">
          <p className="muted">From <code>{excerpt.from}</code> · showing {excerpt.rows.length} of {excerpt.total}</p>
          <table>
            <thead><tr>{excerpt.columns.map((column) => <th key={column}>{column}</th>)}</tr></thead>
            <tbody>
              {excerpt.rows.map((row, rowIndex) => (
                <tr key={rowIndex} className={excerpt.highlight?.row === rowIndex ? "is-highlighted" : undefined}>
                  {row.map((value, columnIndex) => {
                    const hit = excerpt.highlight?.row === rowIndex && excerpt.columns[columnIndex] === excerpt.highlight.column;
                    return <td key={columnIndex} className={hit ? "ev-hit" : undefined} data-path={hit ? explained.path ?? undefined : undefined}>{show(value)}</td>;
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
      <details className="ev-raw">
        <summary>Raw record</summary>
        <pre>{JSON.stringify(explained.raw, null, 2)}</pre>
      </details>
    </div>
  );
}
