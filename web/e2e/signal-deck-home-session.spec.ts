import { test, expect } from "@playwright/test";
import { openSignalDeckDestination } from "./helpers/signal-deck";

// Phase 1 of the operating-engine plan ("make the shipped surfaces honest")
// closed a real gap: Home, Time and the Session coach rail all showed
// literal hardcoded strings ("Two Sum", "3h 20m", "Make joins feel
// obvious") regardless of what was actually in the database. This spec is
// the plan's own P1 verification bar -- "every Home/Session number
// traceable to a row; no literal task strings remain" -- run against a
// real anonymous session and a real persisted plan, not a mock.

test("Home and Time show honest empty states for a brand-new user, no fake literals", async ({ page }) => {
  await page.goto("/architecture-02");
  await page.getByRole("button", { name: /close walkthrough/i }).click();

  // The old static markup showed "Two Sum" in three separate places and a
  // fabricated "3h 20m" / "4-day signal" regardless of account state. None
  // of that may appear for a fresh anonymous user with no plan and no
  // blocks.
  await expect(page.getByText("Two Sum")).toHaveCount(0);
  await expect(page.getByText("3h 20m")).toHaveCount(0);
  await expect(page.getByText(/4-day signal/i)).toHaveCount(0);
  await expect(page.getByText("All clear")).toBeVisible();
  await expect(page.getByText(/no active route yet/i)).toBeVisible();
  await expect(page.getByText(/0-day streak/i)).toBeVisible();

  // Time deck (Phase 6 frontend): no fabricated "09:30 -- 10:15 / Two Sum"
  // event -- the real calendar's own honest empty state instead (nothing on
  // the grid, nothing waiting in Unscheduled for a brand-new user with no
  // blocks at all).
  await openSignalDeckDestination(page, "Time");
  await expect(page.getByRole("heading", { name: /give time/i })).toBeVisible();
  await expect(page.getByText(/nothing waiting/i)).toBeVisible();
  await expect(page.locator('[data-testid^="calendar-event-"]')).toHaveCount(0);
  await expect(page.getByText("Two Sum")).toHaveCount(0);

  // Goals is a first-class dock destination. It reads the existing active
  // route when present; the shell must remain useful even before one exists.
  await openSignalDeckDestination(page, "Goals");
  await expect(page.getByRole("heading", { name: /hold the line/i })).toBeVisible();

  // The header's live clock replaced a hardcoded "TUESDAY / 06 SEP / 09:24"
  // -- assert it renders the real current weekday, not that literal string.
  const today = new Intl.DateTimeFormat("en", { weekday: "long" }).format(new Date()).toUpperCase();
  await expect(page.getByText(today, { exact: false })).toBeVisible();
});

test("marketing root links to the real app", async ({ page }) => {
  await page.goto("/");
  const openApp = page.getByRole("link", { name: /open the app/i });
  await expect(openApp).toBeVisible();
  await openApp.click();
  await expect(page).toHaveURL(/\/architecture-02$/);
});

test("Home reflects a real picked task and Session shows real, non-fake coaching", async ({ page }) => {
  await page.goto("/architecture-02");
  await page.getByRole("button", { name: /close walkthrough/i }).click();
  await page.getByRole("link", { name: /set up your route/i }).click();
  await expect(page).toHaveURL(/\/architecture-02\/onboarding$/);
  await page.getByRole("button", { name: /guided ai/i }).click();

  await page.getByLabel(/your goal/i).fill("Get fluent in SQL joins for interviews");
  await page.getByPlaceholder(/add a subject or skill/i).fill("Databases");
  await page.getByRole("button", { name: "Add", exact: true }).click();
  await expect(page.getByRole("button", { name: /^databases ×$/i })).toBeVisible();
  await page.getByRole("button", { name: /set the rhythm/i }).click();

  const buildButton = page.getByRole("button", { name: /build my route/i });
  await expect(buildButton).toBeEnabled();
  await buildButton.click();
  await expect(page.getByRole("heading", { name: /route is ready/i })).toBeVisible({ timeout: 60_000 });

  const enterTodayButton = page.getByRole("button", { name: /enter today/i });
  await enterTodayButton.click();
  await expect(page).toHaveURL(/\/architecture-02\?deck=work$/);

  await page.getByRole("button", { name: /add from route/i }).click();
  const routeMenu = page.getByRole("dialog", { name: /choose the next piece/i });
  const routeItem = routeMenu.locator(".a02-curriculum-item").first();
  await expect(routeItem).toBeVisible();
  const taskText = (await routeItem.locator("b").textContent())?.trim();
  expect(taskText).toBeTruthy();
  await routeItem.click();
  await expect(routeMenu).toBeHidden();
  await expect(page.locator(".a02-live-block").filter({ hasText: taskText! })).toBeVisible();

  // Home's "01 / TASK SIGNAL" card and "02 / TODAY'S LOAD" counter must now
  // reflect this real picked block -- not the old static "Two Sum" card.
  await openSignalDeckDestination(page, "Deck");
  await expect(page.getByText(taskText!).first()).toBeVisible();
  await expect(page.getByText("0/1", { exact: false })).toBeVisible();

  // The hero orb button also shows this same real task -- clicking it goes
  // straight into a real linked session (Home's beginFocus routes directly
  // when a next task exists, no lens step). Confirm the coach rail there
  // shows real merged content, not the hardcoded "If a join feels
  // slippery..." SQL paragraph the old static markup showed for every task
  // regardless of what it actually was.
  await page.locator(".a02-focus-node").click();
  await expect(page).toHaveURL(/\/session\?blockId=/);

  // Focus now enters the timer and coaching workspace directly: the retired
  // unlinked pre-session landing surface is no longer part of this flow.
  await expect(page.getByRole("heading", { name: /stay with the question/i })).toBeVisible();
  await expect(page.getByText(/if a join feels slippery/i)).toHaveCount(0);
  await expect(page.getByText(/what changes if an order has no matching customer/i)).toHaveCount(0);
  await expect(page.getByRole("button", { name: /ask for a nudge/i })).toHaveCount(0);
  // Real coach content: at minimum the generic-library "Ask yourself" /
  // "Watch for" sections render something, whatever the merge produced.
  await expect(page.getByText("Ask yourself")).toBeVisible();
  await expect(page.getByText("Watch for")).toBeVisible();
});
