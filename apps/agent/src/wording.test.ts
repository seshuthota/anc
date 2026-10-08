import { describe, expect, it } from "vitest";
import { personReason, plural } from "./wording.js";

describe("receipt wording", () => {
  it("pluralises properly", () => {
    expect(plural(1, "late complaint")).toBe("1 late complaint");
    expect(plural(0, "late complaint")).toBe("0 late complaints");
    expect(plural(1200, "complaint record")).toBe("1,200 complaint records");
  });

  it("never shows a raw tool name or error", () => {
    const cases: Array<[string, string]> = [
      ["Company tool escalate_equipment_fault failed: Equipment event version is stale", "someone else changed it first"],
      ["Company tool escalate_equipment_fault failed: Equipment event eq-hyd-0920 is already escalated", "it had already been escalated"],
      ["Company tool commit_complaint_assignment failed: Complaint cmp-1 is closed", "the complaint had already been closed"],
      ["Company tool escalate_equipment_fault failed: No engineer is on call for this hub", "no engineer is on call for this hub"],
      ["MCP client is not connected", "the company system could not be reached"],
      ["Company tool escalate_equipment_fault failed: SQLITE_BUSY: database is locked", "the company system reported a problem"],
      ["Company tool escalate_equipment_fault failed", "the company system reported a problem"],
    ];
    for (const [raw, words] of cases) {
      expect(personReason(raw)).toBe(words);
      expect(personReason(raw)).not.toMatch(/_|Company tool|eq-|cmp-/);
    }
  });
});
