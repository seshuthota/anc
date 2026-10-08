import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { resolvePrincipal } from "@anc/policy";
import { prepareTestEnvironment } from "./test-env.js";

prepareTestEnvironment("anc-completed-actions-");

const { CompanyMcpClient } = await import("./mcp-client.js");
const { completedBriefingActions } = await import("./operations.js");
const { store } = await import("./runtime.js");

const coo = resolvePrincipal("user-coo");
const accountManager = resolvePrincipal("user-accounts");

afterAll(() => store.close());
afterEach(() => vi.restoreAllMocks());

/** Records which company tools the done-check looks up, without changing what they return. */
function spyLookups() {
  const calls: Array<{ tool: string; args: unknown }> = [];
  const original = CompanyMcpClient.prototype.call;
  vi.spyOn(CompanyMcpClient.prototype, "call").mockImplementation(function (this: InstanceType<typeof CompanyMcpClient>, ...args: Parameters<typeof original>) {
    calls.push({ tool: args[0], args: args[1] });
    return original.apply(this, args);
  });
  const connect = vi.spyOn(CompanyMcpClient.prototype, "connect");
  return { calls, connect };
}

const escalate = { id: "escalate_equipment_fault", entities: [{ type: "equipment", id: "eq-hyd-0920" }] };
const notify = (shipperId: string) => ({ id: "notify_shipper", entities: [{ type: "shipper", id: shipperId }] });
const assign = { id: "assign_complaints", entities: [] };

describe("completedBriefingActions", () => {
  it("makes no lookup at all when the plan offers neither notify nor assign", async () => {
    const { calls, connect } = spyLookups();
    const done = await completedBriefingActions(store, coo, [escalate], "run-escalate-only", new Set(["escalate_equipment_fault:eq-hyd-0920"]));
    expect([...done]).toEqual(["escalate_equipment_fault:eq-hyd-0920"]);
    expect(calls).toEqual([]);
    expect(connect).not.toHaveBeenCalled();
    expect(await completedBriefingActions(store, coo, [], "run-empty")).toEqual(new Set());
    expect(calls).toEqual([]);
  });

  it("checks only the card's shipper for a planned notify, and the queue only for a planned assign", async () => {
    const { calls } = spyLookups();
    await completedBriefingActions(store, coo, [escalate, notify("shipper-003")], "run-notify");
    expect(calls.map((call) => call.tool)).toEqual(["get_shipper"]);
    expect(calls[0]!.args).toEqual({ shipperId: "shipper-003" });

    calls.length = 0;
    await completedBriefingActions(store, coo, [assign], "run-assign");
    expect(calls.map((call) => call.tool)).toEqual(["list_complaints"]);
  });

  it("skips a planned action the person has no grant for", async () => {
    const { calls } = spyLookups();
    // The account manager may notify but not assign complaints.
    await completedBriefingActions(store, accountManager, [assign], "run-no-grant");
    expect(calls).toEqual([]);
  });
});
