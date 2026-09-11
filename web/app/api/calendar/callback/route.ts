// Google Calendar OAuth, step 2 of 2 (Phase 6; docs/architecture/api.md §3e).
// Exchanges the authorization code for tokens and stores the connection.
//
// This route holds the only plaintext refresh token that ever exists in this
// system, for the few lines between exchangeCodeForTokens() and
// storeConnection() (which encrypts it). It must therefore never log the
// grant, never echo it into a redirect, and never return it in a body --
// every failure below reports a short reason code in the URL and the detail
// to the server console only.
//
// Outcomes are communicated as `?calendar=<reason>` on the settings screen
// rather than as JSON, because the user arrives here by top-level navigation
// from Google and a JSON body would strand them on a blank page.
import { NextResponse, type NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createServiceClient } from "@/lib/supabase/service";
import { OAUTH_STATE_COOKIE, resolveCalendarConfig } from "@/lib/calendar/config";
import { storeConnection } from "@/lib/calendar/connection";
import { exchangeCodeForTokens } from "@/lib/calendar/google";

const SETTINGS_PATH = "/architecture-02/settings";

function back(origin: string, outcome: string): NextResponse {
  const destination = new URL(SETTINGS_PATH, origin);
  destination.searchParams.set("calendar", outcome);
  // Always built from this app's own `origin` and a constant path -- never
  // from anything Google round-tripped back. app/auth/callback/route.ts has
  // the full write-up of why a caller-supplied redirect target is an open
  // redirect waiting to happen; the cheapest defence is not having one.
  const response = NextResponse.redirect(destination);
  response.cookies.delete(OAUTH_STATE_COOKIE);
  return response;
}

export async function GET(request: NextRequest) {
  const { origin, searchParams } = new URL(request.url);

  const supabase = await createClient();
  const {
    data: { user },
    error: userError,
  } = await supabase.auth.getUser();
  if (userError || !user) {
    return back(origin, "no-session");
  }

  // The user declining consent is a normal outcome, not an error to log.
  const googleError = searchParams.get("error");
  if (googleError) {
    return back(origin, googleError === "access_denied" ? "declined" : "google-error");
  }

  // CSRF check. A mismatch means this callback did not originate from the
  // /api/calendar/connect this browser started -- which is exactly the shape
  // of an attacker binding their own calendar to someone else's account.
  const expectedState = request.cookies.get(OAUTH_STATE_COOKIE)?.value;
  const state = searchParams.get("state");
  if (!expectedState || !state || state !== expectedState) {
    console.error("[calendar/callback] OAuth state mismatch -- refusing the exchange.");
    return back(origin, "state-mismatch");
  }

  const code = searchParams.get("code");
  if (!code) {
    return back(origin, "no-code");
  }

  const resolved = resolveCalendarConfig(origin);
  if (!resolved.configured) {
    // Reachable if the server is reconfigured mid-flow. Honest outcome, no
    // crash -- the same posture the whole calendar surface takes.
    return back(origin, "not-configured");
  }

  const service = createServiceClient();
  if (!service) {
    return back(origin, "not-configured");
  }

  try {
    const grant = await exchangeCodeForTokens(resolved.config, code);
    if (!grant.refreshToken) {
      // buildAuthUrl() sends prompt=consent precisely so this cannot normally
      // happen. If it does, storing an access-token-only connection would
      // create a row that silently stops working within the hour -- refusing
      // is the honest response.
      console.error("[calendar/callback] Google returned no refresh_token; refusing to store a connection that expires in an hour.");
      return back(origin, "no-refresh-token");
    }
    await storeConnection(service, user.id, resolved.config, {
      refreshToken: grant.refreshToken,
      scopes: grant.scopes,
    });
  } catch (err) {
    // Deliberately logs the error object, which carries no token: the grant
    // is never included in a thrown message (lib/calendar/google.ts).
    console.error("[calendar/callback] token exchange or storage failed:", err);
    return back(origin, "exchange-failed");
  }

  return back(origin, "connected");
}
