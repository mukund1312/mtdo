// Curriculum check-in (Phase 3, operating-engine plan; docs/architecture/
// decisions.md 2026-09-08 "extend in place"). Generates new curriculum
// content for whichever of the caller's active-plan categories have their
// unlock cursor pinned (fully unlocked, nothing left to reveal), then
// persists it through extend_plan() (migrations/0016), which appends the
// content AND advances the unlock cursor in the same transaction.
//
// Contract:
//   POST /api/plan/extend, no request body -- eligible categories are
//   detected server-side, never trusted from the client.
//   200 { extended: false, reason: string }               -- nothing was
//     eligible (no active plan, or no category is actually exhausted right
//     now); an honest no-op, not an error, since the client's own
//     exhaustion check can race a state change.
//   200 { extended: true, categories: [{ categoryId, label, addedCount }] }
//   400/401 (plain JSON) for a malformed request or no session.
//   502 { error } if the AI call and its own retry both failed, or the
//     model's response didn't parse into valid extension content -- there
//     is no static-fallback equivalent to onboarding's buildFallbackPlan()
//     here (a generic template doesn't fit an already-personalized plan's
//     specific categories), so this fails loudly rather than persisting
//     something wrong. This does not block the core loop: the user's
//     existing board and content are completely unaffected either way.
import { createClient } from "@/lib/supabase/server";
import type { Json } from "@/lib/supabase/database.types";
import { generatePlanExtension } from "@/lib/ai/service";
import { buildExtensionPrompt, type ExtensionSignal } from "@/lib/plan-generation/extend-prompt";
import { parseExtensionResponse } from "@/lib/plan-generation/parse";
import { PlanGenerationError, type GeneratedTask } from "@/lib/plan-generation/types";
import { recordEvent } from "@/lib/analytics/record-event";

export const maxDuration = 60;

type EligibleCategory = ExtensionSignal;

function itemMeta(item: string | GeneratedTask): Record<string, unknown> {
  if (typeof item === "string") return {};
  return {
    focus_points: item.focus_points ?? [],
    questions: item.questions ?? [],
    interview_questions: item.interview_questions ?? [],
    mistakes: item.mistakes ?? [],
    tips: item.tips ?? [],
    mental_models: item.mental_models ?? [],
    related_topics: item.related_topics ?? [],
  };
}

function itemTask(item: string | GeneratedTask): string {
  return typeof item === "string" ? item : item.task;
}

export async function POST(request: Request) {
  const supabase = await createClient();
  const {
    data: { user },
    error: userError,
  } = await supabase.auth.getUser();
  if (userError || !user) {
    return Response.json({ error: "No authenticated session." }, { status: 401 });
  }

  const { data: planRow, error: planError } = await supabase
    .from("plans")
    .select("id, goal_line, planning_mode")
    .eq("user_id", user.id)
    .eq("is_active", true)
    .maybeSingle();
  if (planError) {
    return Response.json({ error: planError.message }, { status: 500 });
  }
  if (!planRow) {
    return Response.json({ extended: false, reason: "No active route." });
  }

  const { data: categoryRows, error: categoryError } = await supabase
    .from("plan_categories")
    .select("id, label, days, topic_type, menu_unlocked_week_index, curriculum_items(week_index, id)")
    .eq("plan_id", planRow.id);
  if (categoryError) {
    return Response.json({ error: categoryError.message }, { status: 500 });
  }

  const eligible: EligibleCategory[] = [];
  for (const category of categoryRows ?? []) {
    const items = (category.curriculum_items ?? []) as Array<{ id: string; week_index: number }>;
    if (items.length === 0) continue; // nothing generated for this category at all -- not this flow's job
    const maxWeek = Math.max(...items.map((item) => item.week_index));
    // "Cursor pinned": fully unlocked, nothing left for ensure_curriculum_menu()
    // to reveal even if the user waits. Extending a category that still has
    // unrevealed content would be pointless -- the real fix there is just
    // showing up next week, not generating more. Only meaningful for a
    // dynamic_weekly plan -- an overall-mode plan's cursor never advances
    // at all (migrations/0017, by design, so switching back to
    // dynamic_weekly resumes correctly), so this check would almost never
    // pass there even though overall mode can genuinely run its menu down
    // to nothing; skip it entirely for overall and fall through to the
    // real signal below (picked/completed/still-unpicked counts).
    if (planRow.planning_mode === "dynamic_weekly" && category.menu_unlocked_week_index < maxWeek) continue;

    const { count: pickedCount } = await supabase
      .from("blocks")
      .select("id", { count: "exact", head: true })
      .eq("category_id", category.id)
      .not("curriculum_item_id", "is", null);
    const { count: completedCount } = await supabase
      .from("blocks")
      .select("id", { count: "exact", head: true })
      .eq("category_id", category.id)
      .not("curriculum_item_id", "is", null)
      .eq("status", "done");

    eligible.push({
      categoryId: category.id,
      label: category.label,
      topicType: category.topic_type ?? undefined,
      daysPerWeek: Math.max(category.days.length, 1),
      completedCount: completedCount ?? 0,
      inProgressOrBacklogCount: (pickedCount ?? 0) - (completedCount ?? 0),
      stillUnpickedCount: items.length - (pickedCount ?? 0),
    });
  }

  if (eligible.length === 0) {
    return Response.json({ extended: false, reason: "No category is exhausted right now." });
  }

  let rawText: string;
  try {
    rawText = await generatePlanExtension({ prompt: buildExtensionPrompt(planRow.goal_line, eligible), signal: request.signal });
  } catch (err) {
    if (request.signal.aborted) {
      return new Response(null, { status: 499 });
    }
    console.error("[plan/extend] AI provider call failed:", err);
    return Response.json({ error: "Couldn't generate more content right now. Try again shortly." }, { status: 502 });
  }

  let extension;
  try {
    extension = parseExtensionResponse(
      rawText,
      eligible.map((c) => c.categoryId),
    );
  } catch (err) {
    console.error("[plan/extend] model response didn't parse:", err);
    const message = err instanceof PlanGenerationError ? err.message : "The generated content wasn't usable.";
    return Response.json({ error: `Couldn't generate more content right now: ${message}` }, { status: 502 });
  }

  const { data: insertedRows, error: extendError } = await supabase.rpc("extend_plan", {
    // extend_plan(jsonb) validates this shape itself (migrations/0016) --
    // the double cast here is only working around Json's structural type
    // not accepting Record<string, unknown> for the meta objects, which are
    // themselves already a controlled shape (itemMeta's own return type).
    p_extension: extension.map((category) => ({
      category_id: category.category_id,
      items: category.items.map((item) => ({ task: itemTask(item), meta: itemMeta(item) })),
    })) as unknown as Json,
  });
  if (extendError) {
    console.error("[plan/extend] extend_plan RPC failed:", extendError);
    return Response.json({ error: "Generated content couldn't be saved. Try again." }, { status: 500 });
  }

  const addedByCategory = new Map<string, number>();
  for (const row of insertedRows ?? []) {
    addedByCategory.set(row.category_id, (addedByCategory.get(row.category_id) ?? 0) + 1);
  }

  await recordEvent(supabase, "plan_generated", {
    // Reuses plan_generated's kind rather than adding a new ledger value for
    // one telemetry nuance -- both events mean "AI-generated curriculum
    // content was persisted"; this flag is what distinguishes them.
    usedExtension: true,
    categoryCount: eligible.length,
  });

  return Response.json({
    extended: true,
    categories: eligible.map((category) => ({
      categoryId: category.categoryId,
      label: category.label,
      addedCount: addedByCategory.get(category.categoryId) ?? 0,
    })),
  });
}
