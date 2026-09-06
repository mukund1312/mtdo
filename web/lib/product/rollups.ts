import type { Database } from "@/lib/supabase/database.types";

export type DailyRollup = Pick<
  Database["public"]["Tables"]["daily_rollups"]["Row"],
  "date" | "blocks_done" | "focus_seconds" | "sessions_completed"
>;

export const ROLLUP_DAYS = 84;

export function localDateKey(date = new Date()) {
  const offset = date.getTimezoneOffset() * 60_000;
  return new Date(date.getTime() - offset).toISOString().slice(0, 10);
}

export function dateRange(end: string, count = ROLLUP_DAYS) {
  const cursor = new Date(`${end}T12:00:00`);
  return Array.from({ length: count }, (_, index) => {
    const date = new Date(cursor);
    date.setDate(cursor.getDate() - (count - index - 1));
    return localDateKey(date);
  });
}

export function rollupHeatLevel(rollup: DailyRollup | undefined) {
  if (!rollup) return 0;
  if (rollup.focus_seconds >= 90 * 60) return 4;
  if (rollup.focus_seconds >= 50 * 60) return 3;
  if (rollup.focus_seconds >= 25 * 60) return 2;
  if (rollup.focus_seconds > 0 || rollup.blocks_done > 0 || rollup.sessions_completed > 0) return 1;
  return 0;
}

export function formatRollupDuration(seconds: number) {
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  if (hours === 0) return `${minutes}m`;
  return `${hours}h${minutes ? ` ${minutes}m` : ""}`;
}
