// Classifying one category over the trailing two weeks.
//
// Pure functions over `weekly_performance()` output. No I/O, no clock, no
// randomness -- the same two weeks of numbers always produce the same
// classification, which is what makes this engine auditable and what lets the
// whole thing be unit-tested against exact boundary values.

import {
  AVOIDED_PICK_RATE_MAX,
  COASTING_COMPLETION_MIN,
  COASTING_PACE_MAX,
  STRUGGLING_COMPLETION_MAX,
  STRUGGLING_PACE_MIN,
} from "./thresholds";
import type { CategoryPerformance, Classification } from "./types";

/**
 * Did this category have a real, full week of observable life?
 *
 * Two distinct gaps are both excluded, and they must be:
 *   - The category did not exist for the whole week (`existed_before_week`).
 *     A category added on Wednesday has three days of data, and three days
 *     of quiet is not evidence of anything.
 *   - Nothing was offered AND nothing was picked. The menu had nothing to
 *     show and the user put nothing on the board, so there is no behaviour to
 *     read. Note this is NOT the same as "offered things and picked none" --
 *     that IS behaviour, and it is exactly what the avoided signal is for.
 */
export function isObservable(week: CategoryPerformance | undefined): week is CategoryPerformance {
  if (!week) return false;
  if (!week.existed_before_week) return false;
  return week.menu_offered_count > 0 || week.picked_count > 0;
}

const strugglingByCompletion = (w: CategoryPerformance) =>
  w.completion_rate !== null && w.completion_rate < STRUGGLING_COMPLETION_MAX;

const strugglingByPace = (w: CategoryPerformance) =>
  w.pace_ratio !== null && w.pace_ratio > STRUGGLING_PACE_MIN;

const coasting = (w: CategoryPerformance) =>
  w.completion_rate !== null &&
  w.completion_rate >= COASTING_COMPLETION_MIN &&
  w.pace_ratio !== null &&
  w.pace_ratio < COASTING_PACE_MAX;

const avoided = (w: CategoryPerformance) =>
  w.pick_rate !== null && w.pick_rate < AVOIDED_PICK_RATE_MAX;

/**
 * Classify one category from its two trailing weeks.
 *
 * `previous` is the older week, `current` the more recent. Either may be
 * undefined -- a plan's first-ever review has no previous week at all, and
 * that is a normal state producing `insufficient_data`, never an error.
 *
 * ORDER OF PRECEDENCE: avoided -> struggling -> coasting. This is a real
 * decision, not the order they happened to be written in.
 *
 * Avoided wins because engagement is upstream of everything else. A category
 * someone picks 2 tasks from out of 10 offered, and then fails one of them,
 * satisfies both "avoided" and "struggling" -- but telling that person "we've
 * eased your weekly target from 4 to 3" is answering a question they never
 * asked. Their target was never the obstacle; they aren't opening the
 * category at all. The useful move is to ask whether it still belongs in the
 * plan. Adjusting a number would also LOOK like the engine had handled it,
 * which is worse than doing nothing.
 */
export function classifyCategory(
  previous: CategoryPerformance | undefined,
  current: CategoryPerformance | undefined,
): Classification {
  if (!isObservable(previous) || !isObservable(current)) return "insufficient_data";

  if (avoided(previous) && avoided(current)) return "avoided";

  // Either arm may carry the signal, but whichever one does must carry it in
  // BOTH weeks -- completion below half last week and a slow pace this week
  // is two different bad weeks, not one consistent problem.
  if (
    (strugglingByCompletion(previous) && strugglingByCompletion(current)) ||
    (strugglingByPace(previous) && strugglingByPace(current))
  ) {
    return "struggling";
  }

  if (coasting(previous) && coasting(current)) return "coasting";

  return "on_track";
}

/** Which arm of the struggling rule fired, for building an honest reason string. */
export function strugglingArms(
  previous: CategoryPerformance,
  current: CategoryPerformance,
): { completion: boolean; pace: boolean } {
  return {
    completion: strugglingByCompletion(previous) && strugglingByCompletion(current),
    pace: strugglingByPace(previous) && strugglingByPace(current),
  };
}
