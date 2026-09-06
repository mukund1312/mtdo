export type DailyRollup = {
  blocks_done: number;
  computed_at: string;
  date: string;
  focus_seconds: number;
  sessions_completed: number;
};

/** The product has no per-user time zone yet, so Today and Progress use UTC. */
export function utcToday(): string {
  return new Date().toISOString().slice(0, 10);
}

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
