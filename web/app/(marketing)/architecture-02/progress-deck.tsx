"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import {
  dateRange,
  formatRollupDuration,
  localDateKey,
  rollupHeatLevel,
  type DailyRollup,
} from "@/lib/product/rollups";
import "./v1.css";

function displayDay(date: string) {
  return new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" }).format(new Date(`${date}T12:00:00`));
}

export function ProgressDeck() {
  const endDate = useMemo(() => localDateKey(), []);
  const days = useMemo(() => dateRange(endDate), [endDate]);
  const startDate = days[0] ?? endDate;
  const configured = Boolean(process.env.NEXT_PUBLIC_SUPABASE_URL && process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY);
  const [rollups, setRollups] = useState<DailyRollup[]>([]);
  const [loading, setLoading] = useState(true);
  const [message, setMessage] = useState<string | null>(null);

  const load = useCallback(async () => {
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
    const timer = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(timer);
  }, [load]);

  const byDate = useMemo(() => new Map(rollups.map((rollup) => [rollup.date, rollup])), [rollups]);
  const focusSeconds = rollups.reduce((total, rollup) => total + rollup.focus_seconds, 0);
  const blocksDone = rollups.reduce((total, rollup) => total + rollup.blocks_done, 0);
  const sessions = rollups.reduce((total, rollup) => total + rollup.sessions_completed, 0);
  const activeDays = rollups.filter((rollup) => rollupHeatLevel(rollup) > 0).length;
  const hasData = rollups.length > 0;

  return <section className="a02v1Screen a02Progress" aria-label="Progress record">
    <div className="a02v1Head"><div><p className="a02v1Kicker">PROGRESS / LAST 12 WEEKS</p><h1>What you<br /><em>returned</em> to.</h1><p>A record for noticing what helps—not another score to chase.</p></div><button className="a02v1Pill" type="button" onClick={() => void load()} disabled={loading}>{loading ? "Reading record…" : "Refresh"}</button></div>
    {message && <p className="a02v1Notice" role="status">{message}</p>}
    <section className="a02Heatmap" aria-labelledby="a02-heatmap-title"><header><div><p className="a02v1Kicker">FOCUS FREQUENCY</p><h2 id="a02-heatmap-title">Your days, without the theater.</h2></div><p className="a02HeatLegend"><span>Less</span><i /><i /><i /><i /><i /><span>More</span></p></header><div className={`a02HeatGrid ${loading ? "isLoading" : ""}`} role="img" aria-label={`Focus activity from ${displayDay(startDate)} to ${displayDay(endDate)}`}>{days.map((date) => <span className={`level${rollupHeatLevel(byDate.get(date))}`} aria-hidden="true" key={date} />)}</div><footer><span>{displayDay(startDate)}</span><span>{displayDay(endDate)}</span></footer></section>
    {!loading && !hasData && configured && <section className="a02v1Empty"><p className="a02v1Kicker">RECORD PENDING</p><h2>Your grid is ready.</h2><p>Daily rollups have not been computed yet, so there is nothing honest to show. It will fill from completed focus sessions and blocks once the recompute job is live.</p></section>}
    <section className="a02ProgressTotals" aria-label="Progress totals"><div><span>FOCUS TIME</span><b className="num">{formatRollupDuration(focusSeconds)}</b></div><div><span>BLOCKS FINISHED</span><b className="num">{blocksDone}</b></div><div><span>SESSIONS HELD</span><b className="num">{sessions}</b></div><div><span>DAYS RETURNED</span><b className="num">{activeDays}</b></div></section>
    <section className="a02RecordCard" aria-label="Record Card preview"><div><p className="a02v1Kicker">RECORD CARD / PREVIEW</p><h2>A quieter kind<br />of proof.</h2><p>{hasData ? `${formatRollupDuration(focusSeconds)} of attention, held across ${activeDays} days.` : "Your first record will appear when derived progress data is available."}</p><footer><span>MTDO / YOUR RECORD</span><b className="num">{blocksDone}</b><span>blocks finished</span></footer></div><aside><span>Export format</span><b>Awaiting product decision</b><p>Image, link, or PDF has not been chosen, so no export action is shown.</p></aside></section>
  </section>;
}
