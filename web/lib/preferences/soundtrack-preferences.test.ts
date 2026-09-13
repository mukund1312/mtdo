// Unit coverage for the plain Supabase-client functions backing task-tied
// soundtracks (migrations/0026). No existing lib file in this codebase mocks
// a chainable Supabase query builder for its own tests -- this file builds
// one minimal mock chain rather than reaching for an untested precedent.
import { describe, expect, it, vi } from "vitest";

import {
  clearSoundtrackPreference,
  getSoundtrackPreference,
  listSoundtrackPreferences,
  saveSoundtrackPreference,
} from "./soundtrack-preferences";

/** A chainable mock matching Supabase's query builder: every method but the
 * terminal one (maybeSingle, or the implicit thenable resolution of the
 * builder itself) returns `this`, so tests can call `.from().select().eq()`
 * etc in any order this file's functions actually use. */
function makeQueryMock(result: { data: unknown; error: unknown }) {
  const builder: Record<string, unknown> = {};
  const chain = ["select", "eq", "not", "upsert", "delete"];
  for (const method of chain) {
    builder[method] = vi.fn(() => builder);
  }
  builder.maybeSingle = vi.fn(() => Promise.resolve(result));
  // The builder itself is thenable when a query has no terminal call
  // (e.g. a plain `.select()` list read, or `.upsert()`/`.delete()` with no
  // `.maybeSingle()` after it) -- supabase-js resolves it directly on await.
  builder.then = (
    resolve: (value: { data: unknown; error: unknown }) => unknown,
    reject?: (reason: unknown) => unknown,
  ) => Promise.resolve(result).then(resolve, reject);
  return builder;
}

function makeSupabaseMock(result: { data: unknown; error: unknown }, userId = "user-1") {
  const query = makeQueryMock(result);
  return {
    auth: { getUser: vi.fn(() => Promise.resolve({ data: { user: { id: userId } }, error: null })) },
    from: vi.fn(() => query),
    query,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
}

describe("listSoundtrackPreferences", () => {
  it("maps rows into the client-facing shape", async () => {
    const rows = [
      { topic_type: "DSA", spotify_playlist_id: "p1", spotify_playlist_name: "Deep Focus", spotify_playlist_uri: "spotify:playlist:p1" },
    ];
    const supabase = makeSupabaseMock({ data: rows, error: null });
    const result = await listSoundtrackPreferences(supabase);
    expect(result).toEqual({
      ok: true,
      preferences: [{ topicType: "DSA", spotifyPlaylistId: "p1", spotifyPlaylistName: "Deep Focus", spotifyPlaylistUri: "spotify:playlist:p1" }],
    });
  });

  it("reports a failure honestly rather than throwing", async () => {
    const supabase = makeSupabaseMock({ data: null, error: { message: "boom" } });
    const result = await listSoundtrackPreferences(supabase);
    expect(result.ok).toBe(false);
  });
});

describe("getSoundtrackPreference", () => {
  it("returns null, not an error, when no mapping is set for that topic type", async () => {
    const supabase = makeSupabaseMock({ data: null, error: null });
    const result = await getSoundtrackPreference(supabase, "System design");
    expect(result).toEqual({ ok: true, preference: null });
  });

  it("returns the mapped preference when one exists", async () => {
    const supabase = makeSupabaseMock({
      data: { topic_type: "Backend", spotify_playlist_id: "p2", spotify_playlist_name: "Backend Grind", spotify_playlist_uri: "spotify:playlist:p2" },
      error: null,
    });
    const result = await getSoundtrackPreference(supabase, "Backend");
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.preference?.spotifyPlaylistName).toBe("Backend Grind");
  });
});

describe("saveSoundtrackPreference", () => {
  it("upserts on (user_id, topic_type)", async () => {
    const supabase = makeSupabaseMock({ data: null, error: null });
    const result = await saveSoundtrackPreference(supabase, "user-1", {
      topicType: "DSA",
      playlistId: "p1",
      playlistName: "Deep Focus",
      playlistUri: "spotify:playlist:p1",
    });
    expect(result.ok).toBe(true);
    expect(supabase.query.upsert).toHaveBeenCalledWith(
      { user_id: "user-1", topic_type: "DSA", spotify_playlist_id: "p1", spotify_playlist_name: "Deep Focus", spotify_playlist_uri: "spotify:playlist:p1" },
      { onConflict: "user_id,topic_type" },
    );
  });
});

describe("clearSoundtrackPreference", () => {
  it("deletes the mapping for that topic type", async () => {
    const supabase = makeSupabaseMock({ data: null, error: null });
    const result = await clearSoundtrackPreference(supabase, "DSA");
    expect(result.ok).toBe(true);
    expect(supabase.query.delete).toHaveBeenCalled();
    expect(supabase.query.eq).toHaveBeenCalledWith("topic_type", "DSA");
  });
});
