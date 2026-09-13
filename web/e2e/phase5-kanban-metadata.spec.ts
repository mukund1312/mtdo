import { test, expect } from "@playwright/test";

// Phase 5 (migrations/0018): curriculum_items/blocks.priority + estimated_minutes
// are real columns now, copied by pick_curriculum_item() -- not the
// deterministic per-block-id hash the Kanban UI used to fake this with.

test("a picked task shows its real, defaulted priority -- not a fabricated one", async ({ page }) => {
  await page.goto("/architecture-02/onboarding/manual");
  await page.getByPlaceholder(/get fluent in sql joins/i).fill("Get fluent in SQL joins for interviews");
  await page.getByPlaceholder("e.g. SQL Joins").fill("SQL Fundamentals");
  await page.getByPlaceholder("Add a task").fill("Practice INNER JOIN");
  await page.getByRole("button", { name: "Add", exact: true }).click();
  await page.getByRole("button", { name: /create my route/i }).click();
  await expect(page).toHaveURL(/\/architecture-02\?deck=work$/);

  await page.getByRole("button", { name: /add from route/i }).click();
  await page.locator(".a02-curriculum-item").filter({ hasText: "Practice INNER JOIN" }).click();
  await page.getByRole("button", { name: /add selected \(1\)/i }).click();

  const card = page.locator(".a02-live-block").filter({ hasText: "Practice INNER JOIN" });
  await expect(card).toBeVisible();
  // curriculum_items.priority defaults to 'medium' -- no authoring surface
  // sets it explicitly yet (Manual Setup's own form has no priority field).
  await expect(card.locator(".a02-priority")).toHaveText("Medium");
  // estimated_minutes has no default (genuinely unset) -- the card must not
  // show a fabricated number for it.
  await expect(card.locator(".a02-card-estimate")).toHaveCount(0);
});

test("priority and category filters narrow the board using real data", async ({ page }) => {
  await page.goto("/architecture-02/onboarding/manual");
  await page.getByPlaceholder(/get fluent in sql joins/i).fill("Prepare for backend interviews");
  await page.getByPlaceholder("e.g. SQL Joins").fill("SQL");
  await page.getByPlaceholder("Add a task").fill("SQL task one");
  await page.getByRole("button", { name: "Add", exact: true }).click();
  await page.getByRole("button", { name: "+ Add another subject" }).click();
  await page.getByPlaceholder("e.g. SQL Joins").nth(1).fill("System Design");
  await page.getByPlaceholder("Add a task").nth(1).fill("System design task one");
  await page.getByRole("button", { name: "Add", exact: true }).nth(1).click();
  await page.getByRole("button", { name: /create my route/i }).click();
  await expect(page).toHaveURL(/\/architecture-02\?deck=work$/);

  await page.getByRole("button", { name: /add from route/i }).click();
  await page.locator(".a02-curriculum-item").filter({ hasText: "SQL task one" }).click();
  await page.locator(".a02-curriculum-item").filter({ hasText: "System design task one" }).click();
  await page.getByRole("button", { name: /add selected \(2\)/i }).click();

  await expect(page.locator(".a02-live-block")).toHaveCount(2);

  const categoryFilters = page.getByRole("group", { name: /filter by category/i });
  await expect(categoryFilters).toBeVisible();
  await categoryFilters.getByRole("button", { name: "SQL" }).click();
  await expect(page.locator(".a02-live-block")).toHaveCount(1);
  await expect(page.locator(".a02-live-block")).toContainText("SQL task one");

  await page.getByRole("button", { name: "Reset" }).click();
  await expect(page.locator(".a02-live-block")).toHaveCount(2);

  // Both tasks default to 'medium' priority -- filtering to High or Low
  // should leave nothing, since nothing here really has that priority.
  const priorityFilters = page.getByRole("group", { name: /filter by priority/i });
  await priorityFilters.getByRole("button", { name: "High" }).click();
  await expect(page.locator(".a02-live-block")).toHaveCount(0);
  // Every lane (backlog/todo/in_progress/done) shows this same empty-state
  // text once filtered to nothing -- assert at least one, not exactly one.
  await expect(page.getByText("No signals match.").first()).toBeVisible();
});
