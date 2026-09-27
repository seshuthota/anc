import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DEFAULT_COMPANY_DB_PATH, seedScenario } from "@anc/database";
import { resolvePrincipal } from "@anc/policy";
import { PARAPHRASES } from "./rubric.js";

/** Frozen before further planner/prompt edits. Not part of the original 27-run suite. */
export const HELDOUT_PROMPTS = [
  "Brief me on anything unusual overnight.",
  "Which receivables are past due?",
  "Who is waiting in the support queue with no owner?",
] as const;

const dir = mkdtempSync(join(tmpdir(), "anc-heldout-"));
process.env.RUNTIME_DB_PATH = join(dir, "runtime.sqlite");
process.env.COMPANY_DB_PATH = DEFAULT_COMPANY_DB_PATH;
process.env.MODEL_PROVIDER = "fixture";
process.env.VITEST = "true";
seedScenario(process.env.COMPANY_DB_PATH, "sync-regression");

const { runInvestigation } = await import("../runtime.js");

describe("held-out prompts", () => {
  it("are disjoint from the scored opening paraphrases", () => {
    for (const prompt of HELDOUT_PROMPTS) {
      expect(PARAPHRASES).not.toContain(prompt);
    }
  });

  it("completes overnight, receivables, and queue prompts in the same shell", async () => {
    const overnight = await runInvestigation({ question: HELDOUT_PROMPTS[0], threadId: "held-coo", principal: resolvePrincipal("user-coo") });
    const receivables = await runInvestigation({ question: HELDOUT_PROMPTS[1], threadId: "held-finance", principal: resolvePrincipal("user-finance") });
    const queue = await runInvestigation({ question: HELDOUT_PROMPTS[2], threadId: "held-support", principal: resolvePrincipal("user-support") });
    expect(overnight.surface).toBeTruthy();
    expect(JSON.stringify(receivables.surface?.dataModel).toLowerCase()).toMatch(/invoice|overdue|aging/);
    expect(JSON.stringify(queue.surface?.dataModel).toLowerCase()).toMatch(/ticket|unassigned|queue/);
  }, 60_000);
});
