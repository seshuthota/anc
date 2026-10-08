import { describe, expect, it } from "vitest";
import { DEMO_CLOCK, istClock } from "./windows.js";

describe("istClock", () => {
  it("shows IST wall-clock time whatever offset the instant was written with", () => {
    expect(istClock(DEMO_CLOCK)).toBe("07:00 IST");
    // A UTC instant (a proposal's expiresAt is written with toISOString()).
    expect(istClock("2026-09-21T01:30:00.000Z")).toBe("07:00 IST");
    expect(istClock("2026-09-21T01:42:10.512Z")).toBe("07:12 IST");
    // Crossing midnight in UTC.
    expect(istClock("2026-09-20T19:00:00.000Z")).toBe("00:30 IST");
    expect(istClock("2026-09-21T09:30:00.000+08:00")).toBe("07:00 IST");
  });

  it("is empty for anything that is not a timestamp", () => {
    expect(istClock(undefined)).toBe("");
    expect(istClock(null)).toBe("");
    expect(istClock("2026-09-21")).toBe("");
    expect(istClock("not a time T99:99")).toBe("");
  });
});
