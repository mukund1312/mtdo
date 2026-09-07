export type DailyRollup = {
  blocks_done: number;
  computed_at: string;
  date: string;
  focus_seconds: number;
  sessions_completed: number;
};

/**
 * "Today" in the given IANA time zone (default UTC, matching every existing
 * call site until it's wired to a real value -- see below). The backend
 * counterpart is recompute_daily_rollups()'s and pick_curriculum_item()'s
 * coalesce(profiles.timezone, 'UTC') (migrations/0013, 0014); passing a
 * user's real profiles.timezone here is what keeps this screen's "today"
 * agreeing with what those functions already compute server-side. Not
 * wired to profiles.timezone yet -- that needs a profile read at the call
 * site (today-deck.tsx, progress-deck.tsx) and a settings UI to let a user
 * set it in the first place, neither of which exists yet. Deliberately kept
 * to the same function name/signature (an added optional parameter, not a
 * rename) so this change compiles against the existing call sites unchanged
 * until they're wired.
 *
 * toISOString() is unconditionally UTC and cannot express this -- en-CA's
 * locale format is the standard trick for "give me YYYY-MM-DD in this
 * time zone" without a date library.
 */
export function utcToday(timezone = "UTC"): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: timezone }).format(new Date());
}

/**
 * N consecutive calendar-date strings ending at `endDate`. Deliberately
 * takes no `timezone` parameter of its own: `endDate` (from utcToday(tz))
 * is already the correct calendar date in whatever zone matters, and this
 * is then pure calendar-day counting from that string -- zone-agnostic by
 * construction. It stays internally UTC-anchored (parses/formats at
 * T00:00:00.000Z) purely as an arbitrary, timezone-agnostic integer-day
 * counter, and must keep formatting in UTC too: formatting that anchor
 * instant in a *different* zone would shift the calendar day for any
 * negative-offset zone (verified: a UTC-midnight instant reformatted in
 * America/Los_Angeles lands on the previous calendar day), silently
 * reintroducing exactly the bug this whole change exists to close.
 */
export function utcDateRange(days: number, endDate = utcToday()): string[] {
  const end = new Date(`${endDate}T00:00:00.000Z`);
  return Array.from({ length: days }, (_, index) => {
    const date = new Date(end);
    date.setUTCDate(end.getUTCDate() - (days - 1 - index));
    return date.toISOString().slice(0, 10);
  });
}

/**
 * Heat intensity represents completed focus time only. The thresholds are
 * visible visual buckets (under 30m, 30m, 60m, 120m+), never a score.
 */
export function heatLevel(focusSeconds: number): 0 | 1 | 2 | 3 | 4 {
  if (focusSeconds <= 0) return 0;
  if (focusSeconds < 30 * 60) return 1;
  if (focusSeconds < 60 * 60) return 2;
  if (focusSeconds < 120 * 60) return 3;
  return 4;
}

export function formatDuration(totalSeconds: number): string {
  const minutes = Math.floor(Math.max(0, totalSeconds) / 60);
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  if (hours === 0) return `${remainingMinutes}m`;
  return `${hours}h ${remainingMinutes}m`;
}

export function formatShortDate(date: string): string {
  return new Intl.DateTimeFormat("en", { month: "short", day: "2-digit", timeZone: "UTC" })
    .format(new Date(`${date}T00:00:00.000Z`))
    .replace(",", "");
}
