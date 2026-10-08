"use client";

import React, { createContext, useContext, useState } from "react";
import { basicCatalog, createCatalog, type CatalogDefinitions } from "@copilotkit/a2ui-renderer";
import { WORKSPACE_CATALOG_ID } from "@anc/contracts/catalog";
import { z } from "zod";

/**
 * The workspace catalog: the standard A2UI basic catalog, drawn in this
 * product's own style, plus a few components the basic catalog lacks.
 *
 * Agents still author plain basic-catalog components (Text, Row, Column, Card,
 * List, Divider, Button). Their props are the standard ones; only how they are
 * drawn is ours, so the page looks like one product rather than a default
 * renderer. Table, Chart, Stat, Sequence, SelectOption, EditField,
 * PrimaryFinding and Collapsible are extensions. `@anc/contracts/catalog` lists the same names for the server
 * validator and the UI Composer.
 */

/** A prop that is either a literal or a `{ path }` binding into the surface data model. */
const bound = <T extends z.ZodTypeAny>(literal: T) => z.union([literal, z.object({ path: z.string() })]);

/** The standard component's own props schema, so a themed renderer accepts exactly what the standard one does. */
const standard = (name: string) => (basicCatalog.components.get(name) as unknown as { schema: z.ZodObject<z.ZodRawShape> }).schema;

type ChildRef = string | { id: string; basePath?: string };
type Build = (id: string, basePath?: string) => React.ReactNode;

/** Draws a resolved child list, whether it was written out or generated from a data list. */
function Children({ list, build }: { list: unknown; build: Build }) {
  if (!Array.isArray(list)) return null;
  return <>{(list as ChildRef[]).map((item, index) => (typeof item === "string"
    ? <React.Fragment key={`${item}-${index}`}>{build(item)}</React.Fragment>
    : <React.Fragment key={`${item.id}-${index}`}>{build(item.id, item.basePath)}</React.Fragment>))}</>;
}

/** Captions that state how far a claim can be trusted are drawn as tags, so the distinction is visible at a glance. */
const TRUST_TAGS: Record<string, string> = {
  "Observed": "observed",
  "Inferred link, not confirmed": "inferred",
  "Hypothesis, not confirmed": "inferred",
  "Open question": "open",
};

const FLEX: Record<string, string> = { start: "flex-start", center: "center", end: "flex-end", stretch: "stretch", spaceBetween: "space-between", spaceAround: "space-around", spaceEvenly: "space-evenly" };

export const workspaceDefinitions = {
  Text: { props: standard("Text") },
  Column: { props: standard("Column") },
  Row: { props: standard("Row") },
  List: { props: standard("List") },
  Card: { props: standard("Card") },
  Divider: { props: standard("Divider") },
  Button: { props: standard("Button") },
  Stat: {
    description: "One key figure as a tile: a short label, the value, and an optional note.",
    props: z.object({
      label: bound(z.string()),
      value: bound(z.string()),
      tone: z.enum(["neutral", "alert", "good"]).optional(),
      note: bound(z.string()).optional(),
    }),
  },
  Sequence: {
    description: "Draws its children as numbered stops on one connected line. For things that are genuinely in order.",
    props: z.object({ children: z.array(z.string()) }),
  },
  Table: {
    description: "A sortable data table. Bind columns to a string array and rows to an array of {id, cells[]} records.",
    props: z.object({
      columns: bound(z.array(z.string())),
      rows: bound(z.array(z.any())),
      totals: bound(z.array(z.string())).optional(),
      defaultSort: z.number().optional(),
      completeness: z.enum(["complete", "partial", "empty"]).optional(),
      rowActionLabel: z.string().optional(),
    }),
  },
  Chart: {
    description: "A line chart of one metric over time. Bind points to an array of {label, value}.",
    props: z.object({
      title: bound(z.string()),
      unit: z.string().optional(),
      points: bound(z.array(z.any())),
      caption: bound(z.string()).optional(),
    }),
  },
  SelectOption: {
    description: "A checkbox that belongs to a selection group and reports the group's selection to the agent.",
    props: z.object({
      groupId: z.string(),
      optionId: z.string(),
      text: bound(z.string()),
      selected: bound(z.array(z.string())).optional(),
      actionName: z.string().optional(),
    }),
  },
  PrimaryFinding: {
    description: "The briefing's one primary finding, built by the runtime: headline, one figure with its definition, window, denominator and evidence, why it matters, a cause chain of at most three hops, and confidence.",
    props: z.object({ finding: bound(z.any()) }),
  },
  ContextHeader: {
    description: "Built by the runtime above a drill-down: where it came from in the briefing, and Back to that briefing.",
    props: z.object({ context: bound(z.any()) }),
  },
  Collapsible: {
    description: "A disclosure that starts closed and opens in the browser only. For lower-priority material.",
    props: z.object({ summary: bound(z.string()), child: z.string() }),
  },
  EditField: {
    description: "An editable text field. The edit stays in the browser until a save action sends it.",
    props: z.object({
      fieldId: z.string(),
      label: bound(z.string()).optional(),
      value: bound(z.string()),
    }),
  },
} satisfies CatalogDefinitions;

/**
 * Interaction state the agent does not own. Kept outside the surface so a save
 * action can send what the person typed or ticked.
 */
export type ClientState = { fields: Record<string, string>; selections: Record<string, string[]> };
export const ClientStateContext = createContext<{ state: { current: ClientState }; touch: () => void }>({
  state: { current: { fields: {}, selections: {} } },
  touch: () => undefined,
});

/** The data the runtime binds to a PrimaryFinding (see PresentationBriefingPrimarySchema). */
type PrimaryFindingData = {
  headline?: string;
  whyItMatters?: string;
  confidenceLabel?: string;
  evidenceIds?: string[];
  metric?: { metricId: string; value: string; label: string; definition: string; windowLabel: string; denominatorLabel?: string; evidenceIds: string[]; resultPath: string };
  chain?: Array<{ text: string; kind: "observed" | "inferred"; kindLabel?: string; evidenceIds?: string[] }>;
  /** Operations confirmed from this card, written by the runtime after the write and a re-read. */
  receipts?: Array<{ operationId: string; actionId: string; status: "succeeded" | "failed"; text: string; evidenceIds?: string[] }>;
};

type Row = { id?: string; cells?: unknown[]; sortValues?: unknown[]; actionName?: string; entityType?: string; entityId?: string };

/** Sorts by the numeric hint when one was supplied, so currency orders by magnitude rather than as text. */
function sortRows(rows: Row[], column: number, direction: 1 | -1): Row[] {
  return [...rows].sort((left, right) => {
    const a = left.sortValues?.[column];
    const b = right.sortValues?.[column];
    if (typeof a === "number" && typeof b === "number") return (a - b) * direction;
    return String(left.cells?.[column] ?? "").localeCompare(String(right.cells?.[column] ?? ""), undefined, { numeric: true }) * direction;
  });
}

export const workspaceCatalog = createCatalog(workspaceDefinitions, {
  Text: ({ props }) => {
    const text = String((props as { text?: unknown }).text ?? "");
    const variant = String((props as { variant?: unknown }).variant ?? "body");
    if (variant === "caption") {
      const tag = TRUST_TAGS[text];
      return tag ? <span className={`ws-tag ws-tag-${tag}`}>{text}</span> : <small className="ws-caption">{text}</small>;
    }
    if (/^h[1-5]$/.test(variant)) {
      const Heading = variant as "h1" | "h2" | "h3" | "h4" | "h5";
      return <Heading className={`ws-${variant}`}>{text}</Heading>;
    }
    return <p className="ws-body">{text}</p>;
  },
  Column: ({ props, children }) => {
    const view = props as { children?: unknown; align?: string; justify?: string };
    return <div className="ws-column" style={{ alignItems: FLEX[view.align ?? "stretch"], justifyContent: FLEX[view.justify ?? "start"] }}><Children list={view.children} build={children as Build} /></div>;
  },
  Row: ({ props, children }) => {
    const view = props as { children?: unknown; align?: string; justify?: string };
    return <div className="ws-row" style={{ alignItems: FLEX[view.align ?? "stretch"], justifyContent: FLEX[view.justify ?? "start"] }}><Children list={view.children} build={children as Build} /></div>;
  },
  List: ({ props, children }) => {
    const view = props as { children?: unknown; direction?: string };
    return <div className={view.direction === "horizontal" ? "ws-row" : "ws-column"}><Children list={view.children} build={children as Build} /></div>;
  },
  Card: ({ props, children }) => {
    const child = (props as { child?: string }).child;
    return <article className="ws-card">{child ? children(child) : null}</article>;
  },
  Divider: ({ props }) => <hr className={(props as { axis?: string }).axis === "vertical" ? "ws-divider ws-divider-vertical" : "ws-divider"} />,
  Button: ({ props, children }) => {
    const view = props as { child?: string; variant?: string; action?: () => void; isValid?: boolean };
    return (
      <button type="button" className={`ws-button ws-button-${view.variant ?? "default"}`} onClick={view.action} disabled={view.isValid === false}>
        {view.child ? children(view.child) : null}
      </button>
    );
  },
  Stat: ({ props }) => (
    <div className={`ws-stat ws-stat-${props.tone ?? "neutral"}`}>
      <span className="ws-stat-label">{typeof props.label === "string" ? props.label : ""}</span>
      <strong className="ws-stat-value">{typeof props.value === "string" ? props.value : String(props.value ?? "")}</strong>
      {typeof props.note === "string" && props.note ? <span className="ws-stat-note">{props.note}</span> : null}
    </div>
  ),
  Sequence: ({ props, children }) => (
    <ol className="ws-sequence">
      {props.children.map((id, index) => <li className="ws-stop" key={`${id}-${index}`}>{children(id)}</li>)}
    </ol>
  ),
  Table: ({ props, dispatch }) => {
    const headers = Array.isArray(props.columns) ? props.columns.map(String) : [];
    const rows = (Array.isArray(props.rows) ? props.rows : []) as Row[];
    const totals = Array.isArray(props.totals) ? props.totals : [];
    const [sort, setSort] = useState<{ column: number; direction: 1 | -1 }>({ column: props.defaultSort ?? 0, direction: 1 });
    const ordered = sortRows(rows, sort.column, sort.direction);
    const hasActions = ordered.some((row) => row.actionName);
    const cellCount = Math.max(...ordered.map((row) => row.cells?.length ?? 0), headers.length, 0);
    if (!headers.length && !rows.length) return null;
    return (
      <div className="a2ui-table-wrap">
        <table className="a2ui-table">
          <thead>
            <tr>
              {headers.map((header, index) => (
                <th key={index} scope="col" aria-sort={sort.column === index ? (sort.direction === 1 ? "ascending" : "descending") : "none"}>
                  <button type="button" className="a2ui-sort" onClick={() => setSort({ column: index, direction: sort.column === index && sort.direction === 1 ? -1 : 1 })}>
                    {header}
                    <span aria-hidden="true">{sort.column === index ? (sort.direction === 1 ? " ▲" : " ▼") : ""}</span>
                  </button>
                </th>
              ))}
              {hasActions ? <th scope="col"><span className="visually-hidden">Actions</span></th> : null}
            </tr>
          </thead>
          <tbody>
            {ordered.map((row, index) => (
              <tr key={String(row.id ?? index)}>
                {Array.from({ length: cellCount }, (_, cell) => <td key={cell}>{String(row.cells?.[cell] ?? "")}</td>)}
                {row.actionName ? (
                  <td>
                    <button
                      type="button"
                      className="evidence-link"
                      onClick={() => dispatch?.({ event: { name: row.actionName, context: { entityType: row.entityType, entityId: row.entityId ?? row.id, rowId: row.id } } })}
                    >
                      {props.rowActionLabel ?? "Open"}
                    </button>
                  </td>
                ) : hasActions ? <td /> : null}
              </tr>
            ))}
          </tbody>
          {totals.length ? (
            <tfoot>
              <tr>
                {totals.map((cell, index) => <td key={index}>{index === 0 ? "" : String(cell)}</td>)}
                {hasActions ? <td /> : null}
              </tr>
            </tfoot>
          ) : null}
        </table>
        {props.completeness === "partial" ? <p className="a2ui-table-note">Partial result. This table does not contain every matching record.</p> : null}
      </div>
    );
  },
  Chart: ({ props }) => {
    const points = (Array.isArray(props.points) ? props.points : []) as Array<{ label: string; value: number }>;
    if (points.length < 2) return null;
    const title = typeof props.title === "string" ? props.title : "";
    const unit = props.unit ?? "";
    const width = 640;
    const height = 180;
    const padding = 24;
    const values = points.map((point) => point.value);
    const max = Math.max(...values);
    const min = Math.min(...values);
    const span = max - min || 1;
    const stepX = (width - padding * 2) / (points.length - 1);
    const toY = (value: number) => height - padding - ((value - min) / span) * (height - padding * 2);
    const zeroLine = min < 0 && max > 0 ? toY(0) : undefined;
    return (
      <figure className="a2ui-chart">
        <figcaption>{title}{unit ? ` (${unit})` : ""}</figcaption>
        <svg viewBox={`0 0 ${width} ${height}`} role="img" aria-label={title || "trend"} preserveAspectRatio="none">
          {zeroLine !== undefined ? <line className="a2ui-chart-zero" x1={padding} x2={width - padding} y1={zeroLine} y2={zeroLine} /> : null}
          <polyline className="a2ui-chart-line" points={points.map((point, index) => `${padding + index * stepX},${toY(point.value)}`).join(" ")} fill="none" />
          {points.map((point, index) => (
            <circle key={index} className="a2ui-chart-point" cx={padding + index * stepX} cy={toY(point.value)} r={3}>
              <title>{`${point.label}: ${point.value}${unit ? ` ${unit}` : ""}`}</title>
            </circle>
          ))}
        </svg>
        <div className="a2ui-chart-axis">
          <span>{points[0]?.label}</span>
          <span>{points[points.length - 1]?.label}</span>
        </div>
        {typeof props.caption === "string" && props.caption ? <p className="a2ui-chart-caption">{props.caption}</p> : null}
      </figure>
    );
  },
  SelectOption: ({ props, dispatch }) => {
    const client = useContext(ClientStateContext);
    const fallback = Array.isArray(props.selected) ? props.selected.map(String) : [];
    const [, rerender] = useState(0);
    const selected = client.state.current.selections[props.groupId] ?? fallback;
    const checked = selected.includes(props.optionId);
    return (
      <label className="a2ui-check">
        <input
          type="checkbox"
          checked={checked}
          onChange={() => {
            const next = checked ? selected.filter((item) => item !== props.optionId) : [...selected, props.optionId];
            client.state.current.selections[props.groupId] = next;
            rerender((count) => count + 1);
            client.touch();
            dispatch?.({ event: { name: props.actionName ?? "set_selection", context: { selectionId: props.groupId, optionId: props.optionId, selected: next } } });
          }}
        />
        <span>{typeof props.text === "string" ? props.text : ""}</span>
      </label>
    );
  },
  PrimaryFinding: ({ props, dispatch }) => {
    const finding = (props.finding && typeof props.finding === "object" ? props.finding : {}) as PrimaryFindingData;
    const metric = finding.metric;
    const evidence = (ids: string[] | undefined, extra: Record<string, unknown> = {}) => {
      if (!ids?.length) return;
      dispatch?.({ event: { name: "show_evidence", context: { evidenceIds: ids, ...extra } } });
    };
    const evidenceCount = finding.evidenceIds?.length ?? 0;
    return (
      <section className="ws-primary" data-a2ui="PrimaryFinding" aria-label="Primary finding">
        <h2 className="ws-h2 ws-primary-headline">{finding.headline ?? ""}</h2>
        {metric ? (
          <div className="ws-primary-figure">
            <button
              type="button"
              className="ws-primary-value"
              data-metric-id={metric.metricId}
              aria-label={`${metric.value} ${metric.label}: open its evidence`}
              onClick={() => evidence(metric.evidenceIds, { metricId: metric.metricId, resultPath: metric.resultPath })}
            >
              {metric.value}
            </button>
            <div className="ws-primary-definition">
              <strong>{metric.label}</strong>
              <span>{metric.definition} · {metric.windowLabel}{metric.denominatorLabel ? ` · ${metric.denominatorLabel}` : ""}</span>
            </div>
          </div>
        ) : null}
        {finding.whyItMatters ? <p className="ws-body ws-primary-why"><strong>Why it matters: </strong>{finding.whyItMatters}</p> : null}
        {finding.chain?.length ? (
          <ol className="ws-primary-chain" aria-label="Cause and effect">
            {finding.chain.map((hop, index) => (
              <li key={index} className={`ws-hop ws-hop-${hop.kind}`}>
                <span>{hop.text}</span>
                <span className={`ws-tag ws-tag-${hop.kind === "observed" ? "observed" : "inferred"}`}>{hop.kindLabel ?? (hop.kind === "observed" ? "Observed" : "Inferred link, not confirmed")}</span>
              </li>
            ))}
          </ol>
        ) : null}
        {finding.receipts?.length ? (
          <ul className="ws-primary-receipts" aria-label="Done from this briefing">
            {finding.receipts.map((receipt) => (
              <li key={receipt.operationId + receipt.text} className={`ws-receipt ws-receipt-${receipt.status}`} data-testid="action-receipt" data-action-id={receipt.actionId}>
                <span aria-hidden="true">{receipt.status === "succeeded" ? "✓" : "!"}</span>
                <span>{receipt.text}</span>
                {receipt.evidenceIds?.length ? (
                  <button type="button" className="ws-button ws-button-borderless" onClick={() => evidence(receipt.evidenceIds)}>Record</button>
                ) : null}
              </li>
            ))}
          </ul>
        ) : null}
        <div className="ws-primary-foot">
          <span className="ws-caption">{finding.confidenceLabel ?? ""}</span>
          {evidenceCount ? (
            <button type="button" className="ws-button ws-button-borderless" onClick={() => evidence(finding.evidenceIds, metric ? { metricId: metric.metricId, resultPath: metric.resultPath } : {})}>
              Evidence ({evidenceCount})
            </button>
          ) : null}
        </div>
      </section>
    );
  },
  ContextHeader: ({ props, dispatch }) => {
    const context = (props.context && typeof props.context === "object" ? props.context : {}) as { label?: string; surfaceId?: string; revision?: number };
    return (
      <nav className="ws-context" data-a2ui="ContextHeader" aria-label="Where this came from">
        <span className="ws-context-label">From your briefing: <strong>{context.label ?? ""}</strong></span>
        <button
          type="button"
          className="ws-button ws-button-borderless ws-context-back"
          onClick={() => dispatch?.({ event: { name: "back_to_briefing", context: { surfaceId: context.surfaceId, revision: context.revision } } })}
        >
          ▸ Back
        </button>
      </nav>
    );
  },
  Collapsible: ({ props, children }) => (
    <details className="ws-collapsible" data-a2ui="Collapsible">
      <summary>{typeof props.summary === "string" ? props.summary : ""}</summary>
      <div className="ws-collapsible-body">{props.child ? (children as Build)(props.child) : null}</div>
    </details>
  ),
  EditField: ({ props }) => {
    const client = useContext(ClientStateContext);
    const generated = typeof props.value === "string" ? props.value : "";
    const label = typeof props.label === "string" ? props.label : "";
    const key = props.fieldId;
    const [value, setValue] = useState(client.state.current.fields[key] ?? generated);
    return (
      <span className="a2ui-field">
        {label ? <span className="a2ui-field-label">{label}</span> : null}
        <input
          className="a2ui-input"
          type="text"
          aria-label={label || "Editable text"}
          value={value}
          onChange={(event) => {
            setValue(event.target.value);
            client.state.current.fields[key] = event.target.value;
          }}
        />
        {value !== generated ? <small className="a2ui-field-edited">edited</small> : null}
      </span>
    );
  },
}, { catalogId: WORKSPACE_CATALOG_ID, includeBasicCatalog: true });
