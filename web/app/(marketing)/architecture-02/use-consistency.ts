"use client";

import { useCallback, useEffect, useState } from "react";

import { createClient } from "@/lib/supabase/client";
import { asReviewConsistency, type ReviewConsistency } from "@/lib/review/types";
import { buildReviewFixture, getDevReviewStateOverride } from "@/lib/review/dev-fixtures";

import { fetchProfileTimezone } from "./profile-timezone";
import { utcDateRange, utcToday } from "./product-data";

// The Consistency heatmap reads a direct server-computed date range. Its
// caller chooses the range (Month = 30 days, Year = 365); the RPC caps at
// 400 days, so both are safe without a client-side aggregation.

export interface UseConsistencyResult {
  consistency: ReviewConsistency | null;
  state: "loading" | "ready" | "error";
  reload: () => void;
}

export function useConsistency(windowDays = 365): UseConsistencyResult {
  const [consistency, setConsistency] = useState<ReviewConsistency | null>(null);
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");

  const load = useCallback(async () => {
    setState("loading");
    const devState = getDevReviewStateOverride();
    if (devState) {
      const fixture = buildReviewFixture(devState).consistency;
      const days = fixture.days.slice(-windowDays);
      setConsistency({ ...fixture, from: days[0]?.date ?? fixture.from, days });
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
    const windowDates = utcDateRange(windowDays, utcToday(userTimezone));
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
  }, [windowDays]);

  useEffect(() => {
    const timer = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(timer);
  }, [load]);

  return { consistency, state, reload: () => void load() };
}
