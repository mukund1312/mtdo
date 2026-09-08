// Tests for POST /api/plan/extend (see route.ts's own header comment for
// the documented contract). Mocks the Supabase server client (a lightweight
// thenable chain stub, since this route's queries are genuinely chained --
// select().eq().eq()), lib/ai/service's generatePlanExtension, and
// recordEvent. parseExtensionResponse/buildExtensionPrompt run for real, so
// this exercises the actual eligibility/parsing logic, not a stubbed
// version of it.

import { describe, expect, it, vi, beforeEach } from "vitest";

const { mockGetUser } = vi.hoisted(() => ({ mockGetUser: vi.fn() }));
const { mockFrom } = vi.hoisted(() => ({ mockFrom: vi.fn() }));
const { mockRpc } = vi.hoisted(() => ({ mockRpc: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({
  createClient: vi.fn(async () => ({
    auth: { getUser: mockGetUser },
    from: mockFrom,
    rpc: mockRpc,
  })),
}));

const { mockGeneratePlanExtension } = vi.hoisted(() => ({ mockGeneratePlanExtension: vi.fn() }));
vi.mock("@/lib/ai/service", () => ({
  generatePlanExtension: mockGeneratePlanExtension,
}));

const { mockRecordEvent } = vi.hoisted(() => ({ mockRecordEvent: vi.fn() }));
vi.mock("@/lib/analytics/record-event", () => ({
  recordEvent: mockRecordEvent,
}));

const { POST } = await import("./route");

/** A minimal thenable chain: every call (.select/.eq/.not/.order/...)
 * returns itself, and awaiting it (or calling .maybeSingle()/.single())
 * resolves to the fixed result this chain was built with. Matches how this
 * route actually calls the client -- chained builder methods, one final
 * await/terminal call. */
function chain(result: { count?: number | null; data?: unknown; error?: unknown }) {
  const self: Record<string, unknown> = {
    select: () => self,
    eq: () => self,
    not: () => self,
    order: () => self,
    maybeSingle: async () => ({ data: result.data, error: result.error ?? null }),
    single: async () => ({ data: result.data, error: result.error ?? null }),
    then: (resolve: (value: unknown) => unknown) => resolve({ data: result.data, count: result.count, error: result.error ?? null }),
  };
  return self;
}

const AUTHED_USER = { id: "user-1" };

beforeEach(() => {
  vi.clearAllMocks();
  mockGetUser.mockResolvedValue({ data: { user: AUTHED_USER }, error: null });
  mockRecordEvent.mockResolvedValue(true);
});

function makeRequest(): Request {
  return new Request("http://localhost/api/plan/extend", { method: "POST" });
}

describe("POST /api/plan/extend -- auth and eligibility", () => {
  it("401s when there is no authenticated user", async () => {
    mockGetUser.mockResolvedValue({ data: { user: null }, error: null });
    const response = await POST(makeRequest());
    expect(response.status).toBe(401);
  });

  it("returns extended:false when there is no active plan", async () => {
    mockFrom.mockImplementation((table: string) => {
      if (table === "plans") return chain({ data: null });
      throw new Error(`unexpected table ${table}`);
    });
    const response = await POST(makeRequest());
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ extended: false, reason: "No active route." });
    expect(mockGeneratePlanExtension).not.toHaveBeenCalled();
  });

  it("returns extended:false when no category's cursor is pinned", async () => {
    mockFrom.mockImplementation((table: string) => {
      if (table === "plans") return chain({ data: { id: "plan-1", goal_line: "Learn SQL", planning_mode: "dynamic_weekly" } });
      if (table === "plan_categories") {
        return chain({
          data: [
            {
              id: "cat-1",
              label: "SQL",
              days: [0, 1],
              topic_type: null,
              menu_unlocked_week_index: 0,
              // max week_index (1) is ahead of the unlocked cursor (0) --
              // still content left to reveal normally, not exhausted.
              curriculum_items: [{ id: "i1", week_index: 0 }, { id: "i2", week_index: 1 }],
            },
          ],
        });
      }
      throw new Error(`unexpected table ${table}`);
    });
    const response = await POST(makeRequest());
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ extended: false, reason: "No category is exhausted right now." });
    expect(mockGeneratePlanExtension).not.toHaveBeenCalled();
  });

  it("ignores the cursor entirely for an overall-mode plan (migrations/0017)", async () => {
    // Same fixture as the dynamic_weekly test above (cursor at 0, max week
    // 1 -- "not pinned" under dynamic_weekly rules) but planning_mode is
    // "overall", where the cursor never advances at all and is therefore
    // meaningless as an eligibility signal -- this category must still be
    // treated as eligible.
    mockFrom.mockImplementation((table: string) => {
      if (table === "plans") return chain({ data: { id: "plan-1", goal_line: "Learn SQL", planning_mode: "overall" } });
      if (table === "plan_categories") {
        return chain({
          data: [
            {
              id: "cat-1",
              label: "SQL",
              days: [0, 1],
              topic_type: null,
              menu_unlocked_week_index: 0,
              curriculum_items: [{ id: "i1", week_index: 0 }, { id: "i2", week_index: 1 }],
            },
          ],
        });
      }
      if (table === "blocks") return chain({ count: 0 });
      throw new Error(`unexpected table ${table}`);
    });
    mockGeneratePlanExtension.mockResolvedValue(JSON.stringify({ categories: [{ category_id: "cat-1", items: ["New task"] }] }));
    mockRpc.mockResolvedValue({ data: [{ id: "new-1", category_id: "cat-1" }], error: null });

    const response = await POST(makeRequest());
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      extended: true,
      categories: [{ categoryId: "cat-1", label: "SQL", addedCount: 1 }],
    });
  });
});

describe("POST /api/plan/extend -- happy path", () => {
  function mockEligibleCategory() {
    mockFrom.mockImplementation((table: string) => {
      if (table === "plans") return chain({ data: { id: "plan-1", goal_line: "Learn SQL", planning_mode: "dynamic_weekly" } });
      if (table === "plan_categories") {
        return chain({
          data: [
            {
              id: "cat-1",
              label: "SQL",
              days: [0, 1],
              topic_type: "database",
              menu_unlocked_week_index: 1,
              curriculum_items: [{ id: "i1", week_index: 0 }, { id: "i2", week_index: 1 }],
            },
          ],
        });
      }
      if (table === "blocks") return chain({ count: 1 });
      throw new Error(`unexpected table ${table}`);
    });
  }

  it("calls extend_plan with the model's validated content and reports what was added", async () => {
    mockEligibleCategory();
    mockGeneratePlanExtension.mockResolvedValue(
      JSON.stringify({
        categories: [{ category_id: "cat-1", items: [{ task: "New task 1" }, "New task 2"] }],
      }),
    );
    mockRpc.mockResolvedValue({
      data: [
        { id: "new-1", category_id: "cat-1" },
        { id: "new-2", category_id: "cat-1" },
      ],
      error: null,
    });

    const response = await POST(makeRequest());
    expect(response.status).toBe(200);

    expect(mockRpc).toHaveBeenCalledWith("extend_plan", {
      p_extension: [
        {
          category_id: "cat-1",
          items: [
            { task: "New task 1", meta: { focus_points: [], questions: [], interview_questions: [], mistakes: [], tips: [], mental_models: [], related_topics: [] } },
            { task: "New task 2", meta: {} },
          ],
        },
      ],
    });

    await expect(response.json()).resolves.toEqual({
      extended: true,
      categories: [{ categoryId: "cat-1", label: "SQL", addedCount: 2 }],
    });
    expect(mockRecordEvent).toHaveBeenCalledWith(expect.anything(), "plan_generated", { usedExtension: true, categoryCount: 1 });
  });

  it("502s when the AI call fails, without touching extend_plan", async () => {
    mockEligibleCategory();
    mockGeneratePlanExtension.mockRejectedValue(new Error("network down"));

    const response = await POST(makeRequest());
    expect(response.status).toBe(502);
    expect(mockRpc).not.toHaveBeenCalled();
  });

  it("502s when the model's response doesn't parse, without touching extend_plan", async () => {
    mockEligibleCategory();
    mockGeneratePlanExtension.mockResolvedValue("not json at all");

    const response = await POST(makeRequest());
    expect(response.status).toBe(502);
    expect(mockRpc).not.toHaveBeenCalled();
  });

  it("502s when the model references a category_id that wasn't requested", async () => {
    mockEligibleCategory();
    mockGeneratePlanExtension.mockResolvedValue(
      JSON.stringify({ categories: [{ category_id: "cat-does-not-exist", items: ["x"] }] }),
    );

    const response = await POST(makeRequest());
    expect(response.status).toBe(502);
    expect(mockRpc).not.toHaveBeenCalled();
  });
});
