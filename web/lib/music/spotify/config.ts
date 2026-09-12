// Spotify configuration resolution, modelled directly on
// resolveCalendarConfig() (lib/calendar/config.ts), which in turn follows
// lib/ai/service.ts's resolveProvider(): an external dependency that may
// simply not be set up, reported honestly rather than crashed on or faked.
//
// Nothing in the core loop may hard-require this. The board, the focus timer,
// scheduling and the calendar all work identically whether or not a user has
// ever connected Spotify -- music is an accompaniment to studying, never a
// precondition for it. Every route in app/api/music/spotify/** checks this
// first and returns a clean 503 (or, for the status route, an honest 200)
// naming the real reason when it comes back unconfigured.
//
// Real SPOTIFY_CLIENT_ID credentials do NOT exist in this environment (see
// .env.example and PROGRESS.md's 2026-09-13 entry), so "unconfigured" is the
// path that was actually exercised end to end during development, not a
// speculative branch -- the same situation Google Calendar was in for the
// whole of Phase 6.
import { parseEncryptionKey } from "@/lib/crypto/token-envelope";

/**
 * Least privilege, and every one of these three is genuinely required by the
 * Web Playback SDK:
 *   - `streaming`          -- the actual right to play audio in the browser.
 *   - `user-read-email`    -- required alongside `streaming` by Spotify.
 *   - `user-read-private`  -- likewise, and it is what carries the account's
 *                             product tier ('premium' / 'free'), which is the
 *                             only honest signal available for the Premium
 *                             requirement below.
 *
 * Notably absent: any playlist, library, follow or user-modify scope. This app
 * plays audio; it does not read or alter the user's Spotify account. Widening
 * this list later is a re-consent, which is why the GRANTED scopes are stored
 * on the connection row rather than assumed.
 */
export const SPOTIFY_SCOPES = ["streaming", "user-read-email", "user-read-private"] as const;

/**
 * PERMANENT PLATFORM CONSTRAINT, not a bug and not a TODO: the Spotify Web
 * Playback SDK requires a Spotify Premium account (and mobile-only Premium
 * tiers are excluded). A free-tier listener cannot get in-browser playback
 * through this integration, and no amount of app-side work changes that.
 *
 * This constant exists so the limitation is stated in code rather than only in
 * docs. The backend's job is to report whatever real signal exists -- the
 * account's product tier, captured at connect time -- so the Listen deck can
 * render an honest "Spotify Premium required" state instead of a player that
 * silently never starts. See decisions.md 2026-09-13.
 */
export const SPOTIFY_PREMIUM_PRODUCT = "premium";

/** Name of the httpOnly cookie carrying the OAuth `state` nonce between
 * /api/music/spotify/connect and /api/music/spotify/callback. Lives here
 * rather than in either route file because Next validates the export shape of
 * `route.ts` -- a stray named export there is a build error, not a shared
 * constant. Same reasoning as lib/calendar/config.ts's OAUTH_STATE_COOKIE. */
export const SPOTIFY_STATE_COOKIE = "mtdo-spotify-oauth-state";

/**
 * Name of the httpOnly cookie carrying the PKCE **code verifier** between
 * connect and callback.
 *
 * THIS IS THE ONE REAL STRUCTURAL DIFFERENCE FROM THE CALENDAR ROUTES, and it
 * is why those cannot simply be copy-pasted. Google's flow proves the client's
 * identity at the token endpoint with a client_secret that lives in the server
 * env, so nothing needs to survive the round trip except the CSRF state.
 * Spotify's Authorization Code with PKCE has no client_secret at all: the
 * proof is that whoever redeems the code can produce the verifier whose SHA-256
 * hash was sent at authorize time. That verifier is generated in /connect and
 * needed in /callback, two separate requests, so it has to be carried -- and
 * httpOnly cookie is the right carrier, for exactly the reason the state nonce
 * uses one.
 *
 * It is a secret for the lifetime of one consent screen: anyone holding both
 * the verifier and the authorization code can complete the exchange. httpOnly
 * keeps it away from scripts, and the short maxAge in the connect route keeps
 * the window to the length of the interaction.
 */
export const SPOTIFY_VERIFIER_COOKIE = "mtdo-spotify-oauth-verifier";

/** Optional post-connect destination, same contract as the calendar's
 * OAUTH_NEXT_COOKIE. Worth supporting from v1 here (where the calendar only
 * grew it later) because Spotify's caller is the Listen deck on
 * /architecture-02, not the Settings screen the callback defaults to -- a
 * user who connects from the deck should land back on the deck. Absent when
 * /connect is reached without `?next`, in which case the callback falls back
 * to Settings. */
export const SPOTIFY_NEXT_COOKIE = "mtdo-spotify-oauth-next";

export type SpotifyConfig = {
  clientId: string;
  encryptionKey: Buffer;
  /** Exactly what must be registered in the Spotify developer dashboard as a
   * Redirect URI. Spotify matches it byte-for-byte. */
  redirectUri: string;
};

export type SpotifyConfigResult =
  | { configured: true; config: SpotifyConfig }
  | { configured: false; missing: string[] };

/**
 * `origin` is used only to derive a redirect URI when SPOTIFY_OAUTH_REDIRECT_URI
 * is not set -- convenient for local development, where the origin is stable.
 * Set the env var explicitly for any real deployment: Spotify compares the
 * redirect URI against its registered list exactly, and a preview deployment's
 * generated hostname will never be on it.
 *
 * Note what is NOT checked here: there is no SPOTIFY_CLIENT_SECRET, because
 * Authorization Code with PKCE does not use one. Assuming symmetry with the
 * calendar's config and requiring a secret would make this permanently report
 * "unconfigured" for a correctly configured deployment.
 */
export function resolveSpotifyConfig(origin: string): SpotifyConfigResult {
  const missing: string[] = [];

  const clientId = process.env.SPOTIFY_CLIENT_ID;
  if (!clientId) missing.push("SPOTIFY_CLIENT_ID");

  // A present-but-malformed key counts as missing, deliberately. The
  // alternative is discovering it at the moment a real user finishes
  // Spotify's consent screen and we cannot store what they just granted.
  //
  // A SEPARATE KEY FROM THE CALENDAR'S, even though the envelope code is now
  // shared (lib/crypto/token-envelope.ts). Sharing the implementation is a
  // code-duplication question; sharing the KEY is a blast-radius question,
  // and they have different answers. One key per third-party credential store
  // means each can be rotated on its own schedule, and a key disclosed
  // through one integration does not decrypt the other's tokens.
  // decisions.md 2026-09-13.
  const encryptionKey = parseEncryptionKey(process.env.SPOTIFY_TOKEN_ENCRYPTION_KEY);
  if (!encryptionKey) missing.push("SPOTIFY_TOKEN_ENCRYPTION_KEY");

  // Listed here rather than only inside createServiceClient() because a
  // missing service key makes Spotify *specifically* unusable (tokens have
  // nowhere to be stored that a browser cannot reach), and the operator
  // reading the status panel needs to be told which variable is absent.
  if (!process.env.SUPABASE_SERVICE_ROLE_KEY) missing.push("SUPABASE_SERVICE_ROLE_KEY");

  if (missing.length > 0 || !clientId || !encryptionKey) {
    return { configured: false, missing };
  }

  return {
    configured: true,
    config: {
      clientId,
      encryptionKey,
      redirectUri:
        process.env.SPOTIFY_OAUTH_REDIRECT_URI ??
        new URL("/api/music/spotify/callback", origin).toString(),
    },
  };
}
