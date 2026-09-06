"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { createClient } from "@/lib/supabase/client";
import type { Database } from "@/lib/supabase/database.types";
import "./progress.css";

type DailyRollup = Pick<
  Database["public"]["Tables"]["daily_rollups"]["Row"],
  "date" | "blocks_done" | "focus_seconds" | "sessions_completed"
>;

const DAYS_TO_SHOW = 84;

function localDateKey(date = new Date()) {
  const offset = date.getTimezoneOffset() * 60_000;
  return new Date(date.getTime() - offset).toISOString().slice(0, 10);
}

function dateRange(end: string, count: number) {
  const cursor = new Date(`${end}T12:00:00`);
  return Array.from({ length: count }, (_, index) => {
    const date = new Date(cursor);
    date.setDate(cursor.getDate() - (count - index - 1));
    return localDateKey(date);
  });
}

function formatDuration(seconds: number) {
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  if (hours === 0) return `${minutes}m`;
  return `${hours}h${minutes ? ` ${minutes}m` : ""}`;
}

function formatDay(date: string) {
  return new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" }).format(new Date(`${date}T12:00:00`));
}

function heatLevel(rollup: DailyRollup | undefined) {
  if (!rollup) return 0;
  if (rollup.focus_seconds >= 90 * 60) return 4;
  if (rollup.focus_seconds >= 50 * 60) return 3;
  if (rollup.focus_seconds >= 25 * 60) return 2;
  if (rollup.focus_seconds > 0 || rollup.blocks_done > 0 || rollup.sessions_completed > 0) return 1;
  return 0;
}

export default function ProgressPage() {
  const endDate = useMemo(() => localDateKey(), []);
  const days = useMemo(() => dateRange(endDate, DAYS_TO_SHOW), [endDate]);
  const startDate = days[0] ?? endDate;
  const configured = Boolean(process.env.NEXT_PUBLIC_SUPABASE_URL && process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY);
  const [rollups, setRollups] = useState<DailyRollup[]>([]);
  const [loading, setLoading] = useState(true);
  const [message, setMessage] = useState<string | null>(null);

  const loadProgress = useCallback(async () => {
    if (!configured) {
      setMessage("Connect Supabase to view your progress record.");
      setLoading(false);
      return;
    }
    setLoading(true);
    setMessage(null);
    const supabase = createClient();
    const { data, error } = await supabase
      .from("daily_rollups")
      .select("date, blocks_done, focus_seconds, sessions_completed")
      .is("room_id", null)
      .gte("date", startDate)
      .lte("date", endDate)
      .order("date");
    if (error) {
      setMessage(error.message);
      setLoading(false);
      return;
    }
    setRollups((data ?? []) as DailyRollup[]);
    setLoading(false);
  }, [configured, endDate, startDate]);

  useEffect(() => {
    const loadTimer = window.setTimeout(() => void loadProgress(), 0);
    return () => window.clearTimeout(loadTimer);
  }, [loadProgress]);

  const rollupByDate = useMemo(() => new Map(rollups.map((rollup) => [rollup.date, rollup])), [rollups]);
  const totalFocusSeconds = rollups.reduce((total, rollup) => total + rollup.focus_seconds, 0);
  const totalBlocks = rollups.reduce((total, rollup) => total + rollup.blocks_done, 0);
  const totalSessions = rollups.reduce((total, rollup) => total + rollup.sessions_completed, 0);
  const activeDays = rollups.filter((rollup) => heatLevel(rollup) > 0).length;
  const hasRollups = rollups.length > 0;

  return <main className="progressPage">
    <header className="progressNav"><Link href="/" aria-label="MTDO home">mtdo</Link><span>Progress record</span><Link href="/session">Focus session ↗</Link></header>
    <section className="progressShell">
      <div className="progressHeading">
        <div><p className="progressKicker">YOUR LAST 12 WEEKS</p><h1>What you<br /><em>returned</em> to.</h1><p>A record for noticing what helps—not another score to chase.</p></div>
        <button type="button" onClick={() => void loadProgress()} disabled={loading}>{loading ? "Reading record…" : "Refresh"}</button>
      </div>

      {message && <p className="progressNotice" role="status">{message}</p>}
      <section className="heatmapSurface" aria-labelledby="heatmap-title">
        <header><div><p className="progressKicker">FOCUS FREQUENCY</p><h2 id="heatmap-title">Your days, without the theater.</h2></div><p className="heatLegend"><span>Less</span><i /><i /><i /><i /><i /><span>More</span></p></header>
        <div className={`heatmapGrid ${loading ? "isLoading" : ""}`} role="img" aria-label={`Focus activity from ${formatDay(startDate)} to ${formatDay(endDate)}`}>
          {days.map((date) => {
            const rollup = rollupByDate.get(date);
            const level = heatLevel(rollup);
            const label = rollup ? `${formatDay(date)}: ${formatDuration(rollup.focus_seconds)} focus, ${rollup.blocks_done} blocks completed, ${rollup.sessions_completed} sessions.` : `${formatDay(date)}: no recorded activity.`;
            return <span className={`heatCell level${level}`} aria-hidden="true" data-tooltip={label} key={date} />;
          })}
        </div>
        <footer><span>{formatDay(startDate)}</span><span>{formatDay(endDate)}</span></footer>
      </section>

      {!loading && !hasRollups && configured && <section className="progressEmpty"><p className="progressKicker">RECORD PENDING</p><h2>Your grid is ready.</h2><p>Daily rollups have not been computed yet, so there is nothing honest to show. This will fill from completed focus sessions and blocks once the recompute job is live.</p></section>}

      <section className="progressTotals" aria-label="Progress totals for the current period"><div><span>FOCUS TIME</span><b className="num">{formatDuration(totalFocusSeconds)}</b></div><div><span>BLOCKS FINISHED</span><b className="num">{totalBlocks}</b></div><div><span>SESSIONS HELD</span><b className="num">{totalSessions}</b></div><div><span>DAYS RETURNED</span><b className="num">{activeDays}</b></div></section>
      <p className="progressFootnote">Record Card export is intentionally pending a product decision on format.</p>
    </section>
  </main>;
}
