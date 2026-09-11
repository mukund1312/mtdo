import { readFileSync } from "node:fs";
import path from "node:path";
import { test, expect } from "@playwright/test";
import { createClient } from "@supabase/supabase-js";
import type { Database } from "../lib/supabase/database.types";

// migrations/0023 DROPPED and recreated start_session, complete_session and
// abandon_session to add trailing defaulted parameters. pgTAP proves the
// function bodies are right, but it calls them as SQL -- it cannot see the
// layer that actually broke things in this shape of change: PostgREST's
// overload resolution and the grants on the NEW function OIDs. A client
// calling `rpc('complete_session', { p_id })` against two live overloads gets
// a 300 "could not choose the best candidate function", and a recreated
// function that lost its GRANT gets a 42501 -- neither is visible from SQL.
//
// So this drives the real RPCs over the real PostgREST endpoint as a real
// anonymous user under real RLS, which is exactly how the Session screen
// calls them. It deliberately does NOT touch the Session UI: the pause/end/
// leave-early controls do not exist yet (that is the next agent's work
// against api.md §3h), and asserting on a UI that hasn't been built would
// make this spec fail for the wrong reason the moment it is.
//
// Skips rather than fails without Supabase credentials -- CI's web-e2e job
// injects the public URL/anon key, so this runs there; a checkout with no
// .env.local skips cleanly instead of reporting a false red.

// Same two-source lookup phase7-weekly-review.spec.ts uses: CI injects the
// public URL/anon key as real env vars (ci.yml's web-e2e job), while a local
// checkout keeps them in .env.local, which Next.js loads for the app but the
// Playwright runner process never sees.
function loadEnvLocal(): Record<string, string> {
  const out: Record<string, string> = {};
  try {
    const text = readFileSync(path.join(process.cwd(), ".env.local"), "utf8");
    for (const line of text.split("\n")) {
      const m = line.match(/^([A-Z_]+)=(.*)$/);
      if (m?.[1] !== undefined && m[2] !== undefined) out[m[1]] = m[2];
    }
  } catch {
    // No local env file -- fall back to process.env, then skip.
  }
  return out;
}

const ENV = loadEnvLocal();
const url = ENV.NEXT_PUBLIC_SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL;
const anonKey = ENV.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

// SERIAL, and ONE anonymous sign-in shared by all four tests -- both halves
// of that are deliberate and load-bearing.
//
// Anonymous sign-in is a rate-limited, project-wide resource, and this repo
// has already been bitten by exhausting it twice (PROGRESS.md, 2026-09-08 and
// 2026-09-11: a `429 over_request_rate_limit` that surfaces downstream as
// "No authenticated session" and unrelated-looking failures in whatever spec
// happens to run next). A spec that mints a fresh anonymous user per test
// adds four sign-ins to every CI run forever, which is a bad trade for what
// is really one user's worth of work.
//
// Sharing one user REQUIRES serial mode: playwright.config.ts sets
// `fullyParallel: true`, so tests inside a file can otherwise run
// concurrently -- and these four all start focus sessions, which
// focus_sessions_one_running would reject for a shared user. Serial mode is
// what makes one sign-in safe; the two decisions cannot be separated.
test.describe.serial("session RPC contract (migrations/0023)", () => {
  test.skip(!url || !anonKey, "needs NEXT_PUBLIC_SUPABASE_URL / _ANON_KEY");

  type Db = ReturnType<typeof createClient<Database>>;
  let supabase: Db;
  let authFailure: string | null = null;

  test.beforeAll(async () => {
    if (!url || !anonKey) return;
    const c = createClient<Database>(url, anonKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const { error } = await c.auth.signInAnonymously();
    if (error) {
      // Recorded rather than thrown: a rate-limited sign-in is an
      // environment problem, and failing every test here would report it as
      // a code regression. beforeEach turns it into an honest skip.
      authFailure = error.message;
      return;
    }
    supabase = c;
  });

  test.beforeEach(() => {
    test.skip(!!authFailure, `anonymous sign-in unavailable: ${authFailure}`);
  });

  test("the pre-0023 flows still work end to end: start -> complete, start -> abandon", async () => {
    // Exactly the call the shipped Session screen makes today -- p_block_id
    // omitted rather than passed as null (api.md §3's note on why null does
    // not typecheck), p_break_plan not mentioned at all.
    const started = await supabase.rpc("start_session", { p_planned_duration_s: 1500 });
    expect(started.error, JSON.stringify(started.error)).toBeNull();
    const first = started.data as unknown as { id: string; state: string };
    expect(first.state).toBe("running");

    // The one-argument call form must still resolve against the recreated
    // three-argument function. A leftover overload shows up right here.
    const completed = await supabase.rpc("complete_session", { p_id: first.id });
    expect(completed.error, JSON.stringify(completed.error)).toBeNull();
    expect((completed.data as unknown as { state: string }).state).toBe("completed");

    const second = await supabase.rpc("start_session", { p_planned_duration_s: 1500 });
    expect(second.error, JSON.stringify(second.error)).toBeNull();
    const abandoned = await supabase.rpc("abandon_session", {
      p_id: (second.data as unknown as { id: string }).id,
    });
    expect(abandoned.error, JSON.stringify(abandoned.error)).toBeNull();
    expect((abandoned.data as unknown as { state: string }).state).toBe("abandoned");
  });

  test("55006 recovery still branches correctly, and now covers a PAUSED session", async () => {
    const started = await supabase.rpc("start_session", { p_planned_duration_s: 1500 });
    expect(started.error).toBeNull();
    const id = (started.data as unknown as { id: string }).id;

    // Pause is a sub-state of running, so a paused session must still hold
    // the one-running slot -- if it didn't, a user who paused and reloaded
    // would silently start a second timer beside the first.
    const paused = await supabase.rpc("pause_session", { p_id: id, p_reason: "break" });
    expect(paused.error, JSON.stringify(paused.error)).toBeNull();
    expect((paused.data as unknown as { state: string }).state).toBe("running");

    const conflict = await supabase.rpc("start_session", { p_planned_duration_s: 1500 });
    expect(conflict.error?.code).toBe("55006");

    // And the client's existing stale-session recovery read still finds it.
    const { data: running } = await supabase
      .from("focus_sessions")
      .select("id, started_at, planned_duration_s, paused_at, total_paused_s, break_plan")
      .eq("state", "running")
      .maybeSingle();
    expect(running?.id).toBe(id);
    expect(running?.paused_at).not.toBeNull();

    await supabase.rpc("resume_session", { p_id: id });
    await supabase.rpc("abandon_session", { p_id: id });
  });

  test("the full new lifecycle over PostgREST: breaks, extend, and the block outcome", async () => {
    const { data: userData } = await supabase.auth.getUser();
    const userId = userData.user!.id;

    // A real plan/category/block, since the block outcome is the whole point.
    const { data: plan, error: planError } = await supabase
      .from("plans")
      .insert({ user_id: userId, app_name: "e2e", goal_line: "session rpc contract", is_active: false })
      .select("id")
      .single();
    expect(planError, JSON.stringify(planError)).toBeNull();

    const { data: category } = await supabase
      .from("plan_categories")
      .insert({ plan_id: plan!.id, name: "dsa", label: "DSA", days: [0, 1, 2], sort_order: 0 })
      .select("id")
      .single();

    const { data: block } = await supabase
      .from("blocks")
      .insert({
        user_id: userId,
        plan_id: plan!.id,
        category_id: category!.id,
        date: new Date().toISOString().slice(0, 10),
        position: 0,
        text: "session rpc contract block",
        status: "in_progress",
      })
      .select("id")
      .single();

    // The founder's example: 45 minutes of work with 2x5 minute breaks.
    const started = await supabase.rpc("start_session", {
      p_block_id: block!.id,
      p_planned_duration_s: 2700,
      p_break_plan: {
        breaks: [
          { at_s: 900, duration_s: 300 },
          { at_s: 1800, duration_s: 300 },
        ],
      },
    });
    expect(started.error, JSON.stringify(started.error)).toBeNull();
    const session = started.data as unknown as {
      id: string;
      break_plan: { breaks: { at_s: number }[] };
      planned_duration_s: number;
    };
    // Persisted, which is the argument for the column: a reload can rebuild
    // the schedule instead of silently losing the user's remaining breaks.
    expect(session.break_plan.breaks).toHaveLength(2);

    // A scheduled break is a pause with a reason tag -- one mechanic.
    expect((await supabase.rpc("pause_session", { p_id: session.id, p_reason: "break" })).error).toBeNull();
    expect((await supabase.rpc("resume_session", { p_id: session.id })).error).toBeNull();

    // "Do you need more time?" -- yes, ten minutes.
    const extended = await supabase.rpc("extend_session", { p_id: session.id, p_additional_s: 600 });
    expect(extended.error, JSON.stringify(extended.error)).toBeNull();
    const after = extended.data as unknown as { planned_duration_s: number; extended_s: number };
    expect(after.planned_duration_s).toBe(3300);
    expect(after.extended_s).toBe(600);

    // Natural expiry: the session closes first, and the "anything left?"
    // question is answered afterwards (api.md §3h's decision table, row 4).
    expect((await supabase.rpc("complete_session", { p_id: session.id })).error).toBeNull();

    const outcome = await supabase.rpc("settle_block_outcome", {
      p_session_id: session.id,
      p_outcome: "in_progress",
      p_leftover_note: "still need the left-join case",
    });
    expect(outcome.error, JSON.stringify(outcome.error)).toBeNull();
    const settled = outcome.data as unknown as { status: string; notes: string };
    expect(settled.status).toBe("in_progress");
    expect(settled.notes).toContain("still need the left-join case");

    // And the explicit "End session" path: one atomic call, block -> done.
    const second = await supabase.rpc("start_session", {
      p_block_id: block!.id,
      p_planned_duration_s: 1500,
    });
    expect(second.error).toBeNull();
    const ended = await supabase.rpc("complete_session", {
      p_id: (second.data as unknown as { id: string }).id,
      p_block_outcome: "done",
    });
    expect(ended.error, JSON.stringify(ended.error)).toBeNull();

    const { data: finalBlock } = await supabase
      .from("blocks")
      .select("status")
      .eq("id", block!.id)
      .single();
    expect(finalBlock?.status).toBe("done");

    // The ledger event is what makes that visible to weekly_performance() --
    // a bare status write would be invisible to the engine.
    const { data: events } = await supabase
      .from("activity_events")
      .select("kind")
      .eq("kind", "task_completed");
    expect((events ?? []).length).toBeGreaterThan(0);
  });

  test("focus_sessions is still SELECT-only, including the new columns", async () => {
    const started = await supabase.rpc("start_session", { p_planned_duration_s: 1500 });
    expect(started.error).toBeNull();
    const id = (started.data as unknown as { id: string }).id;

    // A bigger total_paused_s is free focus time back; a bigger
    // planned_duration_s raises the cap. D12 says the client writes neither.
    // Worth being explicit about why this compiles: the generated types
    // describe the TABLE's shape, not its GRANTS, so `total_paused_s` and
    // `planned_duration_s` appear in focus_sessions' Update type and this
    // call typechecks perfectly. TypeScript will never catch a forged write
    // to a SELECT-only table -- the 42501 below is the only thing that does,
    // which is exactly why the REVOKE is the real control and not the types.
    const forged = await supabase
      .from("focus_sessions")
      .update({ total_paused_s: 0, planned_duration_s: 86400 })
      .eq("id", id);
    expect(forged.error?.code).toBe("42501");

    await supabase.rpc("abandon_session", { p_id: id });
  });
});
