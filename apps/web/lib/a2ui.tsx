"use client";

import { useState, type CSSProperties, type ReactNode } from "react";
import { isA2UIComponentType } from "@anc/contracts/catalog";

export type A2UIMessage = {
  version?: string;
  createSurface?: { surfaceId: string; catalogId: string };
  updateComponents?: { surfaceId: string; components: Array<Record<string, unknown>> };
  updateDataModel?: { surfaceId: string; path?: string; value?: unknown };
  deleteSurface?: { surfaceId: string };
};

export type WorkspaceAction = {
  name: string;
  surfaceId: string;
  sourceComponentId: string;
  context: Record<string, unknown>;
};

type ActionHandler = (action: WorkspaceAction) => void;

/**
 * Interaction state the model does not own. Kept here so a regenerated surface
 * cannot silently discard what the user typed, sorted, or selected.
 */
type UiState = {
  sorts: Record<string, { column: number; direction: 1 | -1 }>;
  fields: Record<string, string>;
  selections: Record<string, string[]>;
};

type SortPointer = { path?: string };
type Row = { id?: string; cells?: unknown[]; sortValues?: unknown[]; actionName?: string; entityType?: string; entityId?: string };

function readPointer(model: unknown, path: string, scope?: unknown): unknown {
  if (!path) return model;
  if (!path.startsWith("/")) {
    return path.split("/").filter(Boolean).reduce<unknown>((current, part) => (current as Record<string, unknown> | undefined)?.[part], scope);
  }
  return path.split("/").filter(Boolean).reduce<unknown>((current, part) => (current as Record<string, unknown> | undefined)?.[part], model);
}

function textOf(value: unknown, model: unknown, scope?: unknown): string {
  if (typeof value === "string" || typeof value === "number") return String(value);
  if (value && typeof value === "object") {
    const record = value as { path?: string; literal?: string };
    if (record.path) {
      const resolved = readPointer(model, record.path, scope);
      return resolved === undefined || resolved === null ? "" : typeof resolved === "object" ? JSON.stringify(resolved) : String(resolved);
    }
    if (record.literal) return record.literal;
  }
  return "";
}

function resolveContext(context: unknown, model: unknown, scope?: unknown): Record<string, unknown> {
  if (!context || typeof context !== "object") return {};
  const output: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(context as Record<string, unknown>)) {
    if (value && typeof value === "object" && "path" in (value as object)) {
      output[key] = readPointer(model, String((value as { path: string }).path), scope);
    } else {
      output[key] = value;
    }
  }
  return output;
}

function pointerPath(value: unknown): string | undefined {
  if (value && typeof value === "object" && "path" in (value as object)) {
    return String((value as { path: string }).path);
  }
  return undefined;
}

/**
 * Sorts with a numeric hint when the artifact supplied one, so currency and
 * ratios order by magnitude instead of lexically ("$9.0M" before "$10.0M").
 */
function sortRows(rows: Row[], column: number, direction: 1 | -1): Row[] {
  return [...rows].sort((left, right) => {
    const a = left.sortValues?.[column];
    const b = right.sortValues?.[column];
    if (typeof a === "number" && typeof b === "number") return (a - b) * direction;
    const as = String(left.cells?.[column] ?? "");
    const bs = String(right.cells?.[column] ?? "");
    return as.localeCompare(bs, undefined, { numeric: true }) * direction;
  });
}

/**
 * Workspace mounting adapter for A2UI v0.9 basic-catalog messages, plus the
 * documented extensions listed in `@anc/contracts/catalog`. CopilotKit's
 * chat-oriented A2UI renderer is retained for the AG-UI route; this adapter
 * mounts the same message shapes into the dedicated workspace.
 */
export function A2UIWorkspace({
  messages,
  onAction,
}: {
  messages: A2UIMessage[];
  onAction: ActionHandler;
}) {
  const [ui, setUi] = useState<UiState>({ sorts: {}, fields: {}, selections: {} });
  const components = new Map<string, Record<string, unknown>>();
  let surfaceId = "workspace";
  let model: unknown = {};
  for (const message of messages) {
    if (message.createSurface) surfaceId = message.createSurface.surfaceId;
    if (message.updateComponents) {
      surfaceId = message.updateComponents.surfaceId;
      for (const component of message.updateComponents.components) {
        components.set(String(component.id), component);
      }
    }
    if (message.updateDataModel) {
      surfaceId = message.updateDataModel.surfaceId;
      if (!message.updateDataModel.path || message.updateDataModel.path === "/") model = message.updateDataModel.value ?? {};
    }
  }
  const root = components.get("root");
  if (!root) return <p className="muted">The workspace is waiting for a generated surface.</p>;
  const patch = (next: Partial<UiState>) => setUi((current) => ({ ...current, ...next }));
  return (
    <div className="a2ui-root">
      {render(root, components, model, surfaceId, onAction, ui, patch)}
    </div>
  );
}

function childrenOf(component: Record<string, unknown>): string[] {
  const children = component.children;
  if (Array.isArray(children)) return children.map(String);
  return [];
}

function render(
  component: Record<string, unknown>,
  components: Map<string, Record<string, unknown>>,
  model: unknown,
  surfaceId: string,
  onAction: ActionHandler,
  ui: UiState,
  patch: (next: Partial<UiState>) => void,
  scope?: unknown,
): ReactNode {
  const id = String(component.id);
  const type = String(component.component);
  const nested = (childId: string, childScope?: unknown) => {
    const child = components.get(childId);
    return child ? render(child, components, model, surfaceId, onAction, ui, patch, childScope) : null;
  };
  if (type === "Column" || type === "Row") {
    const className = type === "Row" ? "a2ui-row" : "a2ui-col";
    return <div className={className} key={id}>{childrenOf(component).map((childId) => nested(childId, scope))}</div>;
  }
  if (type === "Card") {
    const child = String(component.child ?? childrenOf(component)[0] ?? "");
    return <article className="finding-card" key={id}>{nested(child, scope)}</article>;
  }
  if (type === "Text") {
    const variant = String(component.variant ?? "");
    const Tag = variant === "h2" ? "h2" : variant === "h3" ? "strong" : variant === "caption" ? "small" : "p";
    return <Tag key={id}>{textOf(component.text, model, scope)}</Tag>;
  }
  if (type === "Button") {
    const action = component.action as { event?: { name?: string | { path?: string }; context?: Record<string, unknown> } } | undefined;
    const eventName = typeof action?.event?.name === "string"
      ? action.event.name
      : textOf(action?.event?.name, model, scope) || "investigate";
    const variant = String(component.variant ?? "primary");
    const context = resolveContext(action?.event?.context, model, scope);
    // Actions that persist user edits cannot read the data model, because the
    // edited values only exist in this adapter's state. Send them explicitly.
    if (eventName === "save_draft" || eventName === "set_selection") {
      context.clientFields = { ...ui.fields };
      context.clientSelections = { ...ui.selections };
    }
    return (
      <button
        key={id}
        className={variant === "borderless" ? "evidence-link" : "action-card"}
        type="button"
        aria-label={textOf(component.text, model, scope) || eventName}
        onClick={() => onAction({ name: eventName, surfaceId, sourceComponentId: id, context })}
      >
        {variant !== "borderless" ? <span>＋</span> : null}
        <span>{textOf(component.text, model, scope)}</span>
        {variant !== "borderless" ? <b>→</b> : null}
      </button>
    );
  }
  if (type === "List") {
    const spec = component.children as { path?: string; componentId?: string } | string[];
    if (Array.isArray(spec)) return <div key={id}>{spec.map((childId) => nested(childId, scope))}</div>;
    const rows = (spec?.path ? readPointer(model, spec.path, scope) : []) as unknown;
    const template = spec?.componentId ? components.get(spec.componentId) : undefined;
    if (!Array.isArray(rows) || !template) return null;
    return <div className="a2ui-list" key={id}>{rows.map((row, index) => <div key={`${id}-${index}`}>{render(template, components, model, surfaceId, onAction, ui, patch, row)}</div>)}</div>;
  }
  if (type === "Table") {
    return renderTable(component, model, surfaceId, onAction, ui, patch, scope, id);
  }
  if (type === "TextField") {
    return renderTextField(component, model, id, ui, patch, scope);
  }
  if (type === "Checkbox") {
    return renderCheckbox(component, model, surfaceId, onAction, ui, patch, scope, id);
  }
  if (type === "Chart") {
    return renderChart(component, model, id, scope);
  }
  // Shared list parity: the server validator rejects anything not in
  // `@anc/contracts/catalog`, so reaching here means the two lists diverged.
  if (!isA2UIComponentType(type)) {
    return process.env.NODE_ENV === "development"
      ? <span className="a2ui-unsupported" key={id}>Unsupported component: {type}</span>
      : null;
  }
  return null;
}

function renderTable(
  component: Record<string, unknown>,
  model: unknown,
  surfaceId: string,
  onAction: ActionHandler,
  ui: UiState,
  patch: (next: Partial<UiState>) => void,
  scope: unknown,
  id: string,
): ReactNode {
  const columns = (pointerPath(component.columns) ? readPointer(model, pointerPath(component.columns)!, scope) : []) as unknown;
  const rows = (pointerPath(component.rows) ? readPointer(model, pointerPath(component.rows)!, scope) : []) as unknown;
  if (!Array.isArray(columns) || !Array.isArray(rows)) return null;
  const headers = columns.map(String);
  const typed = rows as Row[];
  const fallbackColumn = typeof component.defaultSort === "number" ? component.defaultSort : 0;
  const sort = ui.sorts[id] ?? { column: fallbackColumn, direction: 1 as const };
  const ordered = sortRows(typed, sort.column, sort.direction);
  const totals = (pointerPath(component.totals) ? readPointer(model, pointerPath(component.totals)!, scope) : undefined) as unknown;
  const cellCount = Math.max(...ordered.map((row) => row.cells?.length ?? 0), headers.length, 0);

  return (
    <div className="a2ui-table-wrap" key={id}>
      <table className="a2ui-table">
        <thead>
          <tr>
            {headers.map((header, index) => (
              <th key={`${id}-h-${index}`} scope="col" aria-sort={sort.column === index ? (sort.direction === 1 ? "ascending" : "descending") : "none"}>
                <button
                  type="button"
                  className="a2ui-sort"
                  onClick={() => patch({
                    sorts: {
                      ...ui.sorts,
                      [id]: { column: index, direction: sort.column === index && sort.direction === 1 ? -1 : 1 },
                    },
                  })}
                >
                  {header}
                  <span aria-hidden="true">{sort.column === index ? (sort.direction === 1 ? " ▲" : " ▼") : ""}</span>
                </button>
              </th>
            ))}
            {ordered.some((row) => row.actionName) ? <th scope="col"><span className="visually-hidden">Actions</span></th> : null}
          </tr>
        </thead>
        <tbody>
          {ordered.map((row, index) => (
            <tr key={String(row.id ?? index)}>
              {Array.from({ length: cellCount }, (_, cell) => (
                <td key={`${id}-${row.id ?? index}-${cell}`}>{String(row.cells?.[cell] ?? "")}</td>
              ))}
              {row.actionName ? (
                <td>
                  <button
                    type="button"
                    className="evidence-link"
                    onClick={() => onAction({
                      name: row.actionName!,
                      surfaceId,
                      sourceComponentId: `${id}-row-${row.id ?? index}`,
                      context: {
                        entityType: row.entityType,
                        entityId: row.entityId ?? row.id,
                        rowId: row.id,
                      },
                    })}
                  >
                    {String((component.rowActionLabel as string | undefined) ?? "Open")}
                  </button>
                </td>
              ) : null}
            </tr>
          ))}
        </tbody>
        {Array.isArray(totals) && totals.length ? (
          <tfoot>
            <tr>
              {totals.map((cell, index) => (
                <td key={`${id}-t-${index}`}>{index === 0 ? "" : String(cell)}</td>
              ))}
              {ordered.some((row) => row.actionName) ? <td /> : null}
            </tr>
          </tfoot>
        ) : null}
      </table>
      {component.completeness === "partial" ? (
        <p className="a2ui-table-note">Partial result. This table does not contain every matching record.</p>
      ) : null}
    </div>
  );
}

function renderTextField(
  component: Record<string, unknown>,
  model: unknown,
  id: string,
  ui: UiState,
  patch: (next: Partial<UiState>) => void,
  scope: unknown,
): ReactNode {
  const generated = textOf(component.value, model, scope);
  // Local value wins so a regenerated surface cannot discard unsaved input.
  const value = ui.fields[id] ?? generated;
  return (
    <span className="a2ui-field" key={id}>
      {component.label ? <label className="a2ui-field-label" htmlFor={id}>{String(component.label)}</label> : null}
      <input
        id={id}
        className="a2ui-input"
        type="text"
        value={value}
        onChange={(event) => patch({ fields: { ...ui.fields, [id]: event.target.value } })}
      />
      {value !== generated ? <small className="a2ui-field-edited">edited</small> : null}
    </span>
  );
}

function renderCheckbox(
  component: Record<string, unknown>,
  model: unknown,
  surfaceId: string,
  onAction: ActionHandler,
  ui: UiState,
  patch: (next: Partial<UiState>) => void,
  scope: unknown,
  id: string,
): ReactNode {
  const groupId = String(component.groupId ?? id);
  const optionId = String(component.optionId ?? textOf(component.value, model, scope));
  const fallback = (readPointer(model, pointerPath(component.selected) ?? "", scope) as string[] | undefined) ?? [];
  const selected = ui.selections[groupId] ?? fallback;
  const checked = selected.includes(optionId);
  return (
    <label className="a2ui-check" key={id}>
      <input
        type="checkbox"
        checked={checked}
        onChange={() => {
          const next = checked ? selected.filter((item) => item !== optionId) : [...selected, optionId];
          patch({ selections: { ...ui.selections, [groupId]: next } });
          onAction({
            name: String(component.actionName ?? "set_selection"),
            surfaceId,
            sourceComponentId: id,
            context: { selectionId: groupId, optionId, selected: next },
          });
        }}
      />
      <span>{textOf(component.text, model, scope)}</span>
    </label>
  );
}

function renderChart(
  component: Record<string, unknown>,
  model: unknown,
  id: string,
  scope: unknown,
): ReactNode {
  const title = textOf(component.title, model, scope);
  const unit = String(component.unit ?? "");
  const points = (pointerPath(component.points) ? readPointer(model, pointerPath(component.points)!, scope) : []) as Array<{ label: string; value: number }> | undefined;
  if (!Array.isArray(points) || points.length < 2) return null;

  const width = 640;
  const height = 180;
  const padding = 24;
  const values = points.map((point) => point.value);
  const max = Math.max(...values);
  const min = Math.min(...values);
  const span = max - min || 1;
  const stepX = (width - padding * 2) / (points.length - 1);
  const toY = (value: number) => height - padding - ((value - min) / span) * (height - padding * 2);
  const line = points.map((point, index) => `${padding + index * stepX},${toY(point.value)}`).join(" ");
  const zeroLine = min < 0 && max > 0 ? toY(0) : undefined;

  return (
    <figure className="a2ui-chart" key={id}>
      <figcaption>{title}{unit ? ` (${unit})` : ""}</figcaption>
      <svg viewBox={`0 0 ${width} ${height}`} role="img" aria-label={title || "trend"} preserveAspectRatio="none">
        {zeroLine !== undefined ? <line className="a2ui-chart-zero" x1={padding} x2={width - padding} y1={zeroLine} y2={zeroLine} /> : null}
        <polyline className="a2ui-chart-line" points={line} fill="none" />
        {points.map((point, index) => (
          <circle
            key={`${id}-${index}`}
            className="a2ui-chart-point"
            cx={padding + index * stepX}
            cy={toY(point.value)}
            r={3}
          >
            <title>{`${point.label}: ${point.value}${unit ? ` ${unit}` : ""}`}</title>
          </circle>
        ))}
      </svg>
      <div className="a2ui-chart-axis">
        <span>{points[0]?.label}</span>
        <span>{points[points.length - 1]?.label}</span>
      </div>
      {component.caption ? <p className="a2ui-chart-caption">{textOf(component.caption, model, scope)}</p> : null}
    </figure>
  );
}

void (0 as unknown as CSSProperties);
