import { describe, expect, it } from "vitest";
import { ACTION_FAILED, CONFLICT_NOTE, GENERIC_NOTE, GENERIC_PROBLEM, REQUEST_FAILED, liveLine, summarise, type Step } from "./activity-text";

let next = 0;
const step = (message: string, kind: Step["kind"] = "status"): Step => ({
  id: `s${next += 1}`,
  message,
  kind,
  timestamp: new Date(Date.UTC(2026, 9, 8, 1, 30, next)).toISOString(),
});

// What the runtime writes when two sources disagree on a figure (reconcile.ts note, emitted by graph.ts).
const CONFLICT = "Reconciliation: Parcels at risk today disagree (231 vs 218); not shown until resolved";

describe("activity pill wording", () => {
  it("never shows a reconciliation conflict's figures or raw text", () => {
    const steps = [
      step("Looking into your question"),
      step("Shipments Agent started", "agent_started"),
      step("Shipments Agent finding: 905 parcels at risk", "finding_discovered"),
      step("Shipments Agent completed", "agent_completed"),
      step(CONFLICT),
    ];
    const live = liveLine(steps.at(-1));
    expect(live).toBe(CONFLICT_NOTE);
    const { findings } = summarise(steps);
    const shown = [live, ...findings.map((item) => `${item.name} ${item.text}`)].join("\n");
    expect(shown).toContain(CONFLICT_NOTE);
    expect(shown).not.toMatch(/218|231|905/);
    expect(shown).not.toContain("Reconciliation");
    expect(shown).not.toContain("disagree (");
    expect(shown).not.toContain("not shown until resolved");
  });

  it("maps every internal status line to fixed wording", () => {
    const cases: Array<[raw: string, shown: string]> = [
      ["Plan adjusted: tasks[1].domain: Invalid enum value 'lockers'", "Adjusted the plan to what you can see"],
      ["Customers Agent used the deterministic specialist (model returned invalid JSON: Unexpected token })", "Used its standard check"],
      ["Composer output invalid; keeping last accepted surface. /components/3: Stat is not allowed", "Kept the last good layout"],
      ["UI Composer layout was rejected; showing the standard layout", "Used the standard layout"],
      ["Lead Analyst ranking was replaced by the deterministic ranker", "Ranked with the standard rules"],
      ["Network Agent failed", "Could not finish"],
    ];
    for (const [raw, shown] of cases) {
      const { findings } = summarise([step(raw)]);
      expect(findings.map((item) => item.text)).toEqual([shown]);
      expect(liveLine(step(raw))).not.toContain(raw);
    }
    expect(liveLine(step("Customers Agent used the deterministic specialist (timeout after 30000ms)"))).toBe("Customers agent used its standard check");
  });

  it("falls back to generic wording for anything unrecognised, including raw errors", () => {
    const raw = step("SqliteError: no such column: hours_to_clear at Statement.all (node:internal)");
    expect(liveLine(raw)).toBe(GENERIC_PROBLEM);
    expect(summarise([raw]).findings.map((item) => item.text)).toEqual([GENERIC_PROBLEM]);
    expect(liveLine(step("Which hub do you mean, HYD-01 or HYD-02?"))).toBe(GENERIC_NOTE);
  });

  it("keeps the client's own failure lines and nothing after them", () => {
    expect(summarise([step(REQUEST_FAILED)]).findings[0]).toMatchObject({ text: REQUEST_FAILED, failed: true });
    expect(summarise([step(`${ACTION_FAILED} (confirmation token expired at 07:12)`)]).findings[0]).toMatchObject({ text: ACTION_FAILED, failed: true });
  });
});
