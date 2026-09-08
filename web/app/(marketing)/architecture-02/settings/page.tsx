"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { PlanningModeSelector } from "../planning-mode-selector";
import { isPlanningMode, type PlanningMode } from "../planning-mode";
import "../signal-deck.css";
import "../planning-mode-selector.css";
import "./settings.css";

type AIStatus = { models: string[]; provider: string; reachable: boolean };
type LoadState = "loading" | "ready" | "error";
type PlanState = "loading" | "ready" | "error" | "no-plan";

// Settings -> AI (Phase 2 of the operating-engine plan). The rest of
// Settings (Plan & Data, Integrations, Preferences, Record, Account, Help)
// is Phase 8's "More" surface -- this page is deliberately just the one
// section Phase 2 actually built a backend for, not a stand-in for the
// whole thing.
export default function SignalDeckSettingsPage() {
  const [status, setStatus] = useState<AIStatus | null>(null);
  const [state, setState] = useState<LoadState>("loading");

  const load = useCallback(async () => {
    setState("loading");
    try {
      const response = await fetch("/api/ai/status");
      if (!response.ok) {
        setState("error");
        return;
      }
      setStatus((await response.json()) as AIStatus);
      setState("ready");
    } catch (err) {
      console.error("[settings] failed to load AI status:", err);
      setState("error");
    }
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(timer);
  }, [load]);

  // Settings -> Planning (migrations/0017). Real plans.planning_mode read
  // and written here -- PlanningModeSelector's controlled `value` prop
  // makes it a dumb radiogroup in this context; this component owns
  // loading/saving/error state, not the selector itself.
  const [planId, setPlanId] = useState<string | null>(null);
  const [planningMode, setPlanningMode] = useState<PlanningMode | null>(null);
  const [planState, setPlanState] = useState<PlanState>("loading");
  const [planSaveError, setPlanSaveError] = useState<string | null>(null);

  const loadPlanningMode = useCallback(async () => {
    setPlanState("loading");
    setPlanSaveError(null);
    const supabase = createClient();
    const {
      data: { user },
      error: userError,
    } = await supabase.auth.getUser();
    if (userError || !user) {
      setPlanState("error");
      return;
    }
    const { data: plan, error } = await supabase
      .from("plans")
      .select("id, planning_mode")
      .eq("user_id", user.id)
      .eq("is_active", true)
      .maybeSingle();
    if (error) {
      console.error("[settings] failed to load planning mode:", error);
      setPlanState("error");
      return;
    }
    if (!plan || !isPlanningMode(plan.planning_mode)) {
      // No active route yet (or, defensively, a stored value the CHECK
      // constraint should have already prevented) -- honest empty state,
      // not a fabricated default rendered as if it were real.
      setPlanState("no-plan");
      return;
    }
    setPlanId(plan.id);
    setPlanningMode(plan.planning_mode);
    setPlanState("ready");
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => void loadPlanningMode(), 0);
    return () => window.clearTimeout(timer);
  }, [loadPlanningMode]);

  const updatePlanningMode = useCallback(
    async (next: PlanningMode) => {
      if (!planId) return;
      const previous = planningMode;
      setPlanSaveError(null);
      setPlanningMode(next); // optimistic -- this is the caller's own plan, not a shared resource
      const supabase = createClient();
      const { error } = await supabase.from("plans").update({ planning_mode: next }).eq("id", planId);
      if (error) {
        console.error("[settings] failed to save planning mode:", error);
        setPlanningMode(previous);
        setPlanSaveError("Couldn't save that -- try again.");
      }
    },
    [planId, planningMode],
  );

  return (
    <main className="a02-shell a02-settings">
      <div className="a02-view-head">
        <div>
          <span className="a02-eyebrow">SETTINGS</span>
          <h1>
            Under the
            <br />
            <em>hood.</em>
          </h1>
        </div>
        <Link href="/architecture-02" className="a02-settings-back">
          ← Back to deck
        </Link>
      </div>

      <section className="a02-product-state a02-settings-card" aria-labelledby="ai-settings-title">
        <b id="ai-settings-title">AI provider</b>
        {state === "loading" && <p>Checking the configured provider…</p>}
        {state === "error" && (
          <>
            <p>Could not read the AI provider&apos;s status.</p>
            <button type="button" onClick={() => void load()}>
              Try again ↗
            </button>
          </>
        )}
        {state === "ready" && status && (
          <div className="a02-settings-status">
            <div className="a02-settings-row">
              <span>Provider</span>
              <strong>{status.provider}</strong>
            </div>
            <div className="a02-settings-row">
              <span>Status</span>
              <strong className={status.reachable ? "is-ok" : "is-down"}>
                <i aria-hidden="true" /> {status.reachable ? "Reachable" : "Unreachable"}
              </strong>
            </div>
            <div className="a02-settings-row">
              <span>Models</span>
              <strong>{status.models.length > 0 ? status.models.join(", ") : "none reported"}</strong>
            </div>
          </div>
        )}
        <p className="a02-settings-note">
          The provider is set on the server (<code>AI_PROVIDER</code>) -- there is no per-user
          switch here yet. Self-hosting with Ollama: point <code>OLLAMA_ENDPOINT</code> at a
          running daemon; a failed health check falls back to Anthropic automatically.
        </p>
      </section>

      <section className="a02-product-state a02-settings-card" aria-labelledby="planning-mode-title">
        <b id="planning-mode-title">Planning mode</b>
        <p className="a02-settings-note">Choose whether your Signal Deck should frame the route one week at a time or against the whole goal.</p>
        {planState === "loading" && <p>Reading your route&apos;s planning mode…</p>}
        {planState === "no-plan" && <p>Set up a route first, then come back here to change how it paces itself.</p>}
        {planState === "error" && (
          <>
            <p>Couldn&apos;t read your planning mode.</p>
            <button type="button" onClick={() => void loadPlanningMode()}>
              Try again ↗
            </button>
          </>
        )}
        {planState === "ready" && planningMode && (
          <>
            <PlanningModeSelector value={planningMode} onChange={(next) => void updatePlanningMode(next)} />
            {planSaveError && (
              <p className="a02-settings-note" role="alert">
                {planSaveError}
              </p>
            )}
          </>
        )}
      </section>
    </main>
  );
}
