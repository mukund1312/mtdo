// Transfers playback to a chosen Spotify Connect device. THE OTHER ROUTE
// WITH A REAL SIDE EFFECT: called only from transferSpotifyPlayback() in
// listen-state.tsx, itself only ever invoked from a real click on a device
// row in listen-deck.tsx. See lib/music/spotify/spotify.ts's header comment.
import { createClient } from "@/lib/supabase/server";
import { createServiceClient } from "@/lib/supabase/service";
import { resolveSpotifyConfig } from "@/lib/music/spotify/config";
import { acquireAccessToken } from "@/lib/music/spotify/connection";
import { transferPlayback, SpotifyError } from "@/lib/music/spotify/spotify";

const NO_STORE = { headers: { "Cache-Control": "no-store" } };

function json(body: unknown, status = 200) {
  return Response.json(body, { ...NO_STORE, status });
}

export async function POST(request: Request) {
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

  const body = (await request.json().catch(() => null)) as { deviceId?: string; play?: boolean } | null;
  if (!body?.deviceId) {
    return json({ error: "Provide deviceId to transfer playback to." }, 400);
  }

  let token;
  try {
    token = await acquireAccessToken(service, user.id, resolved.config);
  } catch (err) {
    console.error("[music/spotify/player/transfer] couldn't mint an access token:", err);
    return json({ error: "Spotify didn't return a token. Try again in a moment." }, 502);
  }

  if (token.outcome === "not-connected") {
    return json({ connected: false, error: "No Spotify account is connected." }, 409);
  }
  if (token.outcome === "reconnect-required") {
    return json({ connected: true, error: token.reason, reconnectRequired: true }, 409);
  }

  try {
    await transferPlayback(token.accessToken, body.deviceId, body.play);
    return json({ ok: true });
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
    console.error("[music/spotify/player/transfer] couldn't transfer playback:", err);
    return json({ error: "Spotify couldn't switch devices. Try again in a moment." }, 502);
  }
}
