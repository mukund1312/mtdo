// Task-tied soundtracks: reading and writing soundtrack_preferences
// (migrations/0026). Plain functions taking a Supabase client, not a
// localStorage hook like focus-timer.ts/focus-sandglass.ts -- this is
// DB-backed and cross-device (a user's mapping should survive a fresh
// browser), the same posture as blocks.notes (calendar-deck.tsx's
// saveBlockNotes), not a device-local UI toggle.
//
// Deliberately no service-role client anywhere in this file: a chosen
// playlist id/name/uri is a preference the user picked, not a credential --
// ordinary RLS (owner-only, migrations/0026) is the right and sufficient
// gate, the same posture blocks.notes already has.
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/database.types";

export type SoundtrackPreference = {
  topicType: string;
  spotifyPlaylistId: string;
  spotifyPlaylistName: string;
  spotifyPlaylistUri: string;
};

type SoundtrackPreferenceRow = Pick<
  Database["public"]["Tables"]["soundtrack_preferences"]["Row"],
  "topic_type" | "spotify_playlist_id" | "spotify_playlist_name" | "spotify_playlist_uri"
>;

function toPreference(row: SoundtrackPreferenceRow): SoundtrackPreference {
  return {
    topicType: row.topic_type,
    spotifyPlaylistId: row.spotify_playlist_id,
    spotifyPlaylistName: row.spotify_playlist_name,
    spotifyPlaylistUri: row.spotify_playlist_uri,
  };
}

function errorMessage(error: unknown, fallback: string): string {
  if (!error || typeof error !== "object") return fallback;
  const candidate = error as { message?: string };
  return candidate.message || fallback;
}

/** All of the current user's mappings -- RLS already scopes this to their
 * own rows, no explicit user_id filter needed here. */
export async function listSoundtrackPreferences(
  supabase: SupabaseClient<Database>,
): Promise<{ ok: true; preferences: SoundtrackPreference[] } | { ok: false; message: string }> {
  const { data, error } = await supabase
    .from("soundtrack_preferences")
    .select("topic_type, spotify_playlist_id, spotify_playlist_name, spotify_playlist_uri");
  if (error) {
    console.error("[soundtrack-preferences] failed to list:", error);
    return { ok: false, message: errorMessage(error, "Couldn't load your soundtrack mappings.") };
  }
  return { ok: true, preferences: data.map(toPreference) };
}

/** One mapping for a single topic type, or null if unset -- the shape the
 * session screen actually needs (it only ever cares about one block's own
 * topic type at a time). */
export async function getSoundtrackPreference(
  supabase: SupabaseClient<Database>,
  topicType: string,
): Promise<{ ok: true; preference: SoundtrackPreference | null } | { ok: false; message: string }> {
  const { data, error } = await supabase
    .from("soundtrack_preferences")
    .select("topic_type, spotify_playlist_id, spotify_playlist_name, spotify_playlist_uri")
    .eq("topic_type", topicType)
    .maybeSingle();
  if (error) {
    console.error("[soundtrack-preferences] failed to read one:", error);
    return { ok: false, message: errorMessage(error, "Couldn't check your soundtrack mapping.") };
  }
  return { ok: true, preference: data ? toPreference(data) : null };
}

/** Upserts on (user_id, topic_type) -- migrations/0026's unique constraint --
 * so re-mapping an already-mapped topic type replaces it rather than erroring
 * or accumulating a duplicate row. */
export async function saveSoundtrackPreference(
  supabase: SupabaseClient<Database>,
  userId: string,
  params: { topicType: string; playlistId: string; playlistName: string; playlistUri: string },
): Promise<{ ok: true } | { ok: false; message: string }> {
  const { error } = await supabase.from("soundtrack_preferences").upsert(
    {
      user_id: userId,
      topic_type: params.topicType,
      spotify_playlist_id: params.playlistId,
      spotify_playlist_name: params.playlistName,
      spotify_playlist_uri: params.playlistUri,
    },
    { onConflict: "user_id,topic_type" },
  );
  if (error) {
    console.error("[soundtrack-preferences] failed to save:", error);
    return { ok: false, message: errorMessage(error, "Couldn't save that soundtrack mapping.") };
  }
  return { ok: true };
}

export async function clearSoundtrackPreference(
  supabase: SupabaseClient<Database>,
  topicType: string,
): Promise<{ ok: true } | { ok: false; message: string }> {
  const { error } = await supabase.from("soundtrack_preferences").delete().eq("topic_type", topicType);
  if (error) {
    console.error("[soundtrack-preferences] failed to clear:", error);
    return { ok: false, message: errorMessage(error, "Couldn't clear that soundtrack mapping.") };
  }
  return { ok: true };
}
