// Disconnect Spotify (docs/architecture/api.md §3i).
//
// MUCH SIMPLER THAN /api/calendar/disconnect, and the difference is worth
// stating rather than leaving as an apparent inconsistency. That route has to
// delete the Google events mtdo created BEFORE dropping the connection,
// because the connection holds the only token that could reach them. Spotify
// playback creates nothing on the user's account -- this server never issues a
// playback command at all (lib/music/spotify/spotify.ts has no player
// endpoints) -- so there is no external state to clean up. Deleting the row is
// genuinely the whole operation.
//
// What this does NOT do, named rather than silently omitted: it does not
// revoke the grant on Spotify's side. Spotify exposes no token-revocation
// endpoint for the PKCE flow; a user who wants the app's access removed from
// their Spotify account entirely does that in their own Spotify settings. What
// this route guarantees is the half that is in this system's control -- after
// it, mtdo holds no credential for that account and cannot mint another token.
import { createClient } from "@/lib/supabase/server";
import { createServiceClient } from "@/lib/supabase/service";
import { resolveSpotifyConfig } from "@/lib/music/spotify/config";
import { deleteConnection } from "@/lib/music/spotify/connection";

export async function POST(request: Request) {
  const supabase = await createClient();
  const {
    data: { user },
    error: userError,
  } = await supabase.auth.getUser();
  if (userError || !user) {
    return Response.json({ error: "No authenticated session." }, { status: 401 });
  }

  const resolved = resolveSpotifyConfig(new URL(request.url).origin);
  const service = createServiceClient();
  if (!resolved.configured || !service) {
    return Response.json(
      {
        configured: false,
        error: "Spotify isn't configured on this server.",
        missing: resolved.configured ? ["SUPABASE_SERVICE_ROLE_KEY"] : resolved.missing,
      },
      { status: 503 },
    );
  }

  try {
    await deleteConnection(service, user.id);
  } catch (err) {
    console.error("[music/spotify/disconnect] failed to delete the connection:", err);
    return Response.json({ error: "Couldn't disconnect Spotify." }, { status: 500 });
  }

  // Idempotent by construction: a DELETE matching no rows is a success, so
  // disconnecting an already-disconnected account returns the same 200 rather
  // than a 404. The caller asked for a state, and that state holds.
  return Response.json({ disconnected: true });
}
