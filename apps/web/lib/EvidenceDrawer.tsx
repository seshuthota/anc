"use client";

import { useState } from "react";
import { describeFilters, fieldLabel, formatIstTime, formatValue, isInternalField, scopeLabel, sourceLabel, sourceTitle, toolLabel } from "./evidence-format";

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
  excerpt: { columns: string[]; rows: unknown[][]; highlight: { row: number; column: string } | null; from: string; total: number; cited?: { count: number; label: string; noun: string } };
  labels?: Record<string, string>;
  raw: Record<string, unknown>;
};

export type EvidenceItem = { evidenceId: string; explanation?: EvidenceExplanation; raw?: Record<string, unknown>; error?: string };
export type EvidenceDrawerState = { items: EvidenceItem[]; metricId?: string; resultPath?: string };

const show = (value: unknown) => (typeof value === "number" ? value.toLocaleString("en-IN") : value === null || value === undefined ? "—" : String(value));

/**
 * The evidence drawer is a host component, not part of the A2UI surface: the
 * model never authors it, opening it does not change the surface revision, and
 * every record in it has passed the runtime's grant check and redaction.
 */
export function EvidenceDrawer({ state, onClose, developer = false }: { state: EvidenceDrawerState; onClose: () => void; developer?: boolean }) {
  // Open on the record that holds the figure that was clicked, if there is one.
  const focused = Math.max(0, state.items.findIndex((item) => item.explanation?.path && item.explanation.value !== null));
  const [active, setActive] = useState(focused);
  const item = state.items[active] ?? state.items[0];
  return (
    <div className="drawer" role="dialog" aria-modal="true" aria-label="Supporting evidence">
      <div className="drawer-scrim" aria-hidden="true" onClick={onClose} />
      <div className="drawer-card" data-testid="evidence-drawer">
        <div className="drawer-heading">
          <div>
            <span className="drawer-kicker">Evidence</span>
            <h2>Where this came from</h2>
            <p className="muted">{state.items.length === 1 ? "1 record" : `${state.items.length} records`} from company tools · read-only</p>
          </div>
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
                {sourceTitle(entry.explanation?.tool ?? String(entry.raw?.tool ?? ""))}
              </button>
            ))}
          </div>
        ) : null}
        {item ? <EvidencePanel item={item} developer={developer} /> : null}
      </div>
    </div>
  );
}

function EvidencePanel({ item, developer }: { item: EvidenceItem; developer: boolean }) {
  if (item.error) return <p className="ev-error" role="alert">{item.error}</p>;
  const explained = item.explanation;
  if (!explained) {
    return (
      <div role="tabpanel">
        {developer ? (
          <>
            <p className="muted">{item.evidenceId}</p>
            <pre>{JSON.stringify(item.raw ?? {}, null, 2)}</pre>
          </>
        ) : <p className="muted">This record has no summary to show.</p>}
      </div>
    );
  }
  const { excerpt } = explained;
  const labels = explained.labels ?? {};
  const filters = describeFilters(explained.filters ?? {}, labels, developer);
  const cited = excerpt.cited && !excerpt.highlight ? excerpt.cited : undefined;
  const plural = (n: number, noun: string) => `${n.toLocaleString("en-IN")} ${noun}${n === 1 ? "" : "s"}`;
  const context = { groupBy: explained.filters?.groupBy };
  // A list of fields beside a total ("field", "value"): label each field. A table of rows: label the columns and hide internal keys.
  const fieldList = excerpt.columns.length === 2 && excerpt.columns[0] === "field";
  // An id column whose every value has a name is shown as that name ("Hub": "Hyderabad Hub"), unless a name column is already there.
  const nameAt = excerpt.columns.indexOf("name");
  const named = (column: string, index: number) => /.Id$/.test(column) && !excerpt.columns.includes(`${column.slice(0, -2)}Name`)
    && excerpt.rows.every((row) => row[index] === null || (typeof row[index] === "string" && Boolean(labels[row[index] as string])))
    // A row that is the hub itself ({ hubId, name }) already shows its name.
    && !(nameAt >= 0 && excerpt.rows.every((row) => row[index] === null || labels[row[index] as string] === row[nameAt]));
  const visible = excerpt.columns.map((column, index) => ({ column, index })).filter(({ column, index }) => fieldList || developer || !isInternalField(column) || named(column, index) || excerpt.highlight?.column === column);
  const heading = (column: string, index: number) => (!developer && named(column, index) ? fieldLabel(column.slice(0, -2), context) : fieldLabel(column, context));
  return (
    <div role="tabpanel" className="ev-panel">
      {explained.definition ? (
        <header className="ev-definition">
          <p className="ev-label">{explained.definition.label}</p>
          <p className="ev-value" data-path={explained.path ?? ""}><mark>{show(explained.value)}</mark></p>
          <p className="ev-text">{explained.definition.text}</p>
          <p className="muted">
            {[explained.window?.label, explained.denominator ? `of ${show(explained.denominator.value)} ${explained.denominator.label.toLowerCase()}${explained.denominator.share !== null ? ` (${(explained.denominator.share * 100).toFixed(1)}%)` : ""}` : null, scopeLabel(explained.definition.scope, labels, developer)]
              .filter(Boolean).join(" · ")}
          </p>
        </header>
      ) : null}
      <dl className="ev-meta">
        <div><dt>From</dt><dd>{sourceLabel(explained.tool)}</dd></div>
        {developer ? <div><dt>Company tool</dt><dd><code>{explained.tool}</code> ({toolLabel(explained.tool)})</dd></div> : null}
        <div><dt>Data as of</dt><dd>{formatIstTime(explained.dataAsOf)}</dd></div>
        {developer && explained.path ? <div><dt>Read from</dt><dd><code>{explained.path}</code></dd></div> : null}
        {filters.length ? <div><dt>Looked at</dt><dd>{filters.join(" · ")}</dd></div> : null}
      </dl>
      {excerpt.rows.length ? (
        <div className="ev-excerpt">
          <p className="muted">
            {fieldList
              ? "The figures in this record"
              : cited
                ? `${plural(cited.count, `${cited.label} ${cited.noun}`)} first${excerpt.rows.length > cited.count ? `, then ${excerpt.rows.length - cited.count} of the other ${(excerpt.total - cited.count).toLocaleString("en-IN")}` : ""}`
                : `Showing ${excerpt.rows.length} of ${excerpt.total.toLocaleString("en-IN")} ${excerpt.total === 1 ? "row" : "rows"}`}
            {developer ? <> · from <code>{excerpt.from}</code></> : null}
          </p>
          <table>
            <thead><tr>{visible.map(({ column, index }) => <th key={column}>{fieldList ? (column === "field" ? "Figure" : "Value") : heading(column, index)}</th>)}</tr></thead>
            <tbody>
              {excerpt.rows.map((row, rowIndex) => (
                <tr key={rowIndex} className={excerpt.highlight?.row === rowIndex ? "is-highlighted" : cited && rowIndex < cited.count ? "is-cited" : undefined}>
                  {visible.map(({ column, index }) => {
                    const value = row[index];
                    const hit = excerpt.highlight?.row === rowIndex && column === excerpt.highlight.column;
                    const field = fieldList ? String(row[0]) : column;
                    const text = fieldList && column === "field" ? fieldLabel(String(value), context) : formatValue(value, field, labels);
                    return <td key={column} className={hit ? "ev-hit" : undefined} data-path={hit ? explained.path ?? undefined : undefined}>{text}</td>;
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
      {developer ? (
        <details className="ev-raw">
          <summary>Raw record</summary>
          <pre>{JSON.stringify(explained.raw, null, 2)}</pre>
        </details>
      ) : null}
    </div>
  );
}
