import { readFileSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { DEFAULT_COMPANY_DB_PATH, seedScenario } from "@anc/database";
import { resolvePrincipal } from "@anc/policy";

const here = dirname(fileURLToPath(import.meta.url));
const dir = mkdtempSync(join(tmpdir(), "anc-unseen-"));
process.env.RUNTIME_DB_PATH = join(dir, "runtime.sqlite");
process.env.COMPANY_DB_PATH = DEFAULT_COMPANY_DB_PATH;
process.env.MODEL_PROVIDER = "fixture";
process.env.VITEST = "true";
seedScenario(process.env.COMPANY_DB_PATH, "sync-regression");

const { runInvestigation } = await import("./runtime.js");

function source(relative: string) {
  return readFileSync(join(here, relative), "utf8");
}

describe("unseen capability", () => {
  it("answers an incidents question without planner or page branches for incidents", async () => {
    const planner = source("planner.ts");
    const page = source("../../web/app/page.tsx");
    expect(planner).not.toMatch(/incident/i);
    expect(page).not.toMatch(/incident/i);
    const state = await runInvestigation({
      question: "What open incidents should I know about?",
      threadId: "session:user-ops-incidents",
      principal: resolvePrincipal("user-ops"),
    });
    const blob = JSON.stringify(state.surface?.dataModel ?? {}).toLowerCase();
    expect(state.surface).toBeTruthy();
    expect(blob).toMatch(/incident/);
  }, 60_000);

  it("answers a newly registered maintenance question without planner, composer, graph, or page branches", async () => {
    const files = ["planner.ts", "composer.ts", "graph.ts", "../../web/app/page.tsx", "../../web/lib/a2ui.tsx"];
    for (const file of files) expect(source(file)).not.toMatch(/maintenance/i);
    const state = await runInvestigation({
      question: "What open maintenance windows are scheduled?",
      threadId: "session:user-ops-maintenance",
      principal: resolvePrincipal("user-ops"),
    });
    const blob = JSON.stringify(state.surface?.dataModel ?? {}).toLowerCase();
    expect(state.status === "completed" || state.status === "partial").toBe(true);
    expect(blob).toMatch(/maintenance/);
    expect(blob).not.toMatch(/morning overview/);
  }, 60_000);
});
