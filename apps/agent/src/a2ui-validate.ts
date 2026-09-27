import { A2UI_CATALOG_ID, ActionNameSchema, type A2UIMessage } from "@anc/contracts";
import { isA2UIComponentType } from "@anc/contracts/catalog";

/**
 * Derived from the contract so the validator cannot drift from the action names
 * the runtime will later parse.
 */
const KNOWN_ACTIONS: ReadonlySet<string> = new Set(ActionNameSchema.options);

export function validateA2UI(messages: A2UIMessage[]): string[] {
  const errors: string[] = [];
  if (process.env.FORCE_INVALID_A2UI === "1") errors.push("Forced invalid A2UI");
  let surfaceId: string | undefined;
  const components = new Map<string, Record<string, unknown>>();
  for (const message of messages) {
    if (message.version !== "v0.9") errors.push("A2UI version must be v0.9");
    if ("createSurface" in message && message.createSurface) {
      surfaceId = message.createSurface.surfaceId;
      if (!message.createSurface.catalogId) errors.push("createSurface missing catalogId");
      if (message.createSurface.catalogId && message.createSurface.catalogId !== A2UI_CATALOG_ID) {
        errors.push(`Unknown catalog ${message.createSurface.catalogId}`);
      }
    }
    if ("updateComponents" in message && message.updateComponents) {
      if (surfaceId && message.updateComponents.surfaceId !== surfaceId) {
        errors.push("updateComponents surfaceId does not match createSurface");
      }
      for (const component of message.updateComponents.components) {
        const id = String(component.id ?? "");
        if (!id) errors.push("component missing id");
        const type = String(component.component ?? "");
        // Must stay in step with the renderer in apps/web/lib/a2ui.tsx, which
        // switches on this same shared list. Accepting a component the renderer
        // cannot draw would replace the last good workspace with a blank one.
        if (!isA2UIComponentType(type)) errors.push(`unsupported component ${type}`);
        components.set(id, component);
        const actionName = (component.action as { event?: { name?: string | { path?: string } } } | undefined)?.event?.name;
        const bound = actionName && typeof actionName === "object" && typeof actionName.path === "string";
        if (type === "Button" && typeof actionName === "string" && !KNOWN_ACTIONS.has(actionName)) {
          errors.push(`unknown action ${actionName}`);
        }
        if (type === "Button" && actionName && typeof actionName !== "string" && !bound) {
          errors.push("action name must be a known action or a data path");
        }
      }
    }
  }
  if (!components.has("root")) errors.push("missing root component");
  for (const component of components.values()) {
    const children = component.children;
    const ids = Array.isArray(children) ? children.map(String) : [];
    if (typeof component.child === "string") ids.push(component.child);
    if (children && typeof children === "object" && !Array.isArray(children) && "componentId" in (children as object)) {
      ids.push(String((children as { componentId: string }).componentId));
    }
    for (const childId of ids) {
      if (!components.has(childId)) errors.push(`dangling child ${childId}`);
    }
  }
  return errors;
}
