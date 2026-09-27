import type { Domain, EntityRef, SemanticAction } from "@anc/contracts";
import { hasGrant, type Principal } from "@anc/policy";
import OpenAI from "openai";
import { recordSubstitution } from "./execution.js";
import { resolveExecutionMode, resolveModelConfig } from "./provider.js";
import { authorizedCapabilities, CAPABILITIES, SPECIALISTS, type CapabilityDefinition } from "./registry.js";
import { recordUsage } from "./usage.js";

export type PlannedTask = {
  domain: Domain;
  question: string;
  capabilities: string[];
};

export type WorkPlan = {
  intent: string;
  view: "summary" | "table" | "form" | "comparison" | "queue";
  tasks: PlannedTask[];
  clarification?: string;
  unsupported?: string;
  deterministic: boolean;
  source: "fixture" | "live";
};

const STOP = new Set(["about", "should", "what", "know", "this", "that", "with", "from", "have", "need", "needs", "show", "list", "give", "tell", "please", "the", "and", "for", "any", "our", "you"]);
const BROAD = /attention|this morning|start of the day|going on with the company|need to know|care about|anything on fire|brief me|overnight|unusual/;
const UNSUPPORTED_WRITE = /refund|wire transfer|payroll|send email to all customers|delete all/;

export type PlanModelRequest = {
  objective: string;
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
  const tableView = /as a table|show this as a table|in a table/.test(text);
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
  const authorized = authorizedCapabilities(input.principal).filter((item) => item.sideEffect === "read" || /assign|owner/.test(input.objective.toLowerCase()));
  const scored = authorized.map((capability) => ({ capability, score: scoreCapability(input.objective, input.principal, capability) }));
  const broad = BROAD.test(input.objective.toLowerCase());
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
  const view = broad
    ? "summary"
    : selected.some((item) => item.capabilities.includes("cap.tickets.assign") || item.capabilities.includes("cap.tickets.read") && /assign|unassigned|queue|owner/.test(input.objective.toLowerCase()))
      ? "queue"
      : selected.some((item) => item.capabilities.some((id) => CAPABILITIES.find((cap) => cap.id === id)?.rowEntity))
        ? "table"
        : "summary";
  return sanitizePlan({ intent: "work", view, tasks: selected.slice(0, 3), deterministic: true, source: "fixture" }, input.principal);
}

function planRequest(input: { objective: string; principal: Principal; selectedEntities?: EntityRef[]; completedCapabilities?: string[] }): PlanModelRequest {
  return {
    objective: input.objective,
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
        content: "You are a workflow planner. Propose at most three specialist tasks using only the provided authorized capabilities. Never invent tools. Do not schedule write/commit tools. Skip capabilities listed as already completed. If affected account ids are present and an authorized exposure capability is not completed, you may add that task. If the request cannot be served, return unsupported. Return JSON {intent, view, tasks:[{domain,question,capabilities}], unsupported?, clarification?}. view is summary, table, form, comparison, or queue.",
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

function scoreCapability(objective: string, principal: Principal, capability: CapabilityDefinition): number {
  const haystack = `${capability.id} ${capability.tool} ${capability.description} ${capability.rowEntity ?? ""}`.toLowerCase();
  const words = objective.toLowerCase().split(/[^a-z0-9]+/).filter((word) => word.length > 3 && !STOP.has(word));
  let score = words.filter((word) => haystack.includes(word)).length;
  for (const priority of principal.preferences.priorities) {
    const overlap = priority.toLowerCase().split(/[^a-z0-9]+/).filter((word) => word.length > 3 && haystack.includes(word));
    if (overlap.length && (BROAD.test(objective.toLowerCase()) || words.some((word) => priority.toLowerCase().includes(word)))) {
      score += overlap.length;
    }
  }
  return score;
}

function task(domain: Domain, question: string, capabilities: string[]): PlannedTask {
  return { domain, question, capabilities };
}
