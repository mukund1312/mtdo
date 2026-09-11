// Turning classifications into a candidate change set.
//
// Pure, deterministic, and the only place proposals are produced. No AI call
// happens here or anywhere downstream of here -- see decisions.md 2026-09-11.
// Every `reason` string below is assembled from numbers this engine actually
// computed, so a user reading one can check it against their own board.

import { classifyCategory, strugglingArms } from "./classify";
import { LOW_COMPLETION_FLOOR, proposeTarget } from "./thresholds";
import type {
  CategoryOutcome,
  CategoryPerformance,
  ProposedChange,
  WeeklyPerformance,
  WeeklyProposal,
} from "./types";

/** 0.3333 -> "33%". Percentages in reasons are whole numbers; nobody reads 33.33%. */
function pct(value: number): string {
  return `${Math.round(value * 100)}%`;
}

/** "1 of 4 tasks" / "1 of 1 task" */
function ofTasks(done: number, total: number): string {
  return `${done} of ${total} ${total === 1 ? "task" : "tasks"}`;
}

function completionReason(previous: CategoryPerformance, current: CategoryPerformance): string {
  return (
    `Finished ${ofTasks(current.done_count, current.picked_count)} this week ` +
    `(${pct(current.completion_rate as number)}) and ` +
    `${ofTasks(previous.done_count, previous.picked_count)} the week before ` +
    `(${pct(previous.completion_rate as number)}) — under half both weeks.`
  );
}

function paceReason(previous: CategoryPerformance, current: CategoryPerformance): string {
  const over = (r: number) => `${Math.round((r - 1) * 100)}% longer than estimated`;
  return (
    `Tasks with an estimate took ${over(current.pace_ratio as number)} this week ` +
    `and ${over(previous.pace_ratio as number)} the week before.`
  );
}

function coastingReason(previous: CategoryPerformance, current: CategoryPerformance): string {
  return (
    `Finished ${ofTasks(current.done_count, current.picked_count)} this week and ` +
    `${ofTasks(previous.done_count, previous.picked_count)} the week before, ` +
    `in about ${pct(current.pace_ratio as number)} and ${pct(previous.pace_ratio as number)} ` +
    `of the estimated time — two weeks of finishing early.`
  );
}

function avoidedReason(
  previous: CategoryPerformance,
  current: CategoryPerformance,
  label: string,
): string {
  return (
    `Picked ${current.menu_picked_count} of ${current.menu_offered_count} tasks offered this week ` +
    `(${pct(current.pick_rate as number)}) and ${previous.menu_picked_count} of ` +
    `${previous.menu_offered_count} the week before (${pct(previous.pick_rate as number)}). ` +
    `Is ${label} still a priority?`
  );
}

export interface BuildWeeklyProposalInput {
  /** The week under review. */
  current: WeeklyPerformance;
  /** The week before it. Undefined for a plan's first-ever review -- a normal state. */
  previous?: WeeklyPerformance;
}

/**
 * Build the candidate change set for the week AFTER `current`.
 *
 * Never throws on thin data. A first-ever review (no `previous`), a plan whose
 * categories are all too new, or a week where everything is on track all
 * produce an empty `changes` array and a populated `outcomes` array -- "we
 * looked and there is nothing to change" is a real, reportable result, not an
 * error and not a reason to skip recording the review.
 *
 * THE HARD CONSTRAINTS, and where each one actually lives:
 *   1. Never modifies `plans.goal_line`  -- structural: nothing here or in
 *      apply_weekly_plan_change() writes that column. The goal is the user's,
 *      full stop.
 *   2. Never increases `plan_categories.days` -- structural, same way. `days`
 *      is what the user told us about their availability; inventing more of
 *      it would be the engine fabricating hours in someone's week.
 *   3. Never stacks load after a bad week -- enforced here (see
 *      `increasesSuppressed` below), because it needs the plan-level metrics
 *      of the week being reviewed. Deliberately NOT re-checked at apply time:
 *      re-deriving it on every click could flip a proposal while the user is
 *      looking at it.
 *   4. No change exceeds +/-30% or one block, whichever is larger -- enforced
 *      by `proposeTarget()` here AND independently in SQL by
 *      apply_weekly_plan_change(), which also bounds a value the user edits
 *      by hand.
 */
export function buildWeeklyProposal({
  current,
  previous,
}: BuildWeeklyProposalInput): WeeklyProposal {
  const previousByCategory = new Map<string, CategoryPerformance>(
    (previous?.categories ?? []).map((c) => [c.category_id, c]),
  );

  // Constraint 3. A null plan-level completion means nothing was picked at
  // all that week, which is treated as below the floor: there is no reading
  // of "did nothing" under which the right response is more work.
  const planCompletion = current.plan.completion_rate;
  const increasesSuppressed =
    planCompletion === null || planCompletion < LOW_COMPLETION_FLOOR;

  const changes: ProposedChange[] = [];
  const outcomes: CategoryOutcome[] = [];

  for (const cat of current.categories) {
    const prev = previousByCategory.get(cat.category_id);
    const classification = classifyCategory(prev, cat);
    const outcome: CategoryOutcome = {
      category_id: cat.category_id,
      label: cat.label,
      classification,
    };

    if (classification === "avoided" && prev) {
      // A flagged question, never a numeric change. It carries no values at
      // all (the DB constraint enforces that), and accept-all deliberately
      // skips it -- a question cannot be answered by a bulk "yes".
      changes.push({
        change_type: "flag_question",
        target_category_id: cat.category_id,
        old_value: null,
        new_value: null,
        reason: avoidedReason(prev, cat, cat.label),
        signal: "avoided",
      });
      outcomes.push(outcome);
      continue;
    }

    if (classification === "struggling" && prev) {
      const next = proposeTarget(cat.current_target, "decrease");
      if (next === cat.current_target) {
        // Already at the floor -- a target of 1 cannot be eased further, and
        // proposing 1 -> 1 is noise the user has to read and dismiss.
        outcome.suppressed = "capped_to_no_change";
        outcomes.push(outcome);
        continue;
      }
      const arms = strugglingArms(prev, cat);
      const reasons: string[] = [];
      if (arms.completion) reasons.push(completionReason(prev, cat));
      if (arms.pace) reasons.push(paceReason(prev, cat));
      changes.push({
        change_type: "weekly_target_blocks",
        target_category_id: cat.category_id,
        old_value: cat.current_target,
        new_value: next,
        reason: reasons.join(" "),
        signal: "struggling",
      });
      outcomes.push(outcome);
      continue;
    }

    if (classification === "coasting" && prev) {
      if (increasesSuppressed) {
        outcome.suppressed = "low_completion_week";
        outcomes.push(outcome);
        continue;
      }
      const next = proposeTarget(cat.current_target, "increase");
      if (next === cat.current_target) {
        outcome.suppressed = "capped_to_no_change";
        outcomes.push(outcome);
        continue;
      }
      changes.push({
        change_type: "weekly_target_blocks",
        target_category_id: cat.category_id,
        old_value: cat.current_target,
        new_value: next,
        reason: coastingReason(prev, cat),
        signal: "coasting",
      });
      outcomes.push(outcome);
      continue;
    }

    outcomes.push(outcome);
  }

  return { changes, outcomes, increasesSuppressed };
}
