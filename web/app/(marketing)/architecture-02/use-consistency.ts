"use client";

import { useCallback, useEffect, useState } from "react";

import { createClient } from "@/lib/supabase/client";
import { asReviewConsistency, type ReviewConsistency } from "@/lib/review/types";
import { buildReviewFixture, getDevReviewStateOverride } from "@/lib/review/dev-fixtures";

import { fetchProfileTimezone } from "./profile-timezone";
import { utcDateRange, utcToday } from "./product-data";

// The Consistency heatmap's own fetch, over a 365-day window -- separate
// from ProgressDeck's existing 42-day one (Wave 1's heatmap stays on its own
// shorter window; this is the new full-year card the reference mock calls
// for). review_consistency() caps at 400 days (migrations/0026), so 365 is
// safe as-is.

const WINDOW_DAYS = 365;

export interface UseConsistencyResult {
  consistency: ReviewConsistency | null;
  state: "loading" | "ready" | "error";
  reload: () => void;
}

export function useConsistency(): UseConsistencyResult {
  const [consistency, setConsistency] = useState<ReviewConsistency | null>(null);
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");

  const load = useCallback(async () => {
    setState("loading");
    const devState = getDevReviewStateOverride();
    if (devState) {
      setConsistency(buildReviewFixture(devState).consistency);
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
    const userTimezone = await fetchProfileTimezone(supabase, user.id);
    const windowDates = utcDateRange(WINDOW_DAYS, utcToday(userTimezone));
    const { data, error } = await supabase.rpc("review_consistency", {
      p_start: windowDates[0]!,
      p_end: windowDates.at(-1)!,
    });
    if (error) {
      console.error("[review] failed to load consistency:", error);
      setState("error");
      return;
    }
    try {
      setConsistency(asReviewConsistency(data));
      setState("ready");
    } catch (parseError) {
      console.error("[review] malformed consistency response:", parseError);
      setState("error");
    }
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(timer);
  }, [load]);

  return { consistency, state, reload: () => void load() };
}
