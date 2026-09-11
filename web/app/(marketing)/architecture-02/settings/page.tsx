"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { PlanningModeSelector } from "../planning-mode-selector";
import { isPlanningMode, type PlanningMode } from "../planning-mode";
import "../signal-deck.css";
import "../planning-mode-selector.css";
import "./settings.css";
import "../fixed-layer-safety.css";

type AIStatus = { models: string[]; provider: string; reachable: boolean };
type LoadState = "loading" | "ready" | "error";
type PlanState = "loading" | "ready" | "error" | "no-plan";

type CalendarStatus = {
  configured: boolean;
  connected: boolean;
  connection: { calendarId: string; connectedAt: string; scopes: string[] } | null;
  missing: string[];
  provider: string;
};

// Outcomes /api/calendar/callback round-trips back as ?calendar=<reason>.
// Kept as a plain lookup rather than rendering the raw code: these strings are
// the only place a user learns why a consent round trip didn't take.
const CALENDAR_OUTCOMES: Record<string, string> = {
  connected: "Google Calendar connected.",
  declined: "You declined access on Google's side -- nothing was connected.",
  "exchange-failed": "Google accepted the sign-in but the connection couldn't be completed. Try again.",
  "google-error": "Google returned an error during sign-in. Try again.",
  "no-code": "Google didn't return an authorisation code. Try again.",
  "no-refresh-token": "Google didn't return a long-lived token, so the connection would have expired within the hour. Try again.",
  "no-session": "Your session expired during sign-in. Sign in and try again.",
  "not-configured": "Google Calendar isn't configured on this server.",
  "state-mismatch": "That sign-in didn't start here, so it was refused. Try again from this page.",
};

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

  // Settings -> Calendar (Phase 6, migrations/0019-0020). Read-only plus two
  // actions, deliberately: the Time deck's own scheduling UI is a separate
  // frontend piece built against this phase's contract, and this panel exists
  // so "is Google Calendar even set up here?" has an honest answer rather than
  // a control that looks live and isn't. Connecting a calendar is optional --
  // scheduling a task works with or without it.
  const [calendar, setCalendar] = useState<CalendarStatus | null>(null);
  const [calendarState, setCalendarState] = useState<LoadState>("loading");
  const [calendarNotice, setCalendarNotice] = useState<string | null>(null);
  const [disconnecting, setDisconnecting] = useState(false);

  const loadCalendar = useCallback(async () => {
    setCalendarState("loading");
    try {
      const response = await fetch("/api/calendar/status");
      if (!response.ok) {
        setCalendarState("error");
        return;
      }
      setCalendar((await response.json()) as CalendarStatus);
      setCalendarState("ready");
    } catch (err) {
      console.error("[settings] failed to load calendar status:", err);
      setCalendarState("error");
    }
  }, []);

  useEffect(() => {
    // Read straight off location rather than useSearchParams(): this is a
    // one-shot read of a value the callback put there, and useSearchParams()
    // would force a Suspense boundary around the whole page for it.
    // Deferred through the same setTimeout the other two panels use: a
    // synchronous setState in an effect body is a cascading render (and a
    // react-hooks/set-state-in-effect lint error).
    const timer = window.setTimeout(() => {
      const outcome = new URLSearchParams(window.location.search).get("calendar");
      if (outcome) setCalendarNotice(CALENDAR_OUTCOMES[outcome] ?? "That calendar sign-in didn't complete.");
      void loadCalendar();
    }, 0);
    return () => window.clearTimeout(timer);
  }, [loadCalendar]);

  const disconnectCalendar = useCallback(async () => {
    setDisconnecting(true);
    setCalendarNotice(null);
    try {
      const response = await fetch("/api/calendar/disconnect", { method: "POST" });
      if (!response.ok) {
        setCalendarNotice("Couldn't disconnect the calendar. Try again.");
        return;
      }
      const body = (await response.json()) as { orphanedEvents?: number };
      setCalendarNotice(
        body.orphanedEvents
          ? `Disconnected. ${body.orphanedEvents} event(s) couldn't be removed from Google and may need deleting there.`
          : "Disconnected, and the events mtdo created were removed.",
      );
      await loadCalendar();
    } catch (err) {
      console.error("[settings] failed to disconnect the calendar:", err);
      setCalendarNotice("Couldn't disconnect the calendar. Try again.");
    } finally {
      setDisconnecting(false);
    }
  }, [loadCalendar]);

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

      <section className="a02-product-state a02-settings-card" aria-labelledby="calendar-settings-title">
        <b id="calendar-settings-title">Calendar</b>
        {calendarNotice && (
          <p className="a02-settings-note" role="status">
            {calendarNotice}
          </p>
        )}
        {calendarState === "loading" && <p>Checking the calendar connection…</p>}
        {calendarState === "error" && (
          <>
            <p>Could not read the calendar&apos;s status.</p>
            <button type="button" onClick={() => void loadCalendar()}>
              Try again ↗
            </button>
          </>
        )}
        {calendarState === "ready" && calendar && !calendar.configured && (
          <>
            <div className="a02-settings-status">
              <div className="a02-settings-row">
                <span>Google Calendar</span>
                <strong className="is-down">
                  <i aria-hidden="true" /> Not configured
                </strong>
              </div>
            </div>
            <p className="a02-settings-note">
              This server has no Google credentials set
              {calendar.missing.length > 0 && (
                <>
                  {" (missing "}
                  {calendar.missing.map((name, index) => (
                    <span key={name}>
                      {index > 0 && ", "}
                      <code>{name}</code>
                    </span>
                  ))}
                  {")"}
                </>
              )}
              . Scheduling a task onto a date and time still works normally -- a calendar is a
              mirror of your schedule, never where it lives.
            </p>
          </>
        )}
        {calendarState === "ready" && calendar?.configured && (
          <>
            <div className="a02-settings-status">
              <div className="a02-settings-row">
                <span>Google Calendar</span>
                <strong className={calendar.connected ? "is-ok" : "is-down"}>
                  <i aria-hidden="true" /> {calendar.connected ? "Connected" : "Not connected"}
                </strong>
              </div>
              {calendar.connection && (
                <div className="a02-settings-row">
                  <span>Calendar</span>
                  <strong>{calendar.connection.calendarId}</strong>
                </div>
              )}
            </div>
            {calendar.connected ? (
              <button type="button" disabled={disconnecting} onClick={() => void disconnectCalendar()}>
                {disconnecting ? "Disconnecting…" : "Disconnect ↗"}
              </button>
            ) : (
              // A plain link, not fetch(): /api/calendar/connect answers with a
              // redirect to Google's consent screen, which has to be a top-level
              // navigation to work at all.
              <a href="/api/calendar/connect">Connect Google Calendar ↗</a>
            )}
            <p className="a02-settings-note">
              Sync is one-way: mtdo writes to your calendar, and edits you make on Google&apos;s
              side don&apos;t come back. Each task is added individually -- nothing is put on your
              calendar unless you ask for it.
            </p>
          </>
        )}
      </section>
    </main>
  );
}
