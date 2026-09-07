import { test, expect } from "@playwright/test";

// Real end-to-end happy path: landing page -> onboarding entry -> intent step
// -> rhythm step -> submit -> a persisted plan is ready. gh95 (anonymous
// sign-ins disabled on the connected Supabase project, blocking the
// POST /api/onboarding/plan call this test now drives) is fixed -- see
// README.md for history.
test("onboarding wizard: intent -> rhythm -> build a route end-to-end", async ({ page }) => {
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

  // Step 3: submit and wait for a persisted plan. This calls the real
  // Anthropic API and Supabase (route.ts's own failure contract falls back
  // to a static plan if either misbehaves, so "ready" is the right thing to
  // assert on here, not "used the AI-generated plan specifically").
  await buildButton.click();
  await expect(page.getByText(/route engine active/i)).toBeVisible();

  const readyHeading = page.getByRole("heading", { name: /route is ready/i });
  await expect(readyHeading).toBeVisible({ timeout: 60_000 });
  await expect(page.getByText("Prepare for software engineering interviews by December")).toBeVisible();

  // At least one category card from the persisted plan renders.
  await expect(page.locator("article").first()).toBeVisible();

  const enterTodayButton = page.getByRole("button", { name: /enter today/i });
  await expect(enterTodayButton).toBeEnabled();
  await enterTodayButton.click();
  await expect(page).toHaveURL(/\/architecture-02\?deck=work$/);
  await expect(page.getByRole("heading", { name: /move the right pieces/i })).toBeVisible();
});

test("Review shows an honest empty heatmap and view-only Record Card", async ({ page }) => {
  await page.goto("/architecture-02");
  await page.getByRole("button", { name: /close walkthrough/i }).click();
  await page.getByRole("button", { name: /review/i }).click();

  await expect(page.getByRole("heading", { name: /make effort legible/i })).toBeVisible();
  await expect(page.getByLabel("Six-week focus heatmap")).toBeVisible();
  await expect(page.getByText(/no recorded focus in this window yet/i)).toBeVisible();

  await page.getByRole("button", { name: /view record/i }).click();
  const record = page.getByRole("dialog", { name: /the work is real/i });
  await expect(record).toBeVisible();
  await expect(record.getByText("0m", { exact: true })).toBeVisible();
  await expect(record.getByRole("button", { name: /download|export/i })).toHaveCount(0);
});
