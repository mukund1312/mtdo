"use client";

import { useCallback, useEffect, useState } from "react";

import { createClient } from "@/lib/supabase/client";
import { asStudyProfile, type StudyProfile } from "@/lib/review/types";

// Shared by ReviewStudyProfile (F5) and ReviewInsights (F6) -- both read the
// SAME study_profile() result, so the fetch lives here, once, in their
// common parent (ReviewDeck), rather than each card calling the RPC
// independently. See docs/designs/review-frontend-briefs.md's F6 brief for
// why this split exists.

export interface UseStudyProfileResult {
  profile: StudyProfile | null;
  state: "loading" | "ready" | "error";
  reload: () => void;
}

export function useStudyProfile(): UseStudyProfileResult {
  const [profile, setProfile] = useState<StudyProfile | null>(null);
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");

  const load = useCallback(async () => {
    setState("loading");
    const supabase = createClient();
    const { data, error } = await supabase.rpc("study_profile", { p_window_days: 42 });
    if (error) {
      console.error("[review] failed to load study profile:", error);
      setState("error");
      return;
    }
    try {
      setProfile(asStudyProfile(data));
      setState("ready");
    } catch (parseError) {
      console.error("[review] malformed study profile response:", parseError);
      setState("error");
    }
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(timer);
  }, [load]);

  return { profile, state, reload: () => void load() };
}
