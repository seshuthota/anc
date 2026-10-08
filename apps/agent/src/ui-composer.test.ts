import { afterEach, describe, expect, it } from "vitest";
import type { PresentationInput } from "@anc/contracts";
import { composeSurface, reviewBriefingBudget, useComposerModel } from "./ui-composer.js";

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

const briefingPresentation: PresentationInput = {
  title: "905 parcels at risk of missing today's promise",
  subtitle: "Records from authorized tools.",
  view: "summary",
  briefing: {
    primary: {
      findingId: "f-at-risk",
      headline: "905 parcels at risk of missing today's promise",
      metric: { metricId: "parcels_at_risk_today", value: "905", label: "Parcels at risk today", definition: "Promised for delivery today, not yet on a truck", windowLabel: "Today · as of 07:00 IST", denominatorLabel: "of 4,000 parcels promised today (22.6%)", evidenceIds: ["ev-1"], resultPath: "totals.atRisk" },
      whyItMatters: "Wave-2 runs are held.",
      chain: [{ text: "Sorter belt B is down", kind: "observed", evidenceIds: ["ev-2"] }],
      confidence: "high",
      evidenceIds: ["ev-1", "ev-2"],
    },
    secondary: [
      { id: "f-a", title: "Hyderabad Hub has 595 parcels waiting to sort", evidenceIds: ["ev-3"], question: "Look into: backlog" },
      { id: "f-b", title: "3 route runs held today", evidenceIds: ["ev-4"], question: "Look into: held runs" },
    ],
    quiet: { label: "Everything else is running to plan.", count: 1 },
    restLabel: "2 lower-priority items · everything else is running to plan",
    actions: [{ id: "drill_primary", label: "Look into this", name: "investigate", entities: [], question: "What is behind this?" }],
  },
  metrics: [],
  findings: [],
  actions: [],
  limitations: ["Question: briefing"],
};

const drill = (id: string, question = "What is behind this?") => [
  { id, component: "Button", child: `${id}_label`, action: { event: { name: "investigate", context: { question } } } },
  { id: `${id}_label`, component: "Text", text: "Look into this" },
];

const goodBriefing: Array<Record<string, unknown>> = [
  { id: "root", component: "Column", children: ["primary_block", "act", "rest", "limits"] },
  { id: "act", component: "Row", children: ["drill_1"] },
  ...drill("drill_1"),
  { id: "rest", component: "Collapsible", summary: { path: "/briefing/restLabel" }, child: "rest_col" },
  { id: "rest_col", component: "Column", children: ["rest_a", "rest_b"] },
  { id: "rest_a", component: "Text", text: { path: "/briefing/secondary/f-a/title" } },
  { id: "rest_b", component: "Text", text: { path: "/briefing/secondary/f-b/title" } },
];

describe("UI Composer briefing budget (R3/R4)", () => {
  afterEach(() => useComposerModel(undefined));

  it("accepts one primary block, one action and the rest collapsed", async () => {
    useComposerModel(async () => ({ components: goodBriefing }));
    const surface = await composeSurface("s", briefingPresentation, { objective: "brief me", mode: "briefing" });
    expect(surface.reason).toBeUndefined();
    expect(surface.source).toBe("model");
    expect(componentsOf(surface).filter((component) => component.component === "PrimaryFinding")).toHaveLength(1);
  });

  it("rejects trees that break the budget", async () => {
    const withRoot = (children: string[], extra: Array<Record<string, unknown>>) => [
      { id: "root", component: "Column", children },
      ...goodBriefing.filter((component) => component.id !== "root"),
      ...extra,
    ];
    const cases: Array<[string, Array<Record<string, unknown>>]> = [
      ["authored second PrimaryFinding", withRoot(["primary_block", "act", "rest", "limits", "p2"], [{ id: "p2", component: "PrimaryFinding", finding: { path: "/briefing/primary" } }])],
      ["four actions", withRoot(["primary_block", "act2", "rest", "limits"], [{ id: "act2", component: "Row", children: ["d1", "d2", "d3", "d4"] }, ...drill("d1"), ...drill("d2"), ...drill("d3"), ...drill("d4")])],
      ["free Stat", withRoot(["primary_block", "act", "rest", "limits", "st"], [{ id: "st", component: "Stat", label: "At risk", value: { path: "/briefing/primary/metric/value" } }])],
      ["free Card", withRoot(["primary_block", "act", "rest", "limits", "cd"], [{ id: "cd", component: "Card", child: "cd_t" }, { id: "cd_t", component: "Text", text: { path: "/briefing/secondary/f-a/title" } }])],
      ["figure without evidence", withRoot(["primary_block", "act", "rest", "limits", "qc"], [{ id: "qc", component: "Text", text: { path: "/briefing/quiet/count" } }])],
      ["two Collapsibles", withRoot(["primary_block", "act", "rest", "rest2", "limits"], [{ id: "rest2", component: "Collapsible", summary: { path: "/briefing/restLabel" }, child: "rest2_t" }, { id: "rest2_t", component: "Text", text: { path: "/briefing/quiet/label" } }])],
      ["secondary outside the collapsible", withRoot(["primary_block", "act", "rest", "limits", "out"], [{ id: "out", component: "Text", text: { path: "/briefing/secondary/f-a/title" } }])],
      ["primary block dropped", withRoot(["act", "rest", "limits"], [])],
    ];
    const reasons: Record<string, RegExp> = {
      "authored second PrimaryFinding": /PrimaryFinding/,
      "four actions": /at most three actions/,
      "free Stat": /Stat/,
      "free Card": /finding cards/,
      "figure without evidence": /no evidenceIds/,
      "two Collapsibles": /at most one Collapsible/,
      "secondary outside the collapsible": /inside the Collapsible/,
      "primary block dropped": /primary_block|PrimaryFinding/,
    };
    for (const [label, components] of cases) {
      useComposerModel(async () => ({ components }));
      const surface = await composeSurface("s", briefingPresentation, { objective: "brief me", mode: "briefing" });
      expect(surface.source, label).toBe("template");
      expect(surface.reason, label).toMatch(reasons[label]!);
    }
  });

  it("the fallback template keeps the same budget", async () => {
    const surface = await composeSurface("s", briefingPresentation, { objective: "brief me", mode: "briefing" });
    const components = componentsOf(surface);
    expect(components.filter((component) => component.component === "PrimaryFinding")).toHaveLength(1);
    expect(components.filter((component) => component.component === "Collapsible")).toHaveLength(1);
    expect(components.filter((component) => ["Stat", "Card", "Sequence"].includes(String(component.component)))).toHaveLength(0);
    const model = surface.messages.find((message) => "updateDataModel" in message) as { updateDataModel: { value: Record<string, unknown> } };
    expect(model.updateDataModel.value.findings).toEqual({});
    expect(model.updateDataModel.value.metrics).toEqual({});
  });

  it("sends the composer only the briefing plan", async () => {
    let seen: unknown;
    useComposerModel(async (request) => { seen = request.data; return { components: goodBriefing }; });
    await composeSurface("s", briefingPresentation, { objective: "brief me", mode: "briefing" });
    expect(Object.keys(seen as object).sort()).toEqual(["briefing", "title"]);
  });

  it("rejects a Collapsible holding four secondary items (A4)", async () => {
    const four: PresentationInput = {
      ...briefingPresentation,
      briefing: {
        ...briefingPresentation.briefing!,
        secondary: [
          ...briefingPresentation.briefing!.secondary,
          { id: "f-c", title: "Chennai locker: 64 arrivals with no space", evidenceIds: ["ev-5"], question: "Look into: lockers" },
          { id: "f-d", title: "11 complaints need an owner", evidenceIds: ["ev-6"], question: "Look into: complaints" },
        ],
      },
    };
    const tree = [
      ...goodBriefing.filter((component) => component.id !== "rest_col"),
      { id: "rest_col", component: "Column", children: ["rest_a", "rest_b", "rest_c", "rest_d"] },
      { id: "rest_c", component: "Text", text: { path: "/briefing/secondary/f-c/title" } },
      { id: "rest_d", component: "Text", text: { path: "/briefing/secondary/f-d/title" } },
    ];
    const feedback: string[] = [];
    useComposerModel(async (_request, previous) => { if (previous) feedback.push(previous); return { components: tree }; });
    const surface = await composeSurface("s", four, { objective: "brief me", mode: "briefing" });
    expect(surface.source).toBe("template");
    expect(feedback.join("\n")).toMatch(/collapsed rest holds at most three items; this tree has 4/);
    // The budget check on its own, independent of whether the paths resolve.
    const byId = new Map(tree.map((component) => [String(component.id), component as Record<string, unknown>]));
    const reachable = new Set(tree.map((component) => String(component.id)));
    expect(reviewBriefingBudget(byId, reachable, tree, { primary: {} })).toEqual(expect.arrayContaining([expect.stringMatching(/at most three items; this tree has 4/)]));
  });

  it("trims more than three secondary items when the fallback template is used (A4)", async () => {
    const five: PresentationInput = {
      ...briefingPresentation,
      briefing: {
        ...briefingPresentation.briefing!,
        secondary: ["a", "b", "c", "d", "e"].map((id) => ({ id: `f-${id}`, title: `Item ${id}`, evidenceIds: [`ev-${id}`], question: `Look into: ${id}` })),
      },
    };
    // Model rejected (it binds a path that does not exist), so the budgeted template is shown.
    useComposerModel(async () => ({ components: [...goodBriefing.filter((component) => component.id !== "rest_a"), { id: "rest_a", component: "Text", text: { path: "/briefing/secondary/f-zz/title" } }] }));
    const surface = await composeSurface("s", five, { objective: "brief me", mode: "briefing" });
    expect(surface.source).toBe("template");
    const components = componentsOf(surface);
    const items = components.find((component) => component.id === "rest_items") as { children: string[] };
    expect(items.children).toHaveLength(3);
    const model = surface.messages.find((message) => "updateDataModel" in message) as { updateDataModel: { value: { briefing: { secondary: Record<string, unknown> } } } };
    expect(Object.keys(model.updateDataModel.value.briefing.secondary)).toEqual(["f-a", "f-b", "f-c"]);
    const drills = components.filter((component) => component.component === "Button" && (component.action as { event: { name: string } }).event.name === "investigate" && String(component.id).startsWith("rest_"));
    expect(drills).toHaveLength(3);
  });
});
