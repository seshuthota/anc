"use client";

import { createContext, useContext, useState } from "react";
import { createCatalog, type CatalogDefinitions } from "@copilotkit/a2ui-renderer";
import { WORKSPACE_CATALOG_ID } from "@anc/contracts/catalog";
import { z } from "zod";

/**
 * Workspace extensions to the standard A2UI basic catalog.
 *
 * The basic catalog (Text, Row, Column, Card, List, Divider, Button, …) is
 * rendered by `@copilotkit/a2ui-renderer` unchanged. It has no data table,
 * chart, or selection that reports back to the agent, so those four are
 * registered here. `@anc/contracts/catalog` lists the same names for the
 * server validator and the UI Composer.
 */

/** A prop that is either a literal or a `{ path }` binding into the surface data model. */
const bound = <T extends z.ZodTypeAny>(literal: T) => z.union([literal, z.object({ path: z.string() })]);

export const workspaceDefinitions = {
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
