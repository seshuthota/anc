import type { Domain, EntityRef, SemanticAction } from "@anc/contracts";
import { hasGrant, type Principal } from "@anc/policy";
import OpenAI from "openai";
import { recordSubstitution } from "./execution.js";
import { resolveExecutionMode, resolveModelConfig } from "./provider.js";
import { authorizedCapabilities, CAPABILITIES, SPECIALISTS, type CapabilityDefinition } from "./registry.js";
import { recordUsage } from "./usage.js";
import { DEMO_CLOCK } from "./windows.js";

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

const STOP = new Set(["about", "should", "what", "know", "this", "that", "with", "from", "have", "need", "needs", "show", "list", "give", "tell", "please", "the", "and", "for", "any", "our", "you"]);
const BROAD = /attention|this morning|start of the day|going on with the company|need to know|care about|anything on fire|brief me|overnight|unusual/;
const UNSUPPORTED_WRITE = /refund|wire|pay out|payout|reimburse|remit|transfer funds|send money|payroll|send email to all customers|delete all/;
const TREND = /trend|over time|this week|last week|over the past|timeline|history of|each day|daily|chart|graph/;
const DRAFT = /draft|checklist|onboarding|propose|write a|prepare a|plan for/;
/** The assignment *verb* in verb form, so "unassigned", "assignee" and "no owner" do not match. */
const WRITE_INTENT = /(?<![a-z])assign(?![a-z])|(?<![a-z])reassign(?![a-z])|\bset an? (owner|assignee)\b/;

export type PlanModelRequest = {
  objective: string;
  /** The workspace clock, so "this week" or "overnight" can be resolved without asking. */
  now: string;
  user: { id: string; title: string; priorities: string[] };
  selectedEntities: EntityRef[];
  completedCapabilities: string[];
  capabilities: Array<Pick<CapabilityDefinition, "id" | "tool" | "domain" | "description" | "sideEffect" | "inputSchema">>;
};

/** Test seam. Production live planning calls the configured model. */
let planModelOverride: ((request: PlanModelRequest) => Promise<unknown>) | undefined;

export function usePlanModel(model: ((request: PlanModelRequest) => Promise<unknown>) | undefined) {
  planModelOverride = model;
}

export function isBroadObjective(objective: string): boolean {
  return BROAD.test(objective.toLowerCase());
}

export async function proposePlan(input: {
  objective: string;
  action?: SemanticAction;
  principal: Principal;
  selectedEntities?: EntityRef[];
  completedCapabilities?: string[];
  priorIntent?: string;
  runId?: string;
}): Promise<WorkPlan> {
  const action = input.action?.name;
  const text = input.objective.toLowerCase();
  const tableView = /\btable\b|\btabular\b|\bas a list\b/.test(text);
  if (action === "show_as_table" || (tableView && input.priorIntent)) {
    return { intent: input.priorIntent || "investigate", view: "table", tasks: [], deterministic: true, source: "fixture" };
  }
  if (action === "prepare_assignment" || action === "commit_assignment") {
    return { intent: action, view: "form", tasks: [], deterministic: true, source: "fixture" };
  }
  if (action === "inspect_financial_impact") {
    return sanitizePlan({ intent: action, view: "summary", tasks: [task("finance", input.objective, ["cap.finance.arr"])], deterministic: true, source: "fixture" }, input.principal);
  }
  if (action === "inspect_release") {
    return sanitizePlan({ intent: action, view: "summary", tasks: [task("reliability", input.objective, ["cap.releases.read"])], deterministic: true, source: "fixture" }, input.principal);
  }
  if (action === "inspect_account") {
    return sanitizePlan({
      intent: action,
      view: "summary",
      tasks: [
        task("customer", input.objective, ["cap.customers.read", "cap.tickets.read"]),
        task("product", input.objective, ["cap.usage.read"]),
        task("finance", input.objective, ["cap.finance.arr"]),
      ],
      deterministic: true,
      source: "fixture",
    }, input.principal);
  }
  if (action === "show_affected_accounts") {
    return sanitizePlan({
      intent: action,
      view: "table",
      tasks: [
        task("customer", "Identify and describe the technically impacted accounts.", ["cap.customers.read"]),
        task("finance", "Calculate represented ARR for the affected-account set.", ["cap.finance.arr"]),
      ],
      deterministic: true,
      source: "fixture",
    }, input.principal);
  }

  const mode = resolveExecutionMode();
  if (mode === "fixture") return fixturePlan(input);
  try {
    const live = await livePlan(input);
    return sanitizePlan({ ...live, deterministic: false, source: "live" }, input.principal);
  } catch (error) {
    const message = error instanceof Error ? error.message : "planning failed";
    if (mode === "live-strict") {
      return { intent: "unsupported", view: "summary", tasks: [], unsupported: message, deterministic: false, source: "live" };
    }
    if (input.runId) recordSubstitution(input.runId, "planner", message);
    return { ...fixturePlan(input), deterministic: true, source: "fixture" };
  }
}

export function fixturePlan(input: {
  objective: string;
  principal: Principal;
  selectedEntities?: EntityRef[];
}): WorkPlan {
  if (UNSUPPORTED_WRITE.test(input.objective.toLowerCase())) {
    return {
      intent: "unsupported",
      view: "summary",
      tasks: [],
      unsupported: "This workspace cannot perform that business operation.",
      deterministic: true,
      source: "fixture",
    };
  }
  const text = input.objective.toLowerCase();
  const broad = BROAD.test(text);
  const denied = deniedRequest(input, text);
  if (denied) return denied;
  const authorized = authorizedCapabilities(input.principal).filter((item) => item.sideEffect === "read" || /assign|owner/.test(text));
  const draftPlan = draftRequest(input, authorized);
  if (draftPlan) return draftPlan;
  const trendPlan = trendRequest(input, authorized, text);
  if (trendPlan) return trendPlan;
  const scored = authorized.map((capability) => ({ capability, score: scoreCapability(input.objective, input.principal, capability) }));
  const selected = broad
    ? coreTasks(input.principal, input.objective)
    : groupedTasks((() => {
      const positive = scored.filter((item) => item.score > 0).sort((a, b) => b.score - a.score);
      const max = positive[0]?.score ?? 0;
      return positive.filter((item) => item.score === max);
    })(), input.objective);
  if (!selected.length) {
    return {
      intent: "unsupported",
      view: "summary",
      tasks: [],
      unsupported: "No authorized capability matches this request.",
      deterministic: true,
      source: "fixture",
    };
  }
  const view = broad ? "summary" : viewFor(selected, text);
  return sanitizePlan({ intent: "work", view, tasks: selected.slice(0, 3), deterministic: true, source: "fixture" }, input.principal);
}

/**
 * Recognises a request the persona is not permitted to serve and says so.
 *
 * Without this, a request like "compare overdue invoices by customer" from a
 * support user silently matched an authorized customer-read capability and
 * returned an unrelated answer with no limitation shown. The comparison is made
 * against the whole catalog, not the granted subset, so the workspace can say
 * "that is finance data" rather than guessing at something adjacent.
 */
function deniedRequest(input: { objective: string; principal: Principal }, text: string): WorkPlan | undefined {
  if (UNSUPPORTED_WRITE.test(text)) {
    return {
      intent: "unsupported",
      view: "summary",
      tasks: [],
      unsupported: "This workspace cannot perform that business operation.",
      deterministic: true,
      source: "fixture",
    };
  }
  if (BROAD.test(text)) return undefined;
  const scored = CAPABILITIES
    .map((capability) => ({ capability, score: scoreCapability(input.objective, input.principal, capability) }))
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score);
  const best = scored[0];
  if (!best) return undefined;
  const tied = scored.filter((item) => item.score === best.score);
  const permitted = tied.filter((item) => hasGrant(input.principal, item.capability.id));
  // A request to *perform* an assignment is refused when the write capability is
  // not granted, rather than quietly degrading to the matching read. The test is
  // the verb "assign", not the adjective "unassigned": "which tickets have no
  // owner" is a question about records, "assign the first one" is a change.
  const writeCapability = CAPABILITIES.find((capability) => capability.sideEffect === "write" && WRITE_INTENT.test(text));
  if (writeCapability && !hasGrant(input.principal, writeCapability.id)) {
    return {
      intent: "unsupported",
      view: "summary",
      tasks: [],
      unsupported: `You are not authorized to ${writeCapability.description.toLowerCase()}. You can read the relevant records, but this change has to be made by a permitted owner.`,
      deterministic: true,
      source: "fixture",
    };
  }
  if (permitted.length) return undefined;
  const domains = [...new Set(tied.map((item) => item.capability.domain))];
  const alternatives = [...new Set(tied
    .filter((item) => hasGrant(input.principal, item.capability.id))
    .map((item) => item.capability.description))];
  return {
    intent: "unsupported",
    view: "summary",
    tasks: [],
    unsupported: `That request needs ${domains.join(" or ")} data, which is not available to you.${alternatives.length ? ` Available to you: ${alternatives.join("; ")}.` : ""}`,
    deterministic: true,
    source: "fixture",
  };
}

/**
 * Chooses the view from the capabilities that were actually scheduled, not from
 * the wording of the request. That is what makes paraphrases converge: "compare
 * X by customer" and "break down X per customer" select the same capability and
 * therefore compose the same view, with no extra routing branch.
 */
function viewFor(selected: PlannedTask[], text: string): WorkPlan["view"] {
  const capabilities = selected.flatMap((item) => item.capabilities);
  if (capabilities.includes("cap.service.trend")) return "trend";
  if (capabilities.includes("cap.finance.invoices")) return "comparison";
  const queueish = capabilities.includes("cap.tickets.assign")
    || (capabilities.includes("cap.tickets.read") && /assign|unassigned|queue|owner|escalation/.test(text));
  if (queueish) return "queue";
  if (capabilities.some((id) => CAPABILITIES.find((cap) => cap.id === id)?.rowEntity)) return "table";
  return "summary";
}

/** Trend requests schedule the series capability and compose as a trend view. */
function trendRequest(
  input: { objective: string; principal: Principal },
  authorized: CapabilityDefinition[],
  text: string,
): WorkPlan | undefined {
  if (!TREND.test(text)) return undefined;
  const capabilities = authorized.filter((item) => item.id === "cap.service.trend").map((item) => item.id);
  if (!capabilities.length) {
    return {
      intent: "unsupported",
      view: "summary",
      tasks: [],
      unsupported: "You are not authorized to read service telemetry trends.",
      deterministic: true,
      source: "fixture",
    };
  }
  return sanitizePlan({
    intent: "work",
    view: "trend",
    tasks: [task("reliability", "Show the service error-rate trend over the requested period.", capabilities)],
    deterministic: true,
    source: "fixture",
  }, input.principal);
}

/**
 * Draft requests retrieve the target account first, then present a
 * model-authored checklist. The draft is never presented as observed fact.
 */
function draftRequest(
  input: { objective: string; principal: Principal; selectedEntities?: EntityRef[] },
  authorized: CapabilityDefinition[],
): WorkPlan | undefined {
  if (!DRAFT.test(input.objective.toLowerCase())) return undefined;
  const capabilities = authorized.filter((item) => item.id === "cap.customers.read" || item.id === "cap.tickets.read").map((item) => item.id);
  if (!capabilities.length) {
    return {
      intent: "unsupported",
      view: "summary",
      tasks: [],
      unsupported: "You are not authorized to read the records this draft would be based on.",
      deterministic: true,
      source: "fixture",
    };
  }
  // A draft for "these accounts" needs the accounts to already be in scope.
  const named = input.objective.match(/\bcustomer-[a-z0-9-]+/i)?.[0];
  if (!named && !input.selectedEntities?.length && /\bthese\b|\bthem\b|\bour\b/i.test(input.objective)) {
    return {
      intent: "clarification",
      view: "summary",
      tasks: [],
      clarification: "Which account should this draft cover? Select an account first, or name it.",
      deterministic: true,
      source: "fixture",
    };
  }
  return sanitizePlan({
    intent: "draft",
    view: "form",
    tasks: [{
      ...task("customer", "Retrieve the account context this draft must be based on.", capabilities),
      entities: named ? [{ type: "customer" as const, id: named }] : input.selectedEntities,
    }],
    deterministic: true,
    source: "fixture",
  }, input.principal);
}

function planRequest(input: { objective: string; principal: Principal; selectedEntities?: EntityRef[]; completedCapabilities?: string[] }): PlanModelRequest {
  return {
    objective: input.objective,
    now: DEMO_CLOCK,
    user: { id: input.principal.id, title: input.principal.title, priorities: input.principal.preferences.priorities },
    selectedEntities: input.selectedEntities ?? [],
    completedCapabilities: input.completedCapabilities ?? [],
    capabilities: authorizedCapabilities(input.principal).map((item) => ({
      id: item.id,
      tool: item.tool,
      domain: item.domain,
      description: item.description,
      sideEffect: item.sideEffect,
      inputSchema: item.inputSchema,
    })),
  };
}

function planFromModelJson(parsed: WorkPlan): WorkPlan {
  return {
    intent: String(parsed.intent ?? "work"),
    view: parsed.view ?? "summary",
    tasks: Array.isArray(parsed.tasks) ? parsed.tasks.map((item) => ({
      domain: item.domain as Domain,
      question: item.question,
      capabilities: item.capabilities ?? [],
      entities: item.entities,
    })) : [],
    unsupported: parsed.unsupported,
    clarification: parsed.clarification,
    deterministic: false,
    source: "live",
  };
}

async function livePlan(input: { objective: string; principal: Principal; selectedEntities?: EntityRef[]; completedCapabilities?: string[]; runId?: string }): Promise<WorkPlan> {
  const request = planRequest(input);
  if (planModelOverride) return planFromModelJson(await planModelOverride(request) as WorkPlan);
  const config = resolveModelConfig();
  if (!config.apiKey || !config.baseURL) throw new Error("Live planner is missing API key or base URL");
  const client = new OpenAI({ apiKey: config.apiKey, baseURL: config.baseURL });
  const response = await client.chat.completions.create({
    model: config.model,
    response_format: { type: "json_object" },
    messages: [
      {
        role: "system",
        content: "You are a workflow planner. Propose at most three specialist tasks using only the provided authorized capabilities. Never invent tools. Do not schedule write/commit tools. Skip capabilities listed as already completed. If affected account ids are present and an authorized exposure capability is not completed, you may add that task. If the request cannot be served, return unsupported. Resolve relative dates from the provided now instead of asking; specialists choose their own time windows. Ask for clarification only when a required record is not identified. Return JSON {intent, view, tasks:[{domain,question,capabilities}], unsupported?, clarification?}. view is summary (cross-domain overview), table (a list of records), comparison (records compared by a numeric column), queue (work items awaiting an owner), trend (a metric over time), or form.",
      },
      { role: "user", content: JSON.stringify(request) },
    ],
  });
  if (input.runId) recordUsage(input.runId, response.usage);
  return planFromModelJson(JSON.parse(response.choices[0]?.message?.content ?? "{}") as WorkPlan);
}

export function sanitizePlan(plan: WorkPlan, principal: Principal): WorkPlan {
  const knownDomains = new Set(SPECIALISTS.map((item) => item.id));
  const tasks = plan.tasks.flatMap((item) => {
    if (!knownDomains.has(item.domain)) return [];
    const capabilities = [...new Set(item.capabilities.filter((capability) => {
      const def = CAPABILITIES.find((entry) => entry.id === capability);
      return def && def.domain === item.domain && hasGrant(principal, capability) && def.sideEffect !== "write";
    }))];
    if (!capabilities.length) return [];
    return [{ ...item, capabilities, question: item.question || `Use ${capabilities.join(", ")} for the current objective.` }];
  }).slice(0, 3);
  if (plan.unsupported && !tasks.length) {
    return { ...plan, tasks: [], view: "summary", intent: "unsupported" };
  }
  // A targeted question is not a permission failure. Keep it distinguishable so
  // the user is asked for the missing input instead of being told they lack access.
  if (plan.clarification && !tasks.length) {
    return { ...plan, tasks: [], view: "summary", intent: "clarification" };
  }
  if (!tasks.length && !plan.unsupported) {
    return { intent: "unsupported", view: "summary", tasks: [], unsupported: "You are not authorized for the capabilities this request needs.", deterministic: plan.deterministic, source: plan.source };
  }
  return { ...plan, tasks, intent: plan.intent || "work" };
}

export function validatePlan(plan: WorkPlan): string[] {
  const errors: string[] = [];
  if (plan.tasks.length > 3) errors.push("plan exceeds three concurrent specialist tasks");
  const seen = new Set<string>();
  for (const item of plan.tasks) {
    const key = `${item.domain}:${item.question}`;
    if (seen.has(key)) errors.push("duplicate task");
    seen.add(key);
    if (!SPECIALISTS.some((specialist) => specialist.id === item.domain)) errors.push(`unknown specialist ${item.domain}`);
    for (const capability of item.capabilities) {
      if (!CAPABILITIES.some((entry) => entry.id === capability)) errors.push(`unknown capability ${capability}`);
    }
  }
  return errors;
}

function coreTasks(principal: Principal, objective: string): PlannedTask[] {
  const domains: Domain[] = ["reliability", "product", "customer", "finance"];
  const tasks: PlannedTask[] = [];
  for (const domain of domains) {
    const capabilities = authorizedCapabilities(principal)
      .filter((item) => item.domain === domain && item.sideEffect === "read" && item.core)
      .map((item) => item.id);
    if (!capabilities.length) continue;
    tasks.push(task(domain, objectiveFor(domain, objective, principal), capabilities));
    if (tasks.length === 3) break;
  }
  return tasks;
}

function groupedTasks(scored: Array<{ capability: CapabilityDefinition; score: number }>, objective: string): PlannedTask[] {
  const byDomain = new Map<Domain, string[]>();
  for (const item of scored) {
    const list = byDomain.get(item.capability.domain) ?? [];
    if (!list.includes(item.capability.id)) list.push(item.capability.id);
    byDomain.set(item.capability.domain, list);
  }
  return [...byDomain.entries()].slice(0, 3).map(([domain, capabilities]) => task(domain, objective, capabilities));
}

function objectiveFor(domain: Domain, objective: string, principal: Principal) {
  if (domain === "reliability") return "What reliability signals should be investigated in the current demo window?";
  if (domain === "product") return "How did synchronization usage change versus the equal prior period?";
  if (domain === "customer" && principal.team === "support") return "What unassigned or escalated support work needs attention?";
  if (domain === "customer") return "What customer support evidence exists for synchronization issues?";
  if (domain === "finance") return "Compare overdue invoices and represented exposure.";
  return objective;
}

/**
 * Light morphological match. Without it, "list the tickets still waiting for an
 * assignee" scores nothing against a capability described as
 * "Unassigned support queue", because neither "tickets" nor "assignee" occurs
 * literally in it. Longer words match on a shared prefix, so plural and noun
 * forms reach the same capability without a synonym list per capability.
 */
function termMatches(haystack: string, word: string): boolean {
  if (haystack.includes(word)) return true;
  if (word.length >= 6) return haystack.includes(word.slice(0, 5));
  return false;
}

function scoreCapability(objective: string, principal: Principal, capability: CapabilityDefinition): number {
  const haystack = `${capability.id} ${capability.tool} ${capability.description} ${capability.rowEntity ?? ""}`.toLowerCase();
  const words = objective.toLowerCase().split(/[^a-z0-9]+/).filter((word) => word.length > 3 && !STOP.has(word));
  let score = words.filter((word) => termMatches(haystack, word)).length;
  for (const priority of principal.preferences.priorities) {
    const overlap = priority.toLowerCase().split(/[^a-z0-9]+/).filter((word) => word.length > 3 && termMatches(haystack, word));
    if (overlap.length && (BROAD.test(objective.toLowerCase()) || words.some((word) => priority.toLowerCase().includes(word)))) {
      score += overlap.length;
    }
  }
  return score;
}

function task(domain: Domain, question: string, capabilities: string[]): PlannedTask {
  return { domain, question, capabilities };
}
