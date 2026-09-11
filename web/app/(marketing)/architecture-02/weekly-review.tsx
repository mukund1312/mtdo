"use client";

// The weekly engine's frontend (Phase 7 frontend, operating-engine plan).
// Built directly against PR #153's merged backend contract (docs/architecture/
// api.md §3f/§3g, schema.md's weekly_plans/weekly_plan_changes) -- no schema/
// RLS/RPC touched here, and web/lib/planning/** is read-only from this file:
// classification and proposal-building are re-derived by calling
// buildWeeklyProposal() again against the SAME frozen metrics snapshot
// weekly_plans.metrics stores (that function is pure -- same two weeks of
// numbers always produce the same outcomes, api.md's own words), rather than
// duplicating that logic here or inventing a second copy of it.
//
// WHY outcomes[] ISN'T READ OFF THE GENERATE RESPONSE ALONE: only weekly_plan_changes
// ROWS are persisted (one per actual change); the "we looked at this category and it
// was fine / insufficient data" entries are not stored anywhere. Re-running
// buildWeeklyProposal() against the persisted metrics on every load reconstructs
// that list for free and deterministically, so a reload never loses the "on
// track" / "insufficient data" categories the brief requires rendering.
//
// THE flag_question SPECIAL CASE (api.md §3g, decisions.md 2026-09-11): an
// `avoided` signal produces a change_type of "flag_question", never a numeric
// change -- it carries no old_value/new_value (DB-constrained), and
// accept_all_weekly_plan_changes() skips these rows structurally. This file
// never lets "Accept all" apply one silently: it's rendered as a distinct
// question card with its own accept/decline actions, and after any "Accept
// all" call this file re-derives which flag_question rows are STILL pending
// (rather than trying to parse the RPC's own skipped_questions shape, which
// api.md documents only loosely) and surfaces them with their own banner --
// see the comment on acceptAll() below for why.

import { useCallback, useEffect, useMemo, useState } from "react";

import { createClient } from "@/lib/supabase/client";
import {
  defaultReviewWeek,
  isoWeekStart,
  previousIsoWeek,
} from "@/lib/planning/iso-week";
import { buildWeeklyProposal } from "@/lib/planning/propose";
import {
  asWeeklyPerformance,
  WeeklyPerformanceError,
  type ChangeSignal,
  type Classification,
  type WeeklyPerformance,
} from "@/lib/planning/types";

import { fetchProfileTimezone } from "./profile-timezone";
import { computeStreaks } from "./streak";

type LoadState = "loading" | "ready" | "error" | "no-plan";

type ChangeType = "weekly_target_blocks" | "flag_question";

function isChangeType(value: string): value is ChangeType {
  return value === "weekly_target_blocks" || value === "flag_question";
}

function isChangeSignal(value: string): value is ChangeSignal {
  return value === "struggling" || value === "coasting" || value === "avoided";
}

type DbChangeStatus = "pending" | "accepted" | "rejected" | "edited";

function isDbChangeStatus(value: string): value is DbChangeStatus {
  return value === "pending" || value === "accepted" || value === "rejected" || value === "edited";
}

/** A weekly_plan_changes row, narrowed from the generated string-typed Row. */
type ReviewChange = {
  id: string;
  changeType: ChangeType;
  categoryId: string | null;
  oldValue: number | null;
  newValue: number | null;
  reason: string;
  signal: ChangeSignal;
  status: DbChangeStatus;
  decidedAt: string | null;
};

function narrowChange(row: {
  id: string;
  change_type: string;
  target_category_id: string | null;
  old_value: number | null;
  new_value: number | null;
  reason: string;
  signal: string;
  status: string;
  decided_at: string | null;
}): ReviewChange | null {
  if (!isChangeType(row.change_type) || !isChangeSignal(row.signal) || !isDbChangeStatus(row.status)) {
    return null;
  }
  return {
    id: row.id,
    changeType: row.change_type,
    categoryId: row.target_category_id,
    oldValue: row.old_value,
    newValue: row.new_value,
    reason: row.reason,
    signal: row.signal,
    status: row.status,
    decidedAt: row.decided_at,
  };
}

type StoredMetrics = { schema_version: string; current: WeeklyPerformance; previous: WeeklyPerformance | null };

function narrowStoredMetrics(value: unknown): StoredMetrics | null {
  if (!value || typeof value !== "object") return null;
  const obj = value as Record<string, unknown>;
  try {
    const current = asWeeklyPerformance(obj.current);
    const previous = obj.previous == null ? null : asWeeklyPerformance(obj.previous);
    return { schema_version: String(obj.schema_version ?? ""), current, previous };
  } catch (e) {
    console.error("[weekly-review] stored metrics did not match weekly_performance().v1:", e);
    return null;
  }
}

type WeeklyPlanState = {
  id: string;
  isoWeek: string;
  effectiveIsoWeek: string;
  status: string;
  metrics: StoredMetrics;
  changes: ReviewChange[];
};

const CLASSIFICATION_LABEL: Record<Classification, string> = {
  struggling: "Struggling",
  coasting: "Coasting",
  avoided: "Avoided",
  on_track: "On track",
  insufficient_data: "Not enough data yet",
};

const CLASSIFICATION_CLASS: Record<Classification, string> = {
  struggling: "is-struggling",
  coasting: "is-coasting",
  avoided: "is-avoided",
  on_track: "is-on-track",
  insufficient_data: "is-unknown",
};

function pct(value: number | null): string {
  return value === null ? "—" : `${Math.round(value * 100)}%`;
}

function num(value: number): string {
  return String(value);
}

function formatWeekRange(isoWeek: string): string {
  const start = isoWeekStart(isoWeek);
  const end = new Date(start.getTime() + 6 * 86_400_000);
  const fmt = (d: Date) =>
    new Intl.DateTimeFormat("en", { month: "short", day: "2-digit", timeZone: "UTC" }).format(d);
  return `${fmt(start)} – ${fmt(end)}`;
}

function databaseErrorMessage(error: unknown, fallback: string): string {
  if (!error || typeof error !== "object") return fallback;
  const candidate = error as { code?: string; message?: string };
  if (candidate.code === "22023") {
    return "That value is outside the allowed range for this change, or it's already been decided.";
  }
  if (candidate.code === "42501") return "We couldn't find that on your route.";
  return candidate.message || fallback;
}

export function WeeklyReviewPanel() {
  const [state, setState] = useState<LoadState>("loading");
  const [isoWeek, setIsoWeek] = useState<string | null>(null);
  const [performance, setPerformance] = useState<WeeklyPerformance | null>(null);
  const [previousPerformance, setPreviousPerformance] = useState<WeeklyPerformance | null>(null);
  const [weeklyPlan, setWeeklyPlan] = useState<WeeklyPlanState | null>(null);
  const [streaks, setStreaks] = useState({ current: 0, longest: 0 });
  const [generating, setGenerating] = useState(false);
  const [generateError, setGenerateError] = useState<string | null>(null);
  const [busyChangeId, setBusyChangeId] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [acceptAllBusy, setAcceptAllBusy] = useState(false);
  const [justSkippedQuestions, setJustSkippedQuestions] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editValue, setEditValue] = useState<string>("");

  const load = useCallback(async () => {
    setState("loading");
    setGenerateError(null);
    setActionError(null);
    const supabase = createClient();
    const {
      data: { user },
      error: userError,
    } = await supabase.auth.getUser();
    if (userError || !user) {
      setState("error");
      return;
    }

    const { data: plan, error: planError } = await supabase
      .from("plans")
      .select("id")
      .eq("user_id", user.id)
      .eq("is_active", true)
      .maybeSingle();
    if (planError) {
      console.error("[weekly-review] failed to load active route:", planError);
      setState("error");
      return;
    }
    if (!plan) {
      setState("no-plan");
      return;
    }

    const timezone = await fetchProfileTimezone(supabase, user.id);
    const week = defaultReviewWeek(timezone);
    setIsoWeek(week);
    const priorWeek = previousIsoWeek(week);

    async function readPerformance(isoWeekArg: string): Promise<WeeklyPerformance | null> {
      const { data, error } = await supabase.rpc("weekly_performance", {
        p_plan_id: plan!.id,
        p_iso_week: isoWeekArg,
      });
      if (error) {
        console.error(`[weekly-review] weekly_performance(${isoWeekArg}) failed:`, error);
        return null;
      }
      try {
        return asWeeklyPerformance(data);
      } catch (e) {
        console.error(
          `[weekly-review] weekly_performance(${isoWeekArg}) returned an unexpected shape:`,
          e instanceof WeeklyPerformanceError ? e.message : e,
        );
        return null;
      }
    }

    const [currentPerf, priorPerf, { data: rollups, error: rollupsError }, { data: existingRow, error: rowError }] =
      await Promise.all([
        readPerformance(week),
        readPerformance(priorWeek),
        supabase
          .from("daily_rollups")
          .select("blocks_done, date")
          .eq("user_id", user.id)
          .is("room_id", null)
          .gte("date", new Date(isoWeekStart(priorWeek).getTime() - 35 * 86_400_000).toISOString().slice(0, 10))
          .lte("date", new Date(isoWeekStart(week).getTime() + 6 * 86_400_000).toISOString().slice(0, 10)),
        supabase
          .from("weekly_plans")
          .select(
            "id, iso_week, effective_iso_week, status, metrics, weekly_plan_changes(id, change_type, target_category_id, old_value, new_value, reason, signal, status, decided_at)",
          )
          .eq("plan_id", plan.id)
          .eq("iso_week", week)
          .maybeSingle(),
      ]);

    if (!currentPerf || !priorPerf) {
      setState("error");
      return;
    }
    setPerformance(currentPerf);
    setPreviousPerformance(priorPerf);

    if (!rollupsError && rollups) {
      const today = new Date().toISOString().slice(0, 10);
      setStreaks(computeStreaks(rollups, today, 120));
    }

    if (rowError) {
      console.error("[weekly-review] failed to load existing weekly_plans row:", rowError);
    } else if (existingRow) {
      const metrics = narrowStoredMetrics(existingRow.metrics);
      if (metrics) {
        setWeeklyPlan({
          id: existingRow.id,
          isoWeek: existingRow.iso_week,
          effectiveIsoWeek: existingRow.effective_iso_week,
          status: existingRow.status,
          metrics,
          changes: (existingRow.weekly_plan_changes ?? []).flatMap((c) => {
            const narrowed = narrowChange(c);
            return narrowed ? [narrowed] : [];
          }),
        });
      }
    } else {
      setWeeklyPlan(null);
    }

    setState("ready");
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(timer);
  }, [load]);

  // Re-derive outcomes/changes from whatever metrics we have -- either the
  // frozen snapshot on a saved weekly_plans row, or the live current/previous
  // performance when no review has been generated yet (so outcome badges can
  // still render before the user clicks "Generate this week's review").
  // buildWeeklyProposal() is pure and deterministic (its own docs: "the same
  // two weeks of numbers always produce the same classification"), so this is
  // exactly what the engine saw at generation time, not a re-guess.
  // Pulled into flat locals (rather than reading weeklyPlan.metrics.current
  // inside the memo callback) so the memo's dependency list is exactly the
  // leaf values it reads -- a nested-property read inside the callback body
  // is what the React Compiler can't reconcile with a manually-specified
  // [weeklyPlan, ...] dependency array.
  const currentMetrics = weeklyPlan ? weeklyPlan.metrics.current : performance;
  const previousMetrics = weeklyPlan ? (weeklyPlan.metrics.previous ?? undefined) : (previousPerformance ?? undefined);

  const proposal = useMemo(() => {
    if (!currentMetrics) return null;
    return buildWeeklyProposal({ current: currentMetrics, previous: previousMetrics });
  }, [currentMetrics, previousMetrics]);

  const activePerformance = currentMetrics;

  const isBrandNewRoute = useMemo(
    () => (activePerformance ? activePerformance.categories.every((c) => !c.existed_before_week) : false),
    [activePerformance],
  );

  const generate = useCallback(async () => {
    if (!isoWeek) return;
    setGenerating(true);
    setGenerateError(null);
    try {
      const response = await fetch("/api/plan/weekly-review", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ isoWeek }),
      });
      const body = (await response.json()) as {
        error?: string;
        generated?: boolean;
        reason?: string;
        weeklyPlanId?: string;
      };
      if (!response.ok || body.error) {
        setGenerateError(body.error ?? "Could not generate this week's review.");
        return;
      }
      if (!body.generated && !body.weeklyPlanId) {
        setGenerateError(body.reason ?? "Nothing to review.");
        return;
      }
      // Re-read from the database rather than trusting the POST response's
      // changes[] array directly -- that array is the raw ProposedChange[]
      // from propose.ts and (per api.md §3g) has no row `id`, which every
      // accept/reject/edit action here needs. weeklyPlanId is authoritative.
      const supabase = createClient();
      const { data: row, error: rowError } = await supabase
        .from("weekly_plans")
        .select(
          "id, iso_week, effective_iso_week, status, metrics, weekly_plan_changes(id, change_type, target_category_id, old_value, new_value, reason, signal, status, decided_at)",
        )
        .eq("id", body.weeklyPlanId!)
        .single();
      if (rowError || !row) {
        setGenerateError("Generated, but could not read it back. Try refreshing.");
        return;
      }
      const metrics = narrowStoredMetrics(row.metrics);
      if (!metrics) {
        setGenerateError("Generated, but the stored review looked malformed.");
        return;
      }
      setWeeklyPlan({
        id: row.id,
        isoWeek: row.iso_week,
        effectiveIsoWeek: row.effective_iso_week,
        status: row.status,
        metrics,
        changes: (row.weekly_plan_changes ?? []).flatMap((c) => {
          const narrowed = narrowChange(c);
          return narrowed ? [narrowed] : [];
        }),
      });
    } catch (e) {
      console.error("[weekly-review] failed to generate review:", e);
      setGenerateError("Could not reach the review generator. Try again.");
    } finally {
      setGenerating(false);
    }
  }, [isoWeek]);

  const refetchWeeklyPlan = useCallback(async () => {
    if (!weeklyPlan) return;
    const supabase = createClient();
    const { data: row, error } = await supabase
      .from("weekly_plans")
      .select(
        "id, iso_week, effective_iso_week, status, metrics, weekly_plan_changes(id, change_type, target_category_id, old_value, new_value, reason, signal, status, decided_at)",
      )
      .eq("id", weeklyPlan.id)
      .single();
    if (error || !row) return;
    const metrics = narrowStoredMetrics(row.metrics);
    if (!metrics) return;
    setWeeklyPlan({
      id: row.id,
      isoWeek: row.iso_week,
      effectiveIsoWeek: row.effective_iso_week,
      status: row.status,
      metrics,
      changes: (row.weekly_plan_changes ?? []).flatMap((c) => {
        const narrowed = narrowChange(c);
        return narrowed ? [narrowed] : [];
      }),
    });
  }, [weeklyPlan]);

  const decide = useCallback(
    async (changeId: string, decision: "accepted" | "rejected", newValue?: number) => {
      setBusyChangeId(changeId);
      setActionError(null);
      const supabase = createClient();
      const { data, error } = await supabase.rpc("apply_weekly_plan_change", {
        p_change_id: changeId,
        p_decision: decision,
        ...(newValue !== undefined ? { p_new_value: newValue } : {}),
      });
      if (error || !data) {
        console.error("[weekly-review] failed to decide change:", error);
        setActionError(databaseErrorMessage(error, "We could not save that decision. Nothing was changed."));
        setBusyChangeId(null);
        return;
      }
      const narrowed = narrowChange(data);
      setWeeklyPlan((current) => {
        if (!current) return current;
        return {
          ...current,
          changes: current.changes.map((c) => (c.id === changeId && narrowed ? narrowed : c)),
        };
      });
      setEditingId(null);
      setBusyChangeId(null);
      // The parent review's own status (proposed/accepted/rejected/partial) is
      // recomputed server-side after every decision -- refetch so that stays
      // in sync rather than only patching the one row we touched.
      void refetchWeeklyPlan();
    },
    [refetchWeeklyPlan],
  );

  const acceptAll = useCallback(async () => {
    if (!weeklyPlan) return;
    setAcceptAllBusy(true);
    setActionError(null);
    setJustSkippedQuestions(false);
    const supabase = createClient();
    const { error } = await supabase.rpc("accept_all_weekly_plan_changes", {
      p_weekly_plan_id: weeklyPlan.id,
    });
    if (error) {
      console.error("[weekly-review] accept-all failed:", error);
      setActionError(databaseErrorMessage(error, "Could not accept everything. Nothing was changed."));
      setAcceptAllBusy(false);
      return;
    }
    // Deliberately not parsing the RPC's own { applied, skipped_questions }
    // return shape -- api.md documents it loosely and doesn't pin the element
    // shape of skipped_questions. accept_all_weekly_plan_changes() is
    // documented to SKIP every flag_question row structurally (they stay
    // 'pending'), so refetching and looking at which flag_question rows are
    // still pending is exactly as correct and doesn't depend on guessing an
    // unpinned response shape.
    await refetchWeeklyPlan();
    setJustSkippedQuestions(true);
    setAcceptAllBusy(false);
  }, [weeklyPlan, refetchWeeklyPlan]);

  if (state === "loading") {
    return (
      <section className="a02-weekly-review" aria-label="Weekly plan review" aria-busy="true">
        <div className="a02-view-head">
          <div>
            <span className="a02-eyebrow">REVIEW / WEEKLY PLAN</span>
            <h2>Reading your week.</h2>
          </div>
        </div>
        <div className="a02-weekly-skeleton" />
      </section>
    );
  }

  if (state === "error") {
    return (
      <section className="a02-product-state" role="alert">
        <b>The weekly review is unavailable.</b>
        <p>We could not read your route&apos;s performance. Nothing has been changed.</p>
        <button type="button" onClick={() => void load()}>
          Try again ↗
        </button>
      </section>
    );
  }

  if (state === "no-plan") {
    return (
      <section className="a02-weekly-review">
        <div className="a02-view-head">
          <div>
            <span className="a02-eyebrow">REVIEW / WEEKLY PLAN</span>
            <h2>No active route yet.</h2>
          </div>
        </div>
        <p className="a02-product-note">Set up a route to get a real weekly review here.</p>
      </section>
    );
  }

  if (!activePerformance || !isoWeek) return null;

  const plan = activePerformance.plan;
  const avgSessionMinutes =
    plan.sessions_completed > 0 ? Math.round(plan.actual_minutes / plan.sessions_completed) : null;
  const categoryById = new Map(activePerformance.categories.map((c) => [c.category_id, c]));

  const pendingChanges = weeklyPlan?.changes.filter((c) => c.status === "pending") ?? [];
  const pendingQuestions = pendingChanges.filter((c) => c.changeType === "flag_question");
  const pendingAdjustments = pendingChanges.filter((c) => c.changeType === "weekly_target_blocks");
  const decidedChanges = weeklyPlan?.changes.filter((c) => c.status !== "pending") ?? [];

  return (
    <section className="a02-weekly-review" data-testid="weekly-review-panel">
      <div className="a02-view-head">
        <div>
          <span className="a02-eyebrow">REVIEW / WEEK OF {formatWeekRange(isoWeek)}</span>
          <h2>Your week, plainly.</h2>
        </div>
        <div className="a02-view-controls">
          <button type="button" onClick={() => void load()}>
            Refresh
          </button>
        </div>
      </div>

      {isBrandNewRoute ? (
        <p className="a02-heat-empty">
          Your route is brand new — every category started during or after this week, so there isn&apos;t a
          full week of history to judge yet. Real numbers show up here after your first full week.
        </p>
      ) : plan.picked_count === 0 && plan.study_days === 0 ? (
        <p className="a02-heat-empty">No activity recorded for the week of {formatWeekRange(isoWeek)}.</p>
      ) : (
        <div className="a02-weekly-stats">
          <div className="a02-weekly-stat">
            <span>COMPLETED</span>
            <strong>
              {plan.done_count}
              <small>/{plan.picked_count}</small>
            </strong>
            <p>{pct(plan.completion_rate)} of what you picked this week</p>
          </div>
          <div className="a02-weekly-stat">
            <span>PACE</span>
            <strong>{pct(plan.pace_ratio)}</strong>
            <p>{plan.pace_ratio === null ? "No timed, estimated tasks yet" : "of estimated time, on tasks with a real session"}</p>
          </div>
          <div className="a02-weekly-stat">
            <span>AVG SESSION</span>
            <strong>{avgSessionMinutes === null ? "—" : `${avgSessionMinutes}m`}</strong>
            <p>{plan.sessions_completed} completed session{plan.sessions_completed === 1 ? "" : "s"}</p>
          </div>
          <div className="a02-weekly-stat">
            <span>STREAK</span>
            <strong>{streaks.current}d</strong>
            <p>longest {streaks.longest}d</p>
          </div>
          <div className="a02-weekly-stat">
            <span>SCORE</span>
            <strong>
              {num(plan.score)}
              <small>/{num(plan.score_max)}</small>
            </strong>
            <p>weighted across categories you actually picked from</p>
          </div>
        </div>
      )}

      <div className="a02-weekly-categories">
        {activePerformance.categories.map((cat) => {
          const outcome = proposal?.outcomes.find((o) => o.category_id === cat.category_id);
          const classification = outcome?.classification ?? "insufficient_data";
          return (
            <div className="a02-weekly-category" key={cat.category_id} data-testid={`weekly-category-${cat.name}`}>
              <div className="a02-weekly-category-head">
                <b>{cat.label}</b>
                <span
                  className={`a02-signal-badge ${CLASSIFICATION_CLASS[classification]}`}
                  data-testid={`weekly-category-${cat.name}-badge`}
                >
                  {CLASSIFICATION_LABEL[classification]}
                </span>
              </div>
              <p>
                {cat.done_count}/{cat.picked_count} done ({pct(cat.completion_rate)}) · pace {pct(cat.pace_ratio)} ·
                pick rate {pct(cat.pick_rate)} · target {cat.current_target}/wk
              </p>
              {outcome?.suppressed === "low_completion_week" && (
                <i className="a02-weekly-suppressed">Increase withheld — this week&apos;s overall completion was low.</i>
              )}
              {outcome?.suppressed === "capped_to_no_change" && (
                <i className="a02-weekly-suppressed">Already at its floor/ceiling for this signal — no room to move.</i>
              )}
            </div>
          );
        })}
      </div>

      <div className="a02-weekly-changeset">
        <div className="a02-view-head">
          <div>
            <span className="a02-eyebrow">THIS WEEK&apos;S PROPOSAL</span>
            <h3>{weeklyPlan ? "What the rules noticed." : "No review generated yet."}</h3>
          </div>
          {!weeklyPlan && (
            <div className="a02-view-controls">
              <button
                type="button"
                className="a02-add"
                disabled={generating}
                onClick={() => void generate()}
                data-testid="weekly-review-generate"
              >
                {generating ? "Generating…" : "Generate this week's review ↗"}
              </button>
            </div>
          )}
        </div>

        {generateError && (
          <p className="a02-product-write-error" role="alert">
            {generateError}
          </p>
        )}
        {actionError && (
          <p className="a02-product-write-error" role="alert">
            {actionError}
          </p>
        )}

        {weeklyPlan && weeklyPlan.changes.length === 0 && (
          <p className="a02-checkin-done" data-testid="weekly-review-no-changes">
            {isBrandNewRoute
              ? "Not enough history yet to review — every category is too new to judge. Check back after a full week."
              : "Nothing to change this week — every category with enough history is on track. That's a good outcome, not an empty one."}
          </p>
        )}

        {weeklyPlan && pendingQuestions.length > 0 && (
          <div className="a02-weekly-questions">
            {pendingQuestions.map((change) => {
              const cat = change.categoryId ? categoryById.get(change.categoryId) : undefined;
              return (
                <div
                  className="a02-weekly-question-card"
                  key={change.id}
                  data-testid={cat ? `weekly-question-${cat.name}` : "weekly-question"}
                >
                  <span className="a02-eyebrow">QUESTION{cat ? ` / ${cat.label.toUpperCase()}` : ""}</span>
                  <p>{change.reason}</p>
                  <small>
                    Answering this doesn&apos;t change your plan automatically — it just records your call. If
                    you want to actually change this category&apos;s targets, do that yourself.
                  </small>
                  <div className="a02-weekly-question-actions">
                    <button
                      type="button"
                      className="a02-add"
                      disabled={busyChangeId === change.id}
                      onClick={() => void decide(change.id, "accepted")}
                      data-testid={cat ? `weekly-question-${cat.name}-accept` : undefined}
                    >
                      Still a priority
                    </button>
                    <button
                      type="button"
                      disabled={busyChangeId === change.id}
                      onClick={() => void decide(change.id, "rejected")}
                      data-testid={cat ? `weekly-question-${cat.name}-decline` : undefined}
                    >
                      Not right now
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        )}

        {weeklyPlan && pendingAdjustments.length > 0 && (
          <>
            <div className="a02-weekly-changes-toolbar">
              <button
                type="button"
                className="a02-add"
                disabled={acceptAllBusy}
                onClick={() => void acceptAll()}
                data-testid="weekly-review-accept-all"
              >
                {acceptAllBusy ? "Accepting…" : "Accept all"}
              </button>
              {pendingQuestions.length > 0 && (
                <small>Accept all applies only the numeric changes below — the question above needs its own answer.</small>
              )}
            </div>
            <div className="a02-weekly-changes">
              {pendingAdjustments.map((change) => {
                const cat = change.categoryId ? categoryById.get(change.categoryId) : undefined;
                const isEditing = editingId === change.id;
                return (
                  <div
                    className={`a02-weekly-change-card is-${change.signal}`}
                    key={change.id}
                    data-testid={cat ? `weekly-change-${cat.name}` : "weekly-change"}
                  >
                    <div className="a02-weekly-change-head">
                      <b>{cat?.label ?? "Category"}</b>
                      <span className={`a02-signal-badge is-${change.signal}`}>{change.signal}</span>
                    </div>
                    <p>{change.reason}</p>
                    <div className="a02-weekly-change-values">
                      <span>{change.oldValue}</span>
                      <i>→</i>
                      {isEditing ? (
                        <input
                          type="number"
                          min={1}
                          value={editValue}
                          onChange={(e) => setEditValue(e.target.value)}
                          aria-label={`New weekly target for ${cat?.label ?? "category"}`}
                        />
                      ) : (
                        <span className="a02-weekly-new-value">{change.newValue}</span>
                      )}
                      <small>blocks / week</small>
                    </div>
                    <div className="a02-weekly-change-actions">
                      {isEditing ? (
                        <>
                          <button
                            type="button"
                            className="a02-add"
                            disabled={busyChangeId === change.id}
                            onClick={() => {
                              const parsed = Number(editValue);
                              if (!Number.isFinite(parsed)) return;
                              void decide(change.id, "accepted", parsed);
                            }}
                          >
                            Save &amp; accept
                          </button>
                          <button type="button" onClick={() => setEditingId(null)} disabled={busyChangeId === change.id}>
                            Cancel
                          </button>
                        </>
                      ) : (
                        <>
                          <button
                            type="button"
                            className="a02-add"
                            disabled={busyChangeId === change.id}
                            onClick={() => void decide(change.id, "accepted")}
                            data-testid={cat ? `weekly-change-${cat.name}-accept` : undefined}
                          >
                            Accept
                          </button>
                          <button
                            type="button"
                            disabled={busyChangeId === change.id}
                            onClick={() => {
                              setEditingId(change.id);
                              setEditValue(String(change.newValue ?? change.oldValue ?? ""));
                            }}
                          >
                            Edit
                          </button>
                          <button
                            type="button"
                            disabled={busyChangeId === change.id}
                            onClick={() => void decide(change.id, "rejected")}
                            data-testid={cat ? `weekly-change-${cat.name}-reject` : undefined}
                          >
                            Reject
                          </button>
                        </>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </>
        )}

        {justSkippedQuestions && pendingQuestions.length > 0 && (
          <p className="a02-checkin-banner">
            <span>
              {pendingQuestions.length} question{pendingQuestions.length === 1 ? "" : "s"} above still need
              {pendingQuestions.length === 1 ? "s" : ""} your answer — accepting everything else never answers
              these for you.
            </span>
          </p>
        )}

        {weeklyPlan && decidedChanges.length > 0 && (
          <details className="a02-weekly-decided">
            <summary>{decidedChanges.length} already decided this review</summary>
            <ul>
              {decidedChanges.map((change) => {
                const cat = change.categoryId ? categoryById.get(change.categoryId) : undefined;
                return (
                  <li key={change.id}>
                    <b>{cat?.label ?? "Category"}</b> — {change.status}
                    {change.changeType === "weekly_target_blocks" && ` (${change.oldValue} → ${change.newValue})`}
                  </li>
                );
              })}
            </ul>
          </details>
        )}
      </div>
    </section>
  );
}
