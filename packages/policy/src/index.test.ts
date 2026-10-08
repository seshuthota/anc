import { describe, expect, it } from "vitest";
import { canUseTool, redactForPrincipal, resolvePrincipal, sessionThreadId, TOOL_CAPABILITIES } from "./index.js";

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

  it("lets nobody but customer care change a complaint, and refuses unknown tools and people", () => {
    for (const id of ["user-coo", "user-hub-hyd", "user-lastmile", "user-accounts"]) {
      expect(canUseTool(resolvePrincipal(id), "commit_complaint_assignment")).toBe(false);
    }
    expect(canUseTool(resolvePrincipal("user-coo"), "execute_sql")).toBe(false);
    expect(() => resolvePrincipal("user-nobody")).toThrow(/Unknown principal/);
    // The COO reads everything that is a read.
    const reads = Object.keys(TOOL_CAPABILITIES).filter((tool) => TOOL_CAPABILITIES[tool] !== "cap.complaints.assign");
    expect(reads.every((tool) => canUseTool(resolvePrincipal("user-coo"), tool))).toBe(true);
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
