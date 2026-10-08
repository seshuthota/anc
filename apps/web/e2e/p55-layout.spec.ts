import { expect, test } from "@playwright/test";

/*
 * P5.5: no activity rail. The answer is one centred column; activity is a pill
 * in the masthead; the persona's full name and title are never cut short.
 */
test("no activity sidebar, a pill instead, a centred 760–880px column and an untruncated persona", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/");
  await expect(page.locator('[data-a2ui="PrimaryFinding"]')).toHaveCount(1, { timeout: 90_000 });
  await expect(page.getByTestId("activity-pill")).toHaveText(/lookups/, { timeout: 30_000 });

  // No rail of any kind: no aside, no old trace/steps panel, and no tall narrow
  // element pinned to the right of the column.
  await expect(page.locator("aside, .steps-panel, .trace, [data-testid=trace], .steps")).toHaveCount(0);
  const viewport = page.viewportSize()!;
  const tallRightPanels = await page.evaluate(({ width, height }) => {
    return Array.from(document.querySelectorAll<HTMLElement>("body *")).filter((element) => {
      const box = element.getBoundingClientRect();
      return box.left > width * 0.6 && box.width < width * 0.4 && box.width > 120 && box.height > height * 0.6 && getComputedStyle(element).visibility !== "hidden";
    }).map((element) => element.className || element.tagName);
  }, viewport);
  expect(tallRightPanels).toEqual([]);

  // The pill lives in the masthead.
  await expect(page.locator("header.masthead").getByTestId("activity-pill")).toBeVisible();

  // One centred column, max-width within 760–880px.
  const stage = page.getByTestId("stage");
  const maxWidth = await stage.evaluate((element) => parseFloat(getComputedStyle(element).maxWidth));
  expect(maxWidth).toBeGreaterThanOrEqual(760);
  expect(maxWidth).toBeLessThanOrEqual(880);
  const box = (await stage.boundingBox())!;
  expect(box.width).toBeLessThanOrEqual(880);
  expect(Math.abs(box.x + box.width / 2 - viewport.width / 2)).toBeLessThan(2);
  const workspace = (await page.getByTestId("workspace").boundingBox())!;
  expect(workspace.width).toBeGreaterThan(box.width - 60);

  // Dark-first.
  const background = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
  const [r, g, b] = background.match(/\d+/g)!.map(Number);
  expect(r + g + b).toBeLessThan(60);

  // The persona select is wide enough for the chosen option's full text.
  const persona = page.getByLabel("Demo identity (not real sign-in)");
  const fits = await persona.evaluate((element) => {
    const select = element as HTMLSelectElement;
    const style = getComputedStyle(select);
    const context = document.createElement("canvas").getContext("2d")!;
    context.font = `${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
    const text = select.options[select.selectedIndex]!.text;
    const needed = context.measureText(text).width + parseFloat(style.paddingLeft) + parseFloat(style.paddingRight);
    return { text, needed, actual: select.getBoundingClientRect().width };
  });
  expect(fits.text).toContain("·");
  expect(fits.actual).toBeGreaterThanOrEqual(fits.needed - 1);

  // Severity is a pill, not a red tile: no element on the surface has a red fill.
  const redFills = await page.evaluate(() => Array.from(document.querySelectorAll<HTMLElement>(".a2ui-root *")).filter((element) => {
    const match = getComputedStyle(element).backgroundColor.match(/\d+(\.\d+)?/g);
    if (!match) return false;
    const [r, g, b, a = 1] = match.map(Number);
    return a > 0.2 && r > 150 && r > g * 1.8 && r > b * 1.8;
  }).length);
  expect(redFills).toBe(0);
  await expect(page.locator(".ws-stat")).toHaveCount(0);
});
