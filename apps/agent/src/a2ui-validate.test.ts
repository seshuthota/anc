import { describe, expect, it } from "vitest";
import { composeA2UI } from "./composer.js";
import { validateA2UI } from "./a2ui-validate.js";

describe("A2UI validation", () => {
  it("accepts composer output", () => {
    const { messages } = composeA2UI("surface-1", {
      title: "Morning overview",
      subtitle: "Verified findings",
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
});
