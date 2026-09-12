// Spotify status (docs/architecture/api.md §3i). The direct analogue of
// GET /api/calendar/status and GET /api/ai/status: it reports what the
// server-env-driven configuration actually resolves to right now, and whether
// this user has a live connection -- it never fakes a success.
//
// Real SPOTIFY_CLIENT_ID does not exist in this environment yet, so
// `configured: false` is the response this route genuinely returns today, and
// `missing` names exactly which variables are absent rather than leaving an
// operator to guess. Nothing in the core loop depends on this coming back
// true.
//
// It is also where the PREMIUM CONSTRAINT surfaces. The Web Playback SDK
// requires a Spotify Premium account -- a permanent platform restriction, not
// a bug to fix later -- so `connection.premium` carries the real captured
// signal (true / false / null for unknown) and the Listen deck renders an
// honest "Premium required" state from it rather than showing a player that
// never produces sound.
//
// Auth-gated for the same reason /api/ai/status is: `missing` is deployment
// detail, not public information.
import { createClient } from "@/lib/supabase/server";
import { createServiceClient } from "@/lib/supabase/service";
import { resolveSpotifyConfig } from "@/lib/music/spotify/config";
import { readConnectionSummary } from "@/lib/music/spotify/connection";

export async function GET(request: Request) {
  const supabase = await createClient();
  const {
    data: { user },
    error: userError,
  } = await supabase.auth.getUser();
  if (userError || !user) {
    return Response.json({ error: "No authenticated session." }, { status: 401 });
  }

  const noStore = { headers: { "Cache-Control": "no-store" } };
  const resolved = resolveSpotifyConfig(new URL(request.url).origin);
  if (!resolved.configured) {
    return Response.json(
      { configured: false, connected: false, connection: null, missing: resolved.missing, provider: "spotify" },
      noStore,
    );
  }

  const service = createServiceClient();
  if (!service) {
    // Unreachable in practice -- resolveSpotifyConfig() already lists
    // SUPABASE_SERVICE_ROLE_KEY in `missing` -- but reported as unconfigured
    // rather than thrown, so a future change to either check can't turn this
    // into a 500 on the Listen deck.
    return Response.json(
      {
        configured: false,
        connected: false,
        connection: null,
        missing: ["SUPABASE_SERVICE_ROLE_KEY"],
        provider: "spotify",
      },
      noStore,
    );
  }

  let connection = null;
  try {
    connection = await readConnectionSummary(service, user.id);
  } catch (err) {
    console.error("[music/spotify/status] failed to read the connection:", err);
    return Response.json({ error: "Couldn't read the Spotify connection." }, { status: 500 });
  }

  // `connected` stays true for an expired connection, with `connection.expired`
  // carrying the distinction. Collapsing the two would lose real information:
  // "you never connected" and "your six-month authorization ran out" need
  // different words on screen, and only the second one can say when.
  return Response.json(
    { configured: true, connected: connection !== null, connection, missing: [], provider: "spotify" },
    noStore,
  );
}
