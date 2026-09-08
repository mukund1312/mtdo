// Read-time streak derivation (Phase 1 of the operating-engine plan) --
// deliberately NOT a new column. daily_rollups is the ledger-derived source
// of truth (schema.md §4); a streak is a property computed from it at read
// time, the same way this file's own utcToday()/heatLevel() are computed,
// not a mutable counter that could drift from the rows underneath it.
//
// Approximates src/mtdo/core.py's compute_day_streaks(), which defines a
// streak day as "100% of that day's own blocks completed" against the
// terminal app's full per-block state. daily_rollups only stores the daily
// aggregate (blocks_done, focus_seconds, sessions_completed), not a
// per-block completion ratio, so there is no way to reconstruct "100%" from
// it -- the closest honest equivalent available here is "did anything real
// happen this day," i.e. blocks_done > 0. This is a real, documented
// approximation, not a silent behavior change: a day with 1 of 5 blocks
// done counts as an active day here but would not count under core.py's
// stricter definition.

export type StreakRollup = { blocks_done: number; date: string };

export type Streaks = { current: number; longest: number };

function isActiveDay(rollup: StreakRollup | undefined): boolean {
  return (rollup?.blocks_done ?? 0) > 0;
}

function addDays(date: string, delta: number): string {
  const d = new Date(`${date}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + delta);
  return d.toISOString().slice(0, 10);
}

/** Current & longest streak of active days, derived from a window of
 * daily_rollups rows. `today` is the caller's own local "today" (from
 * utcToday(timezone), see product-data.ts) so this agrees with whatever
 * date the rest of the screen is treating as "today." `rollups` should
 * cover at least the `windowDays` before `today` for `longest` to be
 * accurate -- a shorter window still produces a correct `current`, just a
 * `longest` capped by however much history was actually passed in.
 *
 * current: walks back from yesterday (today itself is deliberately
 * excluded -- a streak should not visibly reset to 0 first thing in the
 * morning before today's own work happens) over consecutive active days.
 * longest: rescans the full window for the longest run of consecutive
 * active days, including a currently-running streak that reaches into
 * today. */
export function computeStreaks(rollups: StreakRollup[], today: string, windowDays = 120): Streaks {
  const byDate = new Map(rollups.map((rollup) => [rollup.date, rollup]));

  let current = 0;
  let cursor = addDays(today, -1);
  for (let i = 0; i < windowDays; i++) {
    if (!isActiveDay(byDate.get(cursor))) break;
    current += 1;
    cursor = addDays(cursor, -1);
  }

  let longest = 0;
  let running = 0;
  cursor = addDays(today, -windowDays);
  const end = addDays(today, 1);
  while (cursor !== end) {
    if (isActiveDay(byDate.get(cursor))) {
      running += 1;
      longest = Math.max(longest, running);
    } else {
      running = 0;
    }
    cursor = addDays(cursor, 1);
  }

  return { current, longest: Math.max(longest, current) };
}
