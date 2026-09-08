// Writes a GeneratedPlan into plans/plan_categories/curriculum_items under
// RLS, as the calling user (schema.md §2/§6: these three tables are ordinary
// client-writable tables -- no RPC needed for the inserts themselves, unlike
// focus_sessions/activity_events/etc.).
//
// Atomicity note: there is no single-transaction RPC for the three inserts.
// Each `.insert()` call is its own statement; a plan is inserted, then all
// its categories in one batch insert, then all curriculum_items in one
// batch insert -- three round trips, each atomic on its own table, but not
// atomic across all three. If categories or curriculum_items fail after the
// plan row exists, the caller (route.ts) must not leave that plan marked
// is_active: true -- see markPlanInactive below, called from route.ts's
// catch block. This is why the plan is inserted `is_active: false` and only
// flipped on at the very end, once every write has actually succeeded.
//
// gh90 (real fix): "which plan ends up active" used to be decided by two
// separate, unprotected `.update()` calls -- a genuine data race between
// concurrent requests for the same user, with undefined interleaving. A
// prior attempt (PR #95) reordered those calls and was reviewed/hand-traced
// as moving the race rather than closing it: no combination of `.neq(id,
// ...)` scoping on separate PostgREST round trips can make them atomic
// against each other. The actual fix is activate_plan() (migrations/0005,
// guarded against a raw-write bypass by 0006/0007), a security-definer RPC
// that holds `pg_advisory_xact_lock` for the duration of its own
// deactivate+activate pair, serializing concurrent calls for the same user
// -- see that migration's own comment for exactly what this does and does
// not close (the write race is now closed; a genuine double-submission
// where the loser's HTTP response was already sent before the winner
// supersedes it is a separate, UI-layer problem no database lock can fix).
//
// Residual risk from this still being two round trips (insert, then a
// separate activate_plan() call), not one transaction: if the activate_plan
// RPC's response is lost after its transaction already committed
// server-side (network drop, function timeout) -- as opposed to the RPC
// genuinely failing/rolling back -- an activateError alone can't tell the
// difference. A third `/code-review 102` pass flagged that blindly trusting
// the error would let the catch block's markPlanInactive() below
// incorrectly deactivate a plan that is actually already correctly active
// (the old plan was already deactivated inside activate_plan()'s own
// committed transaction, so the user would end up with zero active plans).
// Fixed below: on any activateError, the code re-reads the plan's actual
// is_active state before deciding it really failed -- if activate_plan()
// did commit, that read wins and this is treated as success.
//
// What that re-check does NOT close, and can't: if the process dies between
// the curriculum_items insert succeeding and the activate_plan() call being
// attempted at all (no RPC call ever went out, nothing to re-check), a
// fully-valid plan is left permanently is_active: false with no repair path
// (no DELETE policy on plans, no background retry job). Same class of
// problem as the double-submission risk documented above: real, requires a
// specific crash window, not fixed here because Wave 1 has no concurrent
// real users yet for it to matter. Closing it for real means making the
// insert-then-activate sequence one transaction (e.g. moving all four
// writes inside activate_plan() itself, or a dedicated
// create_and_activate_plan() RPC) -- filed separately if it turns out to
// matter.

import type { SupabaseClient } from "@supabase/supabase-js";
import type { GeneratedPlan, OnboardingAnswers, PlanningMode } from "./types";

export interface PersistPlanOptions {
  /** Omitted for Manual Setup and Import -- neither has an OnboardingAnswers,
   * and plans.onboarding_answers stays a genuine NULL rather than a
   * defaulted-away empty object (migrations/0016's own column comment).
   * Only the AI-generation route (route.ts) has answers to pass. */
  onboardingAnswers?: OnboardingAnswers;
  /** Omitted lets the plans.planning_mode column's own DEFAULT
   * ('dynamic_weekly', migrations/0017) apply -- there is no meaningful
   * "unset" state to preserve here the way onboardingAnswers has one. */
  planningMode?: PlanningMode;
}

/** Thrown only when persistGeneratedPlan genuinely cannot determine whether
 * activate_plan() committed -- both the activation call and the follow-up
 * verification read failed. Deliberately distinct from a normal failure:
 * the catch block below must NOT run markPlanInactive() on an unverified
 * guess, since forcing is_active:false could itself be the wrong write if
 * the plan actually did commit active (see the module header's residual-risk
 * note). A 4th-pass /code-review 102 finding -- the original re-check logic
 * dropped the verification read's own error and didn't handle rpc() itself
 * throwing (vs. returning {error}), both of which could still reach
 * markPlanInactive() on a plan that was actually active. */
class PlanActivationAmbiguousError extends Error {
  constructor(activateCause: unknown, recheckCause: unknown) {
    super(
      `Could not confirm whether the plan was actually activated -- activation failed (${
        activateCause instanceof Error ? activateCause.message : String(activateCause)
      }) and the verification read also failed (${
        recheckCause instanceof Error ? recheckCause.message : String(recheckCause)
      })`,
    );
    this.name = "PlanActivationAmbiguousError";
  }
}

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

/** Inserts the new plan (inactive) + its categories + curriculum items, then
 * calls activate_plan() (plans_one_active, schema.md §2) to atomically
 * deactivate every other plan and activate this one -- see the gh90 note
 * above for why that's an RPC and not a raw `.update()`. Throws on any
 * write failure -- callers must catch and either fall back or surface an
 * error; never assume partial success is usable. */
export async function persistGeneratedPlan(
  supabase: SupabaseClient,
  userId: string,
  plan: GeneratedPlan,
  options: PersistPlanOptions = {},
): Promise<PersistedPlanSummary> {
  // Inserted inactive on purpose: nothing else can mistake this row for
  // "the" active plan until activate_plan() says so, at the very end, once
  // every other write below has actually succeeded.
  const { data: planRow, error: planError } = await supabase
    .from("plans")
    .insert({
      user_id: userId,
      app_name: plan.app_name,
      goal_line: plan.goal_line,
      is_active: false,
      onboarding_answers: options.onboardingAnswers ?? null,
      // Omitted entirely (not an explicit default value) when unset, so the
      // column's own DEFAULT applies -- same reasoning as coaching_framework
      // a few lines below in the categories insert.
      ...(options.planningMode ? { planning_mode: options.planningMode } : {}),
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
      // plan_categories.coaching_framework is `not null default '{}'::jsonb`
      // (migrations/0001) -- `?? null` was sending an explicit null, which
      // overrides the column default and violates the not-null constraint
      // outright. `?? {}` matches what an omitted column would actually
      // resolve to. Reproduced live: the fallback plan's second category has
      // no coaching_framework at all (fallback.ts), so this broke every
      // fallback-plan persist, which is the one path api.md's "onboarding
      // never dead-ends a new user on an AI failure" guarantee depends on.
      coaching_framework: category.coaching_framework ?? {},
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

    // Every write above succeeded -- now, and only now, make this plan the
    // active one. See migrations/0005 for what the advisory lock inside
    // this RPC actually serializes against.
    try {
      const { error: activateError } = await supabase.rpc("activate_plan", { p_plan_id: planId });
      if (activateError) throw activateError;
    } catch (activateErr) {
      // A network drop or serverless timeout can lose activate_plan()'s
      // response after its transaction already committed server-side --
      // this alone can't distinguish "the RPC genuinely failed" from "it
      // succeeded but we never heard back." The try/catch (rather than just
      // checking `{error}`) also covers rpc() throwing outright, e.g. an
      // aborted fetch, which would otherwise skip this recovery path
      // entirely. Re-check the plan's real state before trusting it.
      const { data: recheck, error: recheckError } = await supabase
        .from("plans")
        .select("is_active")
        .eq("id", planId)
        .maybeSingle();

      if (recheck?.is_active) {
        // Confirmed: activate_plan() did commit. Only its response (or the
        // call itself) was lost -- treat this as the success it actually
        // was.
      } else if (recheckError) {
        // Can't confirm either way: activation failed AND the verification
        // read failed. Surface this as ambiguous rather than "confirmed
        // inactive" -- see PlanActivationAmbiguousError above.
        throw new PlanActivationAmbiguousError(activateErr, recheckError);
      } else {
        throw new Error(
          `Failed to activate plan: ${
            activateErr instanceof Error ? activateErr.message : String(activateErr)
          }`,
        );
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
    // design, so this update is the only cleanup available. Exception: a
    // PlanActivationAmbiguousError means we genuinely couldn't determine
    // whether activate_plan() committed -- forcing is_active:false here
    // could itself be the wrong write, so this skips cleanup and logs the
    // ambiguity loudly instead of guessing.
    if (err instanceof PlanActivationAmbiguousError) {
      console.error(
        `[persist] could not confirm activation state for plan ${planId} -- skipping cleanup rather than guessing:`,
        err,
      );
    } else {
      await markPlanInactive(supabase, planId);
    }
    throw err;
  }
}

/** Best-effort cleanup, not a guarantee -- there's no DELETE path for plans
 * (schema.md: "no DELETE policy on plans"), so this update is the only
 * recovery available. In the common failure case (categories/curriculum_items
 * insert failed) this is a no-op: the plan was inserted is_active: false and
 * never got as far as activate_plan(), so there's nothing to undo -- it's
 * called unconditionally anyway because that's cheaper and safer than trying
 * to track "did activation actually happen" in the caller. The case where it
 * does real work is when activate_plan() itself genuinely errored (rolled
 * back, never committed) -- the caller already re-checks the plan's real
 * is_active state before treating an activateError as a failure at all (see
 * the residual-risk note above), and skips calling this function entirely
 * (PlanActivationAmbiguousError) when that re-check itself can't confirm
 * either way, rather than guess. So by the time this actually runs,
 * is_active really is false already in every remaining case, and this is a
 * no-op there too -- it exists for the "even that shouldn't be possible"
 * defensive case, not because it's expected to do real work.
 * Logged loudly on failure rather than swallowed: if this itself fails
 * (transient DB error, RLS), the plan may be left broken AND active, so that
 * must be visible somewhere rather than silently discarded alongside the
 * original error. */
export async function markPlanInactive(supabase: SupabaseClient, planId: string): Promise<void> {
  const { error } = await supabase.from("plans").update({ is_active: false }).eq("id", planId);
  if (error) {
    console.error(
      `[persist] failed to deactivate broken plan ${planId} -- it is left is_active: true:`,
      error,
    );
  }
}
