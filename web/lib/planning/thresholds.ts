// The numbers the weekly engine turns on, in one file, with the reasoning
// attached to each -- because a rules engine whose constants are scattered
// through its branches cannot be argued with, tuned, or audited.
//
// Every threshold here is evaluated over the TRAILING TWO WEEKS, never one.
// That is the single most important property of this engine: a person has a
// bad week for reasons that have nothing to do with their study plan (a
// deadline, a flu, a wedding), and an engine that rewrites their plan every
// time they do is worse than no engine. Two consecutive weeks is the cheapest
// evidence that something is actually structural.
//
// These values are STARTING POINTS chosen for defensibility, not tuned
// against real usage data -- there isn't any yet. decisions.md 2026-09-11
// records them as the first thing to revisit once there is.

/**
 * Below half of what you took on. Not "below target" -- below half of your
 * OWN choices, which is a much stronger signal than missing a number someone
 * else set. Strict `<`, so exactly 0.5 is not struggling: at exactly half,
 * the evidence does not say the plan is too heavy.
 */
export const STRUGGLING_COMPLETION_MAX = 0.5;

/**
 * 30% over the estimate. Strict `>`, so exactly 1.3 is not struggling.
 * Estimates are user/model-supplied and coarse; treating a 10% overrun as a
 * problem would fire constantly and mean nothing.
 */
export const STRUGGLING_PACE_MIN = 1.3;

/**
 * Coasting needs near-perfect completion AND real speed, together. Either one
 * alone is not evidence of an easy plan: finishing everything at a normal
 * pace is just a good week, and finishing things fast while dropping half of
 * them is a triage strategy, not spare capacity.
 * `>=` on completion (0.9 exactly IS coasting), strict `<` on pace (0.7
 * exactly is NOT).
 */
export const COASTING_COMPLETION_MIN = 0.9;
export const COASTING_PACE_MAX = 0.7;

/**
 * The menu kept offering it and it kept not getting picked. Strict `<`, so
 * exactly 0.3 is not avoided. Set low on purpose: this signal does not adjust
 * anything, it interrupts the user with a question, and a question asked on
 * thin evidence is worse than silence.
 */
export const AVOIDED_PICK_RATE_MAX = 0.3;

/**
 * Never add load in the same review as a bad week, even to an unrelated
 * category. Someone who completed under 40% of their plan does not need more
 * of anything -- and the category that looks like it has spare capacity is
 * very often the one they retreated into while avoiding the hard one.
 * Decreases are unaffected: easing off after a bad week is always allowed.
 *
 * A null plan-level completion (nothing picked at all that week) counts as
 * below the floor. There is no reading of "did nothing" that justifies more.
 */
export const LOW_COMPLETION_FLOOR = 0.4;

/** How far a single review moves a target: a quarter, up or down. */
export const ADJUSTMENT_STEP = 0.25;

/**
 * The hard rail: no proposal may move a target more than 30% of its current
 * value, OR one whole block, whichever is larger.
 *
 * The "or one whole block" half is not a loophole -- it is what makes the rail
 * implementable against integers. Real targets are small. At a target of 3,
 * one extra block is a 33% move, so a flat 30% rail would round every
 * proposal back to 3 and this engine would silently never adjust a 3-block
 * category in either direction. That dead zone is indistinguishable from "the
 * rules are broken". One block is the smallest expressible change; the
 * proportional rail is what binds once targets are large enough for it to
 * mean something (at a target of 10 it allows 7..13, not 9..11).
 *
 * `apply_weekly_plan_change()` (migrations/0022) enforces this exact rule
 * again in SQL, against the value actually being applied -- including a value
 * a user hand-edited. THE TWO MUST AGREE: if this file could propose a value
 * that function rejects, every such proposal would fail the moment someone
 * clicked accept.
 */
export const MAX_CHANGE_RATIO = 0.3;

/** A weekly target below this is a decision to stop, not a pace nudge. */
export const MIN_TARGET = 1;

/**
 * Apply the step, then the rail, then integer reality.
 *
 * Returns the target to propose, which may equal `base` -- meaning "there is
 * no change to make here". Callers must treat that as "propose nothing"
 * rather than writing a no-op change row; a change set full of 4 -> 4 rows is
 * noise the user has to read and dismiss.
 */
export function proposeTarget(base: number, direction: "increase" | "decrease"): number {
  const factor = direction === "increase" ? 1 + ADJUSTMENT_STEP : 1 - ADJUSTMENT_STEP;
  const stepped = Math.round(base * factor);

  const proportional = base * MAX_CHANGE_RATIO;
  const upperBound = Math.max(base + 1, Math.floor(base + proportional));
  const lowerBound = Math.min(base - 1, Math.ceil(base - proportional));

  const bounded =
    direction === "increase"
      ? Math.min(stepped, upperBound)
      : Math.max(stepped, lowerBound);

  return Math.max(MIN_TARGET, bounded);
}
