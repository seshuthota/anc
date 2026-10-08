import { expect, test } from "@playwright/test";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";

test("one click on the headline figure opens its definition and highlighted source value", async ({ page }) => {
  await page.goto("/");
  const primary = page.locator('[data-a2ui="PrimaryFinding"]');
  await expect(primary).toBeVisible({ timeout: 90_000 });
  const value = primary.locator(".ws-primary-value");
  await expect(value).toHaveText("905");
  await value.click();
  const drawer = page.getByTestId("evidence-drawer");
  await expect(drawer).toBeVisible();
  await expect(drawer).toContainText("Promised for delivery today");
  await expect(drawer.locator(".ev-value")).toHaveAttribute("data-path", "totals.atRisk");
  const hit = drawer.locator('td.ev-hit[data-path="totals.atRisk"]');
  await expect(hit).toHaveText("905");
  await expect(drawer).toContainText("of 4,000 parcels promised today");
  // Person-facing: an IST time, labelled figures, no tool plumbing, no raw JSON.
  await expect(drawer.locator(".ev-meta")).toContainText("07:00 IST, Mon 21 Sep");
  await expect(drawer.locator(".ev-excerpt")).toContainText("At risk");
  await expect(drawer.locator(".ev-excerpt")).toContainText("Sorted, not loaded");
  await expect(drawer.locator(".ev-excerpt")).toContainText("Groups (one per district)");
  await expect(drawer).not.toContainText("groupBy");
  await expect(drawer).not.toContainText("sortedNotLoaded");
  await expect(drawer).not.toContainText("Read from");
  await expect(drawer.locator(".ev-meta")).toContainText("Fromshipments promised today");
  await expect(drawer).not.toContainText("Company tool");
  await expect(drawer.locator("details.ev-raw")).toHaveCount(0);
  const outDir = resolve(__dirname, "../../../test-results");
  await mkdir(outDir, { recursive: true });
  await page.screenshot({ path: resolve(outDir, "p3-evidence-drawer.png"), fullPage: true });
  await drawer.screenshot({ path: resolve(outDir, "p7-evidence-drawer.png") });
  await page.getByRole("button", { name: "Close" }).click();
  await expect(drawer).toBeHidden();

  // The finding's own evidence button opens every cited record as tabs.
  await primary.getByRole("button", { name: /Evidence \(\d+\)/ }).click();
  await expect(drawer).toBeVisible();
  const tabs = drawer.getByRole("tab");
  expect(await tabs.count()).toBeGreaterThan(1);
  await expect(drawer.getByRole("tab", { selected: true })).toHaveText("Shipments promised today");
  await page.screenshot({ path: resolve(outDir, "p3-evidence-drawer-tabs.png"), fullPage: true });
});

test("the raw record is only offered to developers (?dev=1)", async ({ page }) => {
  await page.goto("/?dev=1");
  const primary = page.locator('[data-a2ui="PrimaryFinding"]');
  await expect(primary).toBeVisible({ timeout: 90_000 });
  await primary.locator(".ws-primary-value").click();
  const drawer = page.getByTestId("evidence-drawer");
  await expect(drawer).toBeVisible();
  await expect(drawer.locator("details.ev-raw")).toHaveCount(1);
  await expect(drawer.locator("details.ev-raw")).not.toHaveAttribute("open", "");
  await expect(drawer).toContainText("Read from");
});
