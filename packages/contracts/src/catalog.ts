/**
 * Single source of truth for the component types the workspace adapter can render.
 *
 * `apps/agent/src/a2ui-validate.ts` (server) and `apps/web/lib/a2ui.tsx` (client)
 * both read this list. The validator must never accept a component the renderer
 * cannot draw: a surface that validates but renders blank is worse than a
 * rejected surface, because it replaces the last known-good workspace.
 *
 * `BASIC_CATALOG` entries are primitives from the A2UI v0.9 basic catalog.
 * `ADAPTER_EXTENSION` entries are documented extensions implemented only by the
 * local workspace adapter (see docs/compatibility.md).
 */
export const BASIC_CATALOG_COMPONENTS = [
  "Button",
  "Card",
  "Column",
  "List",
  "Row",
  "Text",
] as const;

export const ADAPTER_EXTENSION_COMPONENTS = [
  "Chart",
  "Checkbox",
  "Table",
  "TextField",
] as const;

export const A2UI_COMPONENT_TYPES = [
  ...BASIC_CATALOG_COMPONENTS,
  ...ADAPTER_EXTENSION_COMPONENTS,
] as const;

export type A2UIComponentType = (typeof A2UI_COMPONENT_TYPES)[number];

export const A2UI_COMPONENT_TYPE_SET: ReadonlySet<string> = new Set(A2UI_COMPONENT_TYPES);

export function isA2UIComponentType(value: string): value is A2UIComponentType {
  return A2UI_COMPONENT_TYPE_SET.has(value);
}
