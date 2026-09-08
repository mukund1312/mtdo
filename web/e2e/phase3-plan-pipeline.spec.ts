import { test, expect } from "@playwright/test";

// Phase 3 of the operating-engine plan: manual setup, import/export, and
// the setup-method chooser. Real anonymous session, real Supabase writes --
// not mocked.

test("method chooser offers all three paths", async ({ page }) => {
  await page.goto("/architecture-02");
  await page.getByRole("button", { name: /close walkthrough/i }).click();
  await page.getByRole("link", { name: /set up your route/i }).click();
  await expect(page.getByRole("heading", { name: /how do you.*want to start/is })).toBeVisible();
  await expect(page.getByRole("button", { name: /guided ai/i })).toBeVisible();
  await expect(page.getByRole("button", { name: /manual setup/i })).toBeVisible();
  await expect(page.getByRole("button", { name: /import a plan/i })).toBeVisible();
});

test("Manual Setup builds a real route end-to-end", async ({ page }) => {
  await page.goto("/architecture-02/onboarding/manual");
  await page.getByPlaceholder(/get fluent in sql joins/i).fill("Get fluent in SQL joins for interviews");
  await page.getByPlaceholder("e.g. SQL Joins").fill("SQL Fundamentals");
  await page.getByPlaceholder("Add a task").fill("Practice INNER JOIN");
  await page.getByRole("button", { name: "Add", exact: true }).click();
  await page.getByPlaceholder("Add a task").fill("Practice LEFT JOIN");
  await page.getByRole("button", { name: "Add", exact: true }).click();
  await expect(page.getByText("Practice INNER JOIN")).toBeVisible();
  await expect(page.getByText("Practice LEFT JOIN")).toBeVisible();

  const submit = page.getByRole("button", { name: /create my route/i });
  await expect(submit).toBeEnabled();
  await submit.click();
  await expect(page).toHaveURL(/\/architecture-02\?deck=work$/);
  await expect(page.getByRole("heading", { name: /move the right pieces/i })).toBeVisible();

  // The manually-authored tasks are real curriculum content, sitting in the
  // menu until picked -- same model as an AI-generated plan's content, not
  // pre-placed on the board.
  await page.getByRole("button", { name: /add from route/i }).click();
  await expect(page.getByText("Practice INNER JOIN")).toBeVisible();
  await expect(page.getByText("Practice LEFT JOIN")).toBeVisible();
});

test("Import validates and persists a real mtdo.plan.v1 file, Export reads it back", async ({ page }) => {
  await page.goto("/architecture-02/onboarding/import");
  const plan = {
    schema_version: "mtdo.plan.v1",
    app_name: "Imported Route",
    goal_line: "Master backend interviews",
    categories: [
      {
        name: "system_design",
        label: "System Design",
        days: [0, 2],
        min_blocks: 1,
        score_weight: 100,
        curriculum: [["Design a URL shortener"], ["Design a rate limiter"]],
      },
    ],
  };
  await page.getByPlaceholder(/schema_version/i).fill(JSON.stringify(plan));
  const importPreview = page.locator(".a02-import-preview");
  await expect(importPreview.getByText("Master backend interviews")).toBeVisible();
  await expect(importPreview.getByText("2 tasks")).toBeVisible();

  await page.getByRole("button", { name: /import this route/i }).click();
  await expect(page).toHaveURL(/\/architecture-02\?deck=work$/);

  // Export the same route back and confirm it round-trips.
  await page.goto("/architecture-02/onboarding/import");
  await page.getByRole("tab", { name: /export/i }).click();
  await page.getByRole("button", { name: /export my route/i }).click();
  const exportBox = page.locator(".a02-export-result textarea");
  await expect(exportBox).toBeVisible({ timeout: 15_000 });
  const exported = JSON.parse(await exportBox.inputValue());
  expect(exported.goal_line).toBe("Master backend interviews");
  expect(exported.categories[0].label).toBe("System Design");
  expect(exported.categories[0].curriculum.flat()).toHaveLength(2);
});

test("Import rejects a malformed file with a real error, not a silent failure", async ({ page }) => {
  await page.goto("/architecture-02/onboarding/import");
  await page.getByPlaceholder(/schema_version/i).fill('{"goal_line": "no categories at all"}');
  await expect(page.getByText(/categories.*must be a non-empty array/i)).toBeVisible();
  await expect(page.getByRole("button", { name: /import this route/i })).toBeDisabled();
});
