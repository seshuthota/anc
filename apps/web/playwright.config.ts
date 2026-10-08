import { defineConfig } from "@playwright/test";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const root = resolve(__dirname, "../..");
// Ports can be moved (E2E_AGENT_PORT / E2E_WEB_PORT) so runs can sit side by side.
// Specs read the agent's URL from E2E_AGENT_URL, set here so workers see it too.
const agentPort = Number(process.env.E2E_AGENT_PORT ?? 4110);
const webPort = Number(process.env.E2E_WEB_PORT ?? 3010);
process.env.E2E_AGENT_URL = `http://127.0.0.1:${agentPort}`;
// The e2e run writes (P4 escalations, notices, assignments), so it gets its own
// freshly seeded company database and never touches data/logistics.sqlite.
// Kept in the environment so workers that re-read this file see the same path.
process.env.ANC_E2E_LOGISTICS_DB ??= join(tmpdir(), `anc-e2e-logistics-${Date.now()}.sqlite`);
const logisticsDb = process.env.ANC_E2E_LOGISTICS_DB;

export default defineConfig({
  testDir: "./e2e",
  timeout: 120_000,
  fullyParallel: false,
  workers: 1,
  retries: 0,
  use: {
    baseURL: `http://127.0.0.1:${webPort}`,
    browserName: "chromium",
    channel: "chrome",
    trace: "retain-on-failure",
  },
  webServer: [
    {
      // Schema v2 by construction: the seed writes a brand-new file at the current
      // schema, and agent startup runs migrateCompanyDatabase() before it listens,
      // so no read-only specialist hits the "predates schema v2" refusal.
      command: "pnpm --filter @anc/logistics-db seed && pnpm --filter @anc/agent start",
      cwd: root,
      url: `http://127.0.0.1:${agentPort}/health`,
      reuseExistingServer: false,
      timeout: 120_000,
      env: {
        ...process.env,
        AGENT_PORT: String(agentPort),
        MODEL_PROVIDER: "fixture",
        MODEL_EXECUTION_MODE: "fixture",
        INVESTIGATION_STEP_DELAY_MS: "1200",
        RUNTIME_DB_PATH: join(tmpdir(), `anc-e2e-runtime-${Date.now()}.sqlite`),
        LOGISTICS_DB_PATH: logisticsDb,
      },
    },
    {
      command: `pnpm --filter @anc/web exec next dev --port ${webPort}`,
      cwd: root,
      url: `http://127.0.0.1:${webPort}`,
      reuseExistingServer: false,
      timeout: 120_000,
      env: {
        ...process.env,
        NEXT_PUBLIC_AGENT_URL: `http://127.0.0.1:${agentPort}`,
      },
    },
  ],
});
