"use client";

import { useCallback, useEffect, useState } from "react";

import { createClient } from "@/lib/supabase/client";
import { asReviewDailySummary, type ReviewDailySummary } from "@/lib/review/types";
import { buildReviewFixture, getDevReviewStateOverride } from "@/lib/review/dev-fixtures";

// Shared by ReviewRings and ReviewTodaySignal -- both read the same
// review_daily_summary() result, so the fetch lives here once, in their
// common parent (ReviewDeck), same pattern use-study-profile.ts already
// established for F5/F6.

export interface UseDailySummaryResult {
  summary: ReviewDailySummary | null;
  state: "loading" | "ready" | "error";
  reload: () => void;
}

export function useDailySummary(): UseDailySummaryResult {
  const [summary, setSummary] = useState<ReviewDailySummary | null>(null);
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");

  const load = useCallback(async () => {
    setState("loading");
    const devState = getDevReviewStateOverride();
    if (devState) {
      setSummary(buildReviewFixture(devState).dailySummary);
      setState("ready");
      return;
    }
    const supabase = createClient();
    const { data, error } = await supabase.rpc("review_daily_summary", {});
    if (error) {
      console.error("[review] failed to load daily summary:", error);
      setState("error");
      return;
    }
    try {
      setSummary(asReviewDailySummary(data));
      setState("ready");
    } catch (parseError) {
      console.error("[review] malformed daily summary:", parseError);
      setState("error");
    }
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(timer);
  }, [load]);

  return { summary, state, reload: () => void load() };
}
