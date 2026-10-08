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
        // Must stay in step with the catalog registered in apps/web/lib/catalog.tsx.
        // Accepting a component the renderer cannot draw would replace the last
        // good workspace with a blank one.
        if (!isA2UIComponentType(type)) errors.push(`unsupported component ${type}`);
        if (components.has(id)) errors.push(`duplicate component id ${id}`);
        components.set(id, component);
        if (type === "Button") {
          // The standard Button takes its label as a child component and an event name as a literal.
          if (typeof component.child !== "string") errors.push(`Button ${id} needs a child component for its label`);
          const actionName = (component.action as { event?: { name?: unknown } } | undefined)?.event?.name;
          if (typeof actionName !== "string") errors.push(`Button ${id} needs an action event name`);
          else if (!KNOWN_ACTIONS.has(actionName)) errors.push(`unknown action ${actionName}`);
        }
        if (type === "Text" && component.text === undefined) errors.push(`Text ${id} has no text`);
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
