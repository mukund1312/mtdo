"use client";

import { useCallback, useEffect, useState } from "react";

import { createClient } from "@/lib/supabase/client";
import { asReviewTimePatterns, type ReviewTimePatterns } from "@/lib/review/types";

import { fetchProfileTimezone } from "./profile-timezone";
import { utcDateRange, utcToday } from "./product-data";

// Shared by ReviewFocusDistribution and ReviewSessionQuality -- both read the
// same review_time_patterns() result over the same 42-day window ProgressDeck
// already uses, so the fetch lives here once.

const WINDOW_DAYS = 42;

export interface UseTimePatternsResult {
  patterns: ReviewTimePatterns | null;
  state: "loading" | "ready" | "error";
  reload: () => void;
}

export function useTimePatterns(): UseTimePatternsResult {
  const [patterns, setPatterns] = useState<ReviewTimePatterns | null>(null);
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");

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
    const userTimezone = await fetchProfileTimezone(supabase, user.id);
    const windowDates = utcDateRange(WINDOW_DAYS, utcToday(userTimezone));
    const { data, error } = await supabase.rpc("review_time_patterns", {
      p_start: windowDates[0]!,
      p_end: windowDates.at(-1)!,
    });
    if (error) {
      console.error("[review] failed to load time patterns:", error);
      setState("error");
      return;
    }
    try {
      setPatterns(asReviewTimePatterns(data));
      setState("ready");
    } catch (parseError) {
      console.error("[review] malformed time patterns response:", parseError);
      setState("error");
    }
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(timer);
  }, [load]);

  return { patterns, state, reload: () => void load() };
}
