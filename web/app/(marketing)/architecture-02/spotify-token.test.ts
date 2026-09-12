// GET /api/music/spotify/token is called repeatably by the Web Playback
// SDK's getOAuthToken callback (init, transfer, expiry, every reconnect) --
// this pins that fetchSpotifyAccessToken() classifies each of the four
// documented response shapes (docs/architecture/api.md §3i) correctly and
// distinctly every time it's invoked, not just on a first, lucky call.
import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchSpotifyAccessToken } from "./spotify-token";

function jsonResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as Response;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("fetchSpotifyAccessToken", () => {
  it("returns the access token on 200", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse(200, { access_token: "at-1", expires_in: 3600 })));
    const result = await fetchSpotifyAccessToken();
    expect(result).toEqual({ ok: true, accessToken: "at-1", expiresIn: 3600 });
  });

  it("classifies 409 { connected: false } as not-connected -- offer Connect", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse(409, { connected: false, error: "no connection" })));
    const result = await fetchSpotifyAccessToken();
    expect(result).toEqual({ ok: false, kind: "not-connected" });
  });

  it("classifies 409 { connected: true, reconnectRequired: true } as reconnect-required -- offer Reconnect, not Connect", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse(409, { connected: true, error: "refresh token rejected", reconnectRequired: true })),
    );
    const result = await fetchSpotifyAccessToken();
    expect(result).toEqual({ ok: false, kind: "reconnect-required" });
  });

  it("classifies 502 as transient -- retry, never prompt re-authorization", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse(502, { error: "spotify unreachable" })));
    const result = await fetchSpotifyAccessToken();
    expect(result).toEqual({ ok: false, kind: "transient" });
  });

  it("classifies 503 as not-configured and carries the missing var names", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse(503, { configured: false, missing: ["SPOTIFY_CLIENT_ID", "SPOTIFY_TOKEN_ENCRYPTION_KEY"] })),
    );
    const result = await fetchSpotifyAccessToken();
    expect(result).toEqual({ ok: false, kind: "not-configured", missing: ["SPOTIFY_CLIENT_ID", "SPOTIFY_TOKEN_ENCRYPTION_KEY"] });
  });

  it("classifies 401 as no-session", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse(401, { error: "No authenticated session." })));
    const result = await fetchSpotifyAccessToken();
    expect(result).toEqual({ ok: false, kind: "no-session" });
  });

  it("treats a thrown network error the same as a transient Spotify-side failure", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("network down");
      }),
    );
    const result = await fetchSpotifyAccessToken();
    expect(result).toEqual({ ok: false, kind: "transient" });
  });

  it("falls back to an unknown-status result for anything undocumented, rather than throwing", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse(500, { error: "boom" })));
    const result = await fetchSpotifyAccessToken();
    expect(result).toEqual({ ok: false, kind: "unknown", status: 500 });
  });
});
