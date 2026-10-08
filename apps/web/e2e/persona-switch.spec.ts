import { expect, test } from "@playwright/test";

/*
 * Switching persona through the selector while the first briefing is still
 * loading: the old persona's card and buttons never reach the screen, and the
 * new persona's briefing starts and stays (the e2e agent paces each step at
 * 1.2 s, so the COO's run is mid-flight when the switch happens).
 * Specs share one runtime store: run alone, the COO's first briefing is the
 * in-flight run; after earlier specs the COO already has a briefing, so a typed
 * question is the in-flight run instead. The last-mile lead is not used before
 * this spec, so their briefing is always a fresh one.
 */
test("switching persona mid-load drops the old briefing and starts the new one", async ({ page }) => {
  await page.goto("/");
  const selector = page.getByLabel("Demo identity (not real sign-in)");
  await expect(selector).toHaveValue("user-coo");
  const pill = page.getByTestId("activity-pill");
  const working = pill.and(page.locator('[aria-label^="Working:"]'));
  const restored = page.locator('[data-a2ui="PrimaryFinding"], [data-a2ui="ContextHeader"]').first();
  await expect(working.or(restored)).toBeVisible({ timeout: 20_000 });
  if (await restored.isVisible()) {
    // A briefing was restored: make a typed question the in-flight run.
    await expect(pill).toHaveText(/lookups?\b/, { timeout: 60_000 });
    await page.getByLabel("Workspace question").fill("How is Godavari Organics doing on on-time delivery?");
    await page.getByRole("button", { name: "Ask" }).click();
  }
  await expect(pill).toHaveAttribute("aria-label", /^Working:/, { timeout: 20_000 });

  await selector.selectOption("user-lastmile");
  await expect(selector).toHaveValue("user-lastmile");
  // The new persona's briefing starts on its own.
  await expect(page.getByTestId("activity-pill")).toHaveAttribute("aria-label", /^Working:/, { timeout: 20_000 });

  const primary = page.locator('[data-a2ui="PrimaryFinding"]');
  await expect(primary).toHaveCount(1, { timeout: 90_000 });
  const headline = primary.locator("h2");
  await expect(headline).toHaveText("3 route runs held today");
  await expect(page.getByTestId("activity-pill")).toHaveText(/lookups?\b/, { timeout: 30_000 });

  // Long enough for the COO's old run to have finished had it not been stopped:
  // its card and its operation buttons must never come back.
  await page.waitForTimeout(8_000);
  await expect(primary).toHaveCount(1);
  await expect(headline).toHaveText("3 route runs held today");
  await expect(primary).not.toContainText("905 parcels at risk");
  await expect(page.locator('[data-a2ui="ContextHeader"]')).toHaveCount(0);
  await expect(page.getByRole("button", { name: /^Escalate |^Notify |^Assign / })).toHaveCount(0);
});
