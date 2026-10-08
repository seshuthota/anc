import { describe, expect, it } from "vitest";
import { TOOL_CAPABILITIES, WRITE_CAPABILITIES } from "@anc/policy";
import { describeFilters, fieldLabel, formatIstTime, formatValue, isInternalField, scopeLabel, sourceLabel, sourceTitle, toolLabel } from "./evidence-format";

describe("evidence drawer wording", () => {
  it("formats times in IST, whatever offset they carry", () => {
    expect(formatIstTime("2026-09-21T07:00:00.000+05:30")).toBe("07:00 IST, Mon 21 Sep");
    expect(formatIstTime("2026-09-21T01:30:00.000Z")).toBe("07:00 IST, Mon 21 Sep");
    expect(formatIstTime(null)).toBe("—");
  });

  it("gives fields human labels and explains count", () => {
    expect(fieldLabel("atRisk")).toBe("At risk");
    expect(fieldLabel("sortedNotLoaded")).toBe("Sorted, not loaded");
    expect(fieldLabel("parcelsLeftBehind")).toBe("Parcels left behind");
    expect(fieldLabel("someNewField")).toBe("Some new field");
    expect(fieldLabel("count", { groupBy: "district" })).toBe("Groups (one per district)");
    expect(isInternalField("hubId")).toBe(true);
    expect(isInternalField("hubName")).toBe(false);
    expect(toolLabel("summarize_at_risk_shipments")).toBe("Summarize at risk shipments");
  });

  it("hides the tool's plumbing and words the rest", () => {
    expect(describeFilters({ groupBy: "district" })).toEqual([]);
    expect(describeFilters({ openOnly: true, window: { from: "2026-09-07T07:00:00.000+05:30", to: "2026-09-21T07:00:00.000+05:30" }, page: { limit: 100, offset: 0 } }))
      .toEqual(["Open only", "From 07:00 IST, Mon 7 Sep to 07:00 IST, Mon 21 Sep"]);
    expect(describeFilters({ serviceDate: "2026-09-21" })).toEqual(["Service date: Mon 21 Sep"]);
  });

  it("formats values: rates, hours, dates, booleans, codes", () => {
    expect(formatValue(0.9253, "projectedRateIfAtRiskArriveLate")).toBe("92.5%");
    expect(formatValue(0.5, "hoursToClearAtCurrentRate")).toBe("0.5");
    expect(formatValue(125, "usualSortRatePerHour")).toBe("125");
    expect(formatValue(4555, "due")).toBe("4,555");
    expect(formatValue(true, "wouldMissTarget")).toBe("Yes");
    expect(formatValue(null)).toBe("—");
    expect(formatValue("2026-09-20T22:10:00.000+05:30")).toBe("22:10 IST, Sun 20 Sep");
    expect(formatValue("key_account")).toBe("Key account");
  });

  it("names the source in words, for every read tool, and titles tabs in sentence case", () => {
    expect(sourceLabel("summarize_at_risk_shipments")).toBe("shipments promised today");
    expect(sourceTitle("summarize_at_risk_shipments")).toBe("Shipments promised today");
    expect(sourceTitle("list_route_runs")).toBe("Today's delivery route runs");
    const reads = Object.entries(TOOL_CAPABILITIES).filter(([, capability]) => !WRITE_CAPABILITIES.includes(capability)).map(([tool]) => tool);
    for (const tool of [...reads, "list_eligible_assignees"]) {
      expect(sourceLabel(tool), tool).not.toBe("company records");
      expect(sourceLabel(tool), tool).not.toMatch(/_/);
    }
  });

  it("shows names, never raw ids, outside developer view", () => {
    const labels = { "hub-hyd": "Hyderabad Hub", "lock-velachery": "Velachery MRTS Station" };
    expect(scopeLabel({ type: "hub", id: "hub-hyd" }, labels)).toBe("Hyderabad Hub");
    expect(scopeLabel({ type: "locker", id: "lock-velachery" }, labels)).toBe("Velachery MRTS Station");
    expect(scopeLabel({ type: "hub", id: "hub-blr" }, labels)).toBeNull();
    expect(scopeLabel({ type: "hub", id: "hub-blr" }, labels, true)).toBe("hub: hub-blr");
    expect(scopeLabel({ type: "network" })).toBe("whole network");
    expect(describeFilters({ hubId: "hub-hyd", serviceDate: "2026-09-21" }, labels)).toEqual(["Hub: Hyderabad Hub", "Service date: Mon 21 Sep"]);
    expect(describeFilters({ hubId: "hub-blr" }, labels)).toEqual([]);
    expect(describeFilters({ hubId: "hub-blr" }, labels, true)).toEqual(["Hub: hub-blr"]);
    expect(describeFilters({ siteId: "lock-velachery" }, labels)).toEqual(["Site: Velachery MRTS Station"]);
    expect(formatValue("lock-velachery", "lockerSiteId", labels)).toBe("Velachery MRTS Station");
  });

  it("capitalises one-word codes from the company system", () => {
    expect(formatValue("high", "severity")).toBe("High");
    expect(formatValue("departed", "status")).toBe("Departed");
    expect(formatValue("standard", "tier")).toBe("Standard");
    expect(formatValue("Hyderabad Hub", "hubName")).toBe("Hyderabad Hub");
  });
});
