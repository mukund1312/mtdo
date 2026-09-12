"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { PlanningModeSelector } from "../planning-mode-selector";
import { DockStyleChooser } from "../dock-style-chooser";
import { isPlanningMode, type PlanningMode } from "../planning-mode";
import { useFocusClockPreference } from "@/lib/preferences/focus-clock";
import "../signal-deck.css";
import "../planning-mode-selector.css";
import "./settings.css";
import "../fixed-layer-safety.css";

type AIStatus = { models: string[]; provider: string; reachable: boolean };
type LoadState = "loading" | "ready" | "error";
type PlanState = "loading" | "ready" | "error" | "no-plan";
type SettingsSection = "general" | "appearance" | "focus" | "planning" | "integrations" | "account" | "system" | "help";

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

// Settings -> AI (Phase 2 of the operating-engine plan). The provider
// report remains read-only: it is a server capability, not a per-user
// preference.
export default function SignalDeckSettingsPage() {
  const [activeSection, setActiveSection] = useState<SettingsSection>("appearance");
  const [status, setStatus] = useState<AIStatus | null>(null);
  const [state, setState] = useState<LoadState>("loading");
  const [showFocusClock, setShowFocusClock] = useFocusClockPreference();

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

      <div className="a02-settings-workspace">
        <nav className="a02-settings-nav" aria-label="Settings sections">
          <span>SETTINGS</span>
          <button type="button" className={activeSection === "general" ? "is-active" : ""} onClick={() => setActiveSection("general")}>General</button>
          <button type="button" className={activeSection === "appearance" ? "is-active" : ""} onClick={() => setActiveSection("appearance")}>Appearance</button>
          <button type="button" className={activeSection === "focus" ? "is-active" : ""} onClick={() => setActiveSection("focus")}>Focus</button>
          <button type="button" className={activeSection === "planning" ? "is-active" : ""} onClick={() => setActiveSection("planning")}>Planning &amp; Route</button>
          <button type="button" className={activeSection === "integrations" ? "is-active" : ""} onClick={() => setActiveSection("integrations")}>Integrations</button>
          <button type="button" className={activeSection === "account" ? "is-active" : ""} onClick={() => setActiveSection("account")}>Account</button>
          <button type="button" className={activeSection === "system" ? "is-active" : ""} onClick={() => setActiveSection("system")}>System</button>
          <button type="button" className={activeSection === "help" ? "is-active" : ""} onClick={() => setActiveSection("help")}>Help</button>
          <small>COMING LATER</small>
          <i>Kanban · Goals · Listen<br />Notifications · Tutor</i>
        </nav>

        <div className="a02-settings-content">
          {activeSection === "general" && <GeneralSettings />}
          {activeSection === "appearance" && <section className="a02-product-state a02-settings-card" aria-label="Appearance settings"><DockStyleChooser /></section>}
          {activeSection === "focus" && (
            <section className="a02-product-state a02-settings-card" aria-labelledby="focus-settings-title">
              <b id="focus-settings-title">Focus mode</b>
              <label className="a02-settings-toggle">
                <span>
                  <strong>Show clock in Focus Mode</strong>
                  <small>Keep the current time available without competing with your focus timer.</small>
                </span>
                <input type="checkbox" role="switch" checked={showFocusClock} onChange={(event) => setShowFocusClock(event.target.checked)} />
              </label>
            </section>
          )}
          {activeSection === "account" && <AccountSettings />}
          {activeSection === "help" && <HelpSettings />}

          {activeSection === "system" && <section className="a02-product-state a02-settings-card" aria-labelledby="ai-settings-title">
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
          </section>}

          {activeSection === "planning" && <>
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
      <section className="a02-product-state a02-settings-card" aria-labelledby="route-tools-title">
        <b id="route-tools-title">Route tools</b>
        <p className="a02-settings-note">Import an existing route or export the route you have. These tools use the same active plan as Signal Deck.</p>
        <Link href="/architecture-02/onboarding/import" className="a02-settings-action">Open import / export ↗</Link>
      </section>
          </>}

          {activeSection === "integrations" && <section className="a02-product-state a02-settings-card" aria-labelledby="calendar-settings-title">
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
          </section>}
        </div>
      </div>
    </main>
  );
}

function GeneralSettings() {
  const router = useRouter();
  const [timezone, setTimezone] = useState("UTC");
  const [state, setState] = useState<LoadState>("loading");
  const [notice, setNotice] = useState<string | null>(null);
  const zones = useMemo(() => {
    const supported = typeof Intl.supportedValuesOf === "function" ? Intl.supportedValuesOf("timeZone") : ["UTC"];
    return Array.from(new Set(["UTC", Intl.DateTimeFormat().resolvedOptions().timeZone, ...supported])).filter(Boolean).sort();
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(async () => {
      const supabase = createClient();
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) { setState("error"); return; }
      const { data, error } = await supabase.from("profiles").select("timezone").eq("id", user.id).maybeSingle();
      if (error) { setState("error"); return; }
      setTimezone(data?.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone ?? "UTC");
      setState("ready");
    }, 0);
    return () => window.clearTimeout(timer);
  }, []);

  const saveTimezone = async (next: string) => {
    setTimezone(next);
    setNotice(null);
    const supabase = createClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) { setNotice("Sign in to save your time zone."); return; }
    const { error } = await supabase.from("profiles").update({ timezone: next }).eq("id", user.id);
    setNotice(error ? "Couldn’t save that time zone. Try again." : "Time zone saved.");
  };

  const replayGuide = () => {
    try { window.localStorage.removeItem("mtdo:signal-deck:walkthrough"); } catch { /* navigation still works */ }
    router.push("/architecture-02");
  };

  return <>
    <section className="a02-product-state a02-settings-card" aria-labelledby="general-time-title">
      <b id="general-time-title">Time zone</b>
      <p className="a02-settings-note">Sets the local day used by Today, Review, and calendar sync.</p>
      {state === "loading" && <p>Reading your time zone…</p>}
      {state === "error" && <p role="alert">Couldn’t read your profile time zone.</p>}
      {state === "ready" && <label className="a02-settings-select"><span>Current time zone</span><select value={timezone} onChange={(event) => void saveTimezone(event.target.value)}>{zones.map((zone) => <option key={zone} value={zone}>{zone}</option>)}</select></label>}
      {notice && <p className="a02-settings-note" role="status">{notice}</p>}
    </section>
    <section className="a02-product-state a02-settings-card" aria-labelledby="guide-title">
      <b id="guide-title">Field Guide</b>
      <p className="a02-settings-note">Replay the existing Signal Deck walkthrough whenever you want a quick tour of the route, Kanban, focus, and review loop.</p>
      <button type="button" className="a02-settings-action" onClick={replayGuide}>Replay Field Guide ↗</button>
    </section>
  </>;
}

function AccountSettings() {
  const router = useRouter();
  const [name, setName] = useState("");
  const [email, setEmail] = useState<string | null>(null);
  const [state, setState] = useState<LoadState>("loading");
  const [notice, setNotice] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    const timer = window.setTimeout(async () => {
      const supabase = createClient();
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) { setState("error"); return; }
      const { data, error } = await supabase.from("profiles").select("display_name").eq("id", user.id).maybeSingle();
      if (error) { setState("error"); return; }
      setName(data?.display_name ?? "");
      setEmail(user.email ?? null);
      setState("ready");
    }, 0);
    return () => window.clearTimeout(timer);
  }, []);

  const save = async () => {
    setSaving(true); setNotice(null);
    const supabase = createClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) { setSaving(false); setNotice("Sign in to save your profile."); return; }
    const { error } = await supabase.from("profiles").update({ display_name: name.trim() || null }).eq("id", user.id);
    setSaving(false); setNotice(error ? "Couldn’t save your profile. Try again." : "Profile saved.");
  };

  const resetPassword = async () => {
    if (!email) return;
    const redirectTo = `${window.location.origin}/auth/callback?next=${encodeURIComponent("/architecture-02?auth=reset")}`;
    const { error } = await createClient().auth.resetPasswordForEmail(email, { redirectTo });
    setNotice(error ? "Couldn’t send a password-reset link. Try again." : "If this account supports password login, a secure reset link is on its way.");
  };

  const signOut = async () => {
    setSaving(true);
    const { error } = await createClient().auth.signOut();
    if (error) { setSaving(false); setNotice("Couldn’t log out. Try again."); return; }
    router.replace("/architecture-02?auth=logged-out");
    router.refresh();
  };

  return <section className="a02-product-state a02-settings-card" aria-labelledby="account-title">
    <b id="account-title">Account</b>
    {state === "loading" && <p>Reading your account…</p>}
    {state === "error" && <p role="alert">Couldn’t read account details. Open the profile menu on Deck to try again.</p>}
    {state === "ready" && <div className="a02-settings-form">
      <label><span>Display name</span><input value={name} maxLength={80} onChange={(event) => setName(event.target.value)} placeholder="How MTDO should address you" /></label>
      <label><span>Email</span><input value={email ?? "Guest route"} readOnly aria-readonly="true" /></label>
      <div className="a02-settings-actions"><button type="button" className="a02-settings-action" onClick={() => void save()} disabled={saving}>{saving ? "Saving…" : "Save profile"}</button><button type="button" className="a02-settings-secondary" onClick={() => void resetPassword()} disabled={!email || saving}>Reset password</button><button type="button" className="a02-settings-danger" onClick={() => void signOut()} disabled={saving}>Log out</button></div>
    </div>}
    {notice && <p className="a02-settings-note" role="status">{notice}</p>}
  </section>;
}

function HelpSettings() {
  return <>
    <section className="a02-product-state a02-settings-card" aria-labelledby="shortcuts-title">
      <b id="shortcuts-title">Keyboard shortcuts</b>
      <div className="a02-shortcuts"><span><kbd>?</kbd> Open Field Guide</span><span><kbd>M</kbd> Open Navigation Wheel</span><span><kbd>Space</kbd> Play / pause Radio</span><span><kbd>N</kbd> Next radio station</span><span><kbd>P</kbd> Previous radio station</span><span><kbd>F</kbd> Favourite radio station</span></div>
      <p className="a02-settings-note">Shortcuts run only when focus is not in a text field. Shortcut remapping is not available yet.</p>
    </section>
    <section className="a02-product-state a02-settings-card" aria-labelledby="feedback-title">
      <b id="feedback-title">Feedback</b>
      <p className="a02-settings-note">Use the Feedback control at the lower-right of the app to send product feedback with the current screen attached.</p>
    </section>
  </>;
}
