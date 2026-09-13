"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

import { createClient } from "@/lib/supabase/client";
import { asReviewConsistency, type ConsistencyDay } from "@/lib/review/types";

import { fetchProfileTimezone } from "./profile-timezone";
import { type DailyRollup, formatDuration, formatShortDate, utcDateRange, utcToday } from "./product-data";
import { WeeklyReviewPanel } from "./weekly-review";

const WINDOW_DAYS = 42;

export function ProgressDeck() {
  const [rollups, setRollups] = useState<DailyRollup[]>([]);
  // F3 of docs/designs/review-frontend-briefs.md: the heatmap's coloring
  // comes from review_consistency()'s server-computed Effort Score, never
  // client-side heatLevel(focus_seconds) anymore (migrations/0026, api.md
  // sec3k). The FOCUS TIME/6 WEEKS and LAST 7 DAYS panels below are
  // deliberately untouched -- still daily_rollups, not this phase's charter.
  const [consistencyDays, setConsistencyDays] = useState<ConsistencyDay[]>([]);
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
    setDates(windowDates);

    const [rollupsResult, consistencyResult] = await Promise.all([
      supabase
        .from("daily_rollups")
        .select("blocks_done, computed_at, date, focus_seconds, sessions_completed")
        .eq("user_id", user.id)
        .is("room_id", null)
        .gte("date", windowDates[0]!)
        .lte("date", windowDates.at(-1)!)
        .order("date", { ascending: true }),
      supabase.rpc("review_consistency", { p_start: windowDates[0]!, p_end: windowDates.at(-1)! }),
    ]);

    if (rollupsResult.error) {
      console.error("[progress] failed to load rollups:", rollupsResult.error);
      setState("error");
      return;
    }
    if (consistencyResult.error) {
      console.error("[progress] failed to load consistency:", consistencyResult.error);
      setState("error");
      return;
    }
    try {
      setConsistencyDays(asReviewConsistency(consistencyResult.data).days);
    } catch (parseError) {
      console.error("[progress] malformed consistency response:", parseError);
      setState("error");
      return;
    }
    setRollups(rollupsResult.data ?? []);
    setState("ready");
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(timer);
  }, [load]);

  const rollupByDate = useMemo(() => new Map(rollups.map((rollup) => [rollup.date, rollup])), [rollups]);
  const consistencyByDate = useMemo(
    () => new Map(consistencyDays.map((day) => [day.date, day])),
    [consistencyDays],
  );
  const totals = useMemo(() => rollups.reduce((sum, rollup) => ({
    blocks: sum.blocks + rollup.blocks_done,
    focusSeconds: sum.focusSeconds + rollup.focus_seconds,
    sessions: sum.sessions + rollup.sessions_completed,
  }), { blocks: 0, focusSeconds: 0, sessions: 0 }), [rollups]);
  const latestComputedAt = useMemo(() => rollups.map((rollup) => rollup.computed_at).sort().at(-1), [rollups]);
  const recentBars = useMemo(() => dates.slice(-7).map((date) => rollupByDate.get(date)?.focus_seconds ?? 0), [dates, rollupByDate]);
  const maxRecentFocus = Math.max(...recentBars, 1);

  return (
    <section className="a02-review" aria-labelledby="progress-title">
      {/* The "MAKE EFFORT LEGIBLE." hero now lives once, at the top of
          ReviewDeck (F1) -- this repeated it verbatim, which reads as a
          visible duplicate now that ReviewRings (F2) sits between the two.
          Kept the real controls (Refresh / View record), dropped only the
          redundant title. Found while building F2, not F2's own scope --
          flagged rather than left in place. */}
      <div className="a02-view-head">
        <span id="progress-title" className="a02-eyebrow">SIX-WEEK PULSE</span>
        <div className="a02-view-controls"><button type="button" onClick={() => void load()}>Refresh</button><button className="a02-export" type="button" onClick={() => setRecordOpen(true)} disabled={state !== "ready"}>View record ↗</button></div>
      </div>

      {state === "error" ? <section className="a02-product-state" role="alert"><b>Progress is unavailable.</b><p>We could not read your recorded activity. Nothing has been changed.</p><button type="button" onClick={() => void load()}>Try again ↗</button></section> : <div className={`a02-review-grid ${state === "loading" ? "is-loading" : ""}`} aria-busy={state === "loading"}>
        <section className="a02-heat">
          <header><b>CONSISTENCY</b><span>LOW <i /> HIGH</span></header>
          <div aria-label="Six-week consistency heatmap">
            {dates.map((date) => {
              const day = consistencyByDate.get(date);
              const level = state === "loading" ? null : day?.level ?? null;
              const pct = (value: number | null | undefined) => (value == null ? "—" : `${value}%`);
              const label =
                level === null
                  ? `${formatShortDate(date)} · no goal set yet`
                  : `${formatShortDate(date)} · effort ${day?.effort_score ?? 0} · focus ${pct(day?.focus_percentage)} · execute ${pct(day?.execute_percentage)} · progress ${pct(day?.progress_percentage)}`;
              return (
                <i
                  className={level === null ? "level-none" : `level-${level}`}
                  key={date}
                  title={label}
                  aria-label={label}
                />
              );
            })}
          </div>
          <footer>{formatShortDate(dates[0]!)} <span>{formatShortDate(dates.at(-1)!)}</span></footer>
          {state === "ready" && consistencyDays.every((day) => day.level === null) && (
            <p className="a02-heat-empty">Set up your route first, then return here for its first useful piece.</p>
          )}
        </section>
        <section className="a02-score">
          <span>FOCUS TIME / 6 WEEKS</span>
          <strong>{state === "loading" ? "…" : formatDuration(totals.focusSeconds)}</strong>
          <p>{state === "loading" ? "Reading your recorded sessions." : `${totals.sessions} completed sessions · ${totals.blocks} blocks recorded`}</p>
          {latestComputedAt && <i>Updated {new Intl.DateTimeFormat("en", { hour: "numeric", minute: "2-digit", timeZone: "UTC" }).format(new Date(latestComputedAt))} UTC</i>}
        </section>
        <section className="a02-trajectory">
          <span>LAST 7 DAYS / FOCUS TIME</span>
          <div className="a02-line-graph" aria-label="Last seven days of focus time">
            {recentBars.map((seconds, index) => <i key={dates.at(-7 + index)} style={{ height: `${state === "loading" ? 24 : seconds === 0 ? 4 : Math.max(12, Math.round((seconds / maxRecentFocus) * 100))}%` }} title={`${Math.floor(seconds / 60)} focused minutes`} />)}
          </div>
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
