import { test, expect } from "@playwright/test";
import { openSignalDeckDestination } from "./helpers/signal-deck";

// Phase 6 frontend (migrations/0019-0020, docs/architecture/api.md §3d/§3e):
// the Time deck now renders real `blocks.scheduled_start_at`/`scheduled_end_at`
// and reschedules through the real `schedule_block()` RPC -- this replaces the
// honest "not built yet" placeholder from Phase 1. Google Calendar has no
// credentials in this environment (Phase 6 backend's own report), so the
// "not configured" branch below is the one every real run actually exercises,
// same as the backend's own settings.spec.ts coverage.

// Today's local calendar date, formatted the same way calendar-deck.tsx's own
// isoDate() does (Y-MM-DD, browser-local) -- used to target a specific day's
// hour-slot drop zone by its data-testid.
function todayIso(): string {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
}

async function createRouteWithTwoTasks(page: import("@playwright/test").Page, taskA: string, taskB: string) {
  await page.goto("/architecture-02/onboarding/manual");
  await page.getByPlaceholder(/get fluent in sql joins/i).fill("Prepare for backend interviews");
  await page.getByPlaceholder("e.g. SQL Joins").fill("SQL Fundamentals");
  await page.getByPlaceholder("Add a task").fill(taskA);
  await page.getByRole("button", { name: "Add", exact: true }).click();
  await page.getByPlaceholder("Add a task").fill(taskB);
  await page.getByRole("button", { name: "Add", exact: true }).click();
  await page.getByRole("button", { name: /create my route/i }).click();
  await expect(page).toHaveURL(/\/architecture-02\?deck=work$/);

  await page.getByRole("button", { name: /add from route/i }).click();
  await page.locator(".a02-curriculum-item").filter({ hasText: taskA }).click();
  await page.getByRole("button", { name: /add from route/i }).click();
  await page.locator(".a02-curriculum-item").filter({ hasText: taskB }).click();
  await expect(page.locator(".a02-live-block")).toHaveCount(2);
}

async function openTimeDeck(page: import("@playwright/test").Page) {
  await openSignalDeckDestination(page, "Time");
  await expect(page.getByRole("heading", { name: /give time/i })).toBeVisible();
}

test("day, week and month views render a real scheduled block, drag-scheduled from Unscheduled", async ({ page }) => {
  const taskA = "Practice window functions";
  const taskB = "Review B-tree indexes";
  await createRouteWithTwoTasks(page, taskA, taskB);
  await openTimeDeck(page);

  // Both freshly-picked blocks have no schedule yet -- they belong only in
  // the Unscheduled panel, never on the grid (that's the whole point of the
  // nullable scheduled_start_at/scheduled_end_at columns).
  const unscheduledA = page.locator('button[data-testid^="calendar-unscheduled-"]').filter({ hasText: taskA });
  await expect(unscheduledA).toBeVisible();
  await expect(page.locator('[data-testid^="calendar-event-"]').filter({ hasText: taskA })).toHaveCount(0);

  // Drag task A from Unscheduled onto today's 10:00 slot in Day view.
  const today = todayIso();
  await unscheduledA.dragTo(page.getByTestId(`calendar-slot-${today}-10`));

  const eventChip = page.locator('[data-testid^="calendar-event-"]').filter({ hasText: taskA });
  await expect(eventChip).toBeVisible();
  await expect(page.locator('button[data-testid^="calendar-unscheduled-"]').filter({ hasText: taskA })).toHaveCount(0);
  // Positioned, not just present -- 10:00 falls at (10-6)*48=192px from the
  // top of the 6a-10p grid.
  await expect(eventChip).toHaveCSS("top", "192px");

  // Week view: the same real row, rendered through the multi-column grid.
  await page.locator(".a02-view-switch").getByRole("button", { name: "Week", exact: true }).click();
  await expect(page.locator('[data-testid^="calendar-event-"]').filter({ hasText: taskA })).toBeVisible();

  // Month view: a chip on today's cell, not a time-positioned box.
  await page.locator(".a02-view-switch").getByRole("button", { name: "Month", exact: true }).click();
  const monthCell = page.getByTestId(`calendar-month-cell-${today}`);
  await expect(monthCell.locator('[data-testid^="calendar-month-chip-"]').filter({ hasText: taskA })).toBeVisible();
});

test("unscheduling a block clears its window and returns it to Unscheduled", async ({ page }) => {
  const taskA = "Practice recursion problems";
  const taskB = "Read on indexing strategies";
  await createRouteWithTwoTasks(page, taskA, taskB);
  await openTimeDeck(page);

  const today = todayIso();
  await page.locator('button[data-testid^="calendar-unscheduled-"]').filter({ hasText: taskA }).dragTo(page.getByTestId(`calendar-slot-${today}-14`));
  const eventChip = page.locator('[data-testid^="calendar-event-"]').filter({ hasText: taskA });
  await expect(eventChip).toBeVisible();

  await eventChip.click();
  const popover = page.getByTestId("calendar-detail-popover");
  await expect(popover).toBeVisible();
  await popover.getByTestId("calendar-unschedule-button").click();
  await expect(popover).toHaveCount(0);

  // schedule_block(id) with every optional arg omitted clears the window --
  // the block must leave the grid and reappear in Unscheduled, not just
  // close the popover.
  await expect(page.locator('[data-testid^="calendar-event-"]').filter({ hasText: taskA })).toHaveCount(0);
  await expect(page.locator('button[data-testid^="calendar-unscheduled-"]').filter({ hasText: taskA })).toBeVisible();
});

test("Google Calendar's honest not-connected state renders with no console errors", async ({ page }) => {
  const consoleErrors: string[] = [];
  page.on("console", (message) => { if (message.type() === "error") consoleErrors.push(message.text()); });
  page.on("pageerror", (error) => consoleErrors.push(error.message));

  const taskA = "Draft normalization notes";
  const taskB = "Practice joins under time pressure";
  await createRouteWithTwoTasks(page, taskA, taskB);
  await openTimeDeck(page);

  const today = todayIso();
  await page.locator('button[data-testid^="calendar-unscheduled-"]').filter({ hasText: taskA }).dragTo(page.getByTestId(`calendar-slot-${today}-9`));
  await page.locator('[data-testid^="calendar-event-"]').filter({ hasText: taskA }).click();

  const popover = page.getByTestId("calendar-detail-popover");
  await expect(popover).toBeVisible();
  // No GOOGLE_CLIENT_ID/GOOGLE_CLIENT_SECRET in this environment --
  // GET /api/calendar/status genuinely reports configured:false, and the
  // popover must say so plainly rather than showing a toggle that looks
  // live and isn't.
  await expect(popover.getByTestId("calendar-sync-not-configured")).toBeVisible();
  await expect(popover.getByTestId("calendar-sync-not-configured")).toContainText(/isn.t connected yet/i);
  await expect(popover.locator(".a02-calendar-sync-toggle")).toHaveCount(0);

  expect(consoleErrors).toEqual([]);
});
