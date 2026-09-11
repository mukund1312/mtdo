// Google Calendar OAuth, step 1 of 2 (Phase 6; docs/architecture/api.md §3e).
// Redirects the signed-in user to Google's consent screen; /api/calendar/
// callback handles the return leg.
//
// UNCONFIGURED IS A FIRST-CLASS OUTCOME, not an error path bolted on. Real
// Google credentials do not exist in this environment, so this route's
// honest, exercised behaviour today is a 503 naming exactly which env vars
// are missing -- never a crash, and never a redirect to a half-built Google
// URL that would fail on Google's side with an opaque message.
import { NextResponse, type NextRequest } from "next/server";
import { randomBytes } from "node:crypto";
import { createClient } from "@/lib/supabase/server";
import { OAUTH_STATE_COOKIE, resolveCalendarConfig } from "@/lib/calendar/config";
import { buildAuthUrl } from "@/lib/calendar/google";

export async function GET(request: NextRequest) {
  const supabase = await createClient();
  const {
    data: { user },
    error: userError,
  } = await supabase.auth.getUser();
  if (userError || !user) {
    return Response.json({ error: "No authenticated session." }, { status: 401 });
  }

  const resolved = resolveCalendarConfig(new URL(request.url).origin);
  if (!resolved.configured) {
    return Response.json(
      {
        configured: false,
        error: "Google Calendar isn't configured on this server.",
        missing: resolved.missing,
      },
      { status: 503 },
    );
  }

  // CSRF for the OAuth round trip: a random value echoed back by Google in
  // `state` and compared against an httpOnly cookie only this browser holds.
  // Without it, an attacker can complete the callback leg with their own
  // authorization code and bind THEIR calendar to the victim's account -- the
  // login-CSRF variant of the open-redirect problem app/auth/callback/route.ts
  // already documents for `next`.
  const state = randomBytes(32).toString("base64url");

  const response = NextResponse.redirect(buildAuthUrl(resolved.config, state));
  response.cookies.set(OAUTH_STATE_COOKIE, state, {
    httpOnly: true,
    maxAge: 600, // the consent screen is a one-shot, minutes-long interaction
    path: "/api/calendar",
    // `lax`, not `strict`: Google's redirect back is a cross-site top-level
    // GET navigation, and `strict` would withhold the cookie on exactly the
    // request that needs to read it.
    sameSite: "lax",
    secure: new URL(request.url).protocol === "https:",
  });
  return response;
}
