// The Spotify API surface this app actually uses: the OAuth authorize URL,
// the PKCE token exchange, the refresh call, a profile read, and (Phase 1 of
// the music control center) playlist/queue/device/playback-control calls.
// Written against `fetch` with no SDK -- the same choice lib/calendar/
// google.ts and lib/ai/providers/ollama.ts made, for the same reason: the
// request shapes are stable, documented, and easier to test when they are
// visible in the file.
//
// PLAYBACK CONTROL IS NO LONGER ABSENT, but the invariant it used to
// guarantee structurally is preserved a different way. playTrack() and
// transferPlayback() below DO call Spotify's Web API player endpoints now --
// that's the one real trust-model change in this file's history, and it's
// deliberate: browsing a playlist and switching a Connect device both need a
// server-side call the Web Playback SDK has no way to make itself. What's
// still true, and load-bearing: every call these functions make originates
// from a real user click inside listen-deck.tsx (playSpotifyTrack,
// transferSpotifyPlayback) -- never a background job, a scheduled task, or
// an AI suggestion. Same shape as the calendar's "AI may only ever suggest a
// slot" rule, just enforced at the call site instead of by this file's own
// absence of the capability.
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

export type SpotifyPlaylistSummary = {
  id: string;
  name: string;
  trackCount: number;
  imageUrl: string | null;
  uri: string;
};

export type SpotifyTrackSummary = {
  uri: string;
  name: string;
  artists: string[];
  album: string | null;
  imageUrl: string | null;
  durationMs: number;
};

export type SpotifyDevice = {
  id: string | null;
  name: string;
  type: string;
  isActive: boolean;
  volumePercent: number | null;
};

/** Wraps every Web API call this file makes past the OAuth/profile ones --
 * same status handling `fetchProfile` above already established (403 means
 * the stored grant no longer covers what this call needs, i.e. reconnect;
 * anything else non-2xx is a genuine upstream problem), applied once instead
 * of six times. `emptyOn204` lets a caller treat "no active device" as a
 * normal empty result instead of an error -- see getQueue/getDevices below,
 * both of which Spotify legitimately answers with a bare 204 for a listener
 * with nothing currently playing. */
async function spotifyApiRequest<T>(
  accessToken: string,
  path: string,
  init: RequestInit,
  what: string,
  emptyOn204?: T,
): Promise<T> {
  const response = await fetch(`${API_BASE}${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${accessToken}`, ...(init.headers ?? {}) },
  });
  if (response.status === 204 && emptyOn204 !== undefined) {
    return emptyOn204;
  }
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new SpotifyError(
      `Spotify returned ${response.status} for ${what}${detail ? `: ${detail.slice(0, 300)}` : ""}`,
      response.status,
      // 403 here means the stored grant is missing a scope this call needs --
      // a pre-Phase-1 connection that authorized only the original three
      // scopes, most likely. Distinct in cause from invalid_grant (a dead
      // refresh token) but identical in the only remedy: send the user
      // through OAuth again. Reusing `requiresReconnect` means the frontend's
      // existing reconnect-required branch handles this with no new state.
      response.status === 403,
    );
  }
  if (response.status === 204) {
    return undefined as T;
  }
  return (await response.json()) as T;
}

function toTrackSummary(track: Record<string, unknown> | null | undefined): SpotifyTrackSummary | null {
  if (!track || typeof track.uri !== "string" || typeof track.name !== "string") return null;
  const album = track.album && typeof track.album === "object" ? (track.album as Record<string, unknown>) : null;
  const images = album && Array.isArray(album.images) ? (album.images as Array<Record<string, unknown>>) : [];
  const artists = Array.isArray(track.artists) ? (track.artists as Array<Record<string, unknown>>) : [];
  return {
    uri: track.uri,
    name: track.name,
    artists: artists.map((a) => (typeof a.name === "string" ? a.name : "")).filter(Boolean),
    album: album && typeof album.name === "string" ? album.name : null,
    imageUrl: typeof images[0]?.url === "string" ? (images[0].url as string) : null,
    durationMs: typeof track.duration_ms === "number" ? track.duration_ms : 0,
  };
}

/** GET /me/playlists -- the control center's playlist browser. `limit`
 * defaults to Spotify's own max (50) rather than its default (20): this is a
 * list a real account can have hundreds of, and the caller (listen-state.tsx)
 * pages via `next` rather than this function guessing a smaller page size. */
export async function listPlaylists(
  accessToken: string,
  opts?: { limit?: number; offset?: number },
): Promise<{ items: SpotifyPlaylistSummary[]; next: string | null }> {
  const params = new URLSearchParams({
    limit: String(opts?.limit ?? 50),
    offset: String(opts?.offset ?? 0),
  });
  const payload = await spotifyApiRequest<{
    items: Array<Record<string, unknown>>;
    next: string | null;
  }>(accessToken, `/me/playlists?${params}`, { method: "GET" }, "the playlist list");
  return {
    items: payload.items.map((p) => {
      const images = Array.isArray(p.images) ? (p.images as Array<Record<string, unknown>>) : [];
      const tracks = p.tracks && typeof p.tracks === "object" ? (p.tracks as Record<string, unknown>) : {};
      return {
        id: String(p.id ?? ""),
        name: typeof p.name === "string" ? p.name : "Untitled playlist",
        trackCount: typeof tracks.total === "number" ? tracks.total : 0,
        imageUrl: typeof images[0]?.url === "string" ? (images[0].url as string) : null,
        uri: typeof p.uri === "string" ? p.uri : "",
      };
    }),
    next: payload.next,
  };
}

/** GET /playlists/{id}/tracks -- the track list shown after drilling into
 * one playlist. Local/unavailable tracks (no `track.uri`, e.g. a track
 * removed from Spotify's catalog) are filtered out rather than rendered as a
 * broken row -- there is nothing a click on one could honestly do. */
export async function getPlaylistTracks(
  accessToken: string,
  playlistId: string,
  opts?: { limit?: number; offset?: number },
): Promise<{ items: SpotifyTrackSummary[]; next: string | null }> {
  const params = new URLSearchParams({
    limit: String(opts?.limit ?? 50),
    offset: String(opts?.offset ?? 0),
  });
  const payload = await spotifyApiRequest<{
    items: Array<{ track: Record<string, unknown> | null }>;
    next: string | null;
  }>(
    accessToken,
    `/playlists/${encodeURIComponent(playlistId)}/tracks?${params}`,
    { method: "GET" },
    "a playlist's tracks",
  );
  return {
    items: payload.items.map((item) => toTrackSummary(item.track)).filter((t): t is SpotifyTrackSummary => t !== null),
    next: payload.next,
  };
}

/** GET /me/player/queue. A bare 204 here is Spotify's normal answer for "no
 * active playback session" -- not an error, and genuinely the common case
 * for a listener who hasn't started anything yet or whose device timed out.
 * Rendered as an honest empty queue rather than surfaced as a failure. */
export async function getQueue(
  accessToken: string,
): Promise<{ currentlyPlaying: SpotifyTrackSummary | null; queue: SpotifyTrackSummary[] }> {
  const empty = { currentlyPlaying: null, queue: [] };
  const payload = await spotifyApiRequest<{
    currently_playing: Record<string, unknown> | null;
    queue: Array<Record<string, unknown>>;
  } | null>(accessToken, "/me/player/queue", { method: "GET" }, "the playback queue", null);
  if (!payload) return empty;
  return {
    currentlyPlaying: toTrackSummary(payload.currently_playing),
    queue: (payload.queue ?? []).map(toTrackSummary).filter((t): t is SpotifyTrackSummary => t !== null),
  };
}

/** GET /me/player/devices. Also legitimately empty (an empty `devices`
 * array, not a 204, is Spotify's actual behaviour here) when nothing running
 * Spotify is currently reachable -- rendered as "no devices found", not an
 * error, same honest-empty philosophy as getQueue(). */
export async function getDevices(accessToken: string): Promise<SpotifyDevice[]> {
  const payload = await spotifyApiRequest<{ devices: Array<Record<string, unknown>> }>(
    accessToken,
    "/me/player/devices",
    { method: "GET" },
    "the device list",
  );
  return (payload.devices ?? []).map((d) => ({
    id: typeof d.id === "string" ? d.id : null,
    name: typeof d.name === "string" ? d.name : "Unnamed device",
    type: typeof d.type === "string" ? d.type : "Unknown",
    isActive: d.is_active === true,
    volumePercent: typeof d.volume_percent === "number" ? d.volume_percent : null,
  }));
}

/** PUT /me/player/play -- starts playback of a chosen context/track. Called
 * ONLY from a real click in listen-deck.tsx (playSpotifyTrack); see this
 * file's header comment. `deviceId` is optional: omitted, Spotify targets
 * whatever device is already active, which is the common case once the Web
 * Playback SDK's own device has been transferred to. */
export async function playTrack(
  accessToken: string,
  opts: { deviceId?: string; contextUri?: string; uris?: string[]; offset?: { uri: string } },
): Promise<void> {
  const params = new URLSearchParams();
  if (opts.deviceId) params.set("device_id", opts.deviceId);
  const qs = params.toString();
  await spotifyApiRequest<undefined>(
    accessToken,
    `/me/player/play${qs ? `?${qs}` : ""}`,
    {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        ...(opts.contextUri ? { context_uri: opts.contextUri } : {}),
        ...(opts.uris ? { uris: opts.uris } : {}),
        ...(opts.offset ? { offset: opts.offset } : {}),
      }),
    },
    "starting playback",
  );
}

/** PUT /me/player -- transfers playback to a different Spotify Connect
 * device. Called ONLY from a real click in listen-deck.tsx
 * (transferSpotifyPlayback); see this file's header comment. */
export async function transferPlayback(accessToken: string, deviceId: string, play?: boolean): Promise<void> {
  await spotifyApiRequest<undefined>(
    accessToken,
    "/me/player",
    {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ device_ids: [deviceId], ...(play !== undefined ? { play } : {}) }),
    },
    "transferring playback",
  );
}
