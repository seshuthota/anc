import { afterEach, describe, expect, it } from "vitest";
import type { PresentationInput } from "@anc/contracts";
import { composeSurface, useComposerModel } from "./ui-composer.js";

const presentation: PresentationInput = {
  title: "Parcels at risk today",
  subtitle: "Records from authorized tools.",
  view: "comparison",
  metrics: [{ id: "m1", label: "At risk today", value: "905", evidenceId: "ev-1" }],
  findings: [{ id: "f1", title: "Hyderabad sorter fault puts 905 parcels at risk", body: "Promised for delivery today, not yet on a truck.", kind: "observation", evidenceIds: ["ev-1"] }],
  table: { id: "t", columns: ["Shipper", "At risk"], rows: [{ id: "r1", cells: ["Godavari Organics", "218"] }], totals: ["218"] },
  actions: [{ id: "drill", label: "Look into Hyderabad", name: "show_as_table", entities: [{ type: "hub", id: "hub-hyd" }] }],
  limitations: ["Question: parcels at risk"],
};

const good = [
  { id: "root", component: "Column", children: ["head", "metric_card", "finding_card", "table_block", "next", "limits"] },
  { id: "head", component: "Text", text: { path: "/title" }, variant: "h2" },
  { id: "metric_card", component: "Card", child: "metric_value" },
  { id: "metric_value", component: "Text", text: { path: "/metrics/m1/value" }, variant: "h3" },
  { id: "finding_card", component: "Card", child: "finding_col" },
  { id: "finding_col", component: "Column", children: ["finding_title", "finding_kind", "finding_source"] },
  { id: "finding_title", component: "Text", text: { path: "/findings/f1/title" } },
  { id: "finding_kind", component: "Text", text: { path: "/findings/f1/kindLabel" }, variant: "caption" },
  { id: "finding_source", component: "Button", child: "finding_source_label", variant: "borderless", action: { event: { name: "show_evidence", context: { evidenceIds: ["ev-1"] } } } },
  { id: "finding_source_label", component: "Text", text: "View evidence" },
  { id: "next", component: "Button", child: "next_label", action: { event: { name: "show_as_table", context: { entities: [{ type: "hub", id: "someone-else" }] } } } },
  { id: "next_label", component: "Text", text: "Look into Hyderabad" },
];

function componentsOf(surface: Awaited<ReturnType<typeof composeSurface>>) {
  return (surface.messages.find((message) => "updateComponents" in message) as { updateComponents: { components: Array<Record<string, unknown>> } }).updateComponents.components;
}

describe("UI Composer", () => {
  afterEach(() => useComposerModel(undefined));

  it("uses the standard layout when no model is configured", async () => {
    const surface = await composeSurface("s", presentation, { objective: "parcels at risk" });
    expect(surface.source).toBe("template");
    expect(surface.reason).toBeUndefined();
  });

  it("accepts a model-authored tree and keeps runtime-built blocks and action targets", async () => {
    useComposerModel(async () => ({ components: good }));
    const surface = await composeSurface("s", presentation, { objective: "parcels at risk" });
    expect(surface.source).toBe("model");
    const components = componentsOf(surface);
    expect(components.find((component) => component.id === "table_block")?.component).toBe("Table");
    // The model named the action; the runtime decides which records it applies to.
    const next = components.find((component) => component.id === "next") as { action: { event: { context: { entities: Array<{ id: string }> } } } };
    expect(next.action.event.context.entities[0]?.id).toBe("hub-hyd");
  });

  it("rejects figures, paths, actions and evidence the data does not contain", async () => {
    const cases: Array<[string, Record<string, unknown>]> = [
      ["figure", { id: "head", component: "Text", text: "Revenue at risk is $9,999,999" }],
      ["path", { id: "head", component: "Text", text: { path: "/findings/invented/title" } }],
      ["action", { id: "next", component: "Button", child: "next_label", action: { event: { name: "commit_assignment" } } }],
      ["evidence", { id: "finding_source", component: "Button", child: "finding_source_label", action: { event: { name: "show_evidence", context: { evidenceIds: ["ev-999"] } } } }],
    ];
    for (const [label, replacement] of cases) {
      let calls = 0;
      useComposerModel(async () => {
        calls += 1;
        return { components: good.map((component) => (component.id === replacement.id ? replacement : component)) };
      });
      const surface = await composeSurface("s", presentation, { objective: "parcels at risk" });
      expect(surface.source, label).toBe("template");
      expect(surface.reason, label).toBeTruthy();
      expect(calls, label).toBe(2);
    }
  });

  it("rejects a tree that drops a provided block and overrules one that redefines it", async () => {
    useComposerModel(async () => ({ components: good.map((component) => (component.id === "root" ? { ...component, children: ["head", "limits"] } : component)) }));
    expect((await composeSurface("s", presentation, { objective: "parcels at risk" })).source).toBe("template");
    // Redefining a block does not replace it: the runtime's table is what is shown.
    useComposerModel(async () => ({ components: [...good, { id: "table_block", component: "Text", text: "no table today" }] }));
    const overruled = await composeSurface("s", presentation, { objective: "parcels at risk" });
    expect(overruled.source).toBe("model");
    expect(componentsOf(overruled).find((component) => component.id === "table_block")?.component).toBe("Table");
  });

  it("repairs once using the rejection as feedback", async () => {
    useComposerModel(async (_request, feedback) => ({
      components: feedback ? good : good.map((component) => (component.id === "head" ? { ...component, text: { path: "/nope" } } : component)),
    }));
    const surface = await composeSurface("s", presentation, { objective: "parcels at risk" });
    expect(surface.source).toBe("model");
  });
});
