import { test, expect, type Page } from "@playwright/test";
import { openSignalDeckDestination } from "./helpers/signal-deck";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

// Phase 7 frontend (migrations/0021-0022, docs/architecture/api.md §3f/§3g):
// the Review deck's weekly-performance summary and the change-review screen
// (web/app/(marketing)/architecture-02/weekly-review.tsx), built against
// PR #153's merged backend contract. No schema/RLS/RPC touched here.
//
// TWO TIERS OF COVERAGE, DELIBERATELY SPLIT:
//
// 1. Tests that need NO seeded history (a fresh anonymous user, or one that
//    just created a route through the real onboarding flow) -- these run
//    anywhere, including CI, the same as every other spec in this directory.
//
// 2. The real struggling/coasting/avoided/on-track mix requires multiple
//    WEEKS of backdated history, which supabase/seeds/weekly_engine_demo.sql
//    exists specifically to fabricate (see its own header for why three real
//    calendar weeks can't be waited for). Seeding it here uses the `supabase`
//    CLI's `db query --linked` against the real dev project this worktree's
//    .env.local points at -- the same mechanism a manual walkthrough uses per
//    that file's own instructions. That requires a `supabase` CLI logged in
//    and linked on THIS machine (true for local development) and is NOT true
//    in CI (no SUPABASE_ACCESS_TOKEN secret there, matching web-e2e's actual
//    job env -- only the public URL/anon key are injected). Tests in this
//    tier detect that and skip cleanly rather than failing on missing infra.

function loadEnvLocal(): Record<string, string> {
  const out: Record<string, string> = {};
  try {
    const text = readFileSync(path.join(process.cwd(), ".env.local"), "utf8");
    for (const line of text.split("\n")) {
      const m = line.match(/^([A-Z_]+)=(.*)$/);
      if (m?.[1] !== undefined && m[2] !== undefined) out[m[1]] = m[2];
    }
  } catch {
    // No local env file -- callers fall back to process.env, and ultimately
    // to skipping the seeded-data tier below.
  }
  return out;
}

const ENV = loadEnvLocal();
const SUPABASE_URL = ENV.NEXT_PUBLIC_SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL;

function projectRef(url: string | undefined): string | null {
  if (!url) return null;
  const match = /^https?:\/\/([a-z0-9]+)\.supabase\.co/.exec(url);
  return match?.[1] ?? null;
}

/** Reads the current anonymous user's id straight out of the session
 * `@supabase/ssr` actually wrote -- not localStorage. This app's browser
 * client (lib/supabase/client.ts, via @supabase/ssr's createBrowserClient)
 * and its middleware (proxy.ts) share the session through a `sb-<ref>-auth-
 * token` COOKIE (base64-prefixed JSON), the mechanism that keeps server and
 * client reading the same session -- @supabase/ssr's whole reason to exist
 * over plain supabase-js, which would use localStorage instead. Avoids
 * adding any test-only debug endpoint to the real app just to expose this. */
async function currentUserId(page: Page): Promise<string | null> {
  const ref = projectRef(SUPABASE_URL);
  if (!ref) return null;
  const cookies = await page.context().cookies();
  const authCookie = cookies.find((c) => c.name === `sb-${ref}-auth-token`);
  if (!authCookie) return null;
  const raw = authCookie.value.startsWith("base64-") ? authCookie.value.slice(7) : authCookie.value;
  try {
    const parsed = JSON.parse(Buffer.from(raw, "base64").toString("utf8")) as { user?: { id?: string } };
    return parsed.user?.id ?? null;
  } catch {
    return null;
  }
}

/** Seeds the weekly-engine demo fixture (struggling/coasting/avoided/on-track,
 * one category each) for the given user, via the linked Supabase project.
 * Returns false -- meaning "skip the caller's test", never "fail it" -- when
 * the `supabase` CLI isn't available/linked/authenticated on this machine. */
function seedWeeklyEngineDemo(userId: string): boolean {
  const repoRoot = path.join(process.cwd(), "..");
  const seedSource = path.join(repoRoot, "supabase", "seeds", "weekly_engine_demo.sql");
  if (!existsSync(seedSource)) return false;
  try {
    const dir = mkdtempSync(path.join(tmpdir(), "mtdo-weekly-seed-"));
    const defineFile = path.join(dir, "define.sql");
    const callFile = path.join(dir, "call.sql");
    writeFileSync(defineFile, readFileSync(seedSource));
    writeFileSync(callFile, `select public.seed_weekly_engine_demo('${userId}');`);
    execFileSync("supabase", ["db", "query", "--linked", "-f", defineFile], { cwd: repoRoot, stdio: "pipe" });
    execFileSync("supabase", ["db", "query", "--linked", "-f", callFile], { cwd: repoRoot, stdio: "pipe" });
    return true;
  } catch (e) {
    console.warn("[phase7-weekly-review] could not seed weekly-engine demo data -- skipping. Reason:", e);
    return false;
  }
}

async function openReviewDeck(page: Page) {
  await openSignalDeckDestination(page, "Review");
  // The 6-week pulse's own outer section, always rendered regardless of
  // whether the weekly-engine panel below it has a route to show yet --
  // the panel's own testid only exists in its "ready, has a route" branch.
  await expect(page.locator("section.a02-review")).toBeVisible();
}

test.describe("Review deck -- honest empty states (no seeding required)", () => {
  test("a user with no active route sees an honest 'no route yet' state, not fabricated numbers", async ({ page }) => {
    await page.goto("/architecture-02");
    await page.getByRole("button", { name: /close walkthrough/i }).click();
    await openReviewDeck(page);
    await expect(page.getByRole("heading", { name: /no active route yet/i })).toBeVisible();
    await expect(page.getByText(/set up a route to get a real weekly review/i)).toBeVisible();
    // Nothing that would exist only for a real route.
    await expect(page.getByTestId("weekly-review-generate")).toHaveCount(0);
  });

  test("a brand-new route (real onboarding, zero history) reviews honestly: no fake numbers, no fabricated changes", async ({ page }) => {
    await page.goto("/architecture-02/onboarding/manual");
    await page.getByPlaceholder(/get fluent in sql joins/i).fill("Land a backend offer");
    await page.getByPlaceholder("e.g. SQL Joins").fill("Arrays");
    await page.getByPlaceholder("Add a task").fill("Two-pointer basics");
    await page.getByRole("button", { name: "Add", exact: true }).click();
    await page.getByRole("button", { name: /create my route/i }).click();
    await expect(page).toHaveURL(/\/architecture-02\?deck=work$/);

    await openReviewDeck(page);

    // The category was created moments ago -- every week under review predates
    // it, so the summary panel must say so plainly rather than showing a fake
    // 0%/empty chart (api.md §3f's existed_before_week rule).
    await expect(page.getByText(/your route is brand new/i)).toBeVisible();

    // Generating a review for a route with no real history must still be a
    // normal, non-error result: zero changes, categories marked "not enough
    // data yet" -- never an error and never a fabricated proposal.
    await page.getByTestId("weekly-review-generate").click();
    await expect(page.getByTestId("weekly-review-no-changes")).toBeVisible();
    await expect(page.getByText(/not enough history yet to review/i)).toBeVisible();
    await expect(page.locator(".a02-weekly-change-card")).toHaveCount(0);
    await expect(page.locator(".a02-weekly-question-card")).toHaveCount(0);
  });
});

test.describe("Review deck -- real seeded threshold-crossing behavior", () => {
  test.beforeEach(async ({ page }) => {
    // Establish the anonymous session (proxy.ts signs in on first request).
    await page.goto("/architecture-02");
    await page.getByRole("button", { name: /close walkthrough/i }).click();
  });

  test("a struggling/coasting/avoided/on-track mix renders correctly, and the avoided category is never silently auto-accepted", async ({ page }) => {
    const userId = await currentUserId(page);
    test.skip(!userId, "Could not read the anonymous session's user id from browser storage.");
    const seeded = seedWeeklyEngineDemo(userId!);
    test.skip(!seeded, "supabase CLI is not linked/authenticated on this machine -- seeded-data coverage needs local infra CI does not have.");

    await page.reload();
    await openReviewDeck(page);

    // Real numbers, not an empty/fake chart -- this route has three backdated
    // weeks of real history.
    await expect(page.getByText(/your route is brand new/i)).toHaveCount(0);
    await expect(page.locator(".a02-weekly-stat")).toHaveCount(5);

    // All four classifications the fixture is engineered to produce.
    await expect(page.getByTestId("weekly-category-dsa-badge")).toHaveText(/struggling/i);
    await expect(page.getByTestId("weekly-category-sql-badge")).toHaveText(/coasting/i);
    await expect(page.getByTestId("weekly-category-system_design-badge")).toHaveText(/avoided/i);
    await expect(page.getByTestId("weekly-category-behavioral-badge")).toHaveText(/on track/i);

    // Generate this week's proposal from the real seeded numbers.
    await page.getByTestId("weekly-review-generate").click();
    await expect(page.getByTestId("weekly-review-generate")).toHaveCount(0, { timeout: 15_000 });

    // The avoided category renders as a QUESTION, never a numeric change --
    // and it is a distinct card type, not lumped in with the target-block
    // change cards (decisions.md 2026-09-11 / api.md §3g).
    const question = page.getByTestId("weekly-question-system_design");
    await expect(question).toBeVisible();
    await expect(page.getByTestId("weekly-question-system_design-accept")).toBeVisible();
    await expect(page.getByTestId("weekly-change-system_design")).toHaveCount(0);

    // Struggling (dsa) and coasting (sql) get real numeric proposals with
    // old -> new values, each carrying its own plain-language reason.
    const dsaChange = page.getByTestId("weekly-change-dsa");
    await expect(dsaChange).toBeVisible();
    await expect(dsaChange).toContainText(/under half both weeks|longer than estimated/i);
    const sqlChange = page.getByTestId("weekly-change-sql");
    await expect(sqlChange).toBeVisible();
    await expect(sqlChange).toContainText(/finishing early|two weeks/i);

    // behavioral is on_track: present in the category list, absent from both
    // the change and question lists.
    await expect(page.getByTestId("weekly-change-behavioral")).toHaveCount(0);
    await expect(page.getByTestId("weekly-question-behavioral")).toHaveCount(0);

    // THE CORE SAFETY PROPERTY: "Accept all" must never silently resolve the
    // avoided/flag_question row. Click it, then confirm the question is still
    // sitting there, unanswered, with its own visible prompt.
    await page.getByTestId("weekly-review-accept-all").click();
    await expect(page.getByTestId("weekly-review-accept-all")).toHaveCount(0, { timeout: 15_000 }); // both numeric changes now decided, toolbar disappears
    await expect(page.getByTestId("weekly-question-system_design")).toBeVisible();
    await expect(page.getByText(/question.*above still need/i)).toBeVisible();

    // Individual accept/reject actually persisted -- reload and confirm dsa
    // and sql now show up as decided, not as pending changes again.
    await page.reload();
    await openReviewDeck(page);
    await expect(page.getByTestId("weekly-change-dsa")).toHaveCount(0);
    await expect(page.getByTestId("weekly-change-sql")).toHaveCount(0);
    await expect(page.getByTestId("weekly-question-system_design")).toBeVisible();
    await page.locator(".a02-weekly-decided summary").click();
    await expect(page.locator(".a02-weekly-decided")).toContainText(/dsa|DSA/i);
    await expect(page.locator(".a02-weekly-decided")).toContainText(/sql|SQL/i);

    // Answer the flagged question individually, then reload and confirm that
    // decision also persisted -- the question stops rendering as pending.
    await page.getByTestId("weekly-question-system_design-decline").click();
    await expect(page.getByTestId("weekly-question-system_design")).toHaveCount(0, { timeout: 15_000 });
    await page.reload();
    await openReviewDeck(page);
    await expect(page.getByTestId("weekly-question-system_design")).toHaveCount(0);
    await expect(page.locator(".a02-weekly-decided")).toContainText(/system design/i);
  });
});
