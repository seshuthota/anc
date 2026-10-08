import { expect, test } from "@playwright/test";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";

test("captures a full-page briefing screenshot", async ({ page }) => {
  await page.goto("/");
  // Auto-briefing runs on load; wait for a non-empty surface title.
  const heading = page.locator(".a2ui-root h2");
  await expect(heading).toBeVisible({ timeout: 90_000 });
  await expect.poll(async () => (await heading.innerText()).trim().length, { timeout: 90_000 }).toBeGreaterThan(0);
  const outDir = resolve(__dirname, "../../../test-results");
  await mkdir(outDir, { recursive: true });
  await page.screenshot({ path: resolve(outDir, "briefing-baseline.png"), fullPage: true });
});
