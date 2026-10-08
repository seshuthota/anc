import { describe, expect, it } from "vitest";
import { displayCell } from "./artifacts.js";

describe("table cells", () => {
  it("shows hours to clear in hours, and a dash for a hub with nothing waiting (P6 fix: was 0.0%)", () => {
    expect(displayCell("hoursToClearAtCurrentRate", 19.8)).toBe("19.8 h");
    expect(displayCell("hoursToClearAtCurrentRate", 0.5)).toBe("0.5 h");
    expect(displayCell("hoursToClearAtCurrentRate", 3)).toBe("3.0 h");
    expect(displayCell("hoursToClearAtCurrentRate", 0)).toBe("—");
    expect(displayCell("hoursToClearAtCurrentRate", null)).toBe("—");
  });

  it("still shows real rates as percentages and counts as numbers", () => {
    expect(displayCell("onTimeRate", 0.925)).toBe("92.5%");
    expect(displayCell("occupancy", 1)).toBe("100.0%");
    expect(displayCell("usualSortRatePerHour", 163)).toBe("163");
    expect(displayCell("parcelsWaitingToSort", 0)).toBe("0");
  });
});
