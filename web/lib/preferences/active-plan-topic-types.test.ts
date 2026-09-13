// Unit coverage for listActiveTopicTypes -- the query behind Settings'
// soundtrack-mapping section (what topic types this user's active plan
// actually has categories for). Same minimal chainable-mock approach as
// soundtrack-preferences.test.ts.
import { describe, expect, it, vi } from "vitest";

import { listActiveTopicTypes } from "./active-plan-topic-types";

function makeChain(finalResult: { data: unknown; error: unknown }) {
  const builder: Record<string, unknown> = {};
  for (const method of ["select", "eq", "not"]) {
    builder[method] = vi.fn(() => builder);
  }
  builder.maybeSingle = vi.fn(() => Promise.resolve(finalResult));
  builder.then = (
    resolve: (value: { data: unknown; error: unknown }) => unknown,
    reject?: (reason: unknown) => unknown,
  ) => Promise.resolve(finalResult).then(resolve, reject);
  return builder;
}

function makeSupabaseMock(opts: {
  activePlan: { data: unknown; error: unknown };
  categories?: { data: unknown; error: unknown };
  noUser?: boolean;
}) {
  const plansChain = makeChain(opts.activePlan);
  const categoriesChain = makeChain(opts.categories ?? { data: [], error: null });
  const from = vi.fn((table: string) => (table === "plans" ? plansChain : categoriesChain));
  return {
    auth: {
      getUser: vi.fn(() =>
        Promise.resolve(opts.noUser ? { data: { user: null }, error: null } : { data: { user: { id: "user-1" } }, error: null }),
      ),
    },
    from,
    plansChain,
    categoriesChain,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
}

describe("listActiveTopicTypes", () => {
  it("reports no-active-plan distinctly from an empty-but-real list", async () => {
    const supabase = makeSupabaseMock({ activePlan: { data: null, error: null } });
    const result = await listActiveTopicTypes(supabase);
    expect(result).toEqual({ ok: true, topicTypes: [], noActivePlan: true });
  });

  it("returns distinct, non-null topic types from the active plan's categories", async () => {
    const supabase = makeSupabaseMock({
      activePlan: { data: { id: "plan-1" }, error: null },
      categories: { data: [{ topic_type: "DSA" }, { topic_type: "DSA" }, { topic_type: "Backend" }], error: null },
    });
    const result = await listActiveTopicTypes(supabase);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.topicTypes.sort()).toEqual(["Backend", "DSA"]);
  });

  it("fails honestly without a session", async () => {
    const supabase = makeSupabaseMock({ activePlan: { data: null, error: null }, noUser: true });
    const result = await listActiveTopicTypes(supabase);
    expect(result.ok).toBe(false);
  });

  it("fails honestly when the active-plan lookup itself errors", async () => {
    const supabase = makeSupabaseMock({ activePlan: { data: null, error: { message: "boom" } } });
    const result = await listActiveTopicTypes(supabase);
    expect(result.ok).toBe(false);
  });
});
