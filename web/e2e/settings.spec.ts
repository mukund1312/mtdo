import { test, expect } from "@playwright/test";

test("Planning mode stays inline during setup and is available in Settings", async ({ page }) => {
  await page.goto("/architecture-02/onboarding");
  await page.getByRole("button", { name: /guided ai/i }).click();
  await page.getByLabel(/your goal/i).fill("Prepare a clear study route for interview practice");
  await page.getByRole("button", { name: /\+ sql/i }).click();
  await page.getByRole("button", { name: /set the rhythm/i }).click();

  const modeGroup = page.getByRole("radiogroup", { name: /planning mode/i });
  await expect(modeGroup).toBeVisible();
  const overall = modeGroup.getByRole("radio", { name: /overall/i });
  await overall.click();
  await expect(overall).toHaveAttribute("aria-checked", "true");
  await overall.press("ArrowLeft");
  await expect(modeGroup.getByRole("radio", { name: /dynamic weekly/i })).toHaveAttribute("aria-checked", "true");

  await page.goto("/architecture-02/settings");
  await expect(page.getByRole("heading", { name: /under the hood/i })).toBeVisible();
  await expect(page.getByRole("radiogroup", { name: /planning mode/i })).toBeVisible();
});

// Phase 2's frontend piece: Settings -> AI is a real status panel backed by
// GET /api/ai/status, not a static mock -- and the "More" dock button
// (previously dead, no onClick) now actually navigates there.
test("More dock button opens Settings, which shows real AI provider status", async ({ page }) => {
  await page.goto("/architecture-02");
  await page.getByRole("button", { name: /close walkthrough/i }).click();

  await page.getByRole("navigation", { name: "Signal deck navigation" }).getByRole("button", { name: /more/i }).click();
  await expect(page).toHaveURL(/\/architecture-02\/settings$/);

  await expect(page.getByRole("heading", { name: /under the hood/i })).toBeVisible();
  await expect(page.getByText("AI provider")).toBeVisible();
  // healthCheck() makes a real outbound call (Anthropic or Ollama) before
  // the status resolves -- give it real headroom instead of the default 5s.
  const providerRow = page.locator(".a02-settings-row").filter({ hasText: "Provider" });
  await expect(providerRow).toBeVisible({ timeout: 20_000 });
  const statusRow = page.locator(".a02-settings-row").filter({ hasText: "Status" });
  await expect(statusRow.getByText(/reachable|unreachable/i)).toBeVisible();

  await page.getByRole("link", { name: /back to deck/i }).click();
  await expect(page).toHaveURL(/\/architecture-02$/);
});
