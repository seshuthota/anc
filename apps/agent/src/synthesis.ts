import type { AgentFinding } from "@anc/contracts";
import OpenAI from "openai";
import { resolveExecutionMode, resolveModelConfig } from "./provider.js";
import { specialistLabel } from "./registry.js";
import { recordUsage } from "./usage.js";

/**
 * What the lead analyst concludes from the specialists' separate findings: the
 * one thing that matters most, the chain of cause and effect behind it, and
 * the issues that are not part of that chain.
 */
export type Synthesis = {
  headline: string;
  steps: Array<{ id: string; text: string; kind: "observed" | "inferred"; findingIds: string[] }>;
  separate: Array<{ id: string; text: string; findingIds: string[] }>;
};

export type SynthesisRequest = {
  objective: string;
  audience: string;
  findings: Array<{ id: string; from: string; kind: string; severity: string; title: string; summary: string; about: string[] }>;
};

/** Test seam. Production synthesis calls the configured model. */
let synthesisModelOverride: ((request: SynthesisRequest, feedback?: string) => Promise<unknown>) | undefined;

export function useSynthesisModel(model: typeof synthesisModelOverride) {
  synthesisModelOverride = model;
}

const SYSTEM = `You are the lead analyst at an Indian parcel carrier. Specialists have each investigated one part of the network and do not see each other's work. Your job is to connect what they found into one account a busy person can act on.

- headline: the single most important thing for this audience right now, in at most 16 words.
- steps: two to six short sentences in order of cause and effect, starting from the root cause if one is visible and ending with the consequences for customers. Each at most 30 words, each citing the findingIds it rests on.
  - kind "observed" when the step only restates what a finding observed.
  - kind "inferred" when the step links findings that no single specialist linked, such as saying one caused another. Say plainly when a link is likely but not proven.
- separate: up to four issues that are not part of that chain, because they are in a different place or have a different cause. Do not force a connection that the findings do not support.
- Use only figures, names and times that appear in the findings. Name places and shippers by name.
- If the findings do not connect at all, give the most important ones as "observed" steps and say in the headline that they are unrelated.

Reply with one JSON object: {"headline": string, "steps": [{"text", "kind", "findingIds": []}], "separate": [{"text", "findingIds": []}]}.`;

function review(reply: unknown, request: SynthesisRequest): { synthesis?: Synthesis; errors: string[] } {
  const errors: string[] = [];
  const value = (reply ?? {}) as { headline?: unknown; steps?: unknown; separate?: unknown };
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
  return errors.length ? { errors: [...new Set(errors)] } : { synthesis: { headline, steps, separate }, errors };
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

/**
 * Connects the specialists' findings. Returns nothing when there is no model or
 * too little to connect; the answer is then the findings side by side. A
 * synthesis only cites findings that exist and only repeats figures they contain.
 */
export async function synthesize(input: { objective: string; audience: string; findings: AgentFinding[]; runId?: string }): Promise<{ synthesis?: Synthesis; reason?: string }> {
  if (input.findings.length < 2) return {};
  if (resolveExecutionMode() === "fixture" && !synthesisModelOverride) return {};
  const request: SynthesisRequest = {
    objective: input.objective,
    audience: input.audience,
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
      if (checked.synthesis) return { synthesis: checked.synthesis };
      feedback = checked.errors.slice(0, 10).map((error) => `- ${error}`).join("\n");
      reason = checked.errors[0]!;
    } catch (error) {
      reason = error instanceof Error ? error.message : "synthesis failed";
      feedback = `- ${reason}`;
    }
  }
  return { reason };
}
