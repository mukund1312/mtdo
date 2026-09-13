/**
 * Client-side callers for the Phase 1 queue/device/transfer routes
 * (GET /api/music/spotify/player/queue, GET /api/music/spotify/player/devices,
 * POST /api/music/spotify/player/transfer). Same discriminated-union-result
 * pattern as spotify-token.ts and spotify-playlists.ts, for the same reason:
 * the failure kinds need different UI, so collapsing them into one generic
 * error would produce a wrong UI, not just an imprecise one.
 */
import type { SpotifyTrackSummary } from "./spotify-playlists";

export type { SpotifyTrackSummary } from "./spotify-playlists";

export type SpotifyDevice = {
  id: string | null;
  name: string;
  type: string;
  isActive: boolean;
  volumePercent: number | null;
};

export type SpotifyQueue = {
  currentlyPlaying: SpotifyTrackSummary | null;
  queue: SpotifyTrackSummary[];
};

export type SpotifyApiResult<T> =
  | ({ ok: true } & T)
  | { ok: false; kind: "not-connected" }
  | { ok: false; kind: "reconnect-required" }
  | { ok: false; kind: "transient" }
  | { ok: false; kind: "not-configured"; missing: string[] }
  | { ok: false; kind: "no-session" }
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

export async function fetchSpotifyQueue(): Promise<SpotifyApiResult<SpotifyQueue>> {
  let response: Response;
  try {
    response = await fetch("/api/music/spotify/player/queue", { cache: "no-store" });
  } catch (err) {
    console.error("[spotify-player] queue fetch failed:", err);
    return { ok: false, kind: "transient" };
  }
  if (response.ok) {
    const body = (await response.json()) as SpotifyQueue;
    return { ok: true, currentlyPlaying: body.currentlyPlaying, queue: body.queue };
  }
  return classifyFailure(response);
}

export async function fetchSpotifyDevices(): Promise<SpotifyApiResult<{ devices: SpotifyDevice[] }>> {
  let response: Response;
  try {
    response = await fetch("/api/music/spotify/player/devices", { cache: "no-store" });
  } catch (err) {
    console.error("[spotify-player] devices fetch failed:", err);
    return { ok: false, kind: "transient" };
  }
  if (response.ok) {
    const body = (await response.json()) as { devices: SpotifyDevice[] };
    return { ok: true, devices: body.devices };
  }
  return classifyFailure(response);
}

export type SpotifyTransferResult =
  | { ok: true }
  | { ok: false; kind: "not-connected" }
  | { ok: false; kind: "reconnect-required" }
  | { ok: false; kind: "transient" }
  | { ok: false; kind: "not-configured"; missing: string[] }
  | { ok: false; kind: "no-session" }
  | { ok: false; kind: "unknown"; status: number };

/** POST /api/music/spotify/player/transfer. Called ONLY from a real click on
 * a device row in listen-deck.tsx -- never a background call, matching
 * postSpotifyPlay's same invariant in spotify-playlists.ts. */
export async function postSpotifyTransfer(deviceId: string, play?: boolean): Promise<SpotifyTransferResult> {
  let response: Response;
  try {
    response = await fetch("/api/music/spotify/player/transfer", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ deviceId, play }),
    });
  } catch (err) {
    console.error("[spotify-player] transfer request failed:", err);
    return { ok: false, kind: "transient" };
  }
  if (response.ok) return { ok: true };
  return classifyFailure(response);
}
