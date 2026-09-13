// Lists the tracks in one playlist -- the drill-down after picking a
// playlist in the control center's library browser. Same shape as
// ../../route.ts and token/route.ts; see those for the pattern this follows.
import { createClient } from "@/lib/supabase/server";
import { createServiceClient } from "@/lib/supabase/service";
import { resolveSpotifyConfig } from "@/lib/music/spotify/config";
import { acquireAccessToken } from "@/lib/music/spotify/connection";
import { getPlaylistTracks, SpotifyError } from "@/lib/music/spotify/spotify";

const NO_STORE = { headers: { "Cache-Control": "no-store" } };

function json(body: unknown, status = 200) {
  return Response.json(body, { ...NO_STORE, status });
}

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id: playlistId } = await params;

  const supabase = await createClient();
  const {
    data: { user },
    error: userError,
  } = await supabase.auth.getUser();
  if (userError || !user) {
    return json({ error: "No authenticated session." }, 401);
  }

  const resolved = resolveSpotifyConfig(new URL(request.url).origin);
  if (!resolved.configured) {
    return json(
      { configured: false, error: "Spotify isn't configured on this server.", missing: resolved.missing },
      503,
    );
  }

  const service = createServiceClient();
  if (!service) {
    return json(
      {
        configured: false,
        error: "Spotify isn't configured on this server.",
        missing: ["SUPABASE_SERVICE_ROLE_KEY"],
      },
      503,
    );
  }

  let token;
  try {
    token = await acquireAccessToken(service, user.id, resolved.config);
  } catch (err) {
    console.error("[music/spotify/playlists/tracks] couldn't mint an access token:", err);
    return json({ error: "Spotify didn't return a token. Try again in a moment." }, 502);
  }

  if (token.outcome === "not-connected") {
    return json({ connected: false, error: "No Spotify account is connected." }, 409);
  }
  if (token.outcome === "reconnect-required") {
    return json({ connected: true, error: token.reason, reconnectRequired: true }, 409);
  }

  const { searchParams } = new URL(request.url);
  const limit = searchParams.get("limit");
  const offset = searchParams.get("offset");

  try {
    const result = await getPlaylistTracks(token.accessToken, playlistId, {
      limit: limit ? Number(limit) : undefined,
      offset: offset ? Number(offset) : undefined,
    });
    return json(result);
  } catch (err) {
    if (err instanceof SpotifyError && err.requiresReconnect) {
      return json(
        {
          connected: true,
          error: "Spotify says this connection is missing a permission it now needs. Reconnect to continue.",
          reconnectRequired: true,
        },
        409,
      );
    }
    console.error("[music/spotify/playlists/tracks] couldn't read playlist tracks:", err);
    return json({ error: "Spotify didn't return this playlist's tracks. Try again in a moment." }, 502);
  }
}
