import type { AuthError, SupabaseClient } from "@supabase/supabase-js";

// Anonymous -> real account upgrade (docs/architecture/decisions.md: "Supabase
// anonymous auth from first visit, upgraded in place"). This is the upgrade
// MECHANISM only -- deciding *when* to show the prompt ("a streak worth
// losing") is a separate, frontend concern that calls into this module.
//
// The load-bearing rule: never sign the user out and create a fresh account.
// The whole point is that auth.uid() does not change -- every activity_events
// row, plan, and block the anonymous user already has stays attached. Both
// paths below act on the EXISTING session via updateUser()/linkIdentity(),
// never signUp()/signInWithPassword() from a clean slate.

export type UpgradeOutcome = {
  ok: boolean;
  /** Present when ok is true. True if Supabase requires an email confirmation
   *  click before the account is no longer anonymous (see syncIsAnonymousFlag). */
  pendingEmailConfirmation?: boolean;
  /** Friendly, already-classified message. Null when ok is true and no
   *  follow-up is needed (rare -- password-only upgrades with confirmations
   *  disabled resolve immediately). */
  message: string | null;
  /** Raw Supabase error, for callers that want to branch further/log it. */
  error?: AuthError | null;
};

// Supabase's stable string error codes (GoTrueError.code) for this call --
// checked first, since messages are not guaranteed to stay stable across
// versions. Substring fallback below covers older/self-hosted GoTrue.
const EMAIL_TAKEN_CODES = new Set(["email_exists", "user_already_exists"]);
const IDENTITY_TAKEN_CODES = new Set(["identity_already_exists"]);
const WEAK_PASSWORD_CODES = new Set(["weak_password"]);

function classifyUpdateUserError(error: AuthError): string {
  const code = (error as { code?: string }).code;
  const msg = error.message ?? "";

  if (code ? EMAIL_TAKEN_CODES.has(code) : /already registered|already exists|already in use/i.test(msg)) {
    return "That email is already registered to another account. Log in with that account instead, or use a different email.";
  }
  if (code ? WEAK_PASSWORD_CODES.has(code) : /password.*(weak|short|characters)/i.test(msg)) {
    return "Choose a longer password -- Supabase requires at least 6 characters.";
  }
  if (/rate limit/i.test(msg)) {
    return "Too many attempts. Wait a moment and try again.";
  }
  return error.message || "Couldn't save that. Try again.";
}

function classifyLinkIdentityError(error: AuthError): string {
  const code = (error as { code?: string }).code;
  const msg = error.message ?? "";

  if (code ? IDENTITY_TAKEN_CODES.has(code) : /already.*linked|already exists/i.test(msg)) {
    return "That account is already linked to a different mtdo login. Log in with it directly instead.";
  }
  if (/rate limit/i.test(msg)) {
    return "Too many attempts. Wait a moment and try again.";
  }
  return error.message || "Couldn't connect that account. Try again.";
}

/**
 * Reads the real is_anonymous flag off the auth user (not assumed) and mirrors
 * it onto profiles.is_anonymous. profiles.is_anonymous is informational only
 * (schema.md §2, decisions.md) -- it is never read as an auth signal -- so
 * getting this slightly stale is not a security bug, but it should still
 * reflect reality for any UI that reads it (e.g. "you're on a guest account"
 * banners). Exported so app/auth/callback/route.ts can call the same sync
 * after an OAuth linkIdentity redirect completes.
 */
export async function syncIsAnonymousFlag(
  supabase: SupabaseClient,
): Promise<{ isAnonymous: boolean | null; email: string | null }> {
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) return { isAnonymous: null, email: null };

  // Best-effort: profiles is client select/update-able (schema.md §6), so
  // this is a normal authenticated write, not a privileged one. A failure
  // here (e.g. offline) must not be surfaced as an upgrade failure -- the
  // auth-side upgrade already succeeded or is pending independently of it.
  await supabase
    .from("profiles")
    .update({ is_anonymous: user.is_anonymous ?? false })
    .eq("id", user.id);

  return { isAnonymous: user.is_anonymous ?? false, email: user.email ?? null };
}

/**
 * Email/password upgrade path. Calls updateUser() on the current (anonymous)
 * session -- this attaches the credential to the existing user id rather than
 * creating a new one. If Supabase has email confirmations enabled (the
 * default), the account remains anonymous until the confirmation link is
 * clicked; the caller should tell the user to check their email in that case
 * rather than treating the flow as finished.
 */
export async function upgradeWithEmailPassword(
  supabase: SupabaseClient,
  email: string,
  password: string,
  options?: { emailRedirectTo?: string },
): Promise<UpgradeOutcome> {
  const { data, error } = await supabase.auth.updateUser(
    { email, password },
    options?.emailRedirectTo ? { emailRedirectTo: options.emailRedirectTo } : undefined,
  );

  if (error) {
    return { ok: false, message: classifyUpdateUserError(error), error };
  }

  // updateUser's response reflects the *pending* state immediately after the
  // call, not necessarily the confirmed state -- re-check via getUser() so
  // the flag we persist is accurate rather than optimistic.
  const { isAnonymous } = await syncIsAnonymousFlag(supabase);

  if (isAnonymous === null) {
    // getUser() itself failed (network blip, cookie propagation race) right
    // after a successful updateUser() call. The credential IS saved -- don't
    // conflate "we can't confirm the resulting state" with "still anonymous,
    // check your email," which would tell the user to look for a link that
    // may not exist and may already be fully upgraded.
    return {
      ok: true,
      pendingEmailConfirmation: undefined,
      message: "Saved, but we couldn't confirm the upgrade finished -- refresh the page to check.",
    };
  }

  const stillPendingConfirmation = isAnonymous === true;

  return {
    ok: true,
    pendingEmailConfirmation: stillPendingConfirmation,
    message: stillPendingConfirmation
      ? `Check ${data.user?.email ?? email} for a confirmation link to finish upgrading.`
      : null,
  };
}

export type OAuthProvider = "google" | "github";

/**
 * OAuth upgrade path. linkIdentity() attaches the provider identity to the
 * CURRENT session and redirects the browser there and back -- it does not
 * return a result to await, so there is nothing further to do here. The
 * redirect target (app/auth/callback/route.ts) finishes the exchange and
 * calls syncIsAnonymousFlag() itself.
 */
export async function upgradeWithOAuth(
  supabase: SupabaseClient,
  provider: OAuthProvider,
  redirectTo: string,
): Promise<UpgradeOutcome> {
  const { error } = await supabase.auth.linkIdentity({
    provider,
    options: { redirectTo },
  });

  if (error) {
    return { ok: false, message: classifyLinkIdentityError(error), error };
  }

  // On success the browser is already navigating away; this return value is
  // reachable only if the redirect is somehow suppressed (e.g. a test env).
  return { ok: true, message: null };
}
