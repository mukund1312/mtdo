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
import { OAUTH_NEXT_COOKIE, OAUTH_STATE_COOKIE, resolveCalendarConfig } from "@/lib/calendar/config";
import { storeConnection } from "@/lib/calendar/connection";
import { exchangeCodeForTokens } from "@/lib/calendar/google";

const SETTINGS_PATH = "/architecture-02/settings";

// `destinationPath` is never caller-supplied directly -- it's either the
// constant SETTINGS_PATH, or a value /api/calendar/connect already validated
// with safeNextPath() before setting OAUTH_NEXT_COOKIE. Still built via the
// URL object rather than string concatenation, matching
// app/auth/callback/route.ts's own reasoning.
function back(origin: string, outcome: string, destinationPath: string): NextResponse {
  const destination = new URL(destinationPath, origin);
  destination.searchParams.set("calendar", outcome);
  const response = NextResponse.redirect(destination);
  response.cookies.delete(OAUTH_STATE_COOKIE);
  response.cookies.delete(OAUTH_NEXT_COOKIE);
  return response;
}

export async function GET(request: NextRequest) {
  const { origin, searchParams } = new URL(request.url);
  // Read once, up front: every `back()` call below needs it, including the
  // earliest failure paths, and it must come from the cookie set the moment
  // /api/calendar/connect redirected here -- never from anything Google
  // round-tripped back (searchParams), which is exactly the open-redirect
  // shape app/auth/callback/route.ts's safeNextPath() write-up covers.
  const destinationPath = request.cookies.get(OAUTH_NEXT_COOKIE)?.value || SETTINGS_PATH;

  const supabase = await createClient();
  const {
    data: { user },
    error: userError,
  } = await supabase.auth.getUser();
  if (userError || !user) {
    return back(origin, "no-session", destinationPath);
  }

  // The user declining consent is a normal outcome, not an error to log.
  const googleError = searchParams.get("error");
  if (googleError) {
    return back(origin, googleError === "access_denied" ? "declined" : "google-error", destinationPath);
  }

  // CSRF check. A mismatch means this callback did not originate from the
  // /api/calendar/connect this browser started -- which is exactly the shape
  // of an attacker binding their own calendar to someone else's account.
  const expectedState = request.cookies.get(OAUTH_STATE_COOKIE)?.value;
  const state = searchParams.get("state");
  if (!expectedState || !state || state !== expectedState) {
    console.error("[calendar/callback] OAuth state mismatch -- refusing the exchange.");
    return back(origin, "state-mismatch", destinationPath);
  }

  const code = searchParams.get("code");
  if (!code) {
    return back(origin, "no-code", destinationPath);
  }

  const resolved = resolveCalendarConfig(origin);
  if (!resolved.configured) {
    // Reachable if the server is reconfigured mid-flow. Honest outcome, no
    // crash -- the same posture the whole calendar surface takes.
    return back(origin, "not-configured", destinationPath);
  }

  const service = createServiceClient();
  if (!service) {
    return back(origin, "not-configured", destinationPath);
  }

  try {
    const grant = await exchangeCodeForTokens(resolved.config, code);
    if (!grant.refreshToken) {
      // buildAuthUrl() sends prompt=consent precisely so this cannot normally
      // happen. If it does, storing an access-token-only connection would
      // create a row that silently stops working within the hour -- refusing
      // is the honest response.
      console.error("[calendar/callback] Google returned no refresh_token; refusing to store a connection that expires in an hour.");
      return back(origin, "no-refresh-token", destinationPath);
    }
    await storeConnection(service, user.id, resolved.config, {
      refreshToken: grant.refreshToken,
      scopes: grant.scopes,
    });
  } catch (err) {
    // Deliberately logs the error object, which carries no token: the grant
    // is never included in a thrown message (lib/calendar/google.ts).
    console.error("[calendar/callback] token exchange or storage failed:", err);
    return back(origin, "exchange-failed", destinationPath);
  }

  return back(origin, "connected", destinationPath);
}
