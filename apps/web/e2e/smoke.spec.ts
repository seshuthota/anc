import { expect, test } from "@playwright/test";

test("labels the demo identity switcher", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByLabel("Demo identity (not real sign-in)")).toBeVisible();
});

test("cancels the first run before a workspace is accepted", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "DemoCo" })).toBeVisible();
  await page.getByLabel("Workspace question").fill("What should I care about this morning?");
  await page.getByRole("button", { name: "Ask" }).click();
  await expect(page.getByRole("button", { name: "Cancel" }).first()).toBeVisible();
  await page.getByRole("button", { name: "Cancel" }).first().click();
  await expect(page.locator("header").getByText("Stopped")).toBeVisible({ timeout: 20_000 });
});

test("shows progress, completes an investigation, and restores it on refresh", async ({ page }) => {
  await page.goto("/");
  await page.getByLabel("Workspace question").fill("What should I care about this morning?");
  await page.getByRole("button", { name: "Ask" }).click();
  await expect(page.getByRole("status")).toBeVisible();
  const heading = page.locator(".a2ui-root h2");
  await expect(heading).toHaveText(/Morning overview|Unassigned|Results|Incomplete answer/, { timeout: 60_000 });
  const title = await heading.innerText();
  await page.reload();
  await expect(heading).toHaveText(title);
});
