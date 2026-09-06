// Writes a GeneratedPlan into plans/plan_categories/curriculum_items under
// RLS, as the calling user (schema.md §2/§6: these three tables are ordinary
// client-writable tables -- no RPC needed, unlike focus_sessions/
// activity_events/etc.).
//
// Atomicity note: there is no single-transaction RPC for this (by design --
// these tables don't need security-definer writes). Each `.insert()` call is
// its own statement; a plan is inserted, then all its categories in one
// batch insert, then all curriculum_items in one batch insert -- three
// round trips, each atomic on its own table, but not atomic across all
// three. If categories or curriculum_items fail after the plan row exists,
// the caller (route.ts) must not leave that plan marked is_active: true --
// see markPlanInactive below, called from route.ts's catch block.

import type { SupabaseClient } from "@supabase/supabase-js";
import type { GeneratedPlan } from "./types";

export interface PersistedCategorySummary {
  id: string;
  name: string;
  label: string;
}

export interface PersistedPlanSummary {
  planId: string;
  appName: string;
  goalLine: string;
  categories: PersistedCategorySummary[];
}

/** Deactivates any existing active plan (plans_one_active, schema.md §2), then
 * inserts the new plan + its categories + curriculum items. Throws on any
 * write failure -- callers must catch and either fall back or surface an
 * error; never assume partial success is usable. */
export async function persistGeneratedPlan(
  supabase: SupabaseClient,
  userId: string,
  plan: GeneratedPlan,
): Promise<PersistedPlanSummary> {
  const { error: deactivateError } = await supabase
    .from("plans")
    .update({ is_active: false })
    .eq("user_id", userId)
    .eq("is_active", true);
  if (deactivateError) {
    throw new Error(`Failed to deactivate the previous plan: ${deactivateError.message}`);
  }

  const { data: planRow, error: planError } = await supabase
    .from("plans")
    .insert({
      user_id: userId,
      app_name: plan.app_name,
      goal_line: plan.goal_line,
      is_active: true,
    })
    .select("id")
    .single();
  if (planError || !planRow) {
    throw new Error(`Failed to insert plan: ${planError?.message ?? "no row returned"}`);
  }
  const planId = planRow.id as string;

  try {
    const categoryRows = plan.categories.map((category, sortOrder) => ({
      plan_id: planId,
      name: category.name,
      label: category.label,
      days: category.days,
      min_blocks: category.min_blocks,
      score_weight: category.score_weight,
      topic_type: category.topic_type ?? null,
      coaching_framework: category.coaching_framework ?? null,
      sort_order: sortOrder,
    }));
    const { data: insertedCategories, error: categoriesError } = await supabase
      .from("plan_categories")
      .insert(categoryRows)
      .select("id, name, label");
    if (categoriesError || !insertedCategories || insertedCategories.length !== categoryRows.length) {
      throw new Error(
        `Failed to insert plan_categories: ${categoriesError?.message ?? "row count mismatch"}`,
      );
    }

    // Supabase preserves insert-array order in the returned rows for a single
    // insert statement, so index-aligning against plan.categories is safe --
    // still keyed defensively by name rather than assumed blindly.
    const categoryIdByName = new Map<string, string>();
    for (const row of insertedCategories) {
      categoryIdByName.set(row.name as string, row.id as string);
    }

    const curriculumRows: Array<{
      category_id: string;
      week_index: number;
      position: number;
      task: string;
      meta: Record<string, unknown>;
    }> = [];

    for (const category of plan.categories) {
      const categoryId = categoryIdByName.get(category.name);
      if (!categoryId) {
        throw new Error(`Inserted category "${category.name}" wasn't returned by Supabase.`);
      }
      const daysPerWeek = Math.max(category.days.length, 1);
      let position = 0;
      category.curriculum.forEach((dayList, dayListIndex) => {
        const weekIndex = Math.floor(dayListIndex / daysPerWeek);
        for (const item of dayList) {
          const isRich = typeof item === "object";
          curriculumRows.push({
            category_id: categoryId,
            week_index: weekIndex,
            position: position++,
            task: isRich ? item.task : item,
            meta: isRich
              ? {
                  focus_points: item.focus_points ?? [],
                  questions: item.questions ?? [],
                  interview_questions: item.interview_questions ?? [],
                  mistakes: item.mistakes ?? [],
                  tips: item.tips ?? [],
                  mental_models: item.mental_models ?? [],
                  related_topics: item.related_topics ?? [],
                }
              : {},
          });
        }
      });
    }

    if (curriculumRows.length > 0) {
      const { error: itemsError } = await supabase.from("curriculum_items").insert(curriculumRows);
      if (itemsError) {
        throw new Error(`Failed to insert curriculum_items: ${itemsError.message}`);
      }
    }

    return {
      planId,
      appName: plan.app_name,
      goalLine: plan.goal_line,
      categories: insertedCategories.map((row) => ({
        id: row.id as string,
        name: row.name as string,
        label: row.label as string,
      })),
    };
  } catch (err) {
    // Best-effort: don't leave a half-written plan marked active. There's no
    // delete path for plans (schema.md: "no DELETE policy on plans"), by
    // design, so this update is the only cleanup available.
    await markPlanInactive(supabase, planId);
    throw err;
  }
}

export async function markPlanInactive(supabase: SupabaseClient, planId: string): Promise<void> {
  await supabase.from("plans").update({ is_active: false }).eq("id", planId);
}
