import { describe, expect, it } from "vitest";
import { canUseTool, redactForPrincipal, resolvePrincipal, sessionThreadId } from "./index.js";

describe("policy", () => {
  it("keeps operations off finance tools and finance off assignment", () => {
    const ops = resolvePrincipal("user-ops");
    const finance = resolvePrincipal("user-finance");
    const support = resolvePrincipal("user-support");
    expect(canUseTool(ops, "calculate_account_exposure")).toBe(false);
    expect(canUseTool(ops, "get_error_metrics")).toBe(true);
    expect(canUseTool(finance, "commit_ticket_assignment")).toBe(false);
    expect(canUseTool(finance, "list_invoice_aging")).toBe(true);
    expect(canUseTool(support, "commit_ticket_assignment")).toBe(true);
    expect(canUseTool(support, "list_invoice_aging")).toBe(false);
  });

  it("isolates demo sessions by owner", () => {
    expect(sessionThreadId("user-coo")).toBe("local-demo");
    expect(sessionThreadId("user-ops")).toBe("session:user-ops");
    expect(sessionThreadId("user-ops")).not.toBe(sessionThreadId("user-finance"));
  });

  it("strips denied financial fields before agent context", () => {
    const ops = resolvePrincipal("user-ops");
    const redacted = redactForPrincipal(ops, { customerId: "customer-001", arrMinorUnits: 15000000, name: "Acme" });
    expect(redacted).toEqual({ customerId: "customer-001", name: "Acme" });
  });
});
