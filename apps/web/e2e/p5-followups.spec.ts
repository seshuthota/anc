import { expect, test, type Page } from "@playwright/test";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { agentUrl } from "./agent-url";

const outDir = resolve(__dirname, "../../../test-results");
const primary = (page: Page) => page.locator('[data-a2ui="PrimaryFinding"]');
const header = (page: Page) => page.locator('[data-a2ui="ContextHeader"]');
const anchors = async (page: Page) => (await primary(page).count()) + (await header(page).count());
const revision = async (page: Page) => {
  const response = await page.request.get(agentUrl("/runtime/state"), { headers: { "x-anc-principal": "user-coo" } });
  return ((await response.json()) as { surface: { revision: number } }).surface.revision;
};

test("the activity is one pill; its popover lists findings only, ending in Workspace ready", async ({ page }) => {
  await page.goto("/");
  await expect(primary(page)).toHaveCount(1, { timeout: 90_000 });
  const pill = page.getByTestId("activity-pill");
  await expect(pill).toHaveText(/^4 agents · \d+ lookups · \d+\.\ds▸?$/, { timeout: 30_000 });
  await expect(pill).toHaveAttribute("aria-expanded", "false");
  await expect(page.getByTestId("activity-popover")).toHaveCount(0);
  // The old trace and rail are gone.
  await expect(page.getByTestId("trace")).toHaveCount(0);
  // Developer details only with ?dev=1.
  await expect(page.locator(".dev-details")).toHaveCount(0);

  await pill.click();
  const popover = page.getByTestId("activity-popover");
  await expect(popover).toBeVisible();
  await expect(popover.locator("li").last()).toHaveText("Workspace ready");
  const text = await popover.innerText();
  expect(text).not.toMatch(/\bStarted\b|\bCompleted\b|\bcompleted\b/);
  expect(text).not.toMatch(/218/);
  expect(text).toMatch(/\d+ findings?/);
  await mkdir(outDir, { recursive: true });
  await page.screenshot({ path: resolve(outDir, "p5-activity-popover.png") });
  await page.keyboard.press("Escape");
  await expect(popover).toHaveCount(0);

  await page.goto("/?dev=1");
  await expect(page.locator(".dev-details")).toHaveCount(1, { timeout: 30_000 });
});

test("briefing → Look into this → body replaced under a context header; a typed drill stays; Back restores revision N", async ({ page }) => {
  await page.goto("/");
  await expect(primary(page)).toHaveCount(1, { timeout: 90_000 });
  await expect(page.getByTestId("activity-pill")).toHaveText(/lookups/, { timeout: 30_000 });
  const n = await revision(page);

  // "Look into this" on the primary, or on a lower-priority item when the primary's
  // three buttons are all operations.
  const drill = page.getByRole("button", { name: "Look into this" }).first();
  if (!(await drill.isVisible())) await page.locator('[data-a2ui="Collapsible"] summary').click();
  await drill.click();
  // While it is worked on, the briefing stays on screen, dimmed.
  await expect(page.locator(".workspace.updating")).toBeVisible();
  await expect(primary(page)).toHaveCount(1);

  await expect(header(page)).toHaveCount(1, { timeout: 60_000 });
  await expect(primary(page)).toHaveCount(0);
  await expect(header(page)).toContainText("From your briefing");
  await expect(page.locator(".workspace.updating")).toHaveCount(0);
  expect(await anchors(page)).toBe(1);
  expect(await revision(page)).toBe(n + 1);
  await page.screenshot({ path: resolve(outDir, "p5-drill-down-back.png"), fullPage: true });

  // A typed question about a record on the briefing is still a drill from it.
  await page.getByLabel("Workspace question").fill("How is Godavari Organics doing on on-time delivery?");
  await page.getByRole("button", { name: "Ask" }).click();
  await expect(header(page)).toContainText("Godavari Organics", { timeout: 60_000 });
  expect(await anchors(page)).toBe(1);
  expect(await revision(page)).toBe(n + 2);

  // Back restores exactly the briefing revision the drill came from.
  await header(page).getByRole("button", { name: "Back", exact: true }).click();
  await expect(primary(page)).toHaveCount(1, { timeout: 30_000 });
  await expect(header(page)).toHaveCount(0);
  expect(await anchors(page)).toBe(1);
  expect(await revision(page)).toBe(n);
});
