import { describe, expect, it } from "vitest";
import { canUseTool, redactForPrincipal, resolvePrincipal, sessionThreadId, TOOL_CAPABILITIES, WRITE_CAPABILITIES } from "./index.js";

describe("policy", () => {
  it("gives each person only the tools their role needs", () => {
    const hub = resolvePrincipal("user-hub-hyd");
    const accounts = resolvePrincipal("user-accounts");
    const care = resolvePrincipal("user-care");
    expect(canUseTool(hub, "get_hub_status")).toBe(true);
    expect(canUseTool(hub, "get_shipper_on_time")).toBe(false);
    expect(canUseTool(accounts, "get_shipper_on_time")).toBe(true);
    expect(canUseTool(accounts, "list_locker_sites")).toBe(false);
    expect(canUseTool(accounts, "commit_complaint_assignment")).toBe(false);
    expect(canUseTool(care, "commit_complaint_assignment")).toBe(true);
    expect(canUseTool(care, "get_hub_status")).toBe(false);
  });

  it("lets only customer care and the COO change a complaint, and refuses unknown tools and people", () => {
    // P4: the COO may hand the morning's late complaints to care from the briefing.
    for (const id of ["user-hub-hyd", "user-lastmile", "user-accounts"]) {
      expect(canUseTool(resolvePrincipal(id), "commit_complaint_assignment")).toBe(false);
    }
    expect(canUseTool(resolvePrincipal("user-coo"), "commit_complaint_assignment")).toBe(true);
    expect(canUseTool(resolvePrincipal("user-coo"), "execute_sql")).toBe(false);
    expect(() => resolvePrincipal("user-nobody")).toThrow(/Unknown principal/);
    // The COO reads everything that is a read.
    const reads = Object.keys(TOOL_CAPABILITIES).filter((tool) => !WRITE_CAPABILITIES.includes(TOOL_CAPABILITIES[tool]!));
    expect(reads.every((tool) => canUseTool(resolvePrincipal("user-coo"), tool))).toBe(true);
  });

  it("grants each briefing operation only to the roles that own it (P4)", () => {
    const can = (id: string, tool: string) => canUseTool(resolvePrincipal(id), tool);
    expect(["user-coo", "user-hub-hyd"].every((id) => can(id, "escalate_equipment_fault"))).toBe(true);
    expect(["user-lastmile", "user-accounts", "user-care"].some((id) => can(id, "escalate_equipment_fault"))).toBe(false);
    expect(["user-coo", "user-accounts"].every((id) => can(id, "notify_shipper"))).toBe(true);
    expect(["user-hub-hyd", "user-lastmile", "user-care"].some((id) => can(id, "notify_shipper"))).toBe(false);
  });

  it("isolates demo sessions by owner", () => {
    expect(sessionThreadId("user-coo")).toBe("local-demo");
    expect(sessionThreadId("user-care")).toBe("session:user-care");
    expect(sessionThreadId("user-care")).not.toBe(sessionThreadId("user-accounts"));
  });

  it("strips a person's denied fields at any depth", () => {
    const restricted = { ...resolvePrincipal("user-care"), deniedFields: ["onTimeTarget"] };
    expect(redactForPrincipal(restricted, { rows: [{ shipperId: "shipper-003", onTimeTarget: 0.96 }] })).toEqual({ rows: [{ shipperId: "shipper-003" }] });
  });
});
