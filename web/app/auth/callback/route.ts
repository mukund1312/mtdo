import { NextResponse, type NextRequest } from "next/server";
import { syncIsAnonymousFlag } from "@/lib/auth/upgradeAccount";
import { resolveCalendarConfig } from "@/lib/calendar/config";
import { safeNextPath } from "@/lib/safe-redirect";
import { createClient } from "@/lib/supabase/server";

// Email confirmation and password recovery are single-use links. When the
// exchange fails, keep the person inside Signal Deck with a useful recovery
// state instead of dropping them at the generic marketing root.
function callbackFailurePath(next: string, origin: string): string {
  const destination = new URL(next, origin);
  if (destination.pathname !== "/architecture-02") {
    return "/architecture-02?auth=callback-error";
  }
  const auth = destination.searchParams.get("auth");
  destination.searchParams.set(
    "auth",
    auth === "reset" ? "reset-error" : auth === "confirmed" ? "confirmation-error" : "callback-error",
  );
  return `${destination.pathname}${destination.search}${destination.hash}`;
}

// Lands here after upgradeWithOAuth()'s linkIdentity() redirect completes
// (lib/auth/upgradeAccount.ts). Exchanges the auth code for the session --
// same auth.uid(), now with the OAuth identity attached -- and mirrors the
// resulting is_anonymous state onto profiles the same way the email/password
// path does, so both upgrade paths leave that column consistent.
export async function GET(request: NextRequest) {
  const { searchParams, origin } = new URL(request.url);
  const code = searchParams.get("code");
  const flowId = searchParams.get("sb_flow_id");
  // Where the trigger UI wants the user back; defaults to home. Set via
  // upgradeWithOAuth's redirectTo (?next=<path> appended by the caller).
  const next = safeNextPath(searchParams.get("next"), origin);
  // Set only by account-control.tsx's Google signup path (never login, never
  // email/password) -- a brand-new account created via Google is one click
  // from a second Google consent screen it would otherwise have to find in
  // Settings later. See decisions.md's 2026-09-13 entry for why this isn't
  // one merged OAuth grant: Google requires its own explicit consent screen
  // for the calendar scope regardless of how the app is built, so "one
  // click" here means chaining two real grants, not avoiding the second one.
  const promptCalendar = searchParams.get("promptCalendar") === "1";

  if (code) {
    const supabase = await createClient();
    // OAuth flows can carry a PKCE flow id. Passing it through is required
    // when more than one secure auth flow is in flight, and keeps the callback
    // compatible with both signInWithOAuth() and linkIdentity().
    const { error } = await supabase.auth.exchangeCodeForSession(code, flowId ? { flowId } : undefined);
    if (!error) {
      await syncIsAnonymousFlag(supabase);
      // Unconfigured is a first-class, silent skip here -- same posture as
      // every other calendar surface (lib/calendar/config.ts) -- not an
      // error shown to a user who never asked for calendar integration.
      if (promptCalendar && resolveCalendarConfig(origin).configured) {
        const connectUrl = new URL("/api/calendar/connect", origin);
        connectUrl.searchParams.set("next", next);
        return NextResponse.redirect(connectUrl);
      }
      return NextResponse.redirect(new URL(next, origin));
    }
  }

  return NextResponse.redirect(new URL(callbackFailurePath(next, origin), origin));
}
