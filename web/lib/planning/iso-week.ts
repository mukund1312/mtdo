// ISO-8601 week helpers, in the exact 'YYYY-Www' text format the schema
// already uses everywhere (plan_categories.menu_unlocked_iso_week from 0012,
// weekly_plans.iso_week from 0022).
//
// THESE MUST AGREE WITH `public.iso_week_start()` (migrations/0021) EXACTLY.
// Both are built on the same definition -- "January 4th is always in ISO week
// 1" -- rather than on any library's or any database's week-numbering
// options, because that anchor is the standard itself and is correct for
// 53-week years and across year boundaries without special cases.
// `iso-week.test.ts` pins the boundary years the two have to agree on.

const DAY_MS = 86_400_000;

function utcDate(year: number, month: number, day: number): Date {
  return new Date(Date.UTC(year, month, day));
}

/** Monday of the ISO week containing `d`, as a UTC-midnight Date. */
function mondayOf(d: Date): Date {
  // getUTCDay: Sunday = 0. ISO wants Monday = 1 .. Sunday = 7.
  const isoDow = d.getUTCDay() === 0 ? 7 : d.getUTCDay();
  return new Date(d.getTime() - (isoDow - 1) * DAY_MS);
}

/** The ISO week string for a date, e.g. "2026-W37". */
export function isoWeekOf(d: Date): string {
  const monday = mondayOf(new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())));
  // The ISO year is the year of the Thursday in that week -- that is what
  // makes a late-December week correctly belong to the next year, and an
  // early-January week to the previous one.
  const thursday = new Date(monday.getTime() + 3 * DAY_MS);
  const isoYear = thursday.getUTCFullYear();
  const week1Monday = mondayOf(utcDate(isoYear, 0, 4));
  const week = Math.round((monday.getTime() - week1Monday.getTime()) / (7 * DAY_MS)) + 1;
  return `${isoYear}-W${String(week).padStart(2, "0")}`;
}

export function isValidIsoWeek(value: string): boolean {
  if (!/^\d{4}-W\d{2}$/.test(value)) return false;
  const week = Number(value.slice(6));
  return week >= 1 && week <= 53;
}

/** Monday of the given ISO week, as a UTC-midnight Date. Mirrors iso_week_start() in SQL. */
export function isoWeekStart(isoWeek: string): Date {
  if (!isValidIsoWeek(isoWeek)) {
    throw new RangeError(`${isoWeek} is not an ISO week of the form YYYY-Www`);
  }
  const year = Number(isoWeek.slice(0, 4));
  const week = Number(isoWeek.slice(6));
  return new Date(mondayOf(utcDate(year, 0, 4)).getTime() + (week - 1) * 7 * DAY_MS);
}

export function previousIsoWeek(isoWeek: string): string {
  return isoWeekOf(new Date(isoWeekStart(isoWeek).getTime() - 7 * DAY_MS));
}

export function nextIsoWeek(isoWeek: string): string {
  return isoWeekOf(new Date(isoWeekStart(isoWeek).getTime() + 7 * DAY_MS));
}

/**
 * Today's date in a named zone, as a UTC-midnight Date -- the same
 * "local date, then treat it as a plain date" move `utcToday(timezone)`
 * already makes for the Today and Progress decks.
 *
 * An unknown or unset zone falls back to UTC rather than throwing, matching
 * `coalesce(profiles.timezone, 'UTC')` everywhere in SQL. profiles.timezone
 * is validated on write (0013), so a bad value here means something already
 * went wrong upstream and the review should still render.
 */
export function todayInZone(timezone: string | null | undefined, now: Date = new Date()): Date {
  const zone = timezone ?? "UTC";
  try {
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone: zone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(now);
    const [y, m, d] = parts.split("-").map(Number) as [number, number, number];
    return utcDate(y, m - 1, d);
  } catch {
    return utcDate(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  }
}

/**
 * The week a review should cover by default: the most recently COMPLETED
 * week, not the one the user is still living in. Reviewing a week in progress
 * would classify on partial data and call every category struggling by
 * Tuesday.
 */
export function defaultReviewWeek(timezone: string | null | undefined, now: Date = new Date()): string {
  const today = todayInZone(timezone, now);
  return isoWeekOf(new Date(today.getTime() - 7 * DAY_MS));
}
