import type { Domain, EntityRef, SemanticAction } from "@anc/contracts";
import { hasGrant, type Principal } from "@anc/policy";
import OpenAI from "openai";
import { recordSubstitution } from "./execution.js";
import { resolveExecutionMode, resolveModelConfig } from "./provider.js";
import { authorizedCapabilities, CAPABILITIES, SPECIALISTS, type CapabilityDefinition } from "./registry.js";
import { recordUsage } from "./usage.js";
import { DEMO_CLOCK } from "./windows.js";

/** One task per specialist at most, so a briefing can reach every part of the network. */
export const MAX_TASKS = SPECIALISTS.length;

export type PlannedTask = {
  domain: Domain;
  question: string;
  capabilities: string[];
  /** Records the task is scoped to, resolved from the objective or prior state. */
  entities?: EntityRef[];
};

export type WorkPlan = {
  intent: string;
  view: "summary" | "table" | "form" | "comparison" | "queue" | "trend";
  tasks: PlannedTask[];
  clarification?: string;
  unsupported?: string;
  deterministic: boolean;
  source: "fixture" | "live";
};

const STOP = new Set(["about", "should", "what", "know", "this", "that", "with", "from", "have", "need", "needs", "show", "list", "give", "tell", "please", "the", "and", "for", "any", "our", "you", "today", "right", "which", "there", "many", "much"]);
const BROAD = /attention|this morning|start of the day|going on|need to know|care about|on fire|brief me|briefing|overnight|what are the issues|what is wrong|what's wrong/;
/** Things this workspace cannot do for anyone. */
const UNSUPPORTED_WRITE = /reroute|re-route|cancel (the|a|all)|refund|dispatch|release the (truck|run)|redeliver|delete|send (an? )?(email|sms|message)/;
const TREND = /trend|over time|this week|last week|over the past|timeline|history of|each day|daily|hour by hour|chart|graph/;
/** The assignment verb in verb form, so "unassigned" and "assignee" do not match. */
const WRITE_INTENT = /(?<![a-z])assign(?![a-z])|(?<![a-z])reassign(?![a-z])|\bset an? (owner|assignee)\b/;

const BRIEFING_QUESTIONS: Record<Domain, string> = {
  network: "Are any hubs behind on sorting, is any equipment down, and are any of today's route runs late or held?",
  shipments: "How many parcels promised for today are at risk of missing delivery, and where are they?",
  last_mile: "Are any parcel lockers full or close to full, with parcels arriving today that have no space?",
  customers: "Which shippers are at risk of missing their on-time commitment today, and what is in the open complaint queue?",
};

export type PlanModelRequest = {
  objective: string;
  /** The workspace clock, so "today" or "overnight" can be resolved without asking. */
  now: string;
  user: { id: string; title: string; role: string; priorities: string[] };
  selectedEntities: EntityRef[];
  specialists: Array<{ domain: Domain; responsibilities: string; capabilities: Array<{ id: string; description: string }> }>;
};

/** Test seam. Production live planning calls the configured model. */
let planModelOverride: ((request: PlanModelRequest) => Promise<unknown>) | undefined;

export function usePlanModel(model: ((request: PlanModelRequest) => Promise<unknown>) | undefined) {
  planModelOverride = model;
}

export function isBroadObjective(objective: string): boolean {
  return BROAD.test(objective.toLowerCase());
}

type PlanInput = {
  objective: string;
  action?: SemanticAction;
  principal: Principal;
  selectedEntities?: EntityRef[];
  priorIntent?: string;
  runId?: string;
};

export async function proposePlan(input: PlanInput): Promise<WorkPlan> {
  const action = input.action?.name;
  const text = input.objective.toLowerCase();
  if (action === "show_as_table" || (/\btable\b|\btabular\b|\bas a list\b/.test(text) && input.priorIntent)) {
    return { intent: input.priorIntent || "work", view: "table", tasks: [], deterministic: true, source: "fixture" };
  }
  if (action === "prepare_assignment" || action === "commit_assignment") {
    return { intent: action, view: "form", tasks: [], deterministic: true, source: "fixture" };
  }

  const mode = resolveExecutionMode();
  if (mode === "fixture" && !planModelOverride) return fixturePlan(input);
  // What nobody may do, and what this person may not do, is decided by the runtime, not by a model.
  const refused = refusal(input, text);
  if (refused) return refused;
  try {
    return sanitizePlan({ ...(await livePlan(input)), deterministic: false, source: "live" }, input.principal);
  } catch (error) {
    const message = error instanceof Error ? error.message : "planning failed";
    if (mode === "live-strict") {
      return { intent: "unsupported", view: "summary", tasks: [], unsupported: message, deterministic: false, source: "live" };
    }
    if (input.runId) recordSubstitution(input.runId, "planner", message);
    return fixturePlan(input);
  }
}

const unsupported = (message: string): WorkPlan => ({ intent: "unsupported", view: "summary", tasks: [], unsupported: message, deterministic: true, source: "fixture" });

/** Requests refused before any planning: operations nobody has, and a write this person lacks. */
function refusal(input: PlanInput, text: string): WorkPlan | undefined {
  if (UNSUPPORTED_WRITE.test(text)) return unsupported("This workspace cannot carry out that operation. It can show what is happening and assign complaints.");
  const write = WRITE_INTENT.test(text) ? CAPABILITIES.find((capability) => capability.sideEffect === "write") : undefined;
  if (write && !hasGrant(input.principal, write.id)) {
    return unsupported(`You are not authorized to ${write.description.toLowerCase()}. You can read the records, but the change has to be made by someone who is.`);
  }
  return undefined;
}

export function fixturePlan(input: PlanInput): WorkPlan {
  const text = input.objective.toLowerCase();
  const refused = refusal(input, text);
  if (refused) return refused;
  if (BROAD.test(text)) {
    const tasks = briefingTasks(input.principal);
    return tasks.length
      ? sanitizePlan({ intent: "work", view: "summary", tasks, deterministic: true, source: "fixture" }, input.principal)
      : unsupported("You have no access to operational data.");
  }

  // Score against the whole catalog, so a request this person may not serve is
  // named as such instead of quietly matching something adjacent they can see.
  const scored = CAPABILITIES
    .filter((capability) => capability.sideEffect === "read" && !capability.internal)
    .map((capability) => ({ capability, score: scoreCapability(text, capability) }))
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score);
  const best = scored[0];
  if (!best) return unsupported("Nothing in this workspace matches that request.");
  const tied = scored.filter((item) => item.score === best.score);
  const permitted = tied.filter((item) => hasGrant(input.principal, item.capability.id));
  if (!permitted.length) {
    const domains = [...new Set(tied.map((item) => SPECIALISTS.find((specialist) => specialist.id === item.capability.domain)?.label.replace(" Agent", "").toLowerCase()))];
    const alternatives = authorizedCapabilities(input.principal).filter((capability) => capability.core).map((capability) => capability.description.split(":")[0]);
    return unsupported(`That needs ${domains.join(" or ")} data, which is not available to you.${alternatives.length ? ` Available to you: ${alternatives.join("; ")}.` : ""}`);
  }
  const wantsTrend = TREND.test(text);
  const chosen = wantsTrend && permitted.some((item) => item.capability.series) ? permitted.filter((item) => item.capability.series) : permitted;
  const byDomain = new Map<Domain, string[]>();
  for (const item of chosen) byDomain.set(item.capability.domain, [...(byDomain.get(item.capability.domain) ?? []), item.capability.id]);
  const tasks = [...byDomain.entries()].map(([domain, capabilities]) => ({ domain, question: input.objective, capabilities, entities: input.selectedEntities }));
  return sanitizePlan({ intent: "work", view: viewFor(tasks, text), tasks, deterministic: true, source: "fixture" }, input.principal);
}

/** A briefing asks every specialist the person has access to, about that specialist's own part of the network. */
function briefingTasks(principal: Principal): PlannedTask[] {
  return SPECIALISTS.flatMap((specialist) => {
    const capabilities = authorizedCapabilities(principal).filter((item) => item.domain === specialist.id && item.core).map((item) => item.id);
    return capabilities.length ? [{ domain: specialist.id, question: BRIEFING_QUESTIONS[specialist.id], capabilities }] : [];
  });
}

/** Chooses the view from what was scheduled, so paraphrases of one request compose the same way. */
function viewFor(tasks: PlannedTask[], text: string): WorkPlan["view"] {
  const definitions = tasks.flatMap((item) => item.capabilities).map((id) => CAPABILITIES.find((capability) => capability.id === id)!);
  if (definitions.some((definition) => definition.series)) return "trend";
  if (definitions.some((definition) => definition.rowAction) && /assign|unassigned|queue|owner/.test(text)) return "queue";
  if (definitions.length === 1 && definitions[0]!.rowEntity) return "table";
  return "summary";
}

/** Longer words match on a shared stem, so "lockers" reaches "locker" and "complaint" reaches "complaints". */
function scoreCapability(text: string, capability: CapabilityDefinition): number {
  const haystack = `${capability.tool.replaceAll("_", " ")} ${capability.description}`.toLowerCase();
  const words = text.split(/[^a-z0-9]+/).filter((word) => word.length > 3 && !STOP.has(word));
  return words.filter((word) => haystack.includes(word) || (word.length >= 6 && haystack.includes(word.slice(0, 5)))).length;
}

function planRequest(input: PlanInput): PlanModelRequest {
  const granted = authorizedCapabilities(input.principal).filter((item) => item.sideEffect === "read");
  return {
    objective: input.objective,
    now: DEMO_CLOCK,
    user: { id: input.principal.id, title: input.principal.title, role: input.principal.preferences.roleDescription, priorities: input.principal.preferences.priorities },
    selectedEntities: input.selectedEntities ?? [],
    specialists: SPECIALISTS.flatMap((specialist) => {
      const capabilities = granted.filter((item) => item.domain === specialist.id).map((item) => ({ id: item.id, description: item.description }));
      return capabilities.length ? [{ domain: specialist.id, responsibilities: specialist.responsibilities, capabilities }] : [];
    }),
  };
}

const PLANNER = `You plan work for an Indian parcel carrier's operations workspace. Given a person's objective, decide which specialists should investigate and what each should find out.

- Use only the specialists and capabilities provided; these are everything this person is allowed to see. Give each specialist at most one task.
- For a briefing or any open question about what is going on, give every provided specialist a task about its own part of the network, shaped by what this person cares about.
- For a specific question, involve only the specialists needed, but include one whose area could explain or be affected by the answer.
- Write each question so the specialist can act on it alone. Resolve dates from "now"; do not ask the person for dates.
- Ask for clarification only when a specific record is required and not identified. If nothing provided can serve the request, return unsupported with a one-sentence reason.

Reply with one JSON object: {"intent": short phrase, "view": "summary" | "table" | "comparison" | "queue" | "trend", "tasks": [{"domain", "question", "capabilities": [ids]}], "unsupported"?: string, "clarification"?: string}.
view: summary for several topics together, table for a list of records, comparison for records ranked by a number, queue for work waiting for an owner, trend for a measure over time.`;

async function livePlan(input: PlanInput): Promise<WorkPlan> {
  const request = planRequest(input);
  let parsed: Partial<WorkPlan>;
  if (planModelOverride) {
    parsed = await planModelOverride(request) as Partial<WorkPlan>;
  } else {
    const config = resolveModelConfig();
    if (!config.apiKey || !config.baseURL) throw new Error("Live planner is missing API key or base URL");
    const client = new OpenAI({ apiKey: config.apiKey, baseURL: config.baseURL });
    const response = await client.chat.completions.create({
      model: config.model,
      response_format: { type: "json_object" },
      messages: [{ role: "system", content: PLANNER }, { role: "user", content: JSON.stringify(request) }],
    });
    if (input.runId) recordUsage(input.runId, response.usage);
    const content = response.choices[0]?.message?.content ?? "{}";
    parsed = JSON.parse(content.match(/\{[\s\S]*\}/)?.[0] ?? content) as Partial<WorkPlan>;
  }
  const views: ReadonlyArray<WorkPlan["view"]> = ["summary", "table", "form", "comparison", "queue", "trend"];
  return {
    intent: String(parsed.intent ?? "work"),
    view: views.includes(parsed.view as WorkPlan["view"]) ? parsed.view as WorkPlan["view"] : "summary",
    tasks: Array.isArray(parsed.tasks) ? parsed.tasks.map((item) => ({
      domain: item.domain,
      question: String(item.question ?? ""),
      capabilities: Array.isArray(item.capabilities) ? item.capabilities.map(String) : [],
      entities: input.selectedEntities,
    })) : [],
    unsupported: typeof parsed.unsupported === "string" ? parsed.unsupported : undefined,
    clarification: typeof parsed.clarification === "string" ? parsed.clarification : undefined,
    deterministic: false,
    source: "live",
  };
}

/** Removes anything a plan may not contain: unknown specialists, capabilities the person lacks, and writes. */
export function sanitizePlan(plan: WorkPlan, principal: Principal): WorkPlan {
  const seen = new Set<Domain>();
  const tasks = plan.tasks.flatMap((item) => {
    if (!SPECIALISTS.some((specialist) => specialist.id === item.domain) || seen.has(item.domain)) return [];
    const granted = authorizedCapabilities(principal).filter((definition) => definition.domain === item.domain && definition.sideEffect === "read");
    if (!granted.length) return [];
    const named = [...new Set(item.capabilities)].filter((id) => granted.some((definition) => definition.id === id));
    seen.add(item.domain);
    // A specialist with access but no usable capability named still gets its domain's core set.
    const capabilities = named.length ? named : granted.filter((definition) => definition.core).map((definition) => definition.id);
    return capabilities.length ? [{ ...item, capabilities, question: item.question || BRIEFING_QUESTIONS[item.domain] }] : [];
  }).slice(0, MAX_TASKS);
  if (plan.unsupported && !tasks.length) return { ...plan, tasks: [], view: "summary", intent: "unsupported" };
  // A question back to the person is not a permission failure; keep the two distinguishable.
  if (plan.clarification && !tasks.length) return { ...plan, tasks: [], view: "summary", intent: "clarification" };
  if (!tasks.length) return { intent: "unsupported", view: "summary", tasks: [], unsupported: "You are not authorized for what this request needs.", deterministic: plan.deterministic, source: plan.source };
  return { ...plan, tasks, unsupported: undefined, clarification: undefined, intent: plan.intent || "work" };
}

export function validatePlan(plan: WorkPlan): string[] {
  const errors: string[] = [];
  if (plan.tasks.length > MAX_TASKS) errors.push(`plan exceeds ${MAX_TASKS} specialist tasks`);
  for (const item of plan.tasks) {
    if (!SPECIALISTS.some((specialist) => specialist.id === item.domain)) errors.push(`unknown specialist ${item.domain}`);
    for (const capability of item.capabilities) {
      if (!CAPABILITIES.some((entry) => entry.id === capability)) errors.push(`unknown capability ${capability}`);
    }
  }
  return errors;
}

/**
 * R5: how a new turn relates to what is on screen. A `drill` goes deeper into the
 * briefing (a "Look into this" click, or a question about a record the briefing
 * showed) and is shown under the briefing's context header; an `action` works on
 * the surface itself (propose, confirm, evidence) and never reaches the planner's
 * work; a `new_topic` starts afresh with its own plan.
 */
export type TurnKind = "drill" | "action" | "new_topic";

/** What a drill needs to know about the briefing it came from. */
export type PriorBriefing = {
  surfaceId: string;
  revision: number;
  /** The briefing's headline, used when the drill names no single item. */
  label: string;
  /** Records on the briefing: the primary's, the chain's and the secondary items'. */
  entities: EntityRef[];
  /** The drill questions the briefing offered, with the item each is about. */
  drills: Array<{ question: string; label: string }>;
};

const SURFACE_ACTIONS = new Set(["propose_action", "confirm_action", "cancel_action", "prepare_assignment", "select_assignee", "commit_assignment", "show_evidence", "back_to_briefing", "save_draft", "set_selection"]);

export function classifyTurn(input: { objective: string; action?: string; entities?: EntityRef[]; prior?: PriorBriefing }): { kind: TurnKind; label?: string } {
  if (input.action && SURFACE_ACTIONS.has(input.action)) return { kind: "action" };
  const text = input.objective.trim().toLowerCase();
  // A new briefing request is a new topic even right after a briefing.
  if (!input.prior || isBroadObjective(text)) return { kind: "new_topic" };
  const offered = input.prior.drills.find((drill) => drill.question.trim().toLowerCase() === text);
  if (offered) return { kind: "drill", label: offered.label };
  const known = (entity: EntityRef) => input.prior!.entities.find((item) => item.type === entity.type && item.id === entity.id);
  const selected = input.entities?.find(known);
  if (selected) return { kind: "drill", label: known(selected)?.label ?? input.prior.label };
  // A typed question that names a record the briefing showed, by id or by name.
  const named = input.prior.entities.find((entity) => text.includes(entity.id.toLowerCase()) || (entity.label && entity.label.length >= 4 && text.includes(entity.label.toLowerCase())));
  if (named) return { kind: "drill", label: named.label ?? input.prior.label };
  return { kind: "new_topic" };
}
