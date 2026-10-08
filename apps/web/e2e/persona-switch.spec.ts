import { expect, test } from "@playwright/test";

/*
 * Switching persona through the selector while the first briefing is still
 * loading: the old persona's card and buttons never reach the screen, and the
 * new persona's briefing starts and stays (the e2e agent paces each step at
 * 1.2 s, so the COO's briefing is mid-flight when the switch happens).
 */
test("switching persona mid-load drops the old briefing and starts the new one", async ({ page }) => {
  await page.goto("/");
  const selector = page.getByLabel("Demo identity (not real sign-in)");
  await expect(selector).toHaveValue("user-coo");
  // The COO's first briefing is running.
  await expect(page.getByTestId("activity-pill")).toHaveAttribute("aria-label", /^Working:/, { timeout: 20_000 });
  await expect(page.locator('[data-a2ui="PrimaryFinding"]')).toHaveCount(0);

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
  await expect(page.getByRole("button", { name: /^Escalate |^Notify |^Assign / })).toHaveCount(0);
});
