import { test, expect } from "@playwright/test";

// Real end-to-end happy path: landing page -> onboarding entry -> intent step
// -> rhythm step -> route ready to build. See README.md for why this stops
// short of submitting (gh95: onboarding's plan-generation step is blocked on
// a Supabase config gap, not on this UI).
test("onboarding wizard: intent -> rhythm -> ready to build a route", async ({ page }) => {
  await page.goto("/architecture-02");
  // First visit shows the Signal Deck walkthrough tour as a modal overlay --
  // dismiss it before interacting with the page underneath.
  await page.getByRole("button", { name: /close walkthrough/i }).click();
  await page.getByRole("link", { name: /set up your route/i }).click();
  await expect(page).toHaveURL(/\/architecture-02\/onboarding$/);

  // Step 1: Intent. The primary button stays disabled until a goal is typed
  // and at least one focus area is added.
  const continueButton = page.getByRole("button", { name: /set the rhythm/i });
  await expect(continueButton).toBeDisabled();

  await page.getByLabel(/your goal/i).fill("Prepare for software engineering interviews by December");
  await page.getByRole("button", { name: "+ Data Structures" }).click();
  await page.getByRole("button", { name: "+ System Design" }).click();
  await expect(page.getByRole("button", { name: /^data structures ×$/i })).toBeVisible();

  await expect(continueButton).toBeEnabled();
  await continueButton.click();

  // Step 2: Rhythm. Defaults (intermediate, Mon-Fri) are already valid --
  // the happy path is "accept the sane defaults and go", not "must configure
  // everything by hand".
  await expect(page.getByRole("heading", { name: /build for the/i })).toBeVisible();
  await expect(page.getByRole("button", { name: "intermediate" })).toHaveClass(/is-selected/);
  for (const day of ["MON", "TUE", "WED", "THU", "FRI"]) {
    await expect(page.getByRole("button", { name: day, exact: true })).toHaveClass(/is-selected/);
  }

  const buildButton = page.getByRole("button", { name: /build my route/i });
  await expect(buildButton).toBeVisible();
  await expect(buildButton).toBeEnabled();
});
