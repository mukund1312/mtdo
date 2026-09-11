// The weekly review (Phase 7, operating-engine plan).
//
// Reads two weeks of deterministic metrics out of Postgres, runs the
// rule-based engine in web/lib/planning/**, and stores the resulting candidate
// change set. NOTHING IN THIS PATH CALLS AN AI PROVIDER -- not this route, not
// anything it imports. That is a product decision, not an accident of
// sequencing; see decisions.md 2026-09-11. If you are adding a natural-language
// summary later, it goes somewhere else and reads these numbers, it does not
// get to compute or alter them.
//
// Contract:
//   POST /api/plan/weekly-review
//   Body (optional): { "isoWeek": "2026-W37" } -- the week to review. Omitted,
//     it defaults to the most recently COMPLETED week in the caller's own
//     timezone. Supplied, it is validated as a real ISO week; anything else
//     is a 400.
//   200 { generated: true, weeklyPlanId, isoWeek, effectiveIsoWeek,
//         changeCount, changes[], outcomes[], increasesSuppressed, metrics }
//   200 { generated: false, reason, weeklyPlanId? } -- an honest no-op: no
//     active plan, or this week's review already has decisions recorded
//     against it and regenerating would destroy them.
//   400 malformed body or isoWeek. 401 no session. 500 a database error.
//
// Accept / reject / edit are deliberately NOT routed through here -- they are
// direct `authenticated` RPC calls (apply_weekly_plan_change,
// accept_all_weekly_plan_changes), the same way the Time deck calls
// schedule_block() straight from the client. They hold no secret and need no
// server-side logic; see api.md §3g.
import { createClient } from "@/lib/supabase/server";
import type { Json } from "@/lib/supabase/database.types";
import { buildWeeklyProposal } from "@/lib/planning/propose";
import {
  defaultReviewWeek,
  isValidIsoWeek,
  nextIsoWeek,
  previousIsoWeek,
} from "@/lib/planning/iso-week";
import {
  asWeeklyPerformance,
  WeeklyPerformanceError,
  type WeeklyPerformance,
} from "@/lib/planning/types";

export async function POST(request: Request) {
  const supabase = await createClient();
  const {
    data: { user },
    error: userError,
  } = await supabase.auth.getUser();
  if (userError || !user) {
    return Response.json({ error: "No authenticated session." }, { status: 401 });
  }

  // An empty body is the normal call, so a missing/unparseable body is only an
  // error if something was actually sent.
  let requestedWeek: string | undefined;
  const raw = await request.text();
  if (raw.trim().length > 0) {
    try {
      const body = JSON.parse(raw) as { isoWeek?: unknown };
      if (body.isoWeek !== undefined) {
        if (typeof body.isoWeek !== "string" || !isValidIsoWeek(body.isoWeek)) {
          return Response.json(
            { error: "isoWeek must be an ISO week of the form YYYY-Www." },
            { status: 400 },
          );
        }
        requestedWeek = body.isoWeek;
      }
    } catch {
      return Response.json({ error: "Malformed JSON body." }, { status: 400 });
    }
  }

  const { data: planRow, error: planError } = await supabase
    .from("plans")
    .select("id")
    .eq("user_id", user.id)
    .eq("is_active", true)
    .maybeSingle();
  if (planError) {
    return Response.json({ error: planError.message }, { status: 500 });
  }
  if (!planRow) {
    return Response.json({ generated: false, reason: "No active route." });
  }

  let isoWeek = requestedWeek;
  if (!isoWeek) {
    // The caller's own zone, same coalesce(profiles.timezone, 'UTC') fallback
    // as every other date decision in this product (0013/0014).
    const { data: profile } = await supabase
      .from("profiles")
      .select("timezone")
      .eq("id", user.id)
      .maybeSingle();
    isoWeek = defaultReviewWeek(profile?.timezone ?? null);
  }
  const priorWeek = previousIsoWeek(isoWeek);
  const effectiveIsoWeek = nextIsoWeek(isoWeek);

  // Refuse before computing anything if this review has already been acted
  // on. save_weekly_plan() refuses too -- that is the backstop -- but a clean
  // 200 here beats surfacing a 22023 the UI would have to decode.
  const { data: existing, error: existingError } = await supabase
    .from("weekly_plans")
    .select("id, weekly_plan_changes(status)")
    .eq("plan_id", planRow.id)
    .eq("iso_week", isoWeek)
    .maybeSingle();
  if (existingError) {
    return Response.json({ error: existingError.message }, { status: 500 });
  }
  if (existing) {
    const changes = (existing.weekly_plan_changes ?? []) as Array<{ status: string }>;
    if (changes.some((c) => c.status !== "pending")) {
      return Response.json({
        generated: false,
        reason: "This week's review has already been reviewed.",
        weeklyPlanId: existing.id,
      });
    }
  }

  // Both weeks are read with the user's OWN client, never a service client --
  // weekly_performance() derives its user from auth.uid() and would reject a
  // sessionless caller outright (api.md §3f).
  async function performance(week: string): Promise<WeeklyPerformance | { error: string }> {
    const { data, error } = await supabase.rpc("weekly_performance", {
      p_plan_id: planRow!.id,
      p_iso_week: week,
    });
    if (error) return { error: error.message };
    try {
      return asWeeklyPerformance(data);
    } catch (e) {
      return { error: e instanceof WeeklyPerformanceError ? e.message : String(e) };
    }
  }

  const current = await performance(isoWeek);
  if ("error" in current) {
    return Response.json({ error: current.error }, { status: 500 });
  }
  const priorResult = await performance(priorWeek);
  // A missing prior week is a plan's first-ever review, which is a normal
  // state producing zero proposed changes -- never an error. Only a real
  // database failure is fatal, and weekly_performance() returns a fully
  // zeroed body rather than nothing for a week with no data, so this branch
  // is genuinely about failure.
  if ("error" in priorResult) {
    return Response.json({ error: priorResult.error }, { status: 500 });
  }

  const proposal = buildWeeklyProposal({ current, previous: priorResult });

  const metrics = {
    schema_version: "mtdo.weekly_review.v1",
    current,
    previous: priorResult,
  };

  const { data: weeklyPlanId, error: saveError } = await supabase.rpc("save_weekly_plan", {
    p_plan_id: planRow.id,
    p_iso_week: isoWeek,
    p_effective_iso_week: effectiveIsoWeek,
    p_metrics: metrics as unknown as Json,
    p_changes: proposal.changes as unknown as Json,
  });
  if (saveError) {
    return Response.json({ error: saveError.message }, { status: 500 });
  }

  return Response.json({
    generated: true,
    weeklyPlanId,
    isoWeek,
    effectiveIsoWeek,
    changeCount: proposal.changes.length,
    changes: proposal.changes,
    outcomes: proposal.outcomes,
    increasesSuppressed: proposal.increasesSuppressed,
    metrics,
  });
}
