import type { Domain, EntityRef, SemanticAction } from "@anc/contracts";
import { hasGrant, type Principal } from "@anc/policy";
import OpenAI from "openai";
import { recordSubstitution } from "./execution.js";
import { resolveExecutionMode, resolveModelConfig } from "./provider.js";
import { authorizedCapabilities, CAPABILITIES, SPECIALISTS, type CapabilityDefinition } from "./registry.js";
import { extractModelJsonObject } from "./json-unwrap.js";
import { recordUsage } from "./usage.js";

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
const INVOICE = /invoice|aging|overdue|past-due|past due|receivable/;
const QUEUE = /queue|unassigned|escalat|assignee|no owner/;
/** The assignment *verb* in verb form, so "unassigned", "assignee" and "no owner" do not match. */
const WRITE_INTENT = /(?<![a-z])assign(?![a-z])|(?<![a-z])reassign(?![a-z])|\bset an? (owner|assignee)\b/;
const PLAN_VIEWS = new Set(["summary", "table", "form", "comparison", "queue", "trend"]);

export type PlanModelRequest = {
  objective: string;
  user: { id: string; title: string; priorities: string[] };
  selectedEntities: EntityRef[];
  completedCapabilities: string[];
  capabilities: Array<Pick<CapabilityDefinition, "id" | "tool" | "domain" | "description" | "sideEffect" | "inputSchema"> & { granted: boolean }>;
  repairReason?: string;
};

/** Test seam. Production live planning calls the configured model. */
let planModelOverride: ((request: PlanModelRequest) => Promise<unknown>) | undefined;

export function usePlanModel(model: ((request: PlanModelRequest) => Promise<unknown>) | undefined) {
  planModelOverride = model;
}

export function isBroadObjective(objective: string): boolean {
  return BROAD.test(objective.toLowerCase());
}

function looksProductive(objective: string): boolean {
  const text = objective.toLowerCase();
  return BROAD.test(text) || TREND.test(text) || DRAFT.test(text) || INVOICE.test(text) || QUEUE.test(text);
}

function hasReadGrants(principal: Principal): boolean {
  return authorizedCapabilities(principal).some((item) => item.sideEffect === "read");
}

/**
 * Trust rails only: policy/product truth before calling the live model.
 * Never invents specialist evidence or schedules fixture task builders.
 */
function policyGateBeforeLive(input: {
  objective: string;
  principal: Principal;
}): WorkPlan | undefined {
  const text = input.objective.toLowerCase();
  if (UNSUPPORTED_WRITE.test(text)) {
    return {
      intent: "unsupported",
      view: "summary",
      tasks: [],
      unsupported: "This workspace cannot perform that business operation.",
      deterministic: true,
      source: "live",
    };
  }
  const denied = deniedRequest(input, text);
  if (!denied) return undefined;
  return { ...denied, deterministic: true, source: "live" };
}

function shouldRepairLivePlan(plan: WorkPlan, input: { objective: string; principal: Principal }): boolean {
  if (plan.tasks.length > 0) return false;
  if (!hasReadGrants(input.principal)) return false;
  if (!looksProductive(input.objective)) return false;
  // Real unsupported from the model is product truth — do not burn a second Explabs call.
  if (typeof plan.unsupported === "string" && plan.unsupported.trim().length > 0) {
    return false;
  }
  // Keep a genuine missing-target clarification (draft for "these accounts").
  if (plan.clarification && /which account|select an account|name it/i.test(plan.clarification)) {
    return false;
  }
  // Empty, weak, or premature clarification on a productive ask → one repair.
  return true;
}

function livePlanRepairReason(
  plan: WorkPlan,
  input: { objective: string; principal: Principal },
): string {
  const grantedReads = authorizedCapabilities(input.principal)
    .filter((item) => item.sideEffect === "read")
    .map((item) => item.id);
  const text = input.objective.toLowerCase();
  const granted = new Set(grantedReads);
  const pick = (...ids: string[]) => ids.filter((id) => granted.has(id));
  let hint: string;
  let example: string | undefined;
  if (BROAD.test(text)) {
    hint = "This is a broad morning/attention ask: schedule up to three parallel tasks across distinct granted core domains (reliability/product/customer/finance as granted), view summary.";
    const tasks: Array<{ domain: string; question: string; capabilities: string[] }> = [];
    const reliability = pick("cap.service.health", "cap.service.errors", "cap.releases.read");
    const customer = pick("cap.tickets.read");
    const finance = pick("cap.finance.invoices");
    const product = pick("cap.usage.read");
    if (reliability.length) tasks.push({ domain: "reliability", question: "What reliability signals need attention?", capabilities: reliability });
    if (customer.length && tasks.length < 3) tasks.push({ domain: "customer", question: "What customer support evidence needs attention?", capabilities: customer });
    if (finance.length && tasks.length < 3) tasks.push({ domain: "finance", question: "What overdue invoice exposure needs attention?", capabilities: finance });
    if (product.length && tasks.length < 3) tasks.push({ domain: "product", question: "How did product usage change?", capabilities: product });
    if (tasks.length) example = JSON.stringify({ intent: "work", view: "summary", tasks });
  } else if (TREND.test(text)) {
    hint = "Schedule cap.service.trend with view trend if granted.";
    const caps = pick("cap.service.trend");
    if (caps.length) example = JSON.stringify({ intent: "work", view: "trend", tasks: [{ domain: "reliability", question: "Show service error-rate trend for the requested window.", capabilities: caps }] });
  } else if (DRAFT.test(text)) {
    hint = "Schedule customer/ticket reads with intent draft and view form; include named customer entity when present.";
    const caps = pick("cap.customers.read", "cap.tickets.read");
    const named = input.objective.match(/\bcustomer-[a-z0-9-]+/i)?.[0];
    if (caps.length) {
      example = JSON.stringify({
        intent: "draft",
        view: "form",
        tasks: [{ domain: "customer", question: "Retrieve account context for the draft.", capabilities: caps, ...(named ? { entities: [{ type: "customer", id: named }] } : {}) }],
      });
    }
  } else if (INVOICE.test(text)) {
    hint = "Schedule cap.finance.invoices with view comparison if granted.";
    const caps = pick("cap.finance.invoices");
    if (caps.length) example = JSON.stringify({ intent: "work", view: "comparison", tasks: [{ domain: "finance", question: "Compare overdue invoice aging by customer.", capabilities: caps }] });
  } else if (QUEUE.test(text)) {
    hint = "Schedule cap.tickets.read with view queue if granted.";
    const caps = pick("cap.tickets.read");
    if (caps.length) example = JSON.stringify({ intent: "work", view: "queue", tasks: [{ domain: "customer", question: "List unassigned escalations in the support queue.", capabilities: caps }] });
  } else {
    hint = "Schedule the best-matching granted read capabilities.";
  }
  const exampleClause = example ? ` Return JSON shaped exactly like: ${example}` : " Return JSON with non-empty tasks.";
  if (!plan.tasks.length) {
    return `Previous plan had no usable tasks after validation. ${hint} Use only these granted read capability ids: ${grantedReads.join(", ")}. Never schedule write/commit tools.${exampleClause}`;
  }
  return `Previous plan failed validation. ${hint} Granted reads: ${grantedReads.join(", ")}.${exampleClause}`;
}

function finalizeLivePlan(
  live: WorkPlan,
  input: { objective: string; principal: Principal },
): WorkPlan {
  let sanitized = sanitizePlan({ ...live, deterministic: false, source: "live" }, input.principal);
  if (sanitized.tasks.length && sanitized.view !== "form" && sanitized.intent !== "draft") {
    const text = input.objective.toLowerCase();
    // Broad morning briefs stay summary even when a finance/queue cap is among parallel tasks.
    sanitized = { ...sanitized, view: BROAD.test(text) ? "summary" : viewFor(sanitized.tasks, text) };
  }
  return sanitized;
}

function honestEmptyLivePlan(): WorkPlan {
  return {
    intent: "clarification",
    view: "summary",
    tasks: [],
    clarification: "I could not determine which authorized capabilities to use for this request. Please name the domain or records you need.",
    deterministic: false,
    source: "live",
  };
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

  const gated = policyGateBeforeLive(input);
  if (gated) return gated;

  try {
    let live = await livePlan(input);
    let sanitized = finalizeLivePlan(live, input);
    if (shouldRepairLivePlan(sanitized, input)) {
      live = await livePlan(input, livePlanRepairReason(sanitized, input));
      sanitized = finalizeLivePlan(live, input);
    }
    if (!sanitized.tasks.length && !sanitized.unsupported && !sanitized.clarification) {
      return honestEmptyLivePlan();
    }
    return sanitized;
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

function planRequest(input: {
  objective: string;
  principal: Principal;
  selectedEntities?: EntityRef[];
  completedCapabilities?: string[];
  repairReason?: string;
}): PlanModelRequest {
  return {
    objective: input.objective,
    user: { id: input.principal.id, title: input.principal.title, priorities: input.principal.preferences.priorities },
    selectedEntities: input.selectedEntities ?? [],
    completedCapabilities: input.completedCapabilities ?? [],
    capabilities: CAPABILITIES.map((item) => ({
      id: item.id,
      tool: item.tool,
      domain: item.domain,
      description: item.description,
      sideEffect: item.sideEffect,
      inputSchema: item.inputSchema,
      granted: hasGrant(input.principal, item.id),
    })),
    ...(input.repairReason ? { repairReason: input.repairReason } : {}),
  };
}

/** Live models sometimes emit booleans or other non-strings for these fields. */
function optionalPlanText(value: unknown, whenTrue: string): string | undefined {
  if (value == null || value === false) return undefined;
  if (typeof value === "boolean") return whenTrue;
  const text = String(value).trim();
  return text.length ? text : undefined;
}

/**
 * gpt-oss via Explabs often wraps the real plan under a broken key like "final{" when
 * json_object mode is enabled, or buries JSON in markdown fences. Extract a WorkPlan-shaped
 * object without inventing tasks.
 */
export function extractPlanObject(content: unknown): Record<string, unknown> {
  return extractModelJsonObject(content, (obj) => Array.isArray(obj.tasks));
}

function normalizeCapabilityIds(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((item) => {
    if (typeof item === "string" && item.trim()) return [item.trim()];
    if (item && typeof item === "object" && typeof (item as { id?: unknown }).id === "string") {
      const id = String((item as { id: string }).id).trim();
      return id ? [id] : [];
    }
    return [];
  });
}

/**
 * Align task.domain with registry capability domains so sanitize does not strip an otherwise
 * valid plan (e.g. domain "ops" + cap.service.health, or finance caps under "customer").
 */
function coercePlannedTask(item: {
  domain?: unknown;
  question?: unknown;
  capabilities?: unknown;
  entities?: unknown;
}): PlannedTask | undefined {
  const capabilityIds = normalizeCapabilityIds(item.capabilities);
  const known = capabilityIds
    .map((id) => CAPABILITIES.find((entry) => entry.id === id))
    .filter((entry): entry is CapabilityDefinition => Boolean(entry));
  if (!known.length) {
    const domain = String(item.domain ?? "");
    if (!SPECIALISTS.some((specialist) => specialist.id === domain)) return undefined;
    return {
      domain: domain as Domain,
      question: String(item.question ?? ""),
      capabilities: capabilityIds,
      entities: item.entities as EntityRef[] | undefined,
    };
  }
  const domainRaw = String(item.domain ?? "");
  const domainMatches = SPECIALISTS.some((specialist) => specialist.id === domainRaw)
    && known.some((entry) => entry.domain === domainRaw);
  const domain = (domainMatches ? domainRaw : known[0]!.domain) as Domain;
  const capabilities = [...new Set(known.filter((entry) => entry.domain === domain).map((entry) => entry.id))];
  if (!capabilities.length) return undefined;
  return {
    domain,
    question: String(item.question ?? ""),
    capabilities,
    entities: item.entities as EntityRef[] | undefined,
  };
}

function planFromModelJson(parsed: unknown): WorkPlan {
  const raw = extractPlanObject(parsed) as WorkPlan & Record<string, unknown>;
  const viewRaw = typeof raw.view === "string" ? raw.view : "summary";
  const tasks = Array.isArray(raw.tasks)
    ? raw.tasks.flatMap((item) => {
      const coerced = coercePlannedTask(item as { domain?: unknown; question?: unknown; capabilities?: unknown; entities?: unknown });
      return coerced ? [coerced] : [];
    })
    : [];
  return {
    intent: String(raw.intent ?? "work"),
    view: (PLAN_VIEWS.has(viewRaw) ? viewRaw : "summary") as WorkPlan["view"],
    tasks,
    unsupported: optionalPlanText(raw.unsupported, "This request cannot be served with the available capabilities."),
    clarification: optionalPlanText(raw.clarification, "Need a bit more detail before this can be planned."),
    deterministic: false,
    source: "live",
  };
}

const LIVE_PLANNER_SYSTEM = `You are a workflow planner for a multi-specialist workspace.
Return one JSON object only (no markdown fences, no wrapper keys like final, no prose): {intent, view, tasks:[{domain,question,capabilities,entities?}], unsupported?, clarification?}.
Rules:
- view must be one of: summary, table, form, comparison, queue, trend.
- domain must be one of: reliability, product, customer, finance — and must match each capability's registry domain.
- Use capability ids exactly as listed (e.g. cap.service.health, cap.finance.invoices, cap.tickets.read, cap.service.trend, cap.customers.read). Prefer granted:true. Never invent tools.
- Never schedule write/commit tools (sideEffect write), even if granted.
- Skip capabilities listed in completedCapabilities.
- Broad morning / "what needs attention" / "care about" asks: schedule up to three parallel tasks across distinct granted core domains (reliability, product, customer, finance as granted), view summary. Do not return empty tasks or clarification when granted reads can serve the ask.
- Invoice aging / overdue / past-due receivables: finance domain with cap.finance.invoices, view comparison.
- Support queue / unassigned escalations: customer domain with cap.tickets.read, view queue.
- Draft / onboarding checklist: customer (and tickets if useful) read, intent draft, view form; include named customer entity when present.
- Error-rate / service trend over time: reliability with cap.service.trend, view trend.
- If the best-matching capability is granted:false, return unsupported explaining which domain is unavailable — do not substitute an unrelated granted tool.
- If the ask is underspecified (e.g. draft for "these accounts" with no selection), return clarification.
- If you cannot plan, return clarification or unsupported with honest wording. Do not claim "not authorized" when granted:true capabilities exist that could serve the ask.

Examples:
1) Morning COO: {"intent":"work","view":"summary","tasks":[{"domain":"reliability","question":"What reliability signals need attention?","capabilities":["cap.service.health","cap.service.errors","cap.releases.read"]},{"domain":"customer","question":"What customer support evidence needs attention?","capabilities":["cap.tickets.read"]},{"domain":"finance","question":"What overdue invoice exposure needs attention?","capabilities":["cap.finance.invoices"]}]}
2) Ops trend: {"intent":"work","view":"trend","tasks":[{"domain":"reliability","question":"Show service error-rate trend for the requested window.","capabilities":["cap.service.trend"]}]}
3) Finance invoices: {"intent":"work","view":"comparison","tasks":[{"domain":"finance","question":"Compare overdue invoice aging by customer.","capabilities":["cap.finance.invoices"]}]}
4) Support queue: {"intent":"work","view":"queue","tasks":[{"domain":"customer","question":"List unassigned escalations in the support queue.","capabilities":["cap.tickets.read"]}]}
5) Draft customer-001: {"intent":"draft","view":"form","tasks":[{"domain":"customer","question":"Retrieve account context for the draft.","capabilities":["cap.customers.read","cap.tickets.read"],"entities":[{"type":"customer","id":"customer-001"}]}]}`;

async function livePlan(
  input: {
    objective: string;
    principal: Principal;
    selectedEntities?: EntityRef[];
    completedCapabilities?: string[];
    runId?: string;
  },
  repairReason?: string,
): Promise<WorkPlan> {
  const request = planRequest({ ...input, repairReason });
  if (planModelOverride) return planFromModelJson(await planModelOverride(request) as WorkPlan);
  const config = resolveModelConfig();
  if (!config.apiKey || !config.baseURL) throw new Error("Live planner is missing API key or base URL");
  const client = new OpenAI({ apiKey: config.apiKey, baseURL: config.baseURL });
  const userContent = repairReason
    ? `${JSON.stringify(request)}\n\nRepair: ${repairReason}`
    : JSON.stringify(request);
  // Do not set response_format: json_object. gpt-oss-120b via Explabs emits broken
  // {"final{": ...} wrappers under JSON mode, which parse to empty plans after sanitize.
  const response = await client.chat.completions.create({
    model: config.model,
    messages: [
      { role: "system", content: LIVE_PLANNER_SYSTEM },
      { role: "user", content: userContent },
    ],
  });
  if (input.runId) recordUsage(input.runId, response.usage);
  return planFromModelJson(response.choices[0]?.message?.content ?? "{}");
}

export function sanitizePlan(plan: WorkPlan, principal: Principal): WorkPlan {
  const knownDomains = new Set(SPECIALISTS.map((item) => item.id));
  const proposedCount = plan.tasks.length;
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
  if (!tasks.length && !plan.unsupported && !plan.clarification) {
    // Model proposed capabilities that were all stripped → genuine auth failure.
    if (proposedCount > 0) {
      return {
        intent: "unsupported",
        view: "summary",
        tasks: [],
        unsupported: "You are not authorized for the capabilities this request needs.",
        deterministic: plan.deterministic,
        source: plan.source,
      };
    }
    // Empty model plan: do not invent a misleading auth denial; caller may repair.
    return { ...plan, tasks: [], view: plan.view || "summary" };
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
