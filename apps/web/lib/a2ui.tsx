"use client";

import type { CSSProperties, ReactNode } from "react";

export type A2UIMessage = {
  version?: string;
  createSurface?: { surfaceId: string; catalogId: string };
  updateComponents?: { surfaceId: string; components: Array<Record<string, unknown>> };
  updateDataModel?: { surfaceId: string; path?: string; value?: unknown };
  deleteSurface?: { surfaceId: string };
};

type ActionHandler = (action: { name: string; surfaceId: string; sourceComponentId: string; context: Record<string, unknown> }) => void;

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

/**
 * Workspace mounting adapter for A2UI v0.9 basic-catalog messages.
 * CopilotKit's chat-oriented A2UI renderer is retained for the AG-UI route;
 * this adapter mounts the same catalog primitives into the dedicated workspace.
 */
export function A2UIWorkspace({
  messages,
  onAction,
}: {
  messages: A2UIMessage[];
  onAction: ActionHandler;
}) {
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
  return <div className="a2ui-root">{render(root, components, model, surfaceId, onAction)}</div>;
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
  scope?: unknown,
): ReactNode {
  const id = String(component.id);
  const type = String(component.component);
  const nested = (childId: string, childScope?: unknown) => {
    const child = components.get(childId);
    return child ? render(child, components, model, surfaceId, onAction, childScope) : null;
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
    return (
      <button
        key={id}
        className={variant === "borderless" ? "evidence-link" : "action-card"}
        type="button"
        aria-label={textOf(component.text, model, scope) || eventName}
        onClick={() => onAction({
          name: eventName,
          surfaceId,
          sourceComponentId: id,
          context: resolveContext(action?.event?.context, model, scope),
        })}
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
    return <div className="a2ui-list" key={id}>{rows.map((row, index) => <div key={`${id}-${index}`}>{render(template, components, model, surfaceId, onAction, row)}</div>)}</div>;
  }
  return null;
}

void (0 as unknown as CSSProperties);
