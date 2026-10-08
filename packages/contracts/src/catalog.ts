/**
 * Single source of truth for the component types a workspace surface may use.
 *
 * Surfaces are rendered by the standard A2UI v0.9 renderer
 * (`@copilotkit/a2ui-renderer`). `BASIC_CATALOG_COMPONENTS` are the standard
 * basic-catalog components the workspace uses. `WORKSPACE_EXTENSION_COMPONENTS`
 * are registered on top of the basic catalog in `apps/web/lib/catalog.tsx`,
 * because the basic catalog has no data table, chart, key-figure tile, ordered
 * chain, selection that reports back to the agent, briefing primary-finding
 * block, drill-down context header, or client-only disclosure (Collapsible).
 *
 * The server validator and the UI Composer both read this list, so neither can
 * accept or author a component the browser cannot draw.
 */
export const WORKSPACE_CATALOG_ID = "https://democo.local/a2ui/catalogs/workspace/v1";

export const BASIC_CATALOG_COMPONENTS = [
  "Button",
  "Card",
  "Column",
  "Divider",
  "List",
  "Row",
  "Text",
] as const;

export const WORKSPACE_EXTENSION_COMPONENTS = [
  "Chart",
  "Collapsible",
  "ContextHeader",
  "EditField",
  "PrimaryFinding",
  "SelectOption",
  "Sequence",
  "Stat",
  "Table",
] as const;

/** Extensions a UI Composer may author itself. The rest are built by the runtime from tool output and only placed. */
export const AUTHORABLE_EXTENSION_COMPONENTS = ["Collapsible", "Sequence", "Stat"] as const;

export const A2UI_COMPONENT_TYPES = [
  ...BASIC_CATALOG_COMPONENTS,
  ...WORKSPACE_EXTENSION_COMPONENTS,
] as const;

export type A2UIComponentType = (typeof A2UI_COMPONENT_TYPES)[number];

export const A2UI_COMPONENT_TYPE_SET: ReadonlySet<string> = new Set(A2UI_COMPONENT_TYPES);

export function isA2UIComponentType(value: string): value is A2UIComponentType {
  return A2UI_COMPONENT_TYPE_SET.has(value);
}
