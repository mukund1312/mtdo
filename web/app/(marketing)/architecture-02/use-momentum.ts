"use client";

import { useCallback, useEffect, useState } from "react";

import { createClient } from "@/lib/supabase/client";
import { asReviewMomentum, type ReviewMomentum } from "@/lib/review/types";
import { buildReviewFixture, getDevReviewStateOverride } from "@/lib/review/dev-fixtures";

// Backs the "DAILY SCORE" card (ReviewRings) -- review_momentum()'s smoothed
// score (migrations/0029), not a new "daily" formula. Default 42-day window,
// same as everywhere else this RPC is called.

export interface UseMomentumResult {
  momentum: ReviewMomentum | null;
  state: "loading" | "ready" | "error";
  reload: () => void;
}

export function useMomentum(): UseMomentumResult {
  const [momentum, setMomentum] = useState<ReviewMomentum | null>(null);
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");

  const load = useCallback(async () => {
    setState("loading");
    const devState = getDevReviewStateOverride();
    if (devState) {
      setMomentum(buildReviewFixture(devState).momentum);
      setState("ready");
      return;
    }
    const supabase = createClient();
    const { data, error } = await supabase.rpc("review_momentum", { p_window_days: 42 });
    if (error) {
      console.error("[review] failed to load momentum:", error);
      setState("error");
      return;
    }
    try {
      setMomentum(asReviewMomentum(data));
      setState("ready");
    } catch (parseError) {
      console.error("[review] malformed momentum response:", parseError);
      setState("error");
    }
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(timer);
  }, [load]);

  return { momentum, state, reload: () => void load() };
}
