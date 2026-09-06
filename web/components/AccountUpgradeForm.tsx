"use client";

import { useCallback, useState, type FormEvent } from "react";
import { createClient } from "@/lib/supabase/client";
import {
  upgradeWithEmailPassword,
  upgradeWithOAuth,
  type OAuthProvider,
} from "@/lib/auth/upgradeAccount";
import styles from "./AccountUpgradeForm.module.css";

/**
 * Anonymous -> real account upgrade form. This is the MECHANISM only --
 * deciding when to show it ("a streak worth losing", per decisions.md's
 * delayed-signup rule) is a separate frontend decision made by whatever
 * screen renders this component. That screen owns:
 *   - whether/when to mount this component at all
 *   - any modal/dialog chrome around it (this renders as a plain card so it
 *     composes into either)
 *   - what happens on dismiss (onDismiss) and on success (onUpgraded)
 *
 * Upgrading never signs the user out or creates a new account -- both paths
 * act on the current anonymous session in place (lib/auth/upgradeAccount.ts).
 */
export interface AccountUpgradeFormProps {
  /** Called once the account is fully upgraded (is_anonymous confirmed
   *  false) -- NOT called for a submission that only sent a confirmation
   *  email, since the account is still anonymous until that link is clicked. */
  onUpgraded?: (info: { email: string }) => void;
  /** Called when the user backs out without upgrading. */
  onDismiss?: () => void;
  /** OAuth providers to offer, in order. Omit/empty to show email/password
   *  only -- callers should only pass providers actually enabled in the
   *  Supabase project's Auth settings. */
  oauthProviders?: OAuthProvider[];
  /** Where OAuth should return the user after linking (defaults to the
   *  current path). Passed through as ?next= on the callback redirect. */
  returnTo?: string;
  className?: string;
}

const PROVIDER_LABEL: Record<OAuthProvider, string> = {
  google: "Continue with Google",
  github: "Continue with GitHub",
};

export function AccountUpgradeForm({
  onUpgraded,
  onDismiss,
  oauthProviders = [],
  returnTo,
  className,
}: AccountUpgradeFormProps) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [oauthPending, setOauthPending] = useState<OAuthProvider | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pendingConfirmation, setPendingConfirmation] = useState<string | null>(null);

  const handleSubmit = useCallback(
    async (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      if (submitting) return;
      setSubmitting(true);
      setError(null);
      setPendingConfirmation(null);

      const supabase = createClient();
      const result = await upgradeWithEmailPassword(supabase, email, password);
      setSubmitting(false);

      if (!result.ok) {
        setError(result.message);
        return;
      }
      if (result.pendingEmailConfirmation) {
        setPendingConfirmation(result.message);
        return;
      }
      onUpgraded?.({ email });
    },
    [email, onUpgraded, password, submitting],
  );

  const handleOAuth = useCallback(
    async (provider: OAuthProvider) => {
      if (oauthPending) return;
      setOauthPending(provider);
      setError(null);

      const supabase = createClient();
      const next = returnTo ?? window.location.pathname;
      const redirectTo = `${window.location.origin}/auth/callback?next=${encodeURIComponent(next)}`;
      const result = await upgradeWithOAuth(supabase, provider, redirectTo);

      // A success here means the redirect didn't happen (unusual) -- an
      // ordinary success navigates the browser away before this line runs.
      if (!result.ok) {
        setOauthPending(null);
        setError(result.message);
      }
    },
    [oauthPending, returnTo],
  );

  return (
    <div className={[styles.card, className].filter(Boolean).join(" ")}>
      <p className={styles.eyebrow}>Save your progress</p>
      <h2 className={styles.title}>Keep this streak</h2>
      <p className={styles.intro}>
        Add an email and password (or connect an account) and everything you&rsquo;ve already done
        stays exactly where it is -- nothing to redo, nothing to lose.
      </p>

      {pendingConfirmation ? (
        <p className={styles.notice} role="status">
          {pendingConfirmation}
        </p>
      ) : (
        <>
          <form className={styles.form} onSubmit={handleSubmit} noValidate>
            <label className={styles.field}>
              <span>Email</span>
              <input
                type="email"
                name="email"
                autoComplete="email"
                required
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                disabled={submitting || oauthPending !== null}
              />
            </label>
            <label className={styles.field}>
              <span>Password</span>
              <input
                type="password"
                name="password"
                autoComplete="new-password"
                required
                minLength={6}
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                disabled={submitting || oauthPending !== null}
              />
            </label>

            {error ? (
              <p className={styles.error} role="alert">
                {error}
              </p>
            ) : null}

            <button
              type="submit"
              className={styles.submitButton}
              disabled={submitting || oauthPending !== null}
            >
              {submitting ? "Saving..." : "Create my account"}
            </button>
          </form>

          {oauthProviders.length > 0 ? (
            <div className={styles.oauthGroup}>
              <span className={styles.divider}>or</span>
              {oauthProviders.map((provider) => (
                <button
                  key={provider}
                  type="button"
                  className={styles.oauthButton}
                  onClick={() => void handleOAuth(provider)}
                  disabled={submitting || oauthPending !== null}
                >
                  {oauthPending === provider ? "Connecting..." : PROVIDER_LABEL[provider]}
                </button>
              ))}
            </div>
          ) : null}
        </>
      )}

      {onDismiss ? (
        <button type="button" className={styles.dismissButton} onClick={onDismiss}>
          Not now
        </button>
      ) : null}
    </div>
  );
}
