import { defineConfig } from "@playwright/test";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const root = resolve(__dirname, "../..");
const agentPort = 4110;
const webPort = 3010;

export default defineConfig({
  testDir: "./e2e",
  timeout: 120_000,
  fullyParallel: false,
  retries: 0,
  use: {
    baseURL: `http://127.0.0.1:${webPort}`,
    browserName: "chromium",
    channel: "chrome",
    trace: "retain-on-failure",
  },
  webServer: [
    {
      command: "pnpm --filter @anc/agent start",
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
        // tsx auto-loads repo .env; empty RATE_LIMIT_PER_MINUTE becomes 0 and blocks every POST.
        RATE_LIMIT_PER_MINUTE: "120",
        // Web e2e serves on webPort, not the .env default :3000.
        ALLOWED_ORIGINS: `http://127.0.0.1:${webPort},http://localhost:${webPort}`,
        RUNTIME_DB_PATH: join(tmpdir(), `anc-e2e-runtime-${Date.now()}.sqlite`),
        COMPANY_DB_PATH: resolve(root, "data/company.sqlite"),
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
