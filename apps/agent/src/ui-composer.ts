import { A2UI_CATALOG_ID, ActionNameSchema, type A2UIMessage, type PresentationInput } from "@anc/contracts";
import { BASIC_CATALOG_COMPONENTS } from "@anc/contracts/catalog";
import OpenAI from "openai";
import { validateA2UI } from "./a2ui-validate.js";
import { composeA2UI } from "./composer.js";
import { resolveExecutionMode, resolveModelConfig } from "./provider.js";
import { recordUsage } from "./usage.js";

type Component = Record<string, unknown>;

export type ComposedSurface = {
  messages: A2UIMessage[];
  dataModel: Record<string, unknown>;
  /** Who laid the surface out: the model, or the standard layout. */
  source: "model" | "template";
  /** Why the standard layout was used when a model was available. */
  reason?: string;
};

export type ComposerModelRequest = {
  /** A briefing is the first thing a person sees; a detail view answers one question in depth. */
  mode: "briefing" | "detail";
  audience: string;
  objective: string;
  view: string;
  catalog: string;
  data: unknown;
  blocks: Array<{ id: string; what: string }>;
  actions: Array<{ name: string; label: string }>;
  evidenceIds: string[];
};

/** Test seam. Production composition calls the configured model. */
let composerModelOverride: ((request: ComposerModelRequest, feedback?: string) => Promise<unknown>) | undefined;

export function useComposerModel(model: typeof composerModelOverride) {
  composerModelOverride = model;
}

/**
 * Interactive and trust-critical parts of a surface. The runtime builds these
 * from tool output, so the model places them but cannot alter them.
 */
const BLOCKS: Record<string, string> = {
  table_block: "The data table for this answer (sortable, with totals).",
  chart_block: "The time-series chart for this answer.",
  draft_block: "The editable draft with its save button.",
  form_block: "The confirmation form with its submit button.",
  selection_block: "Checkboxes that narrow the comparison to selected records.",
  receipt_block: "The receipt for a completed operation.",
  limits: "Limitations of this answer. Must stay visible.",
};

const BRIEFING_OMITS = new Set(["table_block", "chart_block", "selection_block"]);

const CATALOG = `Components (A2UI v0.9, flat list; every component has a unique "id" and a "component" type):
- Text: {"text": string | {"path"}, "variant"?: "h1"|"h2"|"h3"|"h4"|"h5"|"caption"|"body"}
- Column: {"children": [ids], "align"?: "start"|"center"|"end"|"stretch"}
- Row: {"children": [ids], "justify"?: "start"|"center"|"end"|"spaceBetween"|"spaceAround"|"spaceEvenly"|"stretch", "align"?: "start"|"center"|"end"|"stretch"}
- Card: {"child": id}
- List: {"children": [ids], "direction"?: "vertical"|"horizontal"}
- Divider: {}
- Button: {"child": id of a Text component, "variant"?: "primary"|"borderless"|"default", "action": {"event": {"name": string, "context"?: object}}}
A {"path"} value is a JSON Pointer into the data model, for example {"path": "/findings/<id>/title"}.`;

const SYSTEM = `You are DemoCo's UI Composer. You design the interface for the user's current objective as an A2UI v0.9 component tree.

Rules:
- Present only what is in the supplied data. Every number, name, date and finding must be shown through a {"path"} binding. Literal text is for short labels and section headings only, and must not contain figures.
- Design for this objective, not a fixed page. Lead with what matters most, group related findings, put key metrics side by side in a Row of Cards, and give lower-priority material less space. Prefer structure over long prose.
- Show a finding's kindLabel next to it so an unconfirmed hypothesis never reads as fact.
- Offer drill-downs as Buttons. Use only the listed actions, by name. For evidence use the action "show_evidence" with context {"evidenceIds": [...]} or {"evidenceId": "..."} using ids from the data.
- Brevity is the point of this product. Never fill the page with prose: a person should grasp it in seconds and know what to do next.
- In "briefing" mode, show at most five items, the ones that matter most to this audience, most serious first. Each item is one Card: its headline (the finding title), one key figure if a metric supports it, its kindLabel, and exactly one Button with action "investigate" whose question asks about that specific item. Do not show finding bodies, the subtitle, or anything the audience cannot act on. Merge findings that describe the same problem into one item. Leave out low-value and housekeeping findings entirely.
- In "detail" mode, answer the one question asked: lead with the figures, show at most six findings, and show a finding's body only where the headline is not enough.
- To let the person go deeper into a topic, use a Button with action "investigate" and context {"question": "<a short follow-up question in plain words>"}.
- Place every listed block by adding its id to a "children" array exactly once. Do not define components with those ids.
- The tree must start at a component with id "root". Use only the listed component types and props.

Reply with one JSON object: {"components": [...]}.`;

function collect(id: string, byId: Map<string, Component>, out: Set<string>) {
  if (out.has(id)) return;
  const component = byId.get(id);
  if (!component) return;
  out.add(id);
  const children = Array.isArray(component.children) ? component.children.map(String) : [];
  if (typeof component.child === "string") children.push(component.child);
  for (const child of children) collect(child, byId, out);
}

function hasCycle(id: string, byId: Map<string, Component>, trail = new Set<string>()): boolean {
  if (trail.has(id)) return true;
  const component = byId.get(id);
  if (!component) return false;
  const children = Array.isArray(component.children) ? component.children.map(String) : [];
  if (typeof component.child === "string") children.push(component.child);
  const next = new Set(trail).add(id);
  return children.some((child) => hasCycle(child, byId, next));
}

function readPointer(model: unknown, path: string): unknown {
  return path.split("/").filter(Boolean).reduce<unknown>((current, part) => (current as Record<string, unknown> | undefined)?.[part.replace(/~1/g, "/").replace(/~0/g, "~")], model);
}

/** Arrays are shown to the model by size and first element, so a long table does not fill the prompt. */
function outline(value: unknown, depth = 0): unknown {
  if (Array.isArray(value)) return value.length > 3 && depth > 0 ? { arrayOfLength: value.length, first: outline(value[0], depth + 1) } : value.map((item) => outline(item, depth + 1));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined).map(([key, item]) => [key, outline(item, depth + 1)]));
  return value;
}

function paths(value: unknown, found: string[] = []): string[] {
  if (Array.isArray(value)) value.forEach((item) => paths(item, found));
  else if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    if (typeof record.path === "string" && Object.keys(record).length === 1) found.push(record.path);
    else Object.values(record).forEach((item) => paths(item, found));
  }
  return found;
}

/**
 * Checks a model-authored tree beyond catalog validity: bindings must resolve,
 * literals must not carry figures the data does not contain, actions must be
 * ones this answer offers, and every protected block must be placed.
 */
function review(components: Component[], template: Component[], blockIds: string[], data: Record<string, unknown>, request: ComposerModelRequest): string[] {
  const errors: string[] = [];
  const allowedTypes = new Set<string>(BASIC_CATALOG_COMPONENTS);
  const haystack = `${JSON.stringify(data)} ${request.objective}`;
  const offered = new Map(request.actions.map((action) => [action.name, action]));
  const evidence = new Set(request.evidenceIds);
  const protectedIds = new Set<string>();
  const templateById = new Map(template.map((component) => [String(component.id), component]));
  for (const id of blockIds) collect(id, templateById, protectedIds);

  for (const component of components) {
    const id = String(component.id ?? "");
    const type = String(component.component ?? "");
    if (protectedIds.has(id)) errors.push(`"${id}" is a provided block; place it, do not define it`);
    if (!allowedTypes.has(type)) errors.push(`component type ${type} is not available to you`);
    for (const path of paths(component)) {
      if (!path.startsWith("/") || readPointer(data, path) === undefined) errors.push(`path ${path} does not exist in the data`);
    }
    if (type === "Text" && typeof component.text === "string") {
      for (const figure of component.text.match(/\d[\d,.]*\d|\d/g) ?? []) {
        if (!haystack.includes(figure)) errors.push(`literal text "${component.text.slice(0, 60)}" contains a figure that is not in the data; bind it with a path`);
      }
      if (component.text.length > 120) errors.push(`literal text in ${id} is too long; bind prose with a path`);
    }
    if (type === "Button") {
      const event = (component.action as { event?: { name?: unknown; context?: Record<string, unknown> } } | undefined)?.event;
      const name = String(event?.name ?? "");
      if (name === "investigate") {
        const question = event?.context?.question;
        if (typeof question !== "string" || !question.trim() || question.length > 160) errors.push(`Button ${id} needs context.question, a short follow-up question`);
        else for (const figure of question.match(/\d[\d,.]*\d|\d/g) ?? []) {
          if (!haystack.includes(figure)) errors.push(`follow-up question in ${id} contains a figure that is not in the data`);
        }
      } else if (name === "show_evidence") {
        const ids = [event?.context?.evidenceId, ...(Array.isArray(event?.context?.evidenceIds) ? event.context.evidenceIds : [])].filter(Boolean).map(String);
        if (!ids.length || ids.some((item) => !evidence.has(item))) errors.push(`Button ${id} cites evidence that is not in the data`);
      } else if (!offered.has(name)) {
        errors.push(`action ${name} is not offered for this answer`);
      }
    }
  }

  const merged = new Map([...template.filter((component) => protectedIds.has(String(component.id))), ...components].map((component) => [String(component.id), component]));
  const reachable = new Set<string>();
  collect("root", merged, reachable);
  for (const id of blockIds) if (!reachable.has(id)) errors.push(`block ${id} must be placed in the tree`);
  if (!paths(components.filter((component) => reachable.has(String(component.id)))).length && !blockIds.length) {
    errors.push("the surface shows none of the supplied data");
  }
  if (hasCycle("root", merged)) errors.push("the component tree contains a cycle");
  if (request.mode === "briefing") {
    const drills = components.filter((component) => reachable.has(String(component.id)) && (component.action as { event?: { name?: string } } | undefined)?.event?.name === "investigate");
    if (!drills.length) errors.push('a briefing needs an "investigate" Button on each item so the person can go deeper');
    if (components.filter((component) => reachable.has(String(component.id)) && component.component === "Card").length > 5) errors.push("a briefing shows at most five items");
  }
  return [...new Set(errors)];
}

async function askModel(request: ComposerModelRequest, runId: string | undefined, feedback?: string): Promise<unknown> {
  if (composerModelOverride) return composerModelOverride(request, feedback);
  const config = resolveModelConfig();
  if (!config.apiKey || !config.baseURL) throw new Error("UI Composer is missing API key or base URL");
  const client = new OpenAI({ apiKey: config.apiKey, baseURL: config.baseURL });
  const response = await client.chat.completions.create({
    model: config.model,
    response_format: { type: "json_object" },
    messages: [
      { role: "system", content: `${SYSTEM}\n\n${request.catalog}` },
      { role: "user", content: JSON.stringify({ mode: request.mode, audience: request.audience, objective: request.objective, suggestedView: request.view, data: request.data, blocks: request.blocks, actions: request.actions }) },
      ...(feedback ? [{ role: "user" as const, content: `Your previous tree was rejected:\n${feedback}\nSend a corrected {"components": [...]}.` }] : []),
    ],
  });
  if (runId) recordUsage(runId, response.usage);
  const content = response.choices[0]?.message?.content ?? "{}";
  return JSON.parse(content.match(/\{[\s\S]*\}/)?.[0] ?? content);
}

/**
 * Produces the surface for a presentation. With a live model, the UI Composer
 * authors the layout from the standard catalog and the runtime checks it; the
 * standard layout is used when no model is configured or its tree is rejected
 * twice. Either way the data model comes from verified findings and tool
 * output, never from the composer.
 */
export async function composeSurface(surfaceId: string, presentation: PresentationInput, options: { objective: string; runId?: string; mode?: "briefing" | "detail"; audience?: string }): Promise<ComposedSurface> {
  const template = composeA2UI(surfaceId, presentation);
  if (resolveExecutionMode() === "fixture" && !composerModelOverride) return { ...template, source: "template" };

  const templateComponents = (template.messages.find((message) => "updateComponents" in message) as { updateComponents: { components: Component[] } }).updateComponents.components;
  const templateById = new Map(templateComponents.map((component) => [String(component.id), component]));
  const briefing = options.mode === "briefing";
  // A briefing is headlines only: the records behind them belong to the view a person drills into.
  const blockIds = Object.keys(BLOCKS).filter((id) => templateById.has(id) && !(briefing && BRIEFING_OMITS.has(id)));
  const data = template.dataModel;
  const request: ComposerModelRequest = {
    mode: options.mode ?? "detail",
    audience: options.audience ?? "",
    objective: options.objective,
    view: presentation.view,
    catalog: CATALOG,
    data: outline({ title: data.title, subtitle: data.subtitle, metrics: data.metrics, findings: data.findings }),
    blocks: blockIds.map((id) => ({ id, what: BLOCKS[id]! })),
    actions: briefing ? [] : presentation.actions.filter((action) => ActionNameSchema.safeParse(action.name).success).map((action) => ({ name: action.name, label: action.label })),
    evidenceIds: [...new Set([...presentation.metrics.map((metric) => metric.evidenceId), ...presentation.findings.flatMap((finding) => finding.evidenceIds)])],
  };

  let feedback: string | undefined;
  let reason = "";
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const reply = await askModel(request, options.runId, feedback) as { components?: unknown };
      const authored = (Array.isArray(reply.components) ? reply.components : []).filter((item): item is Component => Boolean(item) && typeof item === "object");
      const errors = review(authored, templateComponents, blockIds, data, request);
      const protectedIds = new Set<string>();
      for (const id of blockIds) collect(id, templateById, protectedIds);
      // Follow-up actions carry the entities the runtime chose, whatever context the model wrote.
      const offered = new Map(presentation.actions.map((action) => [action.name, action]));
      const components = [
        ...authored.map((component) => {
          const event = (component.action as { event?: { name?: string } } | undefined)?.event;
          const match = event?.name ? offered.get(event.name) : undefined;
          return match ? { ...component, action: { event: { name: match.name, context: { entities: match.entities } } } } : component;
        }),
        ...templateComponents.filter((component) => protectedIds.has(String(component.id))),
      ];
      const messages: A2UIMessage[] = [
        { version: "v0.9", createSurface: { surfaceId, catalogId: A2UI_CATALOG_ID } },
        { version: "v0.9", updateComponents: { surfaceId, components } },
        { version: "v0.9", updateDataModel: { surfaceId, path: "/", value: data } },
      ];
      if (!errors.length) errors.push(...validateA2UI(messages));
      if (!errors.length) return { messages, dataModel: data, source: "model" };
      feedback = errors.slice(0, 12).map((error) => `- ${error}`).join("\n");
      reason = errors[0]!;
    } catch (error) {
      reason = error instanceof Error ? error.message : "UI Composer failed";
      feedback = `- ${reason}`;
    }
  }
  return { ...template, source: "template", reason };
}
