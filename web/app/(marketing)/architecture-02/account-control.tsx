"use client";

import { useCallback, useEffect, useState, type FormEvent } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import type { User } from "@supabase/supabase-js";

import { upgradeWithEmailPassword } from "@/lib/auth/upgradeAccount";
import { createClient } from "@/lib/supabase/client";

type AccountView = "forgot" | "login" | "logout" | "profile" | "reset" | "settings" | "signup" | null;

type Viewer = {
  email: string | null;
  id: string;
  isAnonymous: boolean;
  name: string | null;
};

function initials(name: string | null, email: string | null): string {
  const source = name?.trim() || email?.trim() || "Guest";
  const words = source.split(/[\s@._-]+/).filter(Boolean);
  return words.slice(0, 2).map((word) => word[0]?.toUpperCase()).join("") || "G";
}

function accountError(error: { message?: string } | null | undefined, fallback: string): string {
  if (!error?.message) return fallback;
  if (/invalid login credentials/i.test(error.message)) return "That email and password do not match an account.";
  if (/email not confirmed/i.test(error.message)) return "Confirm your email first, then return here to log in.";
  if (/rate limit/i.test(error.message)) return "Too many attempts. Wait a moment, then try again.";
  return error.message;
}

function accountFrom(user: User, displayName: string | null): Viewer {
  return {
    id: user.id,
    email: user.email ?? null,
    isAnonymous: user.is_anonymous ?? false,
    name: displayName || (typeof user.user_metadata.display_name === "string" ? user.user_metadata.display_name : null),
  };
}

/**
 * Architecture 02's account control. Supabase creates an anonymous identity
 * before this mounts; account creation upgrades that identity in place so a
 * route, blocks, sessions, and progress never move to a different user id.
 */
export function SignalDeckAccountControl() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const authState = searchParams.get("auth");
  const [viewer, setViewer] = useState<Viewer | null>(null);
  const [loadingViewer, setLoadingViewer] = useState(true);
  const [menuOpen, setMenuOpen] = useState(false);
  const [view, setView] = useState<AccountView>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const refreshViewer = useCallback(async () => {
    const supabase = createClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) {
      setViewer(null);
      setLoadingViewer(false);
      return;
    }
    const { data: profile } = await supabase
      .from("profiles")
      .select("display_name")
      .eq("id", user.id)
      .maybeSingle();
    setViewer(accountFrom(user, profile?.display_name ?? null));
    setLoadingViewer(false);
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => void refreshViewer(), 0);
    const supabase = createClient();
    const { data: listener } = supabase.auth.onAuthStateChange((event) => {
      if (event === "SIGNED_OUT") {
        setNotice("Your saved session ended. Log in to return to your account.");
        setView("login");
      }
      window.setTimeout(() => void refreshViewer(), 0);
    });
    const authTimer = window.setTimeout(() => {
      if (authState === "reset") setView("reset");
      if (authState === "login") {
        setNotice("Confirming the link did not create a session. Log in to continue.");
        setView("login");
      }
      if (authState === "confirmation-error") {
        setNotice("That confirmation link is invalid or has expired. Request a fresh link, then try again.");
        setView("signup");
      }
      if (authState === "reset-error") {
        setNotice("That reset link is invalid or has expired. Request a fresh reset link to continue.");
        setView("forgot");
      }
      if (authState === "callback-error") {
        setNotice("We could not finish that secure link. Return to your account and try again.");
        setView("login");
      }
      if (authState === "logged-out") setNotice("You are now using a new guest route. Log in any time to return to your account.");
    }, 0);

    return () => {
      window.clearTimeout(timer);
      window.clearTimeout(authTimer);
      listener.subscription.unsubscribe();
    };
  }, [authState, refreshViewer]);

  const open = (nextView: Exclude<AccountView, null>) => {
    setMenuOpen(false);
    setNotice(null);
    setView(nextView);
  };

  const close = () => setView(null);

  const finishedUpgrade = () => {
    close();
    router.push("/architecture-02/onboarding");
  };

  return <div className="a02-account-control">
    <button
      type="button"
      className={`a02-account-trigger ${viewer?.isAnonymous || !viewer ? "is-guest" : ""}`}
      onClick={() => setMenuOpen((isOpen) => !isOpen)}
      aria-label={viewer?.isAnonymous || !viewer ? "Open guest account menu" : "Open profile menu"}
      aria-expanded={menuOpen}
    >
      <span>{loadingViewer ? "…" : initials(viewer?.name ?? null, viewer?.email ?? null)}</span>
      <i>{viewer?.isAnonymous || !viewer ? "GUEST" : "PROFILE"}</i>
    </button>

    {menuOpen && <section className="a02-account-menu" aria-label="Account menu">
      <header>
        <span className="a02-live-pip" />
        <div><b>{viewer?.isAnonymous || !viewer ? "Guest route" : viewer?.name || "Personal route"}</b><small>{viewer?.isAnonymous || !viewer ? "Save this work to an account." : viewer.email}</small></div>
      </header>
      {viewer?.isAnonymous || !viewer ? <>
        <button type="button" onClick={() => open("signup")}>Create account <i>↗</i></button>
        <button type="button" onClick={() => open("login")}>Log in <i>→</i></button>
      </> : <>
        <button type="button" onClick={() => open("profile")}>Profile <i>↗</i></button>
        <button type="button" onClick={() => open("settings")}>Settings <i>⌘</i></button>
        <a href="/theme-studio">Theme studio <i>↗</i></a>
        <button type="button" className="a02-account-menu-logout" onClick={() => open("logout")}>Log out <i>×</i></button>
      </>}
    </section>}

    {notice && !view && <p className="a02-account-notice" role="status">{notice}</p>}
    {view && <AccountDialog viewer={viewer} view={view} sessionNotice={notice} onClose={close} onOpen={open} onRefresh={() => void refreshViewer()} onUpgrade={finishedUpgrade} />}
  </div>;
}

function AccountDialog({
  viewer,
  view,
  sessionNotice,
  onClose,
  onOpen,
  onRefresh,
  onUpgrade,
}: {
  viewer: Viewer | null;
  view: Exclude<AccountView, null>;
  sessionNotice: string | null;
  onClose: () => void;
  onOpen: (view: Exclude<AccountView, null>) => void;
  onRefresh: () => void;
  onUpgrade: () => void;
}) {
  const router = useRouter();
  const [email, setEmail] = useState(viewer?.email ?? "");
  const [password, setPassword] = useState("");
  const [name, setName] = useState(viewer?.name ?? "");
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const isGuest = viewer?.isAnonymous ?? true;

  const resetMessages = () => {
    setError(null);
    setStatus(null);
  };

  const close = () => {
    if (submitting) return;
    onClose();
  };

  const upgrade = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (submitting) return;
    setSubmitting(true);
    resetMessages();
    const redirectTo = `${window.location.origin}/auth/callback?next=${encodeURIComponent("/architecture-02?auth=confirmed")}`;
    const result = await upgradeWithEmailPassword(createClient(), email.trim(), password, { emailRedirectTo: redirectTo });
    if (!result.ok) {
      setSubmitting(false);
      setError(result.message);
      return;
    }
    // The anonymous user id remains unchanged through updateUser(), so this
    // writes the name to that same RLS-owned profile rather than introducing
    // a second account/onboarding record. A missing name is intentionally OK.
    if (viewer && name.trim()) {
      const { error: nameError } = await createClient()
        .from("profiles")
        .update({ display_name: name.trim() })
        .eq("id", viewer.id);
      if (nameError) console.error("[account] could not save display name:", nameError);
    }
    setSubmitting(false);
    if (result.pendingEmailConfirmation) {
      setStatus(result.message ?? "Check your email to finish saving this route.");
      return;
    }
    onUpgrade();
  };

  const login = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (submitting) return;
    setSubmitting(true);
    resetMessages();
    const { error: signInError } = await createClient().auth.signInWithPassword({ email: email.trim(), password });
    setSubmitting(false);
    if (signInError) {
      setError(accountError(signInError, "We could not log you in."));
      return;
    }
    // A returning account should resume the live Today board, where its
    // persisted route and UTC-day blocks already live.
    router.replace("/architecture-02?deck=work");
    router.refresh();
  };

  const sendReset = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (submitting) return;
    setSubmitting(true);
    resetMessages();
    const redirectTo = `${window.location.origin}/auth/callback?next=${encodeURIComponent("/architecture-02?auth=reset")}`;
    const { error: resetError } = await createClient().auth.resetPasswordForEmail(email.trim(), { redirectTo });
    setSubmitting(false);
    if (resetError) {
      setError(accountError(resetError, "We could not send a reset link."));
      return;
    }
    setStatus("If that email has an account, a secure reset link is on its way.");
  };

  const setNewPassword = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (submitting) return;
    setSubmitting(true);
    resetMessages();
    const { error: updateError } = await createClient().auth.updateUser({ password });
    setSubmitting(false);
    if (updateError) {
      setError(accountError(updateError, "We could not reset your password."));
      return;
    }
    setStatus("Password updated. You can continue to Signal Deck.");
  };

  const saveProfile = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!viewer || submitting) return;
    setSubmitting(true);
    resetMessages();
    const { error: profileError } = await createClient().from("profiles")
      .update({ display_name: name.trim() || null })
      .eq("id", viewer.id);
    setSubmitting(false);
    if (profileError) {
      setError("We could not save your profile. Try again.");
      return;
    }
    setStatus("Profile saved.");
    onRefresh();
  };

  const logout = async () => {
    if (submitting) return;
    setSubmitting(true);
    resetMessages();
    const { error: signOutError } = await createClient().auth.signOut();
    if (signOutError) {
      setSubmitting(false);
      setError(accountError(signOutError, "We could not log you out."));
      return;
    }
    router.replace("/architecture-02?auth=logged-out");
    router.refresh();
  };

  const title = view === "signup" ? "Keep the route." : view === "login" ? "Welcome back." : view === "forgot" ? "Find your way back." : view === "reset" ? "Choose a new key." : view === "profile" ? "Your signal." : view === "logout" ? "Leave the route?" : "Account settings.";

  return <section className="a02-account-overlay" role="dialog" aria-modal="true" aria-labelledby="a02-account-title">
    <div className="a02-account-dialog">
      <button type="button" className="a02-account-close" onClick={close} disabled={submitting} aria-label="Close account panel">ESC / close ×</button>
      <span className="a02-eyebrow">{view === "signup" ? "SAVE YOUR ROUTE" : view === "login" ? "ACCOUNT ACCESS" : "PERSONAL SIGNAL"}</span>
      <h2 id="a02-account-title">{title}</h2>

      {view === "signup" && <form onSubmit={upgrade} className="a02-account-form">
        <p>Turn this guest route into an account. Your existing plan, blocks, sessions, and record stay attached.</p>
        {sessionNotice && <p className="a02-account-status" role="status">{sessionNotice}</p>}
        <label>Name <small>OPTIONAL</small><input autoFocus autoComplete="name" value={name} onChange={(event) => setName(event.target.value)} maxLength={80} disabled={submitting} placeholder="How should MTDO address you?" /></label>
        <AccountFields email={email} password={password} onEmail={setEmail} onPassword={setPassword} submitting={submitting} passwordHint="At least 6 characters" passwordAutoComplete="new-password" />
        <Status status={status} error={error} />
        <button className="a02-account-primary" type="submit" disabled={submitting}>{submitting ? "Saving route…" : "Create account ↗"}</button>
        <button className="a02-account-switch" type="button" onClick={() => onOpen("login")} disabled={submitting}>Already have an account? Log in</button>
      </form>}

      {view === "login" && <form onSubmit={login} className="a02-account-form">
        <p>{isGuest ? "Logging in opens your existing route. This guest route stays separate until you choose to save it." : "Restore your route, work, and record."}</p>
        {sessionNotice && <p className="a02-account-status" role="status">{sessionNotice}</p>}
        <AccountFields email={email} password={password} onEmail={setEmail} onPassword={setPassword} submitting={submitting} />
        <Status status={status} error={error} />
        <button className="a02-account-primary" type="submit" disabled={submitting}>{submitting ? "Restoring…" : "Log in →"}</button>
        <button className="a02-account-switch" type="button" onClick={() => onOpen("forgot")} disabled={submitting}>Forgot password?</button>
        {isGuest && <button className="a02-account-switch" type="button" onClick={() => onOpen("signup")} disabled={submitting}>Create an account for this route</button>}
      </form>}

      {view === "forgot" && <form onSubmit={sendReset} className="a02-account-form">
        <p>Enter the email on your account. We will send a secure link if an account is available.</p>
        {sessionNotice && <p className="a02-account-status" role="status">{sessionNotice}</p>}
        <label>Email<input autoFocus type="email" autoComplete="email" value={email} onChange={(event) => setEmail(event.target.value)} required disabled={submitting} /></label>
        <Status status={status} error={error} />
        <button className="a02-account-primary" type="submit" disabled={submitting}>{submitting ? "Sending…" : "Send reset link ↗"}</button>
        <button className="a02-account-switch" type="button" onClick={() => onOpen("login")} disabled={submitting}>← Back to login</button>
      </form>}

      {view === "reset" && <form onSubmit={setNewPassword} className="a02-account-form">
        <p>Choose a new password for this account, then return to Signal Deck.</p>
        <label>New password <small>AT LEAST 6 CHARACTERS</small><input autoFocus type="password" autoComplete="new-password" minLength={6} value={password} onChange={(event) => setPassword(event.target.value)} required disabled={submitting} /></label>
        <Status status={status} error={error} />
        {status ? <button className="a02-account-primary" type="button" onClick={() => { router.replace("/architecture-02"); router.refresh(); }} disabled={submitting}>Return to deck ↗</button> : <button className="a02-account-primary" type="submit" disabled={submitting}>{submitting ? "Updating…" : "Update password ↗"}</button>}
      </form>}

      {view === "profile" && <form onSubmit={saveProfile} className="a02-account-form">
        <div className="a02-account-profile-mark">{initials(viewer?.name ?? null, viewer?.email ?? null)}</div>
        <p>Profile image upload is not available yet. Your account details remain private to your route.</p>
        <label>Display name<input autoFocus value={name} onChange={(event) => setName(event.target.value)} maxLength={80} disabled={submitting} placeholder="How should MTDO address you?" /></label>
        <label>Email<input value={viewer?.email ?? "Guest route"} disabled /></label>
        <Status status={status} error={error} />
        <button className="a02-account-primary" type="submit" disabled={submitting}>{submitting ? "Saving…" : "Save profile ↗"}</button>
      </form>}

      {view === "settings" && <section className="a02-account-form">
        <p>Account controls are deliberately small: your route and history follow your authenticated account.</p>
        <div className="a02-account-setting"><span>Theme preference</span><a href="/theme-studio">Open Theme Studio ↗</a></div>
        <div className="a02-account-setting"><span>Session</span><b>{viewer?.email ?? "Guest route"}</b></div>
        <Status status={status} error={error} />
        <button className="a02-account-danger" type="button" onClick={() => void logout()} disabled={submitting}>{submitting ? "Logging out…" : "Log out"}</button>
      </section>}

      {view === "logout" && <section className="a02-account-form">
        <p>Logging out returns this browser to a fresh guest route. Your saved account remains available when you log in again.</p>
        <Status status={status} error={error} />
        <button className="a02-account-danger" type="button" onClick={() => void logout()} disabled={submitting}>{submitting ? "Logging out…" : "Log out"}</button>
        <button className="a02-account-switch" type="button" onClick={() => onOpen("settings")} disabled={submitting}>Keep working</button>
      </section>}
    </div>
  </section>;
}

function AccountFields({ email, password, onEmail, onPassword, passwordAutoComplete = "current-password", submitting, passwordHint }: { email: string; password: string; onEmail: (value: string) => void; onPassword: (value: string) => void; passwordAutoComplete?: "current-password" | "new-password"; passwordHint?: string; submitting: boolean }) {
  return <><label>Email<input autoFocus type="email" autoComplete="email" value={email} onChange={(event) => onEmail(event.target.value)} required disabled={submitting} /></label><label>Password {passwordHint && <small>{passwordHint}</small>}<input type="password" autoComplete={passwordAutoComplete} minLength={6} value={password} onChange={(event) => onPassword(event.target.value)} required disabled={submitting} /></label></>;
}

function Status({ status, error }: { status: string | null; error: string | null }) {
  if (error) return <p className="a02-account-error" role="alert">{error}</p>;
  if (status) return <p className="a02-account-status" role="status">{status}</p>;
  return null;
}
