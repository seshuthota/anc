import { expect, test, type Page } from "@playwright/test";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";

/*
 * The evidence drawer speaks to people: names, not ids; where the data came
 * from, not a tool name; and for route runs, the rows the briefing cites first.
 * Runs after persona-switch.spec.ts (which needs the last-mile lead unused).
 */
const outDir = resolve(__dirname, "../../../test-results");
const primary = (page: Page) => page.locator('[data-a2ui="PrimaryFinding"]');
const RAW_ID = /\b(hub|lock|dist|shipper|eq|run|emp)-[a-z0-9]+/;

async function briefingAs(page: Page, persona: string) {
  await page.addInitScript((id) => window.localStorage.setItem("anc-principal", id), persona);
  await page.goto("/");
  await expect(page.getByLabel("Demo identity (not real sign-in)")).toHaveValue(persona);
  const pill = page.getByTestId("activity-pill");
  const body = page.locator('[data-a2ui="PrimaryFinding"], [data-a2ui="ContextHeader"]').first();
  await expect(body).toBeVisible({ timeout: 90_000 });
  await expect(pill).toHaveText(/lookups?\b/, { timeout: 60_000 });
  // Earlier specs may have left a drill-down on screen: ask for the briefing again.
  if (!(await primary(page).isVisible()) || (await page.locator('[data-a2ui="ContextHeader"]').count())) {
    await page.getByRole("button", { name: "DemoCo: refresh briefing" }).click();
    await expect(page.locator('[data-a2ui="ContextHeader"]')).toHaveCount(0, { timeout: 90_000 });
  }
  await expect(primary(page)).toHaveCount(1, { timeout: 90_000 });
  await expect(pill).toHaveText(/lookups?\b/, { timeout: 60_000 });
}

async function expectPersonWordingOnEveryTab(page: Page) {
  const drawer = page.getByTestId("evidence-drawer");
  await expect(drawer).toBeVisible();
  const tabs = drawer.getByRole("tab");
  const count = Math.max(1, await tabs.count());
  for (let index = 0; index < count; index += 1) {
    if (await tabs.count()) await tabs.nth(index).click();
    await expect(drawer.locator(".ev-meta")).toBeVisible();
    const text = await drawer.innerText();
    expect(text, `tab ${index}`).not.toMatch(RAW_ID);
    expect(text, `tab ${index}`).not.toContain("Company tool");
    expect(text, `tab ${index}`).not.toMatch(/\b[a-z]+_[a-z_]+\b/);
  }
}

test("hub supervisor's evidence names the hub and never shows raw ids or tool names", async ({ page }) => {
  await briefingAs(page, "user-hub-hyd");
  // The headline figure is the hub's own: its scope reads "Hyderabad Hub", not "hub: hub-hyd".
  await primary(page).locator(".ws-primary-value").click();
  const drawer = page.getByTestId("evidence-drawer");
  await expect(drawer.locator(".ev-definition")).toContainText("Hyderabad Hub");
  await expect(drawer).not.toContainText(RAW_ID);
  await mkdir(outDir, { recursive: true });
  await drawer.screenshot({ path: resolve(outDir, "p8-evidence-drawer.png") });
  await page.getByRole("button", { name: "Close" }).click();
  await primary(page).getByRole("button", { name: /Evidence \(\d+\)/ }).click();
  await expectPersonWordingOnEveryTab(page);
});

test("route runs evidence shows the 3 held runs first; locker evidence names the site", async ({ page }) => {
  await briefingAs(page, "user-lastmile");
  await expect(primary(page).locator("h2")).toHaveText("3 route runs held today");
  await primary(page).locator(".ws-primary-value").click();
  const drawer = page.getByTestId("evidence-drawer");
  await expect(drawer).toBeVisible();
  const panel = drawer.locator(".ev-panel");
  await expect(panel.locator(".ev-meta")).toContainText("today's delivery route runs");
  await expect(panel.locator(".ev-excerpt")).toContainText(/^3 held runs first/);
  const status = await panel.locator(".ev-excerpt table").evaluate((table) => {
    const heads = [...table.querySelectorAll("th")].map((th) => th.textContent);
    const column = heads.indexOf("Status");
    return [...table.querySelectorAll("tbody tr")].slice(0, 4).map((tr) => tr.children[column]?.textContent);
  });
  expect(status.slice(0, 3)).toEqual(["Held", "Held", "Held"]);
  expect(status[3]).not.toBe("Held");
  await expect(panel.locator("tr.is-cited")).toHaveCount(3);
  await mkdir(outDir, { recursive: true });
  await drawer.screenshot({ path: resolve(outDir, "p8-route-runs-evidence.png") });
  await page.getByRole("button", { name: "Close" }).click();

  // Every record behind the last-mile briefing, the locker one included.
  await primary(page).getByRole("button", { name: /Evidence \(\d+\)/ }).click();
  await expectPersonWordingOnEveryTab(page);
});
