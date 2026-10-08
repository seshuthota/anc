import { expect, test } from "@playwright/test";

test("labels the demo identity switcher", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByLabel("Demo identity (not real sign-in)")).toBeVisible();
});

test("cancels the first run before a workspace is accepted", async ({ page }) => {
  await page.goto("/");
  // Auto-briefing starts on load; the wordmark becomes a button once the shell leaves home mode.
  await expect(page.getByRole("button", { name: /DemoCo/i })).toBeVisible({ timeout: 20_000 });
  await page.getByRole("button", { name: "Cancel" }).first().click();
  await expect(page.locator("header").getByText("Stopped")).toBeVisible({ timeout: 20_000 });
});

test("shows progress, completes an investigation, and restores it on refresh", async ({ page }) => {
  await page.goto("/");
  // The e2e company database is seeded with hub-fault: the briefing must lead with
  // one primary finding, never the calm "Nothing needs your attention" line.
  await expect(page.locator('[data-a2ui="PrimaryFinding"]')).toHaveCount(1, { timeout: 90_000 });
  const heading = page.locator(".a2ui-root h2").first();
  await expect(heading).toBeVisible({ timeout: 60_000 });
  await expect(heading).not.toHaveText("", { timeout: 60_000 });
  const title = (await heading.innerText()).trim();
  expect(title.length).toBeGreaterThan(0);
  expect(title).not.toMatch(/Nothing needs your attention/i);
  await page.reload();
  await expect(heading).toHaveText(title);
});
