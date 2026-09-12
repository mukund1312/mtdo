import { test, expect, type Page } from "@playwright/test";

import { categoryColorToken } from "../app/(marketing)/architecture-02/category-color";

// Phase 6 follow-up: editable block duration (resize), real Google-Calendar-
// style overlap lanes, category-based colour, and persisted per-event notes.
// Builds directly on phase6-calendar.spec.ts's own patterns/testids -- that
// file is the regression gate for the row-height/hour-label geometry PR #161
// fixed, and must keep passing unchanged; this file only adds new coverage,
// it does not touch anything phase6-calendar.spec.ts already asserts.
//
// ONE shared page/anonymous session for the whole file (test.describe.serial
// + a manually created page, Playwright's own documented pattern for this),
// not four. Each ordinary `test()` gets a fresh browsing context and so a
// fresh anonymous sign-in -- fine at 3 tests (phase6-calendar.spec.ts), but
// this project's own Supabase project has a real, tight anonymous-auth rate
// limit that four fresh sign-ins back-to-back reliably tripped locally
// ("No authenticated session. Refresh and try again.", confirmed NOT
// reproducible by the pre-existing spec run immediately before it -- same
// server, same build, only the sign-in COUNT differed). PROGRESS.md's
// 2026-09-12 session/page.tsx entry hit the identical class of problem and
// fixed it the same way: one shared sign-in across every test in the file.

function todayIso(): string {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
}

type CategoryDraft = { label: string; tasks: string[] };

/** Builds a real route via the (non-AI) Manual Setup wizard with one or more
 * categories, each carrying its own task list -- the multi-category form
 * this suite needs for the category-colour test, which
 * createRouteWithTwoTasks (phase6-calendar.spec.ts) doesn't exercise since
 * it only ever fills one category. */
async function createRouteWithCategories(page: Page, categories: CategoryDraft[]) {
  await page.goto("/architecture-02/onboarding/manual");
  await page.getByPlaceholder(/get fluent in sql joins/i).fill("Prepare for backend interviews");

  for (let i = 0; i < categories.length; i++) {
    const category = categories[i]!;
    if (i > 0) {
      await page.getByRole("button", { name: /add another subject/i }).click();
    }
    const labelInputs = page.getByPlaceholder("e.g. SQL Joins");
    await labelInputs.nth(i).fill(category.label);
    const taskInputs = page.getByPlaceholder("Add a task");
    const addButtons = page.getByRole("button", { name: "Add", exact: true });
    for (const task of category.tasks) {
      await taskInputs.nth(i).fill(task);
      await addButtons.nth(i).click();
    }
  }

  await page.getByRole("button", { name: /create my route/i }).click();
  await expect(page).toHaveURL(/\/architecture-02\?deck=work$/);

  const totalTasks = categories.reduce((sum, category) => sum + category.tasks.length, 0);
  for (const category of categories) {
    for (const task of category.tasks) {
      await page.getByRole("button", { name: /add from route/i }).click();
      await page.locator(".a02-curriculum-item").filter({ hasText: task }).click();
    }
  }
  await expect(page.locator(".a02-live-block")).toHaveCount(totalTasks);
}

async function openTimeDeck(page: Page) {
  await page.locator(".a02-dock button").filter({ hasText: "Time" }).click();
  await expect(page.getByRole("heading", { name: /give time/i })).toBeVisible();
}

async function openKanbanDeck(page: Page) {
  await page.locator(".a02-dock button").filter({ hasText: "Kanban" }).click();
}

async function scheduleFromUnscheduled(page: Page, taskText: string, hour: number) {
  const today = todayIso();
  // targetPosition biased to the bottom of the slot cell: a slot that
  // already holds a scheduled block (this file's overlap test does exactly
  // that on purpose) has its OWN chip painted on top of most of the row --
  // the chip is the 40px legibility floor tall, the row is 48px, leaving
  // only an ~8px sliver at the row's bottom genuinely exposed. Targeting
  // that sliver (rather than dragTo's default centre, which a same-hour
  // second drop would land squarely on the existing chip) works whether or
  // not the slot already has something in it.
  await page.locator('button[data-testid^="calendar-unscheduled-"]').filter({ hasText: taskText }).dragTo(page.getByTestId(`calendar-slot-${today}-${hour}`), {
    targetPosition: { x: 10, y: 45 },
  });
  const chip = page.locator('[data-testid^="calendar-event-"]').filter({ hasText: taskText });
  await expect(chip).toBeVisible();
  return chip;
}

// All six tasks/two categories used across the whole suite, scheduled onto
// deliberately non-overlapping hours EXCEPT the one pair meant to overlap
// (overlapA/overlapB, both at hour 9) -- since every sub-test below shares
// one Day-view grid on one shared page, an accidental time collision
// between unrelated sub-tests would silently pull a third block into the
// overlap-lane test's cluster and break its lane-count assertions.
const TASK_RESIZE = "Draft resize regression notes";
const TASK_OVERLAP_A = "Overlap lane task A";
const TASK_OVERLAP_B = "Overlap lane task B";
const TASK_COLOR_SQL = "SQL colour comparison task";
const TASK_COLOR_DESIGN = "Design colour comparison task";
const TASK_NOTES = "Task needing a real note";

test.describe.serial("Calendar editing: resize, overlap lanes, category colour, notes", () => {
  let page: Page;

  test.beforeAll(async ({ browser }) => {
    // Explicit viewport, not test.use(): several sub-tests below drop onto
    // afternoon hours (the grid runs 6a-10p, 48px/row -- a 3pm slot alone
    // sits >400px down, before the page's own header/nav chrome). A
    // default-height viewport made dragTo() land on real positions after an
    // implicit scroll that shifted coordinates mid-drag; a tall viewport
    // removes scrolling from this suite's drags entirely.
    page = await browser.newPage({ viewport: { width: 1280, height: 2000 } });
    await createRouteWithCategories(page, [
      { label: "SQL Fundamentals", tasks: [TASK_RESIZE, TASK_OVERLAP_A, TASK_OVERLAP_B, TASK_COLOR_SQL, TASK_NOTES] },
      { label: "System Design", tasks: [TASK_COLOR_DESIGN] },
    ]);
    await openTimeDeck(page);
  });

  test.afterAll(async () => {
    await page.close();
  });

  test("dragging a block's bottom edge persists a new, snapped duration and stays grid-aligned", async () => {
    const today = todayIso();
    const chip = await scheduleFromUnscheduled(page, TASK_RESIZE, 6);
    // 6:00 falls at (6-6)*48 = 0px, same real-grid math PR #161 fixed and
    // phase6-calendar.spec.ts already pins.
    await expect(chip).toHaveCSS("top", "0px");
    // Default 30-minute duration (no estimated_minutes on a manually
    // composed task) hits the 40px legibility floor: max(40, (30/60)*48).
    await expect(chip).toHaveCSS("height", "40px");

    // Grid-cell cross-check, same technique PR #161's own fix verified
    // with: compare the chip's real bounding box against the actual grid
    // cell's bounding box, not just an isolated CSS value.
    const slot6 = page.getByTestId(`calendar-slot-${today}-6`);
    const chipBoxBefore = await chip.boundingBox();
    const slotBoxBefore = await slot6.boundingBox();
    expect(chipBoxBefore).not.toBeNull();
    expect(slotBoxBefore).not.toBeNull();
    expect(Math.abs(chipBoxBefore!.y - slotBoxBefore!.y)).toBeLessThanOrEqual(1);

    // Drag the bottom-edge resize handle down by exactly one grid row
    // (48px = ROW_HEIGHT) -- snapMinutesFromPixels(48) = round(60/15)*15
    // = 60 minutes, so this is an exact, predictable 30min -> 90min
    // resize, not an approximate one.
    const handle = chip.locator(".a02-calendar-event-resize-handle");
    const handleBox = await handle.boundingBox();
    expect(handleBox).not.toBeNull();
    const startX = handleBox!.x + handleBox!.width / 2;
    const startY = handleBox!.y + handleBox!.height / 2;
    await page.mouse.move(startX, startY);
    await page.mouse.down();
    await page.mouse.move(startX, startY + 48, { steps: 6 });
    await page.mouse.up();

    // 90 minutes -> (90/60)*48 = 72px, above the 40px floor so the real
    // proportional height is what renders.
    await expect(chip).toHaveCSS("height", "72px");
    // Start time must NOT have moved -- this is a bottom-edge-only resize.
    await expect(chip).toHaveCSS("top", "0px");

    // Persisted, not just a local/optimistic render: reload and confirm
    // the same 72px height survives a real schedule_block() round trip.
    // (A same-page reload keeps the existing anonymous session -- it does
    // not consume another sign-in.)
    await page.reload();
    await openTimeDeck(page);
    const chipAfterReload = page.locator('[data-testid^="calendar-event-"]').filter({ hasText: TASK_RESIZE });
    await expect(chipAfterReload).toHaveCSS("top", "0px");
    await expect(chipAfterReload).toHaveCSS("height", "72px");

    // And the popover's own time range text reflects the new 90-minute
    // window, confirming this wasn't just a CSS-only illusion.
    await chipAfterReload.click();
    const popover = page.getByTestId("calendar-detail-popover");
    await expect(popover).toBeVisible();
    await expect(popover.locator(".a02-calendar-detail-time")).toContainText(/6:00.*7:30|7:30.*6:00/i);
    await popover.getByRole("button", { name: "Close", exact: true }).click();
  });

  test("two blocks scheduled for the same time render side by side, both independently visible and clickable", async () => {
    // Both dropped onto the SAME hour slot -> identical [9:00,9:30)
    // windows, a real, total overlap -- the case Google Calendar's own
    // side-by-side layout exists for.
    const chipA = await scheduleFromUnscheduled(page, TASK_OVERLAP_A, 9);
    const chipB = await scheduleFromUnscheduled(page, TASK_OVERLAP_B, 9);

    await expect(chipA).toBeVisible();
    await expect(chipB).toBeVisible();

    const boxA = await chipA.boundingBox();
    const boxB = await chipB.boundingBox();
    expect(boxA).not.toBeNull();
    expect(boxB).not.toBeNull();

    // Same top (same start time), but distinct horizontal lanes -- not
    // stacked on top of each other.
    expect(Math.abs(boxA!.y - boxB!.y)).toBeLessThanOrEqual(1);
    expect(Math.abs(boxA!.x - boxB!.x)).toBeGreaterThan(10);
    // Split into two roughly-equal-width lanes, not one full-width chip
    // hiding the other.
    expect(Math.abs(boxA!.width - boxB!.width)).toBeLessThanOrEqual(2);

    // Independently clickable: each opens ITS OWN detail popover.
    await chipA.click();
    let popover = page.getByTestId("calendar-detail-popover");
    await expect(popover.locator("h2")).toHaveText(TASK_OVERLAP_A);
    await popover.getByRole("button", { name: "Close", exact: true }).click();
    await expect(popover).toHaveCount(0);

    await chipB.click();
    popover = page.getByTestId("calendar-detail-popover");
    await expect(popover.locator("h2")).toHaveText(TASK_OVERLAP_B);
    await popover.getByRole("button", { name: "Close", exact: true }).click();

    // Independently draggable: moving B away leaves A alone, and the
    // lane layout recomputes back to a single, full-inset lane for A
    // once nothing overlaps it any more.
    const today = todayIso();
    await chipB.dragTo(page.getByTestId(`calendar-slot-${today}-16`), { targetPosition: { x: 10, y: 20 } });
    await expect(page.locator('[data-testid^="calendar-event-"]').filter({ hasText: TASK_OVERLAP_B })).toHaveCSS("top", `${(16 - 6) * 48}px`);
    const chipAAfter = page.locator('[data-testid^="calendar-event-"]').filter({ hasText: TASK_OVERLAP_A });
    await expect(chipAAfter).toHaveCSS("top", `${(9 - 6) * 48}px`);
    const boxAAfter = await chipAAfter.boundingBox();
    expect(boxAAfter).not.toBeNull();
    // Back to a single lane, not a still-split half-width one -- the real
    // signal that the lane layout recomputed rather than caching the
    // 2-lane placement from before B moved away.
    expect(boxAAfter!.width).toBeGreaterThan(boxA!.width * 1.5);
  });

  test("two blocks in the same category share a colour; a block in a different category renders visibly differently", async () => {
    const chipSql = await scheduleFromUnscheduled(page, TASK_COLOR_SQL, 12);
    const chipDesign = await scheduleFromUnscheduled(page, TASK_COLOR_DESIGN, 13);
    // TASK_RESIZE (still on the grid from the first sub-test, at 6:00-7:30)
    // is also SQL Fundamentals -- reusing it as the second same-category
    // sample instead of a dedicated seventh task.
    const chipResize = page.locator('[data-testid^="calendar-event-"]').filter({ hasText: TASK_RESIZE });

    const classSql = await chipSql.getAttribute("class");
    const classResize = await chipResize.getAttribute("class");
    const classDesign = await chipDesign.getAttribute("class");
    expect(classSql).not.toBeNull();
    expect(classResize).not.toBeNull();
    expect(classDesign).not.toBeNull();

    const catToken = (className: string): string => {
      const match = className.match(/a02-calendar-event--cat-(\w+)/);
      expect(match, `expected a category colour class in "${className}"`).not.toBeNull();
      return match![1]!;
    };

    const tokenSql = catToken(classSql!);
    const tokenResize = catToken(classResize!);
    const tokenDesign = catToken(classDesign!);

    // Same category (SQL Fundamentals) -> same deterministic colour token
    // for both of its blocks. This part is unconditionally reliable --
    // deriving from the SAME real category_id always hashes to the same
    // slot, no matter what that id happens to be.
    expect(tokenSql).toBe(tokenResize);

    // A DIFFERENT category is only guaranteed a visibly different token if
    // its real category_id happens to land on a different one of the four
    // palette slots -- category_id is a server-generated UUID, so this is
    // NOT guaranteed for any two arbitrary categories (a 4-slot palette
    // over random ids collides ~25% of the time for a single pair, exactly
    // the tradeoff category-color.ts's own comment documents). Asserting
    // "not equal" against real random UUIDs would make this test flaky by
    // design, not buggy code. So compute the REAL expected token instead
    // of guessing: read the actual category_id off the DOM and hash it
    // with the exact same function the app uses.
    const sqlCategoryId = await chipSql.getAttribute("data-category-id");
    const designCategoryId = await chipDesign.getAttribute("data-category-id");
    expect(sqlCategoryId).not.toBeNull();
    expect(designCategoryId).not.toBeNull();
    expect(sqlCategoryId).not.toBe(designCategoryId); // sanity: genuinely two different categories
    expect(tokenDesign).toBe(categoryColorToken(designCategoryId!));
    expect(tokenSql).toBe(categoryColorToken(sqlCategoryId!));
    // The real end-to-end claim this test exists to make: colour is a
    // deterministic function of category_id, verified against the actual
    // function the app runs, not a hopeful guess about two random UUIDs.
    if (categoryColorToken(sqlCategoryId!) === categoryColorToken(designCategoryId!)) {
      // A genuine, expected 4-slot palette collision between these two
      // specific real UUIDs -- both chips necessarily render the SAME
      // colour, correctly, and there is nothing further to assert about
      // "visibly different" here without it being a false failure.
      expect(tokenDesign).toBe(tokenSql);
    } else {
      expect(tokenDesign).not.toBe(tokenSql);
      const borderSql = await chipSql.evaluate((el) => getComputedStyle(el).borderColor);
      const borderDesign = await chipDesign.evaluate((el) => getComputedStyle(el).borderColor);
      expect(borderSql).not.toBe(borderDesign);
    }
  });

  test("a note typed in the detail popover persists after reload and surfaces on the Kanban card", async () => {
    const noteText = "Focus on edge cases with NULLs before the next session.";
    const chip = await scheduleFromUnscheduled(page, TASK_NOTES, 15);
    await chip.click();
    const popover = page.getByTestId("calendar-detail-popover");
    await expect(popover).toBeVisible();

    const notesField = popover.getByTestId("calendar-detail-notes");
    await expect(notesField).toHaveValue("");
    await notesField.fill(noteText);
    // Save-on-blur: move focus elsewhere within the popover to trigger it,
    // and the save state must become visibly "Saved", never fail silently.
    await popover.locator("h2").click();
    await expect(popover.getByTestId("calendar-notes-status")).toHaveText("Saved");

    await popover.getByRole("button", { name: "Close", exact: true }).click();

    // Persisted for real: reload, reopen the same block, confirm the note
    // survived a real page reload (a real `blocks.notes` write, not just
    // React state). Same shared anonymous session -- no new sign-in.
    await page.reload();
    await openTimeDeck(page);
    const chipAfterReload = page.locator('[data-testid^="calendar-event-"]').filter({ hasText: TASK_NOTES });
    await chipAfterReload.click();
    const popoverAfterReload = page.getByTestId("calendar-detail-popover");
    await expect(popoverAfterReload.getByTestId("calendar-detail-notes")).toHaveValue(noteText);
    await popoverAfterReload.getByRole("button", { name: "Close", exact: true }).click();

    // The same note is not an island only visible from the calendar --
    // today-deck.tsx's KanbanCard footer already falls back to
    // `notes` when nothing is logged yet (roughDuration(0) is null for a
    // freshly scheduled, not-yet-worked block), so it must show there too.
    await openKanbanDeck(page);
    const kanbanCard = page.locator(".a02-live-block").filter({ hasText: TASK_NOTES });
    await expect(kanbanCard.locator(".a02-card-footer small")).toHaveText(noteText);
  });
});
