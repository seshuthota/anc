import type { AgentFinding } from "@anc/contracts";
import OpenAI from "openai";
import type { BriefingPlan } from "./rank.js";
import { rankBriefing, reviewLeadAnalystRanking } from "./rank.js";
import type { ReconcileResult } from "./reconcile.js";
import { resolveExecutionMode, resolveModelConfig } from "./provider.js";
import { specialistLabel } from "./registry.js";
import { recordUsage } from "./usage.js";
import type { Principal } from "@anc/policy";

/**
 * What the lead analyst concludes from the specialists' separate findings: the
 * one thing that matters most, the chain of cause and effect behind it, and
 * the issues that are not part of that chain.
 */
export type Synthesis = {
  headline: string;
  steps: Array<{ id: string; text: string; kind: "observed" | "inferred"; findingIds: string[] }>;
  separate: Array<{ id: string; text: string; findingIds: string[] }>;
  primaryFindingId?: string;
  secondaryFindingIds?: string[];
  whyItMatters?: string;
  confidence?: "high" | "medium" | "low";
  chain?: Array<{ text: string; kind: "observed" | "inferred"; findingIds: string[] }>;
};

export type SynthesisRequest = {
  objective: string;
  audience: string;
  findings: Array<{ id: string; from: string; kind: string; severity: string; title: string; summary: string; about: string[] }>;
  eligiblePrimaryIds?: string[];
};

/** Test seam. Production synthesis calls the configured model. */
let synthesisModelOverride: ((request: SynthesisRequest, feedback?: string) => Promise<unknown>) | undefined;

export function useSynthesisModel(model: typeof synthesisModelOverride) {
  synthesisModelOverride = model;
}

const SYSTEM = `You are the lead analyst at an Indian parcel carrier. Specialists have each investigated one part of the network and do not see each other's work. Your job is to connect what they found into one account a busy person can act on.

- headline: the single most important thing for this audience right now, in at most 16 words.
- primaryFindingId: the finding id that is the one primary issue (must be one of eligiblePrimaryIds when provided).
- secondaryFindingIds: up to three other finding ids worth a collapsed mention.
- whyItMatters: one sentence for this audience.
- confidence: "high" | "medium" | "low".
- chain: up to three hops {text, kind, findingIds}; kind "observed" or "inferred".
- steps: two to six short sentences in order of cause and effect (legacy support). Each cites findingIds.
- separate: up to four issues not part of that chain.
- Use only figures, names and times that appear in the findings. Name places and shippers by name.

Reply with one JSON object including headline, primaryFindingId, secondaryFindingIds, whyItMatters, confidence, chain, steps, separate.`;

function review(reply: unknown, request: SynthesisRequest): { synthesis?: Synthesis; errors: string[] } {
  const errors: string[] = [];
  const value = (reply ?? {}) as {
    headline?: unknown; steps?: unknown; separate?: unknown;
    primaryFindingId?: unknown; secondaryFindingIds?: unknown; whyItMatters?: unknown; confidence?: unknown; chain?: unknown;
  };
  const known = new Set(request.findings.map((finding) => finding.id));
  const haystack = `${JSON.stringify(request.findings)} ${request.objective}`;
  const figures = (text: string, where: string) => {
    for (const figure of text.match(/\d[\d,.:]*\d|\d/g) ?? []) {
      if (!haystack.includes(figure)) errors.push(`${where} contains "${figure}", which is not in the findings`);
    }
  };
  const headline = typeof value.headline === "string" ? value.headline.trim() : "";
  if (!headline) errors.push("headline is missing");
  else figures(headline, "the headline");
  const entries = (list: unknown, where: string, withKind: boolean) => (Array.isArray(list) ? list : []).map((item, index) => {
    const entry = (item ?? {}) as { text?: unknown; kind?: unknown; findingIds?: unknown };
    const text = typeof entry.text === "string" ? entry.text.trim() : "";
    const findingIds = Array.isArray(entry.findingIds) ? [...new Set(entry.findingIds.map(String))] : [];
    if (!text) errors.push(`${where} ${index + 1} has no text`);
    else figures(text, `${where} ${index + 1}`);
    if (text.length > 260) errors.push(`${where} ${index + 1} is too long`);
    if (!findingIds.length) errors.push(`${where} ${index + 1} cites no finding`);
    for (const id of findingIds) if (!known.has(id)) errors.push(`${where} ${index + 1} cites unknown finding ${id}`);
    if (withKind && entry.kind !== "observed" && entry.kind !== "inferred") errors.push(`${where} ${index + 1} needs kind "observed" or "inferred"`);
    return { id: `${where}-${index + 1}`, text, kind: entry.kind === "inferred" ? "inferred" as const : "observed" as const, findingIds };
  });
  const steps = entries(value.steps, "step", true);
  const separate = entries(value.separate, "separate", false).map(({ id, text, findingIds }) => ({ id, text, findingIds }));
  if (!steps.length) errors.push("at least one step is required");
  if (steps.length > 6) errors.push("at most six steps");
  if (separate.length > 4) errors.push("at most four separate issues");

  const primaryFindingId = typeof value.primaryFindingId === "string" ? value.primaryFindingId : undefined;
  const secondaryFindingIds = Array.isArray(value.secondaryFindingIds) ? value.secondaryFindingIds.map(String).slice(0, 3) : undefined;
  const whyItMatters = typeof value.whyItMatters === "string" ? value.whyItMatters.trim() : undefined;
  const confidence = value.confidence === "high" || value.confidence === "medium" || value.confidence === "low" ? value.confidence : undefined;
  const chain = entries(value.chain, "chain", true).slice(0, 3).map(({ text, kind, findingIds }) => ({ text, kind, findingIds }));
  if (primaryFindingId && request.eligiblePrimaryIds && !request.eligiblePrimaryIds.includes(primaryFindingId)) {
    errors.push(`primaryFindingId ${primaryFindingId} is not eligible`);
  }
  if (primaryFindingId && !known.has(primaryFindingId)) errors.push(`primaryFindingId ${primaryFindingId} is unknown`);

  return errors.length ? { errors: [...new Set(errors)] } : {
    synthesis: { headline, steps, separate, primaryFindingId, secondaryFindingIds, whyItMatters, confidence, chain: chain.length ? chain : undefined },
    errors,
  };
}

async function askModel(request: SynthesisRequest, runId: string | undefined, feedback?: string): Promise<unknown> {
  if (synthesisModelOverride) return synthesisModelOverride(request, feedback);
  const config = resolveModelConfig();
  if (!config.apiKey || !config.baseURL) throw new Error("Lead analyst is missing API key or base URL");
  const client = new OpenAI({ apiKey: config.apiKey, baseURL: config.baseURL });
  const response = await client.chat.completions.create({
    model: config.model,
    response_format: { type: "json_object" },
    messages: [
      { role: "system", content: SYSTEM },
      { role: "user", content: JSON.stringify(request) },
      ...(feedback ? [{ role: "user" as const, content: `Your previous answer was rejected:\n${feedback}\nSend a corrected JSON object.` }] : []),
    ],
  });
  if (runId) recordUsage(runId, response.usage);
  const content = response.choices[0]?.message?.content ?? "{}";
  return JSON.parse(content.match(/\{[\s\S]*\}/)?.[0] ?? content);
}

function planToSynthesis(plan: BriefingPlan, findings: AgentFinding[]): Synthesis | undefined {
  if (plan.quiet || !plan.primary) return undefined;
  const primary = findings.find((finding) => finding.findingId === plan.primary!.findingId);
  if (!primary) return undefined;
  return {
    headline: primary.title,
    steps: plan.primary.chain.map((step, index) => ({ id: `step-${index + 1}`, text: step.text, kind: step.kind, findingIds: step.findingIds })),
    separate: plan.secondary.map((item, index) => ({ id: `separate-${index + 1}`, text: item.title, findingIds: [item.findingId] })),
    primaryFindingId: plan.primary.findingId,
    secondaryFindingIds: plan.secondary.map((item) => item.findingId),
    whyItMatters: plan.primary.whyItMatters,
    confidence: plan.primary.confidence,
    chain: plan.primary.chain,
  };
}

/**
 * Connects the specialists' findings. In fixture mode (or when the model is
 * rejected), the deterministic ranker supplies the primary/secondary plan.
 */
export async function synthesize(input: {
  objective: string;
  audience: string;
  findings: AgentFinding[];
  runId?: string;
  reconciled?: ReconcileResult;
  principal?: Principal;
}): Promise<{ synthesis?: Synthesis; briefingPlan?: BriefingPlan; reason?: string }> {
  const reconciled = input.reconciled ?? { metrics: [], conflicts: [], notes: [] };
  const ranked = rankBriefing({ findings: input.findings, reconciled, principal: input.principal });

  if (input.findings.length < 2) {
    return { briefingPlan: ranked, synthesis: planToSynthesis(ranked, input.findings) };
  }
  if (resolveExecutionMode() === "fixture" && !synthesisModelOverride) {
    return { briefingPlan: ranked, synthesis: planToSynthesis(ranked, input.findings) };
  }

  const eligiblePrimaryIds = [
    ...(ranked.primary ? [ranked.primary.findingId] : []),
    ...ranked.secondary.map((item) => item.findingId),
  ];
  const request: SynthesisRequest = {
    objective: input.objective,
    audience: input.audience,
    eligiblePrimaryIds,
    findings: input.findings.map((finding) => ({
      id: finding.findingId,
      from: specialistLabel(finding.agentId as Parameters<typeof specialistLabel>[0]),
      kind: finding.kind,
      severity: finding.severity,
      title: finding.title,
      summary: finding.summary,
      about: finding.entities.map((entity) => entity.label ?? entity.id),
    })),
  };
  let feedback: string | undefined;
  let reason = "";
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const checked = review(await askModel(request, input.runId, feedback), request);
      if (checked.synthesis) {
        const rankingErrors = reviewLeadAnalystRanking({
          primaryFindingId: checked.synthesis.primaryFindingId,
          secondaryFindingIds: checked.synthesis.secondaryFindingIds,
          findings: input.findings,
          reconciled,
        });
        if (rankingErrors.length) {
          feedback = rankingErrors.slice(0, 10).map((error) => `- ${error}`).join("\n");
          reason = rankingErrors[0]!;
          continue;
        }
        return { synthesis: checked.synthesis, briefingPlan: ranked };
      }
      feedback = checked.errors.slice(0, 10).map((error) => `- ${error}`).join("\n");
      reason = checked.errors[0]!;
    } catch (error) {
      reason = error instanceof Error ? error.message : "synthesis failed";
      feedback = `- ${reason}`;
    }
  }
  // Model rejected: substitute the deterministic ranker.
  return { briefingPlan: ranked, synthesis: planToSynthesis(ranked, input.findings), reason: reason || "lead analyst ranking rejected; using deterministic ranker" };
}
