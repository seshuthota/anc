import { readFileSync } from "node:fs";
import type { ComposerModelRequest } from "../ui-composer.js";
import type { SynthesisRequest } from "../synthesis.js";

type Json = unknown;
const dir = new URL("../__fixtures__/model-replies/", import.meta.url);
const load = (name: string) => (JSON.parse(readFileSync(new URL(name, dir), "utf8")) as { replies: Json[] }).replies;

/** Counts what the replayed models were asked, so the eval can check the repair loop ran. */
export type ReplayLog = { synthesisCalls: number; composerCalls: number };

function fill(value: Json, vars: Record<string, string>): Json {
  if (typeof value === "string") return value.replace(/\{\{([\w.]+)\}\}/g, (_, key: string) => vars[key] ?? "");
  if (Array.isArray(value)) return value.map((item) => fill(item, vars));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, fill(item, vars)]));
  return value;
}

/** Lead Analyst replay: reply 1 first, reply 2 after a rejection. */
export function synthesisReplay(log: ReplayLog) {
  const replies = load("synthesis.json");
  return async (request: SynthesisRequest, feedback?: string) => {
    log.synthesisCalls += 1;
    const primary = request.findings.find((finding) => finding.id === request.primaryFindingId);
    return fill(replies[feedback ? 1 : 0], {
      primaryFindingId: request.primaryFindingId ?? "",
      "primary.title": primary?.title ?? "",
      "primary.summary": primary?.summary ?? primary?.title ?? "",
    });
  };
}

type Component = Record<string, unknown> & { id: string };

/**
 * UI Composer replay. The JSON gives the shape; "$blocks", "$actions", "$rest" and
 * "$quiet" in a children list expand from the request: the runtime-built blocks,
 * one Button per offered action (its literal label, its catalog id), the secondary
 * items in one Collapsible bound to /briefing/restLabel, and the calm line.
 */
export function composerReplay(log: ReplayLog) {
  const replies = load("composer-briefing.json");
  return async (request: ComposerModelRequest, feedback?: string) => {
    log.composerCalls += 1;
    const reply = structuredClone(replies[feedback ? 1 : 0]) as { components: Component[] };
    const briefing = (request.data as { briefing?: { primary?: unknown; secondary?: Record<string, { question?: string }> } }).briefing ?? {};
    const extra: Component[] = [];
    const expand = (child: string): string[] => {
      if (child === "$blocks") return request.blocks.map((block) => block.id);
      if (child === "$actions") {
        if (!request.actions.length) return [];
        const ids = request.actions.map((action, index) => {
          const id = `rp_action_${index}`;
          extra.push(
            { id, component: "Button", child: `${id}_label`, variant: "primary", action: { event: { name: action.name, context: action.actionId ? { actionId: action.actionId } : {} } } },
            { id: `${id}_label`, component: "Text", text: action.label },
          );
          return id;
        });
        extra.push({ id: "rp_actions", component: "Row", children: ids });
        return ["rp_actions"];
      }
      if (child === "$rest") {
        const items = Object.entries(briefing.secondary ?? {});
        if (!items.length) return [];
        const rows = items.map(([itemId, item], index) => {
          const id = `rp_rest_${index}`;
          extra.push(
            { id, component: "Row", justify: "spaceBetween", children: [`${id}_title`, `${id}_drill`] },
            { id: `${id}_title`, component: "Text", text: { path: `/briefing/secondary/${itemId}/title` } },
            { id: `${id}_drill`, component: "Button", child: `${id}_drill_label`, variant: "borderless", action: { event: { name: "investigate", context: { question: item.question ?? "" } } } },
            { id: `${id}_drill_label`, component: "Text", text: "Look into this" },
          );
          return id;
        });
        extra.push({ id: "rp_rest", component: "Collapsible", summary: { path: "/briefing/restLabel" }, child: "rp_rest_items" }, { id: "rp_rest_items", component: "Column", children: rows });
        return ["rp_rest"];
      }
      if (child === "$quiet") {
        if (briefing.primary) return [];
        extra.push({ id: "rp_quiet_title", component: "Text", text: { path: "/title" }, variant: "h2" }, { id: "rp_quiet_label", component: "Text", text: { path: "/briefing/quiet/label" } });
        return ["rp_quiet_title", "rp_quiet_label"];
      }
      return [child];
    };
    const components = reply.components.map((component) => (Array.isArray(component.children) ? { ...component, children: (component.children as string[]).flatMap(expand) } : component));
    return { components: [...components, ...extra] };
  };
}
