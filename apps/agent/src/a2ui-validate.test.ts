import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { A2UI_COMPONENT_TYPES } from "@anc/contracts/catalog";
import { composeA2UI } from "./composer.js";
import { validateA2UI } from "./a2ui-validate.js";

describe("A2UI validation", () => {
  it("accepts composer output", () => {
    const { messages } = composeA2UI("surface-1", {
      title: "Morning overview",
      subtitle: "Verified findings",
      view: "summary",
      metrics: [{ id: "errors", label: "error rate", value: "5.8%", evidenceId: "ev-1", tone: "danger" }],
      findings: [{ id: "f1", title: "Elevated errors", body: "Observed.", kind: "observation", evidenceIds: ["ev-1"] }],
      actions: [{ id: "accounts", label: "Show affected accounts", name: "show_affected_accounts", entities: [] }],
      limitations: [],
    });
    expect(validateA2UI(messages)).toEqual([]);
  });

  it("rejects dangling children and unknown actions", () => {
    const errors = validateA2UI([
      { version: "v0.9", createSurface: { surfaceId: "s", catalogId: "https://a2ui.org/specification/v0_9/catalogs/basic/catalog.json" } },
      { version: "v0.9", updateComponents: { surfaceId: "s", components: [
        { id: "root", component: "Column", children: ["missing"] },
        { id: "btn", component: "Button", text: "x", action: { event: { name: "delete_company" } } },
      ] } },
    ]);
    expect(errors.some((item) => item.includes("dangling"))).toBe(true);
    expect(errors.some((item) => item.includes("unknown action"))).toBe(true);
  });

  it("rejects a component type outside the shared catalog", () => {
    const errors = validateA2UI([
      { version: "v0.9", createSurface: { surfaceId: "s", catalogId: "https://a2ui.org/specification/v0_9/catalogs/basic/catalog.json" } },
      { version: "v0.9", updateComponents: { surfaceId: "s", components: [
        { id: "root", component: "Column", children: ["x"] },
        { id: "x", component: "Carousel" },
      ] } },
    ]);
    expect(errors.some((item) => item.includes("unsupported component Carousel"))).toBe(true);
  });

  /**
   * Guards the defect where the validator accepted `Table`/`TextField` while the
   * renderer returned null for them, so an accepted surface rendered blank.
   * The renderer is a client module, so this is a static source check.
   */
  it("renders every component type the validator accepts", () => {
    const source = readFileSync(fileURLToPath(new URL("../../web/lib/a2ui.tsx", import.meta.url)), "utf8");
    const unhandled = A2UI_COMPONENT_TYPES.filter((type) => !source.includes(`type === "${type}"`));
    expect(unhandled).toEqual([]);
  });
});

describe("view-driven composition", () => {
  it("emits a real table with totals, not a list of buttons", () => {
    const { messages } = composeA2UI("surface-t", {
      title: "Overdue invoices",
      subtitle: "By customer",
      view: "comparison",
      metrics: [],
      findings: [],
      table: {
        id: "invoices",
        columns: ["Customer", "Amount"],
        rows: [{ id: "r1", cells: ["Acme", "$9.0M"], sortValues: [1, 9] }],
        totals: ["$9.0M"],
        defaultSort: 1,
        completeness: "complete",
      },
      actions: [],
      limitations: [],
    });
    expect(validateA2UI(messages)).toEqual([]);
    const components = messages.flatMap((message) => ("updateComponents" in message ? message.updateComponents?.components ?? [] : []));
    expect(components.some((component) => component.component === "Table")).toBe(true);
    expect(components.some((component) => component.component === "Button" && component.text === "Acme")).toBe(false);
  });

  it("emits a chart for a trend view", () => {
    const { messages } = composeA2UI("surface-c", {
      title: "Error rate",
      subtitle: "Past week",
      view: "trend",
      metrics: [],
      findings: [],
      chart: { id: "s1", title: "Service error rate", unit: "error rate", points: [{ label: "d1", value: 0.01 }, { label: "d2", value: 0.06 }] },
      actions: [],
      limitations: [],
    });
    expect(validateA2UI(messages)).toEqual([]);
    const components = messages.flatMap((message) => ("updateComponents" in message ? message.updateComponents?.components ?? [] : []));
    expect(components.some((component) => component.component === "Chart")).toBe(true);
  });

  it("emits editable fields, completion toggles and a save action for a draft", () => {
    const { messages } = composeA2UI("surface-d", {
      title: "Onboarding checklist",
      subtitle: "Proposed",
      view: "form",
      metrics: [],
      findings: [],
      draft: {
        id: "draft-1",
        title: "Onboarding checklist for Acme",
        steps: [{ id: "s1", text: "Confirm subscription" }],
        assumptions: ["No onboarding owner assigned."],
        status: "proposed",
      },
      actions: [],
      limitations: [],
    });
    expect(validateA2UI(messages)).toEqual([]);
    const components = messages.flatMap((message) => ("updateComponents" in message ? message.updateComponents?.components ?? [] : []));
    expect(components.some((component) => component.component === "TextField")).toBe(true);
    expect(components.some((component) => component.component === "Checkbox")).toBe(true);
    const save = components.find((component) => component.component === "Button" && component.text === "Save draft");
    expect((save?.action as { event?: { name?: string } })?.event?.name).toBe("save_draft");
  });

  it("keeps observations, hypotheses and open questions distinguishable in the surface", () => {
    const { dataModel } = composeA2UI("surface-k", {
      title: "Sync regression",
      subtitle: "Verified",
      view: "summary",
      metrics: [],
      findings: [
        { id: "f1", title: "Error rate up", body: "Observed.", kind: "observation", evidenceIds: ["ev-1"] },
        { id: "f2", title: "Release caused it", body: "Unproven.", kind: "hypothesis", evidenceIds: ["ev-1"] },
        { id: "f3", title: "Cohort unknown", body: "Open.", kind: "unresolved_question", evidenceIds: [] },
      ],
      actions: [],
      limitations: [],
    });
    const findings = (dataModel.findings ?? {}) as Record<string, { kindLabel?: string }>;
    expect(findings.f1?.kindLabel).toBe("Observed");
    expect(findings.f2?.kindLabel).toMatch(/hypothesis/i);
    expect(findings.f3?.kindLabel).toMatch(/question/i);
  });
});
