import { expect, test, type Page } from "@playwright/test";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { agentUrl } from "./agent-url";

const outDir = resolve(__dirname, "../../../test-results");
const primary = (page: Page) => page.locator('[data-a2ui="PrimaryFinding"]');

async function briefed(page: Page) {
  await expect(primary(page)).toHaveCount(1, { timeout: 90_000 });
  await expect(page.locator(".a2ui-root button").first()).toBeVisible({ timeout: 90_000 });
}

test("an unauthorized persona gets no Escalate button, and a forged request is refused with 403", async ({ page, request }) => {
  await page.addInitScript(() => window.localStorage.setItem("anc-principal", "user-accounts"));
  await page.goto("/");
  await expect(page.getByLabel("Demo identity (not real sign-in)")).toHaveValue("user-accounts");
  await briefed(page);
  await expect(page.getByRole("button", { name: "Look into this" })).toBeVisible({ timeout: 90_000 });
  await expect(page.getByRole("button", { name: /Notify Godavari Organics/ })).toBeVisible();
  await expect(page.getByRole("button", { name: /^Escalate/ })).toHaveCount(0);
  const forged = await request.post(agentUrl("/runtime/actions"), {
    headers: { "x-anc-principal": "user-accounts", "content-type": "application/json" },
    data: { actionId: `forged-${Date.now()}`, name: "propose_action", parameters: { actionId: "escalate_equipment_fault" } },
  });
  expect(forged.status()).toBe(403);
});

test("Escalate → confirm on the same card → receipt; a double click writes once", async ({ page }) => {
  await page.goto("/");
  await briefed(page);
  const card = primary(page);
  const escalate = page.getByRole("button", { name: "Escalate Sorter belt B fault" });
  await expect(escalate).toBeVisible();
  // ≤3 action buttons on the primary.
  const labels = await page.locator(".a2ui-root button").allInnerTexts();
  expect(labels.filter((label) => /^(Escalate|Notify|Assign|Look into this)/.test(label.trim())).length).toBeLessThanOrEqual(3);
  await escalate.click();

  const confirm = page.getByRole("button", { name: "Confirm escalation" });
  await expect(confirm).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText(/Escalate Sorter belt B at Hyderabad Hub \(eq-hyd-0920\) to Venkatesh Rao/)).toBeVisible();
  await expect(page.getByRole("button", { name: "Cancel" }).last()).toBeVisible();
  await expect(card).toHaveCount(1);
  await mkdir(outDir, { recursive: true });
  await page.screenshot({ path: resolve(outDir, "p4-action-confirm.png"), fullPage: true });

  await confirm.dblclick();
  const receipt = page.getByTestId("action-receipt");
  await expect(receipt).toHaveCount(1, { timeout: 30_000 });
  await expect(receipt).toHaveText(/Escalated Sorter belt B to Venkatesh Rao at \d{2}:\d{2} IST · maintenance log updated · receipt op-/);
  await expect(receipt).toHaveAttribute("data-action-id", "escalate_equipment_fault");
  await expect(page.getByRole("button", { name: "Escalate Sorter belt B fault" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Confirm escalation" })).toHaveCount(0);
  await expect(primary(page)).toHaveCount(1);
  await page.evaluate(() => window.getSelection()?.removeAllRanges());
  await page.screenshot({ path: resolve(outDir, "p4-action-receipt.png"), fullPage: true });

  // The receipt's record opens the re-read evidence.
  await receipt.getByRole("button", { name: "Record" }).click();
  const drawer = page.getByTestId("evidence-drawer");
  await expect(drawer).toBeVisible({ timeout: 15_000 });
  await expect(drawer).toContainText(/equipment events/i);
  await expect(drawer).toContainText(/Venkatesh Rao|emp-eng-hyd/);
  await page.getByRole("button", { name: "Close" }).click();

  // A second confirm on the old card is a no-op on the server: one write, one escalation.
  const state = await page.request.get(agentUrl("/runtime/state"), { headers: { "x-anc-principal": "user-coo" } });
  const body = await state.json() as { surface: { dataModel: { briefing: { primary: { receipts: unknown[] } } } } };
  expect(body.surface.dataModel.briefing.primary.receipts).toHaveLength(1);
});
