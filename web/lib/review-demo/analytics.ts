import type { ReviewDemoDay } from "@/data/review-demo-data";

export function heatmapLevel(effortScore: number): 0 | 1 | 2 | 3 | 4 | 5 {
  if (effortScore <= 0) return 0;
  if (effortScore < 20) return 1;
  if (effortScore < 45) return 2;
  if (effortScore < 70) return 3;
  if (effortScore < 90) return 4;
  return 5;
}

export function activeDaysStats(days: ReviewDemoDay[]) {
  const activeCount = days.filter((d) => d.effortScore > 0).length;
  const activeDaysRate = Math.round((activeCount / days.length) * 100);

  let longest = 0;
  let running = 0;
  for (const d of days) {
    running = d.effortScore > 0 ? running + 1 : 0;
    longest = Math.max(longest, running);
  }

  let current = 0;
  for (let i = days.length - 1; i >= 0; i--) {
    if (days[i]!.effortScore > 0) current += 1;
    else break;
  }

  const lastWeek = days.slice(-7).filter((d) => d.effortScore > 0).length;
  const priorWeek = days.slice(-14, -7).filter((d) => d.effortScore > 0).length;
  const vsLastWeek = priorWeek === 0 ? 0 : Math.round(((lastWeek - priorWeek) / priorWeek) * 100);

  return { activeDaysRate, longestStreak: longest, currentStreak: current, vsLastWeek };
}

export function hourlyFocusDistribution(today: ReviewDemoDay): number[] {
  const buckets = new Array(24).fill(0);
  for (const s of today.sessions) {
    buckets[s.startHour % 24] += s.minutes;
  }
  return buckets;
}

export function sessionQualityBuckets(days: ReviewDemoDay[]) {
  const labels = ["< 15m", "15-30m", "30-45m", "45-60m", "60-90m", "90m+"];
  const counts = new Array(labels.length).fill(0);
  let total = 0;
  for (const day of days) {
    for (const s of day.sessions) {
      total += 1;
      if (s.minutes < 15) counts[0] += 1;
      else if (s.minutes < 30) counts[1] += 1;
      else if (s.minutes < 45) counts[2] += 1;
      else if (s.minutes < 60) counts[3] += 1;
      else if (s.minutes < 90) counts[4] += 1;
      else counts[5] += 1;
    }
  }
  const pct = counts.map((c) => (total === 0 ? 0 : Math.round((c / total) * 100)));
  return labels.map((label, i) => ({ label, pct: pct[i]! }));
}

export function sessionStats(days: ReviewDemoDay[]) {
  const allSessions = days.flatMap((d) => d.sessions.map((s) => s.minutes));
  if (allSessions.length === 0) return { averageMinutes: 0, longestMinutes: 0, completionPct: 0 };
  const averageMinutes = Math.round(allSessions.reduce((a, b) => a + b, 0) / allSessions.length);
  const longestMinutes = Math.max(...allSessions);
  const totalCompleted = days.reduce((sum, d) => sum + d.tasksCompleted, 0);
  const totalPlanned = days.reduce((sum, d) => sum + d.tasksPlanned, 0);
  const completionPct = totalPlanned === 0 ? 0 : Math.round((totalCompleted / totalPlanned) * 100);
  return { averageMinutes, longestMinutes, completionPct };
}

export function planVsRealityWeek(days: ReviewDemoDay[]) {
  const week = days.slice(-7);
  const planned = week.map((d) => d.plannedMinutes);
  const actual = week.map((d) => d.focusMinutes);
  const plannedTotal = planned.reduce((a, b) => a + b, 0);
  const actualTotal = actual.reduce((a, b) => a + b, 0);
  const accuracy = plannedTotal === 0 ? 0 : Math.max(0, 100 - Math.round((Math.abs(actualTotal - plannedTotal) / plannedTotal) * 100));
  return { planned, actual, plannedTotal, actualTotal, accuracy };
}

export function goalBalance(days: ReviewDemoDay[]) {
  const week = days.slice(-14);
  const totals = week.reduce(
    (sum, d) => ({
      backend: sum.backend + d.subjects.backend,
      dsa: sum.dsa + d.subjects.dsa,
      sql: sum.sql + d.subjects.sql,
      systemDesign: sum.systemDesign + d.subjects.systemDesign,
    }),
    { backend: 0, dsa: 0, sql: 0, systemDesign: 0 },
  );
  const grandTotal = totals.backend + totals.dsa + totals.sql + totals.systemDesign || 1;
  const pct = (v: number) => Math.round((v / grandTotal) * 100);
  return {
    actual: {
      backend: pct(totals.backend),
      dsa: pct(totals.dsa),
      sql: pct(totals.sql),
      systemDesign: pct(totals.systemDesign),
    },
    planned: { backend: 30, dsa: 35, sql: 20, systemDesign: 15 },
  };
}

export function formatMinutes(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (h === 0) return `${m}m`;
  return `${h}h ${m}m`;
}
