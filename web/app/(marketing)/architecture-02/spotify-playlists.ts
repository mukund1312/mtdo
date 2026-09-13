/**
 * Client-side callers for the Phase 1 playlist/play routes
 * (GET /api/music/spotify/playlists, GET /api/music/spotify/playlists/{id}/tracks,
 * POST /api/music/spotify/player/play). Same discriminated-union shape as
 * spotify-token.ts's SpotifyTokenResult, and for the same reason: the four
 * failure kinds need different UI (reconnect vs. unconfigured vs. "try
 * again"), so collapsing them into one generic error would produce a wrong
 * UI, not just an imprecise one.
 */
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

export type SpotifyApiResult<T> =
  | ({ ok: true } & T)
  | { ok: false; kind: "not-connected" }
  | { ok: false; kind: "reconnect-required" }
  | { ok: false; kind: "transient" }
  | { ok: false; kind: "not-configured"; missing: string[] }
  | { ok: false; kind: "no-session" }
  | { ok: false; kind: "no-active-device" }
  | { ok: false; kind: "unknown"; status: number };

async function classifyFailure<T>(response: Response): Promise<SpotifyApiResult<T>> {
  if (response.status === 401) return { ok: false, kind: "no-session" };
  if (response.status === 502) return { ok: false, kind: "transient" };
  if (response.status === 503) {
    const body = (await response.json().catch(() => ({}))) as { missing?: string[] };
    return { ok: false, kind: "not-configured", missing: body.missing ?? [] };
  }
  if (response.status === 409) {
    const body = (await response.json().catch(() => ({}))) as { connected?: boolean; reconnectRequired?: boolean };
    return body.connected && body.reconnectRequired
      ? { ok: false, kind: "reconnect-required" }
      : { ok: false, kind: "not-connected" };
  }
  return { ok: false, kind: "unknown", status: response.status };
}

export async function fetchSpotifyPlaylists(): Promise<
  SpotifyApiResult<{ items: SpotifyPlaylistSummary[]; next: string | null }>
> {
  let response: Response;
  try {
    response = await fetch("/api/music/spotify/playlists", { cache: "no-store" });
  } catch (err) {
    console.error("[spotify-playlists] fetch failed:", err);
    return { ok: false, kind: "transient" };
  }
  if (response.ok) {
    const body = (await response.json()) as { items: SpotifyPlaylistSummary[]; next: string | null };
    return { ok: true, items: body.items, next: body.next };
  }
  return classifyFailure(response);
}

export async function fetchSpotifyPlaylistTracks(
  playlistId: string,
): Promise<SpotifyApiResult<{ items: SpotifyTrackSummary[]; next: string | null }>> {
  let response: Response;
  try {
    response = await fetch(`/api/music/spotify/playlists/${encodeURIComponent(playlistId)}/tracks`, {
      cache: "no-store",
    });
  } catch (err) {
    console.error("[spotify-playlists] fetch failed:", err);
    return { ok: false, kind: "transient" };
  }
  if (response.ok) {
    const body = (await response.json()) as { items: SpotifyTrackSummary[]; next: string | null };
    return { ok: true, items: body.items, next: body.next };
  }
  return classifyFailure(response);
}

/** POST /api/music/spotify/player/play. `onPlay*` helpers in listen-state.tsx
 * are the ONLY callers -- always from a real click in listen-deck.tsx, never
 * a background call (lib/music/spotify/spotify.ts's own invariant, held at
 * this boundary too). */
export type SpotifyPlayResult =
  | { ok: true }
  | { ok: false; kind: "not-connected" }
  | { ok: false; kind: "reconnect-required" }
  | { ok: false; kind: "transient" }
  | { ok: false; kind: "not-configured"; missing: string[] }
  | { ok: false; kind: "no-session" }
  | { ok: false; kind: "no-active-device" }
  | { ok: false; kind: "unknown"; status: number };

export async function postSpotifyPlay(opts: {
  contextUri?: string;
  uris?: string[];
  offset?: { uri: string };
}): Promise<SpotifyPlayResult> {
  let response: Response;
  try {
    response = await fetch("/api/music/spotify/player/play", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(opts),
    });
  } catch (err) {
    console.error("[spotify-playlists] play request failed:", err);
    return { ok: false, kind: "transient" };
  }
  if (response.ok) return { ok: true };
  // A "no active device" 409 carries neither `connected` nor
  // `reconnectRequired`, so the shared classifier's generic 409 handling
  // would otherwise misread it as "never connected". Read the body once
  // here (a Response body can only be consumed once) rather than reusing
  // classifyFailure, which would try to read it again.
  if (response.status === 409) {
    const body = (await response.json().catch(() => ({}))) as {
      connected?: boolean;
      reconnectRequired?: boolean;
      noActiveDevice?: boolean;
    };
    if (body.noActiveDevice) return { ok: false, kind: "no-active-device" };
    return body.connected && body.reconnectRequired
      ? { ok: false, kind: "reconnect-required" }
      : { ok: false, kind: "not-connected" };
  }
  return classifyFailure(response);
}
