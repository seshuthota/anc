import { afterEach, describe, expect, it } from "vitest";
import type { PresentationInput } from "@anc/contracts";
import { composeSurface, useComposerModel } from "./ui-composer.js";

const presentation: PresentationInput = {
  title: "Overdue invoices",
  subtitle: "Records from authorized tools.",
  view: "comparison",
  metrics: [{ id: "m1", label: "Overdue total", value: "$300,000.00", evidenceId: "ev-1" }],
  findings: [{ id: "f1", title: "Eight invoices are overdue", body: "Each is $37,500.00.", kind: "observation", evidenceIds: ["ev-1"] }],
  table: { id: "t", columns: ["Customer", "Amount"], rows: [{ id: "r1", cells: ["customer-001", "$37,500.00"] }], totals: ["$37,500.00"] },
  actions: [{ id: "finance", label: "Inspect financial impact", name: "inspect_financial_impact", entities: [{ type: "customer", id: "customer-001" }] }],
  limitations: ["Question: overdue invoices"],
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
  { id: "next", component: "Button", child: "next_label", action: { event: { name: "inspect_financial_impact", context: { entities: [{ type: "customer", id: "someone-else" }] } } } },
  { id: "next_label", component: "Text", text: "Inspect financial impact" },
];

function componentsOf(surface: Awaited<ReturnType<typeof composeSurface>>) {
  return (surface.messages.find((message) => "updateComponents" in message) as { updateComponents: { components: Array<Record<string, unknown>> } }).updateComponents.components;
}

describe("UI Composer", () => {
  afterEach(() => useComposerModel(undefined));

  it("uses the standard layout when no model is configured", async () => {
    const surface = await composeSurface("s", presentation, { objective: "overdue invoices" });
    expect(surface.source).toBe("template");
    expect(surface.reason).toBeUndefined();
  });

  it("accepts a model-authored tree and keeps runtime-built blocks and action targets", async () => {
    useComposerModel(async () => ({ components: good }));
    const surface = await composeSurface("s", presentation, { objective: "overdue invoices" });
    expect(surface.source).toBe("model");
    const components = componentsOf(surface);
    expect(components.find((component) => component.id === "table_block")?.component).toBe("Table");
    // The model named the action; the runtime decides which records it applies to.
    const next = components.find((component) => component.id === "next") as { action: { event: { context: { entities: Array<{ id: string }> } } } };
    expect(next.action.event.context.entities[0]?.id).toBe("customer-001");
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
      const surface = await composeSurface("s", presentation, { objective: "overdue invoices" });
      expect(surface.source, label).toBe("template");
      expect(surface.reason, label).toBeTruthy();
      expect(calls, label).toBe(2);
    }
  });

  it("rejects a tree that drops a provided block and overrules one that redefines it", async () => {
    useComposerModel(async () => ({ components: good.map((component) => (component.id === "root" ? { ...component, children: ["head", "limits"] } : component)) }));
    expect((await composeSurface("s", presentation, { objective: "overdue invoices" })).source).toBe("template");
    // Redefining a block does not replace it: the runtime's table is what is shown.
    useComposerModel(async () => ({ components: [...good, { id: "table_block", component: "Text", text: "no table today" }] }));
    const overruled = await composeSurface("s", presentation, { objective: "overdue invoices" });
    expect(overruled.source).toBe("model");
    expect(componentsOf(overruled).find((component) => component.id === "table_block")?.component).toBe("Table");
  });

  it("repairs once using the rejection as feedback", async () => {
    useComposerModel(async (_request, feedback) => ({
      components: feedback ? good : good.map((component) => (component.id === "head" ? { ...component, text: { path: "/nope" } } : component)),
    }));
    const surface = await composeSurface("s", presentation, { objective: "overdue invoices" });
    expect(surface.source).toBe("model");
  });
});
