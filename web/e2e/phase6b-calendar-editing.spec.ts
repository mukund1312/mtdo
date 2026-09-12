import { test, expect } from "@playwright/test";

// Phase 6 follow-up: editable block duration (resize), real Google-Calendar-
// style overlap lanes, category-based colour, and persisted per-event notes.
// Builds directly on phase6-calendar.spec.ts's own patterns/testids -- that
// file is the regression gate for the row-height/hour-label geometry PR #161
// fixed, and must keep passing unchanged; this file only adds new coverage,
// it does not touch anything phase6-calendar.spec.ts already asserts.
//
// Tall viewport, deliberately: several tests here drop onto afternoon hours
// (the grid runs 6a-10p, 48px/row -- a 3pm slot alone sits >400px down,
// before the page's own header/nav chrome). A default-height viewport made
// dragTo() land on real positions after an implicit scroll that shifted
// coordinates mid-drag; a tall viewport removes scrolling from this file's
// tests entirely, isolating the actual thing under test (resize/overlap/
// colour/notes) from Playwright's own scroll-during-drag behavior.
test.use({ viewport: { width: 1280, height: 2000 } });

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
async function createRouteWithCategories(page: import("@playwright/test").Page, categories: CategoryDraft[]) {
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

async function openTimeDeck(page: import("@playwright/test").Page) {
  await page.locator(".a02-dock button").filter({ hasText: "Time" }).click();
  await expect(page.getByRole("heading", { name: /give time/i })).toBeVisible();
}

async function openKanbanDeck(page: import("@playwright/test").Page) {
  await page.locator(".a02-dock button").filter({ hasText: "Kanban" }).click();
}

async function scheduleFromUnscheduled(page: import("@playwright/test").Page, taskText: string, hour: number) {
  const today = todayIso();
  // targetPosition biased to the bottom of the slot cell: a slot that
  // already holds a scheduled block (this file's overlap tests do exactly
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

test.describe("Calendar: editable duration (resize)", () => {
  test("dragging a block's bottom edge persists a new, snapped duration and stays grid-aligned", async ({ page }) => {
    const task = "Draft resize regression notes";
    await createRouteWithCategories(page, [{ label: "SQL Fundamentals", tasks: [task] }]);
    await openTimeDeck(page);

    const today = todayIso();
    const chip = await scheduleFromUnscheduled(page, task, 10);
    // 10:00 falls at (10-6)*48 = 192px, same real-grid math PR #161 fixed
    // and phase6-calendar.spec.ts already pins.
    await expect(chip).toHaveCSS("top", "192px");
    // Default 30-minute duration (no estimated_minutes on a manually
    // composed task) hits the 40px legibility floor: max(40, (30/60)*48).
    await expect(chip).toHaveCSS("height", "40px");

    // Grid-cell cross-check, same technique PR #161's own fix verified
    // with: compare the chip's real bounding box against the actual grid
    // cell's bounding box, not just an isolated CSS value.
    const slot10 = page.getByTestId(`calendar-slot-${today}-10`);
    const chipBoxBefore = await chip.boundingBox();
    const slotBoxBefore = await slot10.boundingBox();
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
    await expect(chip).toHaveCSS("top", "192px");

    // Persisted, not just a local/optimistic render: reload and confirm
    // the same 72px height survives a real schedule_block() round trip.
    await page.reload();
    await openTimeDeck(page);
    const chipAfterReload = page.locator('[data-testid^="calendar-event-"]').filter({ hasText: task });
    await expect(chipAfterReload).toHaveCSS("top", "192px");
    await expect(chipAfterReload).toHaveCSS("height", "72px");

    // And the popover's own time range text reflects the new 90-minute
    // window, confirming this wasn't just a CSS-only illusion.
    await chipAfterReload.click();
    const popover = page.getByTestId("calendar-detail-popover");
    await expect(popover).toBeVisible();
    await expect(popover.locator(".a02-calendar-detail-time")).toContainText(/10:00.*11:30|11:30.*10:00/i);
  });
});

test.describe("Calendar: overlap lanes (multiple events in one time slot)", () => {
  test("two blocks scheduled for the same time render side by side, both independently visible and clickable", async ({ page }) => {
    const taskA = "Overlap lane task A";
    const taskB = "Overlap lane task B";
    await createRouteWithCategories(page, [{ label: "Backend Practice", tasks: [taskA, taskB] }]);
    await openTimeDeck(page);

    // Both dropped onto the SAME hour slot -> identical [10:00,10:30)
    // windows, a real, total overlap -- the case Google Calendar's own
    // side-by-side layout exists for.
    const chipA = await scheduleFromUnscheduled(page, taskA, 10);
    const chipB = await scheduleFromUnscheduled(page, taskB, 10);

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
    await expect(popover.locator("h2")).toHaveText(taskA);
    await popover.getByRole("button", { name: "Close" }).click();
    await expect(popover).toHaveCount(0);

    await chipB.click();
    popover = page.getByTestId("calendar-detail-popover");
    await expect(popover.locator("h2")).toHaveText(taskB);
    await popover.getByRole("button", { name: "Close" }).click();

    // Independently draggable: moving B away leaves A alone, and the
    // lane layout recomputes back to a single, full-inset lane for A
    // once nothing overlaps it any more.
    const today = todayIso();
    await chipB.dragTo(page.getByTestId(`calendar-slot-${today}-14`));
    await expect(page.locator('[data-testid^="calendar-event-"]').filter({ hasText: taskB })).toHaveCSS("top", `${(14 - 6) * 48}px`);
    const chipAAfter = page.locator('[data-testid^="calendar-event-"]').filter({ hasText: taskA });
    await expect(chipAAfter).toHaveCSS("top", "192px");
    const boxAAfter = await chipAAfter.boundingBox();
    expect(boxAAfter).not.toBeNull();
    // Back to a single lane, not a still-split half-width one -- the real
    // signal that the lane layout recomputed rather than caching the
    // 2-lane placement from before B moved away.
    expect(boxAAfter!.width).toBeGreaterThan(boxA!.width * 1.5);
  });
});

test.describe("Calendar: category-based colour", () => {
  test("two blocks in the same category share a colour; a block in a different category renders visibly differently", async ({ page }) => {
    const taskA1 = "SQL task one";
    const taskA2 = "SQL task two";
    const taskB1 = "Design task one";
    await createRouteWithCategories(page, [
      { label: "SQL Fundamentals", tasks: [taskA1, taskA2] },
      { label: "System Design", tasks: [taskB1] },
    ]);
    await openTimeDeck(page);

    const chipA1 = await scheduleFromUnscheduled(page, taskA1, 9);
    const chipA2 = await scheduleFromUnscheduled(page, taskA2, 11);
    const chipB1 = await scheduleFromUnscheduled(page, taskB1, 13);

    const classA1 = await chipA1.getAttribute("class");
    const classA2 = await chipA2.getAttribute("class");
    const classB1 = await chipB1.getAttribute("class");
    expect(classA1).not.toBeNull();
    expect(classA2).not.toBeNull();
    expect(classB1).not.toBeNull();

    const catToken = (className: string): string => {
      const match = className.match(/a02-calendar-event--cat-(\w+)/);
      expect(match, `expected a category colour class in "${className}"`).not.toBeNull();
      return match![1]!;
    };

    const tokenA1 = catToken(classA1!);
    const tokenA2 = catToken(classA2!);
    const tokenB1 = catToken(classB1!);

    // Same category (SQL Fundamentals) -> same deterministic colour token
    // for both of its blocks.
    expect(tokenA1).toBe(tokenA2);
    // A different category (System Design) -> a visibly different token.
    // (category-color.test.ts already pins that these two specific labels'
    // real category_id values are extremely unlikely to collide on a
    // 4-slot palette; this is the end-to-end confirmation of that.)
    expect(tokenB1).not.toBe(tokenA1);

    // The colour actually painted (border-color) differs too, not just
    // the class name -- confirms the CSS rule is wired up, not just the
    // className string.
    const borderA1 = await chipA1.evaluate((el) => getComputedStyle(el).borderColor);
    const borderB1 = await chipB1.evaluate((el) => getComputedStyle(el).borderColor);
    expect(borderA1).not.toBe(borderB1);
  });
});

test.describe("Calendar: per-event notes", () => {
  test("a note typed in the detail popover persists after reload and surfaces on the Kanban card", async ({ page }) => {
    const task = "Task needing a real note";
    const noteText = "Focus on edge cases with NULLs before the next session.";
    await createRouteWithCategories(page, [{ label: "SQL Fundamentals", tasks: [task] }]);
    await openTimeDeck(page);

    const chip = await scheduleFromUnscheduled(page, task, 15);
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

    await popover.getByRole("button", { name: "Close" }).click();

    // Persisted for real: reload, reopen the same block, confirm the note
    // survived a real page reload (a real `blocks.notes` write, not just
    // React state).
    await page.reload();
    await openTimeDeck(page);
    const chipAfterReload = page.locator('[data-testid^="calendar-event-"]').filter({ hasText: task });
    await chipAfterReload.click();
    const popoverAfterReload = page.getByTestId("calendar-detail-popover");
    await expect(popoverAfterReload.getByTestId("calendar-detail-notes")).toHaveValue(noteText);
    await popoverAfterReload.getByRole("button", { name: "Close" }).click();

    // The same note is not an island only visible from the calendar --
    // today-deck.tsx's KanbanCard footer already falls back to
    // `notes` when nothing is logged yet (roughDuration(0) is null for a
    // freshly scheduled, not-yet-worked block), so it must show there too.
    await openKanbanDeck(page);
    const kanbanCard = page.locator(".a02-live-block").filter({ hasText: task });
    await expect(kanbanCard.locator(".a02-card-footer small")).toHaveText(noteText);
  });
});
