// Spotify OAuth, step 1 of 2 (docs/architecture/api.md §3i). Redirects the
// signed-in user to Spotify's consent screen; /api/music/spotify/callback
// handles the return leg.
//
// UNCONFIGURED IS A FIRST-CLASS OUTCOME, not an error path bolted on. Real
// Spotify credentials do not exist in this environment, so this route's
// honest, exercised behaviour today is a 503 naming exactly which env vars
// are missing -- never a crash, and never a redirect to a half-built Spotify
// URL that would fail on Spotify's side with an opaque message.
//
// STRUCTURAL DIFFERENCE FROM /api/calendar/connect, and the reason this is not
// a copy-paste of it: Spotify uses Authorization Code with PKCE and no
// client_secret. That means a code *verifier* is generated here and must still
// be available in the callback -- a second httpOnly cookie alongside the CSRF
// state. Google's flow needs no such thing, because its client_secret lives in
// the server env and never travels.
import { NextResponse, type NextRequest } from "next/server";
import { randomBytes } from "node:crypto";
import { createClient } from "@/lib/supabase/server";
import {
  SPOTIFY_NEXT_COOKIE,
  SPOTIFY_STATE_COOKIE,
  SPOTIFY_VERIFIER_COOKIE,
  resolveSpotifyConfig,
} from "@/lib/music/spotify/config";
import { createCodeVerifier, deriveCodeChallenge } from "@/lib/music/spotify/pkce";
import { buildAuthUrl } from "@/lib/music/spotify/spotify";
import { safeNextPath } from "@/lib/safe-redirect";

export async function GET(request: NextRequest) {
  const supabase = await createClient();
  const {
    data: { user },
    error: userError,
  } = await supabase.auth.getUser();
  if (userError || !user) {
    return Response.json({ error: "No authenticated session." }, { status: 401 });
  }

  const { origin, protocol, searchParams } = new URL(request.url);

  const resolved = resolveSpotifyConfig(origin);
  if (!resolved.configured) {
    return Response.json(
      {
        configured: false,
        error: "Spotify isn't configured on this server.",
        missing: resolved.missing,
      },
      { status: 503 },
    );
  }

  // CSRF for the OAuth round trip: a random value echoed back by Spotify in
  // `state` and compared against an httpOnly cookie only this browser holds.
  // Without it, an attacker can complete the callback leg with their own
  // authorization code and bind THEIR Spotify account to the victim's --
  // the login-CSRF variant of the open-redirect problem
  // app/auth/callback/route.ts documents for `next`.
  //
  // PKCE does not replace this. They defend different things: PKCE proves the
  // client redeeming the code is the one that started the flow, `state` proves
  // the browser finishing the flow is the one that started it. Both are needed.
  const state = randomBytes(32).toString("base64url");
  const verifier = createCodeVerifier();

  const response = NextResponse.redirect(
    buildAuthUrl(resolved.config, state, deriveCodeChallenge(verifier)),
  );
  const cookieOptions = {
    httpOnly: true,
    maxAge: 600, // the consent screen is a one-shot, minutes-long interaction
    path: "/api/music/spotify",
    // `lax`, not `strict`: Spotify's redirect back is a cross-site top-level
    // GET navigation, and `strict` would withhold the cookies on exactly the
    // request that needs to read them.
    sameSite: "lax" as const,
    secure: protocol === "https:",
  };
  response.cookies.set(SPOTIFY_STATE_COOKIE, state, cookieOptions);
  // The verifier is as sensitive as the code it will be spent with: anyone
  // holding both can complete the exchange. httpOnly keeps it away from
  // scripts; the 10-minute maxAge bounds the window to the interaction.
  response.cookies.set(SPOTIFY_VERIFIER_COOKIE, verifier, cookieOptions);

  // Optional: where to land the user once the Spotify round trip finishes
  // (success, decline, or error), instead of the callback's default Settings
  // destination. Supported from v1 here -- unlike the calendar, which grew it
  // later -- because Spotify's natural caller is the Listen deck rather than
  // Settings, and a user who connects from the deck should land back on it.
  const next = searchParams.get("next");
  if (next) {
    response.cookies.set(SPOTIFY_NEXT_COOKIE, safeNextPath(next, origin), cookieOptions);
  }
  return response;
}
