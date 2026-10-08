import { expect, test } from "@playwright/test";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";

test("captures a full-page briefing screenshot", async ({ page }) => {
  await page.goto("/");
  // Auto-briefing runs on load; wait for a non-empty surface title.
  const heading = page.locator(".a2ui-root h2");
  await expect(heading.first()).toBeVisible({ timeout: 90_000 });
  await expect.poll(async () => (await heading.first().innerText()).trim().length, { timeout: 90_000 }).toBeGreaterThan(0);
  // R3 budget: one primary finding with its one figure, the rest collapsed, no stat tiles.
  await expect(page.locator('[data-a2ui="PrimaryFinding"]')).toHaveCount(1);
  await expect(page.locator('[data-a2ui="PrimaryFinding"] .ws-primary-value')).toHaveText(/905/);
  await expect(page.locator(".ws-stat")).toHaveCount(0);
  await expect(page.locator('[data-a2ui="Collapsible"]')).toHaveCount(1);
  await expect(page.locator('[data-a2ui="Collapsible"]')).not.toHaveAttribute("open", "");
  const outDir = resolve(__dirname, "../../../test-results");
  await mkdir(outDir, { recursive: true });
  await page.screenshot({ path: resolve(outDir, "briefing-baseline.png"), fullPage: true });
  await page.screenshot({ path: resolve(outDir, "p2-after-briefing.png"), fullPage: true });
});
