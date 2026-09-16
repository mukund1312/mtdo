export const WEEKDAY_NAMES = ["", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];

export const DURATION_LABELS: Record<string, string> = {
  "<15m": "< 15m",
  "15-30m": "15–30m",
  "30-45m": "30–45m",
  "45-60m": "45–60m",
  "60-90m": "60–90m",
  "90m+": "90m+",
};

export function formatHour(hour: number): string {
  return `${String(hour).padStart(2, "0")}:00`;
}
