// Tests for POST /api/plan/weekly-review (see route.ts's header for the full
// contract). The rules engine itself is unit-tested in lib/planning/**; what
// is under test here is the routing around it -- which week gets reviewed,
// the refusals that must happen before anything is computed, and that the
// proposal actually reaches save_weekly_plan() intact.
import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockGetUser, mockFrom, mockRpc } = vi.hoisted(() => ({
  mockGetUser: vi.fn(),
  mockFrom: vi.fn(),
  mockRpc: vi.fn(),
}));
vi.mock("@/lib/supabase/server", () => ({
  createClient: vi.fn(async () => ({
    auth: { getUser: mockGetUser },
    from: mockFrom,
    rpc: mockRpc,
  })),
}));

const { POST } = await import("./route");

// Supabase's builder is a long fluent chain whose shape isn't what's under
// test here -- same helper the calendar route tests use.
function chain(result: unknown) {
  const proxy: unknown = new Proxy(
    {},
    {
      get(_target, prop) {
        if (prop === "then") {
          return (resolve: (value: unknown) => unknown, reject: (reason: unknown) => unknown) =>
            Promise.resolve(result).then(resolve, reject);
        }
        return () => proxy;
      },
    },
  );
  return proxy;
}

function performance(isoWeek: string, categories: unknown[], completionRate: number | null = 0.7) {
  return {
    schema_version: "mtdo.weekly_performance.v1",
    plan_id: "plan-1",
    iso_week: isoWeek,
    week_start: "2026-08-31",
    week_end: "2026-09-06",
    timezone: "UTC",
    planning_mode: "dynamic_weekly",
    computed_at: "2026-09-07T00:00:00+00:00",
    plan: {
      picked_count: 10,
      done_count: 7,
      completion_rate: completionRate,
      estimated_minutes: 0,
      actual_minutes: 0,
      paced_actual_minutes: 0,
      paced_task_count: 0,
      pace_ratio: null,
      menu_offered_count: 10,
      menu_picked_count: 10,
      pick_rate: 1,
      regressed_count: 0,
      stale_open_count: 0,
      postponement_count: 0,
      backlog_count: 0,
      sessions_completed: 0,
      study_days: 4,
      score: 70,
      score_max: 100,
    },
    categories,
  };
}

const STRUGGLING_CATEGORY = {
  category_id: "cat-1",
  name: "dsa",
  label: "DSA",
  sort_order: 0,
  min_blocks: 1,
  score_weight: 40,
  days_per_week: 4,
  weekly_target_blocks: null,
  current_target: 4,
  category_created_at: "2026-01-01T00:00:00+00:00",
  existed_before_week: true,
  picked_count: 4,
  done_count: 1,
  completion_rate: 0.25,
  estimated_minutes: 30,
  actual_minutes: 45,
  paced_actual_minutes: 45,
  paced_task_count: 1,
  pace_ratio: 1.5,
  pace_ratio_mean: 1.5,
  menu_offered_count: 4,
  menu_picked_count: 4,
  skipped_count: 0,
  pick_rate: 1,
  regressed_count: 1,
  stale_open_count: 0,
  postponement_count: 1,
  backlog_count: 3,
  sessions_completed: 2,
  study_days: 2,
};

/** Wires up the happy path: an active plan, a UTC profile, no prior review. */
function wireDefaults(existingReview: unknown = null) {
  mockGetUser.mockResolvedValue({ data: { user: { id: "user-1" } }, error: null });
  mockFrom.mockImplementation((table: string) => {
    if (table === "plans") return chain({ data: { id: "plan-1" }, error: null });
    if (table === "profiles") return chain({ data: { timezone: "UTC" }, error: null });
    if (table === "weekly_plans") return chain({ data: existingReview, error: null });
    return chain({ data: null, error: null });
  });
}

beforeEach(() => {
  vi.clearAllMocks();
});

function post(body?: unknown) {
  return POST(
    new Request("http://localhost/api/plan/weekly-review", {
      method: "POST",
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
  );
}

describe("POST /api/plan/weekly-review", () => {
  it("401s without a session", async () => {
    mockGetUser.mockResolvedValue({ data: { user: null }, error: null });
    expect((await post()).status).toBe(401);
  });

  it("reports an honest no-op when there is no active route, rather than erroring", async () => {
    mockGetUser.mockResolvedValue({ data: { user: { id: "user-1" } }, error: null });
    mockFrom.mockImplementation(() => chain({ data: null, error: null }));
    const res = await post();
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({ generated: false });
  });

  it("400s on a malformed isoWeek rather than reviewing some other week", async () => {
    wireDefaults();
    expect((await post({ isoWeek: "2026-37" })).status).toBe(400);
    expect((await post({ isoWeek: "2026-W99" })).status).toBe(400);
  });

  it("reviews the requested week and its predecessor, and targets the week after", async () => {
    wireDefaults();
    mockRpc.mockImplementation(async (fn: string, args: Record<string, unknown>) => {
      if (fn === "weekly_performance") {
        return { data: performance(args.p_iso_week as string, [STRUGGLING_CATEGORY]), error: null };
      }
      return { data: "review-1", error: null };
    });

    const res = await post({ isoWeek: "2026-W36" });
    const body = await res.json();

    expect(body.isoWeek).toBe("2026-W36");
    expect(body.effectiveIsoWeek).toBe("2026-W37");
    const weeksRead = mockRpc.mock.calls
      .filter(([fn]) => fn === "weekly_performance")
      .map(([, args]) => (args as { p_iso_week: string }).p_iso_week);
    expect(weeksRead).toEqual(["2026-W36", "2026-W35"]);
  });

  it("passes the generated change set through to save_weekly_plan", async () => {
    wireDefaults();
    mockRpc.mockImplementation(async (fn: string, args: Record<string, unknown>) => {
      if (fn === "weekly_performance") {
        return { data: performance(args.p_iso_week as string, [STRUGGLING_CATEGORY]), error: null };
      }
      return { data: "review-1", error: null };
    });

    const res = await post({ isoWeek: "2026-W36" });
    const body = await res.json();

    expect(body.generated).toBe(true);
    expect(body.changeCount).toBe(1);
    expect(body.changes[0]).toMatchObject({
      change_type: "weekly_target_blocks",
      signal: "struggling",
      old_value: 4,
      new_value: 3,
    });

    const saveCall = mockRpc.mock.calls.find(([fn]) => fn === "save_weekly_plan");
    expect(saveCall).toBeDefined();
    const args = saveCall![1] as Record<string, unknown>;
    expect(args.p_effective_iso_week).toBe("2026-W37");
    expect((args.p_changes as unknown[]).length).toBe(1);
    // The audit snapshot carries BOTH weeks the engine actually looked at.
    expect(args.p_metrics).toMatchObject({ schema_version: "mtdo.weekly_review.v1" });
    expect((args.p_metrics as { current: unknown }).current).toBeTruthy();
    expect((args.p_metrics as { previous: unknown }).previous).toBeTruthy();
  });

  it("refuses to regenerate a review that has already been acted on", async () => {
    wireDefaults({ id: "review-1", weekly_plan_changes: [{ status: "accepted" }] });
    const res = await post({ isoWeek: "2026-W36" });
    const body = await res.json();

    expect(body).toMatchObject({ generated: false, weeklyPlanId: "review-1" });
    // The refusal must happen BEFORE any metrics are computed -- regenerating
    // over a decided review would destroy the user's decisions.
    expect(mockRpc).not.toHaveBeenCalled();
  });

  it("does regenerate a review whose changes are all still pending", async () => {
    wireDefaults({ id: "review-1", weekly_plan_changes: [{ status: "pending" }] });
    mockRpc.mockImplementation(async (fn: string, args: Record<string, unknown>) => {
      if (fn === "weekly_performance") {
        return { data: performance(args.p_iso_week as string, []), error: null };
      }
      return { data: "review-1", error: null };
    });
    const res = await post({ isoWeek: "2026-W36" });
    await expect(res.json()).resolves.toMatchObject({ generated: true });
  });

  it("never calls an AI provider — the whole path is deterministic", async () => {
    // Guards the product decision, not just the code (decisions.md
    // 2026-09-11): if someone later wires a model call into this route, this
    // fails rather than the change passing as an ordinary feature addition.
    // Comment lines are stripped first -- route.ts's own header talks ABOUT
    // not calling AI, and the point is what the code does.
    const raw = await import("node:fs").then((fs) =>
      fs.readFileSync(new URL("./route.ts", import.meta.url), "utf8"),
    );
    const code = raw
      .split("\n")
      .filter((line) => !line.trimStart().startsWith("//"))
      .join("\n");
    // Matches the AI seam's module path and its exported domain methods.
    // Deliberately NOT a bare /reviewWeek/ -- that also matches this route's
    // own `defaultReviewWeek` import, which is date arithmetic.
    expect(code).not.toMatch(
      /@\/lib\/ai|aiService|anthropic|generateGoalPlan|generatePlanExtension|\breviewWeek\(/i,
    );
  });
});
