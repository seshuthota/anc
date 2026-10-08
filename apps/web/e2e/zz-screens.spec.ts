import { expect, test, type Page } from "@playwright/test";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";

/**
 * Visual record of the main states, taken last so it does not disturb the other
 * specs. SHOT_PREFIX names a curated set (p55-before / p55-after, taken alone on a
 * fresh database); inside the full suite the set is named e2e-screens.
 */
const prefix = process.env.SHOT_PREFIX ?? "e2e-screens";
const outDir = resolve(__dirname, "../../../test-results");
const shot = (page: Page, name: string) => page.screenshot({ path: resolve(outDir, `${prefix}-${name}.png`), fullPage: true });
const primary = (page: Page) => page.locator('[data-a2ui="PrimaryFinding"]');

async function settled(page: Page) {
  await expect(page.locator(".workspace.updating")).toHaveCount(0, { timeout: 60_000 });
  await expect(page.getByRole("button", { name: "Cancel" })).toHaveCount(0, { timeout: 60_000 });
}

async function openActivity(page: Page) {
  const pill = page.getByTestId("activity-pill");
  if (await pill.count()) await pill.click();
  else await page.getByTestId("trace").locator("summary").click();
}

async function closeActivity(page: Page) {
  if (await page.getByTestId("activity-pill").count()) await page.keyboard.press("Escape");
  else await page.getByTestId("trace").locator("summary").click();
}

test("captures the main states", async ({ page }) => {
  test.setTimeout(240_000);
  await page.setViewportSize({ width: 1280, height: 860 });
  await mkdir(outDir, { recursive: true });
  await page.goto("/");
  await expect(primary(page)).toHaveCount(1, { timeout: 90_000 });
  await settled(page);
  await page.waitForTimeout(400);
  await shot(page, "briefing");

  await openActivity(page);
  await page.waitForTimeout(400);
  await shot(page, "activity");
  await closeActivity(page);

  await primary(page).locator(".ws-primary-value").click();
  await expect(page.getByTestId("evidence-drawer")).toBeVisible();
  await page.waitForTimeout(400);
  await shot(page, "evidence");
  await page.getByRole("button", { name: "Close" }).click();
  await expect(page.getByTestId("evidence-drawer")).toHaveCount(0);

  // In the full suite an earlier spec has already escalated the fault, so that
  // button is gone; the shipper notice gives the same confirm → receipt flow.
  const receipts = await page.getByTestId("action-receipt").count();
  const escalate = page.getByRole("button", { name: "Escalate Sorter belt B fault" });
  await ((await escalate.count()) ? escalate : page.getByRole("button", { name: /^Notify / })).click();
  const confirm = page.getByRole("button", { name: /^(Confirm escalation|Queue notice)$/ });
  await expect(confirm).toBeVisible({ timeout: 30_000 });
  await page.waitForTimeout(400);
  await shot(page, "confirm");
  await confirm.click();
  await expect(page.getByTestId("action-receipt")).toHaveCount(receipts + 1, { timeout: 30_000 });
  await page.waitForTimeout(400);
  await shot(page, "receipt");

  const drill = page.getByRole("button", { name: "Look into this" }).first();
  if (!(await drill.isVisible())) await page.locator('[data-a2ui="Collapsible"] summary').click();
  await drill.click();
  await expect(page.locator('[data-a2ui="ContextHeader"]')).toHaveCount(1, { timeout: 60_000 });
  await settled(page);
  await page.waitForTimeout(400);
  await shot(page, "drill");

  await page.locator('[data-a2ui="ContextHeader"]').getByRole("button", { name: /Back/ }).click();
  await expect(primary(page)).toHaveCount(1, { timeout: 30_000 });
  await page.getByRole("button", { name: /refresh briefing/i }).click();
  await expect(page.locator(".workspace.updating")).toBeVisible({ timeout: 10_000 });
  await page.waitForTimeout(2_500);
  await shot(page, "running");
  await settled(page);
});
