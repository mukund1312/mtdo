// Spotify OAuth, step 2 of 2 (docs/architecture/api.md §3i). Exchanges the
// authorization code (with the stored PKCE verifier) for tokens and stores the
// connection.
//
// This route holds the only plaintext Spotify tokens that ever exist in this
// system, for the few lines between exchangeCodeForTokens() and
// storeConnection() (which encrypts both). It must therefore never log the
// grant, never echo it into a redirect, and never return it in a body -- every
// failure below reports a short reason code in the URL and the detail to the
// server console only.
//
// Outcomes are communicated as `?spotify=<reason>` on the destination screen
// rather than as JSON, because the user arrives here by top-level navigation
// from Spotify and a JSON body would strand them on a blank page.
import { NextResponse, type NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createServiceClient } from "@/lib/supabase/service";
import {
  SPOTIFY_NEXT_COOKIE,
  SPOTIFY_STATE_COOKIE,
  SPOTIFY_VERIFIER_COOKIE,
  resolveSpotifyConfig,
} from "@/lib/music/spotify/config";
import { storeConnection } from "@/lib/music/spotify/connection";
import { isValidCodeVerifier } from "@/lib/music/spotify/pkce";
import { exchangeCodeForTokens, fetchProfile, type SpotifyProfile } from "@/lib/music/spotify/spotify";

const SETTINGS_PATH = "/architecture-02/settings";

// `destinationPath` is never caller-supplied directly -- it's either the
// constant SETTINGS_PATH, or a value /api/music/spotify/connect already
// validated with safeNextPath() before setting SPOTIFY_NEXT_COOKIE. Still
// built via the URL object rather than string concatenation, matching
// app/auth/callback/route.ts's own reasoning.
function back(origin: string, outcome: string, destinationPath: string): NextResponse {
  const destination = new URL(destinationPath, origin);
  destination.searchParams.set("spotify", outcome);
  const response = NextResponse.redirect(destination);
  // All three OAuth cookies go on EVERY outcome, not just the happy path. A
  // verifier left behind after a failed attempt is a spent secret sitting in
  // the browser for no reason.
  response.cookies.delete(SPOTIFY_STATE_COOKIE);
  response.cookies.delete(SPOTIFY_VERIFIER_COOKIE);
  response.cookies.delete(SPOTIFY_NEXT_COOKIE);
  return response;
}

export async function GET(request: NextRequest) {
  const { origin, searchParams } = new URL(request.url);
  // Read once, up front: every `back()` call below needs it, including the
  // earliest failure paths, and it must come from the cookie set the moment
  // /api/music/spotify/connect redirected here -- never from anything Spotify
  // round-tripped back (searchParams), which is exactly the open-redirect
  // shape app/auth/callback/route.ts's safeNextPath() write-up covers.
  const destinationPath = request.cookies.get(SPOTIFY_NEXT_COOKIE)?.value || SETTINGS_PATH;

  const supabase = await createClient();
  const {
    data: { user },
    error: userError,
  } = await supabase.auth.getUser();
  if (userError || !user) {
    return back(origin, "no-session", destinationPath);
  }

  // The user declining consent is a normal outcome, not an error to log.
  const spotifyError = searchParams.get("error");
  if (spotifyError) {
    return back(origin, spotifyError === "access_denied" ? "declined" : "spotify-error", destinationPath);
  }

  // CSRF check. A mismatch means this callback did not originate from the
  // /api/music/spotify/connect this browser started -- which is exactly the
  // shape of an attacker binding their own Spotify account to someone else's.
  const expectedState = request.cookies.get(SPOTIFY_STATE_COOKIE)?.value;
  const state = searchParams.get("state");
  if (!expectedState || !state || state !== expectedState) {
    console.error("[music/spotify/callback] OAuth state mismatch -- refusing the exchange.");
    return back(origin, "state-mismatch", destinationPath);
  }

  // The PKCE half. Without the verifier the exchange cannot succeed at all
  // (there is no client_secret to fall back on), so a missing or malformed
  // cookie is caught here rather than sent to Spotify to be rejected with an
  // opaque message. Validated for shape, not just presence -- a truncated or
  // tampered cookie should end the flow cleanly.
  const verifier = request.cookies.get(SPOTIFY_VERIFIER_COOKIE)?.value;
  if (!isValidCodeVerifier(verifier)) {
    console.error("[music/spotify/callback] missing or malformed PKCE verifier -- refusing the exchange.");
    return back(origin, "missing-verifier", destinationPath);
  }

  const code = searchParams.get("code");
  if (!code) {
    return back(origin, "no-code", destinationPath);
  }

  const resolved = resolveSpotifyConfig(origin);
  if (!resolved.configured) {
    // Reachable if the server is reconfigured mid-flow. Honest outcome, no
    // crash -- the same posture the whole Spotify surface takes.
    return back(origin, "not-configured", destinationPath);
  }

  const service = createServiceClient();
  if (!service) {
    return back(origin, "not-configured", destinationPath);
  }

  try {
    const grant = await exchangeCodeForTokens(resolved.config, code, verifier);
    if (!grant.refreshToken) {
      // Spotify returns one on every authorization_code exchange, so this
      // should not happen. If it does, storing an access-token-only
      // connection would create a row that silently stops working within the
      // hour -- refusing is the honest response.
      console.error(
        "[music/spotify/callback] Spotify returned no refresh_token; refusing to store a connection that expires in an hour.",
      );
      return back(origin, "no-refresh-token", destinationPath);
    }

    // Best-effort, and deliberately so: `product` (the Premium signal) is
    // valuable but it is NOT worth losing a consent the user just granted.
    // A failed profile read stores null and the status route reports the tier
    // as unknown, which the deck renders honestly.
    let profile: SpotifyProfile | null = null;
    try {
      profile = await fetchProfile(grant.accessToken);
    } catch (err) {
      console.error("[music/spotify/callback] profile read failed; storing the connection anyway:", err);
    }

    await storeConnection(service, user.id, resolved.config, {
      accessToken: grant.accessToken,
      expiresIn: grant.expiresIn,
      profile,
      refreshToken: grant.refreshToken,
      scopes: grant.scopes,
    });
  } catch (err) {
    // Deliberately logs the error object, which carries no token: the grant
    // is never included in a thrown message (lib/music/spotify/spotify.ts).
    console.error("[music/spotify/callback] token exchange or storage failed:", err);
    return back(origin, "exchange-failed", destinationPath);
  }

  return back(origin, "connected", destinationPath);
}
