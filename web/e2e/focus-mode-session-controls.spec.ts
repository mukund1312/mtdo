import { test, expect, type Page } from "@playwright/test";

// Focus Mode's session controls, built against migrations/0023's locked
// contract (docs/architecture/api.md §3h) and PR #160. Each test drives a
// real browser against the real linked Supabase project, the same pattern
// signal-deck-home-session.spec.ts and phase5-kanban-metadata.spec.ts
// already use for UI-level coverage (one fresh anonymous user per test, via
// the app's own anonymous-auth proxy -- no direct supabase-js calls here,
// unlike session-rpc-contract.spec.ts's raw-RPC coverage of the same
// migration, which this file deliberately does not duplicate).
//
// Real timers are slow, so every test that needs the "last 5 minutes" /
// natural-expiration paths uses a short custom duration (seconds, not
// minutes) via the mm:ss picker -- the fixed 5-minute extend-prompt window
// (EXTEND_WINDOW_S in page.tsx) then applies from the very start of a
// sub-5-minute session, which is expected and asserted on, not worked
// around.

async function createBlockAndEnterSession(page: Page, taskText: string) {
  // Manual Setup (api.md §3c) creates a real plan/category/block with no AI
  // call, unlike Guided AI onboarding -- fast and deterministic for a test.
  await page.goto("/architecture-02/onboarding/manual");
  await page.getByPlaceholder(/get fluent in sql joins/i).fill(`Goal for ${taskText}`);
  await page.getByPlaceholder("e.g. SQL Joins").fill("Focus Mode QA");
  await page.getByPlaceholder("Add a task").fill(taskText);
  await page.getByRole("button", { name: "Add", exact: true }).click();
  await page.getByRole("button", { name: /create my route/i }).click();
  await expect(page).toHaveURL(/\/architecture-02\?deck=work$/);

  await page.getByRole("button", { name: /add from route/i }).click();
  await page.locator(".a02-curriculum-item").filter({ hasText: taskText }).click();
  await expect(page.locator(".a02-live-block").filter({ hasText: taskText })).toBeVisible();

  // Same route signal-deck-home-session.spec.ts already proved: the hero
  // orb routes straight into a real linked session when a next task exists.
  await page.getByRole("navigation", { name: "Signal deck navigation" }).getByRole("button", { name: /deck/i }).click();
  await page.locator(".a02-focus-node").click();
  await expect(page).toHaveURL(/\/session\?blockId=/);
  await expect(page.getByRole("button", { name: /begin focus/i })).toBeEnabled();
}

async function setDuration(page: Page, totalSeconds: number) {
  await page.getByLabel("Session length, minutes").fill(String(Math.floor(totalSeconds / 60)));
  await page.getByLabel("Session length, seconds").fill(String(totalSeconds % 60));
}

async function setBreaks(page: Page, count: number, lengthSeconds: number) {
  for (let i = 0; i < count; i += 1) {
    await page.getByRole("button", { name: "More breaks" }).click();
  }
  if (count > 0) {
    await page.getByLabel("Length each, minutes").fill(String(Math.floor(lengthSeconds / 60)));
    await page.getByLabel("Length each, seconds").fill(String(lengthSeconds % 60));
  }
}

// Any session under 5 minutes trips the "need more time?" prompt immediately
// (remaining starts inside the window) -- dismiss it in tests that aren't
// about that prompt specifically.
async function dismissExtendPromptIfPresent(page: Page) {
  const decline = page.getByRole("button", { name: "No, I'm good", exact: true });
  if (await decline.isVisible().catch(() => false)) await decline.click();
}

test("a custom duration and break plan can be configured, and a scheduled break actually fires mid-session", async ({ page }) => {
  await createBlockAndEnterSession(page, "Break plan QA task");

  await setDuration(page, 18);
  await setBreaks(page, 1, 3);
  // buildBreakPlan(18, 1, 3): one break, evenly split -> at focus-second 9.
  await expect(page.getByText("Breaks at 0:09 (0:03 each)")).toBeVisible();

  await page.getByRole("button", { name: /begin focus/i }).click();
  await expect(page.getByRole("heading", { name: /stay with the question/i })).toBeVisible();
  await dismissExtendPromptIfPresent(page);

  // The break is a real pause_session(reason: 'break') call driven off the
  // break_plan the server actually persisted and echoed back -- this is
  // what proves the configured plan round-tripped correctly, not just that
  // the picker computed the right preview text.
  await expect(page.getByText(/on a break/i)).toBeVisible({ timeout: 15_000 });
  await expect(page.getByRole("button", { name: "Pause", exact: true })).toHaveCount(0);
  await expect(page.getByText(/on a break/i)).toBeHidden({ timeout: 10_000 });
  await expect(page.getByRole("button", { name: "Pause", exact: true })).toBeVisible();

  // finishExit() redirects to the deck once the session is settled -- there
  // is no longer a notice to read on /session itself (PR #162's quiet-exit
  // pattern, preserved); the board is the proof this feature already
  // checks elsewhere, so just confirm the navigation happened.
  await page.getByRole("button", { name: "End session", exact: true }).click();
  await expect(page).toHaveURL(/\/architecture-02$/, { timeout: 10_000 });
});

test("pause stops the visible timer and resume continues it", async ({ page }) => {
  await createBlockAndEnterSession(page, "Pause resume QA task");
  await setDuration(page, 120);

  await page.getByRole("button", { name: /begin focus/i }).click();
  await expect(page.getByRole("heading", { name: /stay with the question/i })).toBeVisible();
  await dismissExtendPromptIfPresent(page);

  const meter = page.getByRole("meter", { name: /% of focus session elapsed/i });
  await page.waitForTimeout(3_000);
  const beforePause = Number(await meter.getAttribute("aria-valuenow"));
  expect(beforePause).toBeGreaterThan(0);

  await page.getByRole("button", { name: "Pause", exact: true }).click();
  await expect(page.getByRole("button", { name: "Resume", exact: true })).toBeVisible();
  const pausedAt = Number(await meter.getAttribute("aria-valuenow"));

  await page.waitForTimeout(4_000);
  const stillPaused = Number(await meter.getAttribute("aria-valuenow"));
  expect(stillPaused).toBe(pausedAt); // frozen while paused, not just slowed

  await page.getByRole("button", { name: "Resume", exact: true }).click();
  await expect(page.getByRole("button", { name: "Pause", exact: true })).toBeVisible();
  await page.waitForTimeout(3_000);
  const afterResume = Number(await meter.getAttribute("aria-valuenow"));
  expect(afterResume).toBeGreaterThan(stillPaused);
});

test("End session marks the linked block Done, visible on the Kanban board after navigating back", async ({ page }) => {
  const taskText = "End session QA task";
  await createBlockAndEnterSession(page, taskText);

  await page.getByRole("button", { name: /begin focus/i }).click();
  await expect(page.getByRole("heading", { name: /stay with the question/i })).toBeVisible();

  // finishExit() redirects to the deck as soon as the session settles (PR
  // #162's quiet-exit pattern, preserved) -- no notice to read on /session
  // itself, so the board state below is the real assertion.
  await page.getByRole("button", { name: "End session", exact: true }).click();
  await expect(page).toHaveURL(/\/architecture-02$/);

  await page.goto("/architecture-02?deck=work");
  const doneLane = page.locator(".a02-today-lane--done");
  await expect(doneLane.locator(".a02-live-block").filter({ hasText: taskText })).toBeVisible();
});

test("Leave early keeps the linked block in In progress, visible on the Kanban board", async ({ page }) => {
  const taskText = "Leave early QA task";
  await createBlockAndEnterSession(page, taskText);

  await page.getByRole("button", { name: /begin focus/i }).click();
  await expect(page.getByRole("heading", { name: /stay with the question/i })).toBeVisible();

  await page.getByRole("button", { name: "Leave early", exact: true }).click();
  await expect(page).toHaveURL(/\/architecture-02$/);

  await page.goto("/architecture-02?deck=work");
  const inProgressLane = page.locator(".a02-today-lane--in_progress");
  await expect(inProgressLane.locator(".a02-live-block").filter({ hasText: taskText })).toBeVisible();
});

test("the need-more-time prompt appears near the end of a short session, and extending it pushes the deadline out", async ({ page }) => {
  await createBlockAndEnterSession(page, "Extend prompt QA task");
  await setDuration(page, 20); // well under the 5-minute window

  await page.getByRole("button", { name: /begin focus/i }).click();
  await expect(page.getByRole("heading", { name: /stay with the question/i })).toBeVisible();

  await expect(page.getByText("Do you need more time to finish this task?")).toBeVisible();
  await page.getByRole("button", { name: "+10 min" }).click();
  await expect(page.getByText("Do you need more time to finish this task?")).toBeHidden();

  // planned_duration_s is now 20 + 600 = 620s. Wait past the original 20s
  // mark -- the session must still be running, not completed/expired, which
  // is the concrete proof extend_session actually raised the cap server-side
  // rather than just hiding the prompt client-side.
  await page.waitForTimeout(21_000);
  await expect(page.getByText(/time's up/i)).toHaveCount(0);
  await expect(page.getByRole("button", { name: "End session", exact: true })).toBeVisible();

  await page.getByRole("button", { name: "End session", exact: true }).click();
});

test("natural expiration asks whether something's left, and a leftover note is saved and visible on the Kanban board", async ({ page }) => {
  const taskText = "Leftover note QA task";
  await createBlockAndEnterSession(page, taskText);
  await setDuration(page, 5); // expires naturally within the test's own time budget

  await page.getByRole("button", { name: /begin focus/i }).click();
  await expect(page.getByRole("heading", { name: /stay with the question/i })).toBeVisible();
  await dismissExtendPromptIfPresent(page);

  // complete_session() fires with no p_block_outcome first (api.md §3h's
  // decision table, row 4) -- the block's fate is asked separately, here.
  await expect(page.getByText("Time's up. Did you finish, or is something left?")).toBeVisible({ timeout: 15_000 });
  await page.getByRole("button", { name: "Something's left", exact: true }).click();

  const note = "Still need to finish the left-join edge case.";
  await page.getByLabel("What's left?").fill(note);
  // finishExit() redirects to the deck once settle_block_outcome() saves
  // (PR #162's quiet-exit pattern, preserved) -- no notice to read on
  // /session itself, so the board state below is the real assertion.
  await page.getByRole("button", { name: /save & leave it in progress/i }).click();
  await expect(page).toHaveURL(/\/architecture-02$/);

  // settle_block_outcome() appends the note to blocks.notes -- confirm it
  // is actually visible on the board afterward (Kanban's own card footer
  // already renders blocks.notes when a block has no elapsed_seconds
  // logged), not just written and never shown.
  await page.goto("/architecture-02?deck=work");
  const inProgressLane = page.locator(".a02-today-lane--in_progress");
  const card = inProgressLane.locator(".a02-live-block").filter({ hasText: taskText });
  await expect(card).toBeVisible();
  await expect(card).toContainText(note);
});
