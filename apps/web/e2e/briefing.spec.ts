import { expect, test, type Page } from "@playwright/test";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";

// The briefing contract on hub-fault, end to end (plan Slice 6).
// Note: the e2e company database is shared by every spec and specs run in file
// order. This file runs before p4-actions.spec.ts, which owns the Sorter belt B
// escalation write, so here the escalation is proposed and cancelled (nothing
// is written) and the full Confirm → receipt write uses the care lead's
// complaint assignment, which no later spec depends on.

const outDir = resolve(__dirname, "../../../test-results");
const primary = (page: Page) => page.locator('[data-a2ui="PrimaryFinding"]');
const header = (page: Page) => page.locator('[data-a2ui="ContextHeader"]');

async function briefedAs(page: Page, persona: string) {
  await page.addInitScript((id) => window.localStorage.setItem("anc-principal", id), persona);
  await page.goto("/");
  await expect(page.getByLabel("Demo identity (not real sign-in)")).toHaveValue(persona);
  await expect(primary(page)).toHaveCount(1, { timeout: 90_000 });
  await expect(page.getByTestId("activity-pill")).toHaveText(/lookups?\b/, { timeout: 60_000 });
}

test("one primary finding, no duplicate metric ids, and its figure opens a definition", async ({ page }) => {
  await briefedAs(page, "user-coo");
  await expect(primary(page)).toHaveCount(1);
  await expect(page.locator(".a2ui-root h2").first()).not.toHaveText(/Nothing needs your attention/);

  const ids = await page.locator("[data-metric-id]").evaluateAll((nodes) => nodes.map((node) => node.getAttribute("data-metric-id")));
  expect(ids.length).toBeGreaterThan(0);
  expect(new Set(ids).size).toBe(ids.length);

  await primary(page).locator(".ws-primary-value").click();
  const drawer = page.getByTestId("evidence-drawer");
  await expect(drawer).toBeVisible();
  // The metric's definition from the registry, not just a raw value.
  await expect(drawer).toContainText("Promised for delivery today");
  await page.getByRole("button", { name: "Close" }).click();
  await expect(drawer).toBeHidden();
});

test("Escalate → Confirm is inline on the same card, and Cancel writes nothing", async ({ page }) => {
  await briefedAs(page, "user-coo");
  const escalate = page.getByRole("button", { name: "Escalate Sorter belt B fault" });
  await expect(escalate).toBeVisible();
  await escalate.click();
  await expect(page.getByRole("button", { name: "Confirm escalation" })).toBeVisible({ timeout: 30_000 });
  await expect(primary(page)).toHaveCount(1);
  // The header's Cancel (stop a run) is gone once the run is done; the last Cancel is the inline confirm's.
  await page.getByRole("button", { name: "Cancel" }).last().click();
  await expect(page.getByRole("button", { name: "Confirm escalation" })).toHaveCount(0, { timeout: 30_000 });
  await expect(page.getByRole("button", { name: "Escalate Sorter belt B fault" })).toBeVisible();
  await expect(page.getByTestId("action-receipt")).toHaveCount(0);
});

test("an operation → Confirm → receipt on the same card (care lead assigns late complaints)", async ({ page }) => {
  await briefedAs(page, "user-care");
  await expect(primary(page)).toContainText(/complaints need an owner/);
  await page.getByRole("button", { name: "Assign late complaints" }).click();
  const confirm = page.getByRole("button", { name: /^Assign \d+ complaints$/ });
  await expect(confirm).toBeVisible({ timeout: 30_000 });
  await confirm.click();
  const receipt = page.getByTestId("action-receipt");
  await expect(receipt).toHaveCount(1, { timeout: 30_000 });
  await expect(receipt).toHaveAttribute("data-action-id", "assign_complaints");
  await expect(receipt).toContainText(/Assigned/);
  await expect(page.getByRole("button", { name: "Assign late complaints" })).toHaveCount(0);
  await expect(primary(page)).toHaveCount(1);
});

test("a follow-up replaces the body; the drill-down hub table shows hours to clear in hours", async ({ page }) => {
  await briefedAs(page, "user-hub-hyd");
  await expect(primary(page)).toContainText(/parcels waiting to sort/);
  // "Look into this" on the hub's backlog: the drill-down replaces the briefing body in place.
  await page.getByRole("button", { name: "Look into this" }).first().click();
  await expect(header(page)).toHaveCount(1, { timeout: 60_000 });
  await expect(header(page)).toContainText("From your briefing");
  await expect(primary(page)).toHaveCount(0);

  const table = page.locator(".a2ui-root table").filter({ hasText: /Hours to clear/i }).first();
  await expect(table).toBeVisible({ timeout: 30_000 });
  const headers = (await table.locator("th").allInnerTexts()).map((text) => text.trim());
  const column = headers.findIndex((text) => /hours to clear/i.test(text));
  expect(column).toBeGreaterThanOrEqual(0);
  const cells = (await table.locator(`tbody tr td:nth-child(${column + 1})`).allInnerTexts()).map((text) => text.trim());
  expect(cells.length).toBeGreaterThan(0);
  for (const cell of cells) expect(cell).toMatch(/^(\d[\d,]*\.\d h|—)$/);
  expect(cells.some((cell) => cell.endsWith(" h"))).toBe(true);
  await table.scrollIntoViewIfNeeded();
  await mkdir(outDir, { recursive: true });
  await page.screenshot({ path: resolve(outDir, "p6-hours-to-clear.png"), fullPage: true });
});
