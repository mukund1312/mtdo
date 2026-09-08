import { test, expect } from "@playwright/test";

// Planning mode (migrations/0017) is real now, not a localStorage draft --
// the wizard's choice is sent to POST /api/onboarding/plan and lands on
// plans.planning_mode; Settings reads and writes that same column, not a
// browser-local copy of it. This is the real round trip, not just "the
// selector renders in both places."
test("Planning mode: choice in onboarding persists, and Settings can change it for real", async ({ page }) => {
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

  await page.getByRole("button", { name: /build my route/i }).click();
  await expect(page.getByRole("heading", { name: /route is ready/i })).toBeVisible({ timeout: 60_000 });
  await page.getByRole("button", { name: /enter today/i }).click();
  await expect(page).toHaveURL(/\/architecture-02\?deck=work$/);

  // The "overall" choice from the wizard really landed on the created plan.
  await page.goto("/architecture-02/settings");
  const settingsGroup = page.getByRole("radiogroup", { name: /planning mode/i });
  await expect(settingsGroup).toBeVisible();
  await expect(settingsGroup.getByRole("radio", { name: /overall/i })).toHaveAttribute("aria-checked", "true");

  // Changing it in Settings is a real write, not a local-only toggle --
  // confirm it survives a reload. updatePlanningMode() updates optimistically
  // and doesn't await the underlying PATCH before returning, so the UI
  // reflects the new value before the write has actually landed -- wait for
  // the real network response, not just the (already-passing) optimistic
  // DOM state, or the reload below can race ahead of the write.
  const saved = page.waitForResponse((response) => response.url().includes("/rest/v1/plans") && response.request().method() === "PATCH");
  await settingsGroup.getByRole("radio", { name: /dynamic weekly/i }).click();
  await expect(settingsGroup.getByRole("radio", { name: /dynamic weekly/i })).toHaveAttribute("aria-checked", "true");
  await saved;
  await page.reload();
  await expect(page.getByRole("radiogroup", { name: /planning mode/i }).getByRole("radio", { name: /dynamic weekly/i })).toHaveAttribute(
    "aria-checked",
    "true",
  );
});

// A fresh session with no active route yet must not show a live control
// with nothing real to save it to -- the exact "fake surface" class of bug
// Phase 1 spent its whole scope removing.
test("Settings shows an honest empty state for planning mode when there is no active route", async ({ page }) => {
  await page.goto("/architecture-02/settings");
  await expect(page.getByRole("heading", { name: /under the hood/i })).toBeVisible();
  await expect(page.getByText(/set up a route first/i)).toBeVisible();
  await expect(page.getByRole("radiogroup", { name: /planning mode/i })).toHaveCount(0);
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
