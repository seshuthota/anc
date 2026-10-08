import { A2UI_CATALOG_ID, ActionNameSchema, type A2UIMessage, type PresentationInput } from "@anc/contracts";
import { AUTHORABLE_EXTENSION_COMPONENTS, BASIC_CATALOG_COMPONENTS } from "@anc/contracts/catalog";
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
  primary_block: "The one primary finding: headline, its one figure with definition, window, denominator and evidence, why it matters, the cause chain and confidence.",
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
- Stat: {"label": string | {"path"}, "value": {"path"}, "tone"?: "neutral"|"alert"|"good", "note"?: string | {"path"}} — one key figure as a tile. Use "alert" for a figure that is a problem. Put several in a Row.
- Sequence: {"children": [ids]} — draws its children as numbered stops on one connected line. Use it only for things that really are in order, such as the synthesis steps from cause to effect.
- Collapsible: {"summary": string | {"path"}, "child": id} — a disclosure that starts closed and opens in the browser only (no round trip). For lower-priority material.
A {"path"} value is a JSON Pointer into the data model, for example {"path": "/findings/<id>/title"}.`;

const SYSTEM = `You are the UI Composer for an Indian parcel carrier's operations workspace. You design the interface for the person's current objective as an A2UI v0.9 component tree.

Rules:
- Present only what is in the supplied data. Every number, name, date and finding must be shown through a {"path"} binding. Literal text is for short labels and section headings only, and must not contain figures.
- Design for this objective, not a fixed page. Lead with what matters most, group related findings, put key metrics side by side as Stat tiles in a Row, and give lower-priority material less space. Prefer structure over long prose.
- Show a finding's kindLabel next to it so an unconfirmed hypothesis never reads as fact.
- Offer drill-downs as Buttons. Use only the listed actions, by name. For evidence use the action "show_evidence" with context {"evidenceIds": [...]} or {"evidenceId": "..."} using ids from the data.
- Brevity is the point of this product. Never fill the page with prose: a person should grasp it in seconds and know what to do next.
- When the data has a "synthesis", it is the lead analyst's connected account and it is the centrepiece. Show its steps in their order inside one Sequence (cause first, consequences after), each stop holding the step's text and its kindLabel so an inferred link never reads as fact. Do not repeat a finding as its own card when a step already covers it. Show each "separate" issue apart from the sequence, so it is clearly not part of it.
- In "briefing" mode the data holds a "briefing" plan, and the surface is one primary plus a collapsed rest:
  - Place the "primary_block" block first when it is listed. It already shows the one figure, why it matters, the chain and confidence; do not repeat any of them.
  - Offer the plan's actions (data.briefing.actions, at most three) as Buttons; an "investigate" action carries context {"question": <its question>}.
  - Put the secondary items (data.briefing.secondary, at most three) inside exactly one Collapsible whose summary is bound to /briefing/restLabel. Each item is its title (bound) and one Button with action "investigate" and context {"question": <its question>}; an evidence Button is optional.
  - With no primary_block (a quiet day, or no single headline), show /title as a heading and /briefing/quiet/label under it.
  - Do not add Stat tiles, Cards, or a Sequence. Do not show anything else.
- Every figure you bind must sit next to its evidence: a bound number's parent object in the data has "evidenceIds".
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
  const allowedTypes = new Set<string>([...BASIC_CATALOG_COMPONENTS, ...AUTHORABLE_EXTENSION_COMPONENTS]);
  const haystack = `${JSON.stringify(data)} ${request.objective}`;
  const offered = new Map(request.actions.map((action) => [action.name, action]));
  const evidence = new Set(request.evidenceIds);
  const protectedIds = new Set<string>();
  const templateById = new Map(template.map((component) => [String(component.id), component]));
  for (const id of blockIds) collect(id, templateById, protectedIds);

  for (const component of components) {
    const id = String(component.id ?? "");
    const type = String(component.component ?? "");
    if (!allowedTypes.has(type)) errors.push(`component type ${type} is not available to you`);
    for (const path of paths(component)) {
      if (!path.startsWith("/") || readPointer(data, path) === undefined) errors.push(`path ${path} does not exist in the data`);
    }
    // Any literal the person will read is held to the same rule, whichever component carries it.
    for (const field of type === "Text" ? ["text"] : type === "Stat" ? ["label", "value", "note"] : []) {
      const literal = component[field];
      if (typeof literal !== "string") continue;
      for (const figure of literal.match(/\d[\d,.]*\d|\d/g) ?? []) {
        if (!haystack.includes(figure)) errors.push(`literal ${field} "${literal.slice(0, 60)}" in ${id} contains a figure that is not in the data; bind it with a path`);
      }
      if (literal.length > 120) errors.push(`literal ${field} in ${id} is too long; bind prose with a path`);
    }
    if (type === "Stat" && typeof component.value === "string") errors.push(`Stat ${id} must take its value from the data with a path`);
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
  const shown = paths(components.filter((component) => reachable.has(String(component.id))));
  const synthesis = data.synthesis as { steps?: Record<string, unknown> } | undefined;
  for (const stepId of Object.keys(synthesis?.steps ?? {})) {
    if (!shown.includes(`/synthesis/steps/${stepId}/text`)) errors.push(`synthesis step ${stepId} must be shown, bound to /synthesis/steps/${stepId}/text`);
    if (!shown.includes(`/synthesis/steps/${stepId}/kindLabel`)) errors.push(`synthesis step ${stepId} must show its kindLabel`);
  }
  if (!paths(components.filter((component) => reachable.has(String(component.id)))).length && !blockIds.length) {
    errors.push("the surface shows none of the supplied data");
  }
  if (hasCycle("root", merged)) errors.push("the component tree contains a cycle");
  // R4: a bound figure must have its evidence next to it in the data model.
  for (const path of shown) {
    const value = readPointer(data, path);
    const leaf = path.split("/").filter(Boolean).at(-1) ?? "";
    const figure = typeof value === "number" || (leaf === "value" && typeof value === "string" && /\d/.test(value));
    if (!figure) continue;
    const parent = readPointer(data, path.split("/").slice(0, -1).join("/")) as { evidenceIds?: unknown } | undefined;
    if (!Array.isArray(parent?.evidenceIds) || !parent.evidenceIds.length) errors.push(`figure ${path} has no evidenceIds next to it; bind only figures that carry their evidence`);
  }
  const briefingPlan = data.briefing as { primary?: unknown; secondary?: Record<string, unknown> } | undefined;
  if (request.mode === "briefing" && briefingPlan) {
    errors.push(...reviewBriefingBudget(merged, reachable, components, briefingPlan));
  } else if (request.mode === "briefing") {
    const drills = components.filter((component) => reachable.has(String(component.id)) && (component.action as { event?: { name?: string } } | undefined)?.event?.name === "investigate");
    if (!drills.length) errors.push('a briefing needs an "investigate" Button on each item so the person can go deeper');
    if (components.filter((component) => reachable.has(String(component.id)) && component.component === "Card").length > 9) errors.push("a briefing is too long; merge or drop items");
  }
  return [...new Set(errors)];
}

/**
 * R3: the briefing budget. Exactly one PrimaryFinding (none without a primary),
 * at most three action buttons outside the collapsed rest (evidence buttons
 * excluded), at most one Collapsible holding at most three secondary items,
 * secondary items only inside it, and no free Stat, Card or Sequence.
 */
function reviewBriefingBudget(merged: Map<string, Component>, reachable: Set<string>, authored: Component[], plan: { primary?: unknown; secondary?: Record<string, unknown> }): string[] {
  const errors: string[] = [];
  const shownComponents = [...reachable].map((id) => merged.get(id)).filter((component): component is Component => Boolean(component));
  const ofType = (type: string) => shownComponents.filter((component) => component.component === type);
  const primaries = ofType("PrimaryFinding").length;
  const expected = plan.primary ? 1 : 0;
  if (primaries !== expected) errors.push(`a briefing shows exactly ${expected} PrimaryFinding; this tree shows ${primaries}`);
  if (authored.some((component) => component.component === "PrimaryFinding")) errors.push("PrimaryFinding is built by the runtime; place primary_block instead of authoring one");
  if (ofType("Stat").length) errors.push("a briefing has no free-standing Stat tiles; the primary block carries the one figure");
  if (ofType("Card").length) errors.push("a briefing has no free-standing finding cards");
  if (ofType("Sequence").length) errors.push("a briefing shows the chain inside the primary block only, not as a Sequence");
  const collapsibles = ofType("Collapsible");
  if (collapsibles.length > 1) errors.push(`a briefing has at most one Collapsible; this tree has ${collapsibles.length}`);
  const inside = new Set<string>();
  for (const collapsible of collapsibles) collect(String(collapsible.id), merged, inside);
  const insideComponents = [...inside].map((id) => merged.get(id)).filter((component): component is Component => Boolean(component));
  const secondaryIds = (components: Component[]) => new Set(paths(components).map((path) => path.match(/^\/briefing\/secondary\/([^/]+)/)?.[1]).filter((id): id is string => Boolean(id)));
  const collapsedItems = secondaryIds(insideComponents);
  if (collapsedItems.size > 3) errors.push(`the collapsed rest holds at most three items; this tree has ${collapsedItems.size}`);
  const outsideSecondary = secondaryIds(shownComponents.filter((component) => !inside.has(String(component.id))));
  if (outsideSecondary.size) errors.push("lower-priority items stay inside the Collapsible");
  const eventOf = (component: Component) => (component.action as { event?: { name?: string } } | undefined)?.event?.name;
  const actionButtons = shownComponents.filter((component) => component.component === "Button" && !inside.has(String(component.id)) && eventOf(component) !== "show_evidence");
  if (actionButtons.length > 3) errors.push(`a briefing offers at most three actions; this tree has ${actionButtons.length}`);
  const drills = insideComponents.filter((component) => component.component === "Button" && eventOf(component) === "investigate");
  if (drills.length > 3) errors.push("the collapsed rest has at most one drill-down per item");
  return errors;
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
    // A briefing composer sees only the briefing plan, never the raw finding list.
    data: presentation.briefing
      ? outline({ title: data.title, briefing: data.briefing })
      : outline({ title: data.title, subtitle: data.subtitle, synthesis: data.synthesis, metrics: data.metrics, findings: data.findings }),
    blocks: blockIds.map((id) => ({ id, what: BLOCKS[id]! })),
    actions: presentation.briefing
      ? presentation.briefing.actions.filter((action) => action.name !== "investigate" && ActionNameSchema.safeParse(action.name).success).map((action) => ({ name: action.name, label: action.label }))
      : briefing ? [] : presentation.actions.filter((action) => ActionNameSchema.safeParse(action.name).success).map((action) => ({ name: action.name, label: action.label })),
    evidenceIds: [...new Set([
      ...presentation.metrics.map((metric) => metric.evidenceId),
      ...presentation.findings.flatMap((finding) => finding.evidenceIds),
      ...(presentation.briefing?.primary?.evidenceIds ?? []),
      ...(presentation.briefing?.primary?.metric?.evidenceIds ?? []),
      ...(presentation.briefing?.secondary.flatMap((item) => item.evidenceIds) ?? []),
    ])],
  };

  let feedback: string | undefined;
  let reason = "";
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const reply = await askModel(request, options.runId, feedback) as { components?: unknown };
      const protectedIds = new Set<string>();
      for (const id of blockIds) collect(id, templateById, protectedIds);
      // A model that redefines a provided block is simply overruled: the runtime's version is the one that is shown.
      const authored = (Array.isArray(reply.components) ? reply.components : [])
        .filter((item): item is Component => Boolean(item) && typeof item === "object")
        .filter((component) => !protectedIds.has(String(component.id)));
      const errors = review(authored, templateComponents, blockIds, data, request);
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
