// The Spotify API surface this app actually uses: the OAuth authorize URL,
// the PKCE token exchange, the refresh call, and one profile read. Written
// against `fetch` with no SDK -- the same choice lib/calendar/google.ts and
// lib/ai/providers/ollama.ts made, for the same reason: four endpoints do not
// justify a dependency, and the request shapes are stable, documented, and
// easier to test when they are visible in the file.
//
// PLAYBACK CONTROL IS DELIBERATELY ABSENT. There is no play/pause/seek here
// and no call to Spotify's Web API player endpoints. Playback happens entirely
// in the browser through the Web Playback SDK, which holds its own access
// token (minted by GET /api/music/spotify/token). This server never issues a
// playback command, so nothing unattended can start audio on a user's account
// -- structurally, not by convention. The same shape as the calendar's "AI may
// only ever suggest a slot" rule.
import { SPOTIFY_SCOPES, type SpotifyConfig } from "./config";

const AUTH_ENDPOINT = "https://accounts.spotify.com/authorize";
const TOKEN_ENDPOINT = "https://accounts.spotify.com/api/token";
const API_BASE = "https://api.spotify.com/v1";

/** Spotify refresh tokens die six months after the ORIGINAL authorization,
 * and refreshing an access token does not extend that. Captured at consent
 * time into music_connections.refresh_token_expires_at so the status route can
 * warn before playback breaks rather than after. */
export const REFRESH_TOKEN_LIFETIME_DAYS = 180;

export class SpotifyError extends Error {
  readonly status: number;
  /** True when Spotify rejected the stored refresh token itself -- expired
   * (the six-month wall), revoked by the user in their Spotify account, or
   * invalidated by a re-consent. This is NOT a transient error and must not be
   * retried: the only resolution is a fresh authorization. Callers turn this
   * into "reconnect Spotify", never into a 500. */
  readonly requiresReconnect: boolean;

  constructor(message: string, status: number, requiresReconnect = false) {
    super(message);
    this.status = status;
    this.requiresReconnect = requiresReconnect;
  }
}

export type SpotifyTokenGrant = {
  accessToken: string;
  /** Seconds. Spotify issues one-hour access tokens; read from the response
   * rather than hardcoded, so a change on their side does not silently give
   * this app a stale cache. */
  expiresIn: number;
  /**
   * ABSENT IS NORMAL ON REFRESH, and this is a documented Spotify behaviour
   * rather than an error: Spotify "may or may not" issue a new refresh token
   * on each refresh call. When it does not, the caller MUST keep using the
   * one it already stored -- nulling the column out on a successful refresh
   * would destroy a working connection. See storeRefreshedTokens() in
   * connection.ts, which is where that rule is actually enforced.
   */
  refreshToken: string | null;
  scopes: string[];
};

export type SpotifyProfile = {
  displayName: string | null;
  email: string | null;
  id: string;
  /** 'premium' | 'free' | 'open', per Spotify. The Web Playback SDK requires
   * 'premium'; anything else means in-browser playback will not work, which
   * the Listen deck renders as a first-class state rather than a silent
   * failure. Null when the field is absent from the response. */
  product: string | null;
};

export function buildAuthUrl(config: SpotifyConfig, state: string, codeChallenge: string): string {
  const url = new URL(AUTH_ENDPOINT);
  url.searchParams.set("client_id", config.clientId);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("redirect_uri", config.redirectUri);
  url.searchParams.set("scope", SPOTIFY_SCOPES.join(" "));
  url.searchParams.set("state", state);
  // S256, never 'plain'. RFC 7636 permits plain; using it here would put the
  // verifier itself in a URL that travels through the user's browser history
  // and Spotify's logs, defeating the point of PKCE entirely.
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("code_challenge", codeChallenge);
  return url.toString();
}

async function postToken(body: URLSearchParams): Promise<Record<string, unknown>> {
  const response = await fetch(TOKEN_ENDPOINT, {
    body,
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    method: "POST",
  });
  const payload: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const record = payload && typeof payload === "object" ? (payload as Record<string, unknown>) : {};
    const code = typeof record.error === "string" ? record.error : null;
    const detail =
      typeof record.error_description === "string" ? record.error_description : `HTTP ${response.status}`;
    // `invalid_grant` is Spotify's answer for a refresh token that is expired,
    // revoked or simply wrong. Distinguishing it here is the whole reason this
    // wrapper exists: everything upstream needs to tell "reconnect" apart from
    // "Spotify is having a bad day", and the status code alone (400) does not.
    throw new SpotifyError(
      `Spotify rejected the token request: ${detail}`,
      response.status,
      code === "invalid_grant",
    );
  }
  return (payload ?? {}) as Record<string, unknown>;
}

function readGrant(payload: Record<string, unknown>, what: string): SpotifyTokenGrant {
  const accessToken = typeof payload.access_token === "string" ? payload.access_token : null;
  if (!accessToken) {
    throw new SpotifyError(`Spotify's ${what} response had no access_token.`, 502);
  }
  return {
    accessToken,
    // Falls back to one hour, Spotify's documented value, if the field is
    // missing or nonsensical -- an absent expiry must not become a token
    // cached forever.
    expiresIn:
      typeof payload.expires_in === "number" && payload.expires_in > 0 ? payload.expires_in : 3600,
    refreshToken: typeof payload.refresh_token === "string" ? payload.refresh_token : null,
    // Stored as granted, not as requested -- see music_connections.scopes'
    // own comment in migrations/0024.
    scopes: typeof payload.scope === "string" ? payload.scope.split(" ").filter(Boolean) : [],
  };
}

/**
 * PKCE code exchange. Note the absence of client_secret: Authorization Code
 * with PKCE does not use one, and the `code_verifier` is what proves this is
 * the same client that started the flow. Sending a secret here (by analogy
 * with lib/calendar/google.ts) would be rejected.
 */
export async function exchangeCodeForTokens(
  config: SpotifyConfig,
  code: string,
  codeVerifier: string,
): Promise<SpotifyTokenGrant> {
  return readGrant(
    await postToken(
      new URLSearchParams({
        client_id: config.clientId,
        code,
        code_verifier: codeVerifier,
        grant_type: "authorization_code",
        redirect_uri: config.redirectUri,
      }),
    ),
    "token",
  );
}

/** Mints a new access token from a stored refresh token. Also no
 * client_secret. A rejection with `invalid_grant` arrives as a SpotifyError
 * with requiresReconnect set -- see the class comment. */
export async function refreshAccessToken(
  config: SpotifyConfig,
  refreshToken: string,
): Promise<SpotifyTokenGrant> {
  return readGrant(
    await postToken(
      new URLSearchParams({
        client_id: config.clientId,
        grant_type: "refresh_token",
        refresh_token: refreshToken,
      }),
    ),
    "refresh",
  );
}

/**
 * Reads the connected account's profile. Called once, at connect time, for one
 * reason: `product` is the only real signal available for whether the Web
 * Playback SDK can work at all (it requires Premium). Capturing it is what
 * lets the Listen deck say "Spotify Premium is required for in-app playback"
 * honestly, instead of rendering a player that never produces sound.
 *
 * Non-fatal by contract at the call site: a profile read that fails must not
 * lose a consent the user just granted. See the callback route.
 */
export async function fetchProfile(accessToken: string): Promise<SpotifyProfile> {
  const response = await fetch(`${API_BASE}/me`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new SpotifyError(
      `Spotify returned ${response.status} for the profile read${detail ? `: ${detail.slice(0, 300)}` : ""}`,
      response.status,
    );
  }
  const payload = (await response.json().catch(() => null)) as Record<string, unknown> | null;
  if (!payload || typeof payload.id !== "string") {
    throw new SpotifyError("Spotify's profile response had no id.", 502);
  }
  return {
    displayName: typeof payload.display_name === "string" ? payload.display_name : null,
    email: typeof payload.email === "string" ? payload.email : null,
    id: payload.id,
    product: typeof payload.product === "string" ? payload.product : null,
  };
}
