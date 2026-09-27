import { describe, expect, it } from "vitest";
import { resolvePrincipal } from "@anc/policy";
import { authorizedTools, validateRegistry } from "./registry.js";

describe("capability registry", () => {
  it("validates specialists against connected tool metadata", () => {
    expect(validateRegistry()).toEqual([]);
  });

  it("hides unauthorized tools from a specialist", () => {
    const finance = resolvePrincipal("user-finance");
    expect(authorizedTools(finance, "finance")).toContain("list_invoice_aging");
    expect(authorizedTools(finance, "reliability")).toEqual([]);
    const ops = resolvePrincipal("user-ops");
    expect(authorizedTools(ops, "finance")).toEqual([]);
    expect(authorizedTools(ops, "reliability")).toContain("get_error_metrics");
  });
});
