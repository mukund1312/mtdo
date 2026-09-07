"use client";

import { useEffect, useState } from "react";

import { createClient } from "@/lib/supabase/client";

type WelcomeState =
  | { kind: "loading" }
  | { kind: "ready"; name: string | null }
  | { kind: "error" };

type SignalDeckConfirmedWelcomeProps = {
  onBeginGuide: (name: string | null) => void;
  onRecover: () => void;
  onSkipToOnboarding: () => void;
};

/**
 * The only success surface after a real email-confirmation callback. It reads
 * the authenticated session and its existing profile under RLS; it never
 * treats a query parameter as proof that a user is signed in.
 */
export function SignalDeckConfirmedWelcome({
  onBeginGuide,
  onRecover,
  onSkipToOnboarding,
}: SignalDeckConfirmedWelcomeProps) {
  const [state, setState] = useState<WelcomeState>({ kind: "loading" });

  useEffect(() => {
    let cancelled = false;

    async function loadWelcome() {
      const supabase = createClient();
      const {
        data: { user },
      } = await supabase.auth.getUser();

      // A callback URL alone is never sufficient. If Supabase did not create
      // a non-anonymous session, expose recovery instead of a false welcome.
      if (!user || user.is_anonymous) {
        if (!cancelled) setState({ kind: "error" });
        return;
      }

      const { data: profile } = await supabase
        .from("profiles")
        .select("display_name")
        .eq("id", user.id)
        .maybeSingle();

      const metadataName = typeof user.user_metadata.display_name === "string"
        ? user.user_metadata.display_name.trim()
        : "";
      const name = profile?.display_name?.trim() || metadataName || null;
      if (!cancelled) setState({ kind: "ready", name });
    }

    void loadWelcome();
    return () => {
      cancelled = true;
    };
  }, []);

  if (state.kind === "loading") {
    return <section className="a02-confirmed-overlay" aria-live="polite" aria-label="Finishing account confirmation">
      <div className="a02-confirmed-dialog a02-confirmed-loading"><span className="a02-live-pip" /> Confirming your Signal Deck…</div>
    </section>;
  }

  if (state.kind === "error") {
    return <section className="a02-confirmed-overlay" role="dialog" aria-modal="true" aria-labelledby="a02-confirmed-title">
      <div className="a02-confirmed-dialog">
        <span className="a02-eyebrow">ACCOUNT LINK / NEEDS ATTENTION</span>
        <h1 id="a02-confirmed-title">We could not finish signing you in.</h1>
        <p>Your confirmation may have expired, or the browser did not receive a secure session. Return to your account controls to request a new link or log in.</p>
        <button className="a02-confirmed-primary" type="button" onClick={onRecover}>Open account access →</button>
      </div>
    </section>;
  }

  const greeting = state.name ? `You’re in, ${state.name}.` : "You’re in.";
  const guideGreeting = state.name ? `Show me the route, ${state.name}.` : "Show me the route.";

  return <section className="a02-confirmed-overlay" role="dialog" aria-modal="true" aria-labelledby="a02-confirmed-title">
    <div className="a02-confirmed-dialog">
      <div className="a02-confirmed-orbit" aria-hidden="true"><i /><i /><b>◒</b></div>
      <span className="a02-eyebrow">ACCOUNT CONFIRMED / SIGNAL DECK</span>
      <h1 id="a02-confirmed-title">{greeting}</h1>
      <p>Welcome to your workspace. First, take a short look at the route, today’s work, focus, and the record you will build. Then we’ll create your real plan.</p>
      <div className="a02-confirmed-actions">
        <button className="a02-confirmed-primary" type="button" onClick={() => onBeginGuide(state.name)}>{guideGreeting} →</button>
        <button className="a02-confirmed-skip" type="button" onClick={onSkipToOnboarding}>Skip to route setup</button>
      </div>
    </div>
  </section>;
}
