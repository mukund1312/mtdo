// Unit coverage for Phase 1's playlist/queue/device/playback-control
// functions. Focused on the two genuinely load-bearing edge cases that are
// cheap to unit test and hard to e2e: a bare 204 from Spotify meaning "no
// active device" (a normal listener state, not an error), and a 403 meaning
// the stored grant is missing a scope this call needs (reconnect-required,
// not a generic failure). Real network calls are mocked -- see
// lib/calendar's absence of an equivalent as precedent for why this file, not
// an existing one, mocks global fetch directly rather than the module.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  getDevices,
  getPlaylistTracks,
  getQueue,
  listPlaylists,
  playTrack,
  SpotifyError,
  transferPlayback,
} from "./spotify";

const ACCESS_TOKEN = "test-access-token";

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function emptyResponse(status: number) {
  return new Response(null, { status });
}

const fetchMock = vi.fn();

beforeEach(() => {
  vi.stubGlobal("fetch", fetchMock);
  fetchMock.mockReset();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("listPlaylists", () => {
  it("maps a real playlist page into the summary shape, tolerating a missing image", () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        items: [
          { id: "p1", name: "Deep Focus", uri: "spotify:playlist:p1", images: [{ url: "https://img/1" }], tracks: { total: 84 } },
          { id: "p2", name: "No Cover", uri: "spotify:playlist:p2", images: [], tracks: { total: 0 } },
        ],
        next: null,
      }),
    );
    return listPlaylists(ACCESS_TOKEN).then((result) => {
      expect(result.items).toEqual([
        { id: "p1", name: "Deep Focus", trackCount: 84, imageUrl: "https://img/1", uri: "spotify:playlist:p1" },
        { id: "p2", name: "No Cover", trackCount: 0, imageUrl: null, uri: "spotify:playlist:p2" },
      ]);
    });
  });

  it("throws a reconnect-required SpotifyError on 403 -- an under-scoped pre-Phase-1 connection", async () => {
    fetchMock.mockResolvedValueOnce(emptyResponse(403));
    await expect(listPlaylists(ACCESS_TOKEN)).rejects.toMatchObject({
      requiresReconnect: true,
      status: 403,
    });
  });
});

describe("getPlaylistTracks", () => {
  it("filters out local/unavailable tracks that have no uri, rather than rendering a broken row", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        items: [
          { track: { uri: "spotify:track:1", name: "Real Track", artists: [{ name: "Artist A" }], duration_ms: 200000 } },
          { track: null },
          { track: { name: "No URI, e.g. removed from catalog" } },
        ],
        next: "https://api.spotify.com/v1/playlists/p1/tracks?offset=50",
      }),
    );
    const result = await getPlaylistTracks(ACCESS_TOKEN, "p1");
    expect(result.items).toHaveLength(1);
    expect(result.items[0]).toEqual({
      uri: "spotify:track:1",
      name: "Real Track",
      artists: ["Artist A"],
      album: null,
      imageUrl: null,
      durationMs: 200000,
    });
    expect(result.next).toBe("https://api.spotify.com/v1/playlists/p1/tracks?offset=50");
  });
});

describe("getQueue", () => {
  it("returns an honest empty queue on a bare 204 -- not an error", async () => {
    fetchMock.mockResolvedValueOnce(emptyResponse(204));
    const result = await getQueue(ACCESS_TOKEN);
    expect(result).toEqual({ currentlyPlaying: null, queue: [] });
  });

  it("parses a real currently-playing track and queue", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        currently_playing: { uri: "spotify:track:now", name: "Now Playing", artists: [], duration_ms: 100 },
        queue: [{ uri: "spotify:track:next", name: "Up Next", artists: [], duration_ms: 200 }],
      }),
    );
    const result = await getQueue(ACCESS_TOKEN);
    expect(result.currentlyPlaying?.name).toBe("Now Playing");
    expect(result.queue).toHaveLength(1);
    expect(result.queue[0]?.name).toBe("Up Next");
  });
});

describe("getDevices", () => {
  it("returns an empty list, not an error, when nothing is reachable", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ devices: [] }));
    const result = await getDevices(ACCESS_TOKEN);
    expect(result).toEqual([]);
  });

  it("maps real devices, defaulting a missing name/type rather than failing", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        devices: [
          { id: "d1", name: "MacBook", type: "Computer", is_active: true, volume_percent: 60 },
          { is_active: false },
        ],
      }),
    );
    const result = await getDevices(ACCESS_TOKEN);
    expect(result).toEqual([
      { id: "d1", name: "MacBook", type: "Computer", isActive: true, volumePercent: 60 },
      { id: null, name: "Unnamed device", type: "Unknown", isActive: false, volumePercent: null },
    ]);
  });

  it("throws reconnect-required on 403", async () => {
    fetchMock.mockResolvedValueOnce(emptyResponse(403));
    await expect(getDevices(ACCESS_TOKEN)).rejects.toBeInstanceOf(SpotifyError);
    fetchMock.mockResolvedValueOnce(emptyResponse(403));
    await expect(getDevices(ACCESS_TOKEN)).rejects.toMatchObject({ requiresReconnect: true });
  });
});

describe("playTrack", () => {
  it("PUTs to /me/player/play with the device id as a query param and the body as JSON", async () => {
    fetchMock.mockResolvedValueOnce(emptyResponse(204));
    await playTrack(ACCESS_TOKEN, { deviceId: "d1", contextUri: "spotify:playlist:p1" });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.spotify.com/v1/me/player/play?device_id=d1");
    expect(init.method).toBe("PUT");
    expect(JSON.parse(init.body as string)).toEqual({ context_uri: "spotify:playlist:p1" });
  });

  it("surfaces a 404 (no active device) as a distinct, non-reconnect SpotifyError", async () => {
    fetchMock.mockResolvedValueOnce(emptyResponse(404));
    await expect(playTrack(ACCESS_TOKEN, { uris: ["spotify:track:1"] })).rejects.toMatchObject({
      status: 404,
      requiresReconnect: false,
    });
  });
});

describe("transferPlayback", () => {
  it("PUTs to /me/player with device_ids as a single-element array", async () => {
    fetchMock.mockResolvedValueOnce(emptyResponse(204));
    await transferPlayback(ACCESS_TOKEN, "d2", true);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.spotify.com/v1/me/player");
    expect(init.method).toBe("PUT");
    expect(JSON.parse(init.body as string)).toEqual({ device_ids: ["d2"], play: true });
  });
});
