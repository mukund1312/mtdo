"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

import { createClient } from "@/lib/supabase/client";

import { fetchProfileTimezone } from "./profile-timezone";
import { type DailyRollup, formatDuration, formatShortDate, heatLevel, utcDateRange, utcToday } from "./product-data";
import { WeeklyReviewPanel } from "./weekly-review";

const WINDOW_DAYS = 42;
const WEEKDAY_LABELS = ["MON", "TUE", "WED", "THU", "FRI", "SAT", "SUN"];

type HeatmapWeek = { monthLabel: string | null; dates: Array<string | null> };

function buildHeatmapWeeks(dates: string[]): HeatmapWeek[] {
  if (dates.length === 0) return [];
  const first = new Date(`${dates[0]}T00:00:00.000Z`);
  first.setUTCDate(first.getUTCDate() - ((first.getUTCDay() + 6) % 7));
  const last = new Date(`${dates.at(-1)}T00:00:00.000Z`);
  const included = new Set(dates);
  const weeks: HeatmapWeek[] = [];
  let previousMonth = -1;
  for (let weekStart = new Date(first); weekStart <= last; weekStart.setUTCDate(weekStart.getUTCDate() + 7)) {
    const month = weekStart.getUTCMonth();
    const monthLabel = month !== previousMonth
      ? new Intl.DateTimeFormat("en", { month: "short", timeZone: "UTC" }).format(weekStart).toUpperCase()
      : null;
    previousMonth = month;
    weeks.push({
      monthLabel,
      dates: Array.from({ length: 7 }, (_, day) => {
        const date = new Date(weekStart);
        date.setUTCDate(date.getUTCDate() + day);
        const iso = date.toISOString().slice(0, 10);
        return included.has(iso) ? iso : null;
      }),
    });
  }
  return weeks;
}

export function ProgressDeck() {
  const [rollups, setRollups] = useState<DailyRollup[]>([]);
  const [previousRollups, setPreviousRollups] = useState<DailyRollup[]>([]);
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");
  const [recordOpen, setRecordOpen] = useState(false);
  // Recomputed on every load() -- see the comment there on why the window
  // can't be memoized off an empty-dependency utcToday() call the way it
  // was before this was wired to a per-user zone.
  const [dates, setDates] = useState(() => utcDateRange(WINDOW_DAYS));

  const load = useCallback(async () => {
    setState("loading");
    const supabase = createClient();
    const {
      data: { user },
      error: userError,
    } = await supabase.auth.getUser();
    if (userError || !user) {
      setState("error");
      return;
    }

    // Same reasoning as today-deck.tsx: this screen's "today" (the end of
    // the 42-day window) has to agree with the zone recompute_daily_rollups()
    // actually bucketed each row into (migrations/0013), or the window could
    // clip off a day that has a real row sitting just outside it.
    const userTimezone = await fetchProfileTimezone(supabase, user.id);
    const windowDates = utcDateRange(WINDOW_DAYS, utcToday(userTimezone));
    const previousWindowEnd = new Date(`${windowDates[0]}T00:00:00.000Z`);
    previousWindowEnd.setUTCDate(previousWindowEnd.getUTCDate() - 1);
    const previousDates = utcDateRange(WINDOW_DAYS, previousWindowEnd.toISOString().slice(0, 10));
    setDates(windowDates);

    const { data, error } = await supabase
      .from("daily_rollups")
      .select("blocks_done, computed_at, date, focus_seconds, sessions_completed")
      .eq("user_id", user.id)
      .is("room_id", null)
      .gte("date", previousDates[0]!)
      .lte("date", windowDates.at(-1)!)
      .order("date", { ascending: true });

    if (error) {
      console.error("[progress] failed to load rollups:", error);
      setState("error");
      return;
    }
    const rows = data ?? [];
    setRollups(rows.filter((rollup) => rollup.date >= windowDates[0]!));
    setPreviousRollups(rows.filter((rollup) => rollup.date < windowDates[0]!));
    setState("ready");
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(timer);
  }, [load]);

  const rollupByDate = useMemo(() => new Map(rollups.map((rollup) => [rollup.date, rollup])), [rollups]);
  const heatmapWeeks = useMemo(() => buildHeatmapWeeks(dates), [dates]);
  const totals = useMemo(() => rollups.reduce((sum, rollup) => ({
    blocks: sum.blocks + rollup.blocks_done,
    focusSeconds: sum.focusSeconds + rollup.focus_seconds,
    sessions: sum.sessions + rollup.sessions_completed,
  }), { blocks: 0, focusSeconds: 0, sessions: 0 }), [rollups]);
  const previousTotals = useMemo(() => previousRollups.reduce((sum, rollup) => ({
    blocks: sum.blocks + rollup.blocks_done,
    focusSeconds: sum.focusSeconds + rollup.focus_seconds,
    sessions: sum.sessions + rollup.sessions_completed,
  }), { blocks: 0, focusSeconds: 0, sessions: 0 }), [previousRollups]);
  const focusChange = previousTotals.focusSeconds > 0 ? Math.round(((totals.focusSeconds - previousTotals.focusSeconds) / previousTotals.focusSeconds) * 100) : null;
  const latestComputedAt = useMemo(() => rollups.map((rollup) => rollup.computed_at).sort().at(-1), [rollups]);
  const recentBars = useMemo(() => dates.slice(-7).map((date) => rollupByDate.get(date)?.focus_seconds ?? 0), [dates, rollupByDate]);
  const maxRecentFocus = Math.max(...recentBars, 1);
  const recentPeakMinutes = Math.ceil(maxRecentFocus / 60);
  const chartMaxMinutes = Math.max(60, Math.ceil(recentPeakMinutes / 20) * 20);
  const chartTicks = [chartMaxMinutes, Math.round(chartMaxMinutes * 2 / 3), Math.round(chartMaxMinutes / 3), 0];
  const recentDates = dates.slice(-7);

  return (
    <section className="a02-review" aria-labelledby="progress-title">
      <div className="a02-view-head">
        <div>
          <span className="a02-eyebrow">REVIEW / 6-WEEK PULSE</span>
          <h1 id="progress-title">Make effort<br /><em>legible.</em></h1>
          <p className="a02-review-summary" aria-live="polite">{state === "loading" ? "Reading your recorded activity…" : `${totals.sessions} session${totals.sessions === 1 ? "" : "s"} · ${totals.blocks} block${totals.blocks === 1 ? "" : "s"} · ${formatDuration(totals.focusSeconds)} focused`}</p>
        </div>
        <div className="a02-view-controls"><button type="button" onClick={() => void load()}>Refresh</button><button className="a02-export" type="button" onClick={() => setRecordOpen(true)} disabled={state !== "ready"}>View record ↗</button></div>
      </div>

      {state === "error" ? <section className="a02-product-state" role="alert"><b>Progress is unavailable.</b><p>We could not read your recorded activity. Nothing has been changed.</p><button type="button" onClick={() => void load()}>Try again ↗</button></section> : <div className={`a02-review-grid ${state === "loading" ? "is-loading" : ""}`} aria-busy={state === "loading"}>
        <section className="a02-heat">
          <header><b>FOCUS FREQUENCY</b><span>6 WEEKS</span></header>
          <div className="a02-contribution-map" aria-label="Six-week focus heatmap">
            <div className="a02-contribution-months" aria-hidden="true" style={{ gridTemplateColumns: `28px repeat(${heatmapWeeks.length}, 34px)` }}><i />{heatmapWeeks.map((week, index) => <span key={`${week.monthLabel ?? "week"}-${index}`}>{week.monthLabel}</span>)}</div>
            <div className="a02-contribution-body"><div className="a02-contribution-weekdays" aria-hidden="true">{WEEKDAY_LABELS.map((day) => <span key={day}>{day}</span>)}</div><div className="a02-contribution-cells" style={{ gridTemplateColumns: `repeat(${heatmapWeeks.length}, 34px)` }}>{heatmapWeeks.flatMap((week, weekIndex) => week.dates.map((date, dayIndex) => {
              if (!date) return <i className="is-outside" key={`outside-${weekIndex}-${dayIndex}`} aria-hidden="true" />;
              const rollup = rollupByDate.get(date);
              const minutes = Math.floor((rollup?.focus_seconds ?? 0) / 60);
              const sessions = rollup?.sessions_completed ?? 0;
              const blocks = rollup?.blocks_done ?? 0;
              const tooltip = `${formatShortDate(date)} · ${minutes} min focused · ${sessions} ${sessions === 1 ? "session" : "sessions"} · ${blocks} ${blocks === 1 ? "block" : "blocks"}`;
              return <button className={`a02-contribution-cell level-${state === "loading" ? 0 : heatLevel(rollup?.focus_seconds ?? 0)}`} key={date} type="button" data-tooltip={tooltip} aria-label={tooltip} />;
            }))}</div></div>
          </div>
          <footer className="a02-contribution-legend"><span>LESS</span><i className="level-0" /><i className="level-1" /><i className="level-2" /><i className="level-4" /><span>MORE</span></footer>
          {state === "ready" && rollups.length === 0 && <p className="a02-heat-empty">No recorded focus in this window yet. Your grid will fill from completed or ended sessions.</p>}
        </section>
        <section className="a02-score">
          <span>FOCUS TIME / 6 WEEKS</span>
          <strong>{state === "loading" ? "…" : formatDuration(totals.focusSeconds)}</strong>
          <p>{state === "loading" ? "Reading your recorded sessions." : `${totals.sessions} completed sessions · ${totals.blocks} blocks recorded`}</p>
          {state === "ready" && <i className={`a02-score-trend ${focusChange === null ? "is-neutral" : focusChange >= 0 ? "is-up" : "is-down"}`}>{focusChange === null ? (totals.focusSeconds > 0 ? "New focus activity" : "No prior focus activity") : `${focusChange >= 0 ? "↑" : "↓"} ${Math.abs(focusChange)}% vs previous 6 weeks`}</i>}
          {latestComputedAt && <i>Last updated {new Intl.DateTimeFormat("en", { hour: "numeric", minute: "2-digit" }).format(new Date(latestComputedAt))}</i>}
        </section>
        <section className="a02-trajectory">
          <span>FOCUS TIME / LAST 7 DAYS</span>
          <div className="a02-focus-chart" aria-label="Last seven days of focus time">
            <div className="a02-focus-chart-axis" aria-hidden="true">{chartTicks.map((tick) => <span key={tick}>{tick}m</span>)}</div>
            <div className="a02-focus-chart-plot">{recentBars.map((seconds, index) => {
              const minutes = Math.floor(seconds / 60);
              const day = new Intl.DateTimeFormat("en", { weekday: "short", timeZone: "UTC" }).format(new Date(`${recentDates[index]}T00:00:00.000Z`)).toUpperCase();
              const tooltip = `${day} · ${minutes} min`;
              return <i className={index === recentBars.length - 1 ? "is-today" : ""} key={recentDates[index]} style={{ height: `${state === "loading" ? 24 : Math.max(0, Math.min(100, (seconds / 60 / chartMaxMinutes) * 100))}%` }} data-tooltip={tooltip} aria-label={tooltip} />;
            })}</div>
          </div>
          <div className="a02-focus-chart-days" aria-hidden="true">{recentDates.map((date) => <span key={date}>{new Intl.DateTimeFormat("en", { weekday: "narrow", timeZone: "UTC" }).format(new Date(`${date}T00:00:00.000Z`))}</span>)}</div>
          <p>{state === "loading" ? "Loading recorded activity." : totals.focusSeconds === 0 ? "No completed focus time recorded yet." : "Focus time is measured from settled sessions."}</p>
        </section>
      </div>}

      {recordOpen && <RecordCard rollups={rollups} totals={totals} onClose={() => setRecordOpen(false)} />}

      {/* Phase 7 frontend: the deterministic weekly engine's real numbers and
          change-review screen, built against PR #153's merged backend
          contract (docs/architecture/api.md §3f/§3g). Self-contained --
          fetches and manages its own state independently of the 6-week pulse
          above, the same "each deck section owns its own load()" pattern
          HomeDeck/ProgressDeck already use. */}
      <WeeklyReviewPanel />
    </section>
  );
}

function RecordCard({ rollups, totals, onClose }: { rollups: DailyRollup[]; totals: { blocks: number; focusSeconds: number; sessions: number }; onClose: () => void }) {
  const activeDays = rollups.filter((rollup) => rollup.focus_seconds > 0 || rollup.sessions_completed > 0 || rollup.blocks_done > 0).length;

  return <section className="a02-record-overlay" role="dialog" aria-modal="true" aria-labelledby="record-card-title">
    <div className="a02-record-dialog">
      <button className="a02-lens-close" type="button" onClick={onClose}>ESC / close ×</button>
      <article className="a02-record-card">
        <span>MTDO / PERSONAL RECORD</span>
        <h2 id="record-card-title">The work<br /><em>is real.</em></h2>
        <p>A six-week record assembled from settled sessions and completed blocks.</p>
        <dl><div><dt>FOCUS TIME</dt><dd>{formatDuration(totals.focusSeconds)}</dd></div><div><dt>SESSIONS</dt><dd>{totals.sessions}</dd></div><div><dt>ACTIVE DAYS</dt><dd>{activeDays}</dd></div><div><dt>BLOCKS DONE</dt><dd>{totals.blocks}</dd></div></dl>
        <footer>MTDO / SIGNAL DECK / UTC RECORD</footer>
      </article>
    </div>
  </section>;
}
