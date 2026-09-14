"use client";

import { useCallback, useEffect, useState } from "react";

import { createClient } from "@/lib/supabase/client";
import { asWeeklyPerformance, type WeeklyPerformance } from "@/lib/planning/types";
import { isoWeekOf } from "@/lib/planning/iso-week";
import { buildReviewFixture, getDevReviewStateOverride } from "@/lib/review/dev-fixtures";

import { fetchProfileTimezone } from "./profile-timezone";
import { utcToday } from "./product-data";

// Shared by ReviewPlanVsReality and ReviewGoalBalance -- both read the SAME
// weekly_performance() result for the CURRENT (in-progress) ISO week. Reuses
// the already-audited weekly engine formula (api.md sec3f) outright -- no
// new metric, this is composition only, same discipline study_profile() and
// review_consistency() already established for reusing weekly_performance().
//
// Current week, not "the most recently completed week" (unlike
// defaultReviewWeek() in iso-week.ts, which the weekly PLAN review
// deliberately uses to avoid classifying a partial week) -- a "Today"-
// centric Review page showing "Plan vs Reality" is asking "how is this week
// going so far", not proposing a plan change, so a week-in-progress is the
// honest, relevant answer here.

export interface UseWeeklySnapshotResult {
  weekly: WeeklyPerformance | null;
  state: "loading" | "ready" | "error" | "no_active_plan";
  reload: () => void;
}

export function useWeeklySnapshot(): UseWeeklySnapshotResult {
  const [weekly, setWeekly] = useState<WeeklyPerformance | null>(null);
  const [state, setState] = useState<"loading" | "ready" | "error" | "no_active_plan">("loading");

  const load = useCallback(async () => {
    setState("loading");
    const devState = getDevReviewStateOverride();
    if (devState) {
      setWeekly(buildReviewFixture(devState).weekly);
      setState("ready");
      return;
    }
    const supabase = createClient();
    const {
      data: { user },
      error: userError,
    } = await supabase.auth.getUser();
    if (userError || !user) {
      setState("error");
      return;
    }

    const [{ data: activePlan, error: planError }, userTimezone] = await Promise.all([
      supabase.from("plans").select("id").eq("user_id", user.id).eq("is_active", true).maybeSingle(),
      fetchProfileTimezone(supabase, user.id),
    ]);
    if (planError) {
      console.error("[review] failed to resolve active plan:", planError);
      setState("error");
      return;
    }
    if (!activePlan) {
      setState("no_active_plan");
      return;
    }

    const isoWeek = isoWeekOf(new Date(`${utcToday(userTimezone)}T00:00:00Z`));
    const { data, error } = await supabase.rpc("weekly_performance", {
      p_plan_id: activePlan.id,
      p_iso_week: isoWeek,
    });
    if (error) {
      console.error("[review] failed to load weekly performance:", error);
      setState("error");
      return;
    }
    try {
      setWeekly(asWeeklyPerformance(data));
      setState("ready");
    } catch (parseError) {
      console.error("[review] malformed weekly performance response:", parseError);
      setState("error");
    }
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(timer);
  }, [load]);

  return { weekly, state, reload: () => void load() };
}
