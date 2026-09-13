// Reads the real Spotify Connect queue -- the control center's Queue tab.
// Same shape as the sibling routes; see token/route.ts for the pattern.
import { createClient } from "@/lib/supabase/server";
import { createServiceClient } from "@/lib/supabase/service";
import { resolveSpotifyConfig } from "@/lib/music/spotify/config";
import { acquireAccessToken } from "@/lib/music/spotify/connection";
import { getQueue, SpotifyError } from "@/lib/music/spotify/spotify";

const NO_STORE = { headers: { "Cache-Control": "no-store" } };

function json(body: unknown, status = 200) {
  return Response.json(body, { ...NO_STORE, status });
}

export async function GET(request: Request) {
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
    console.error("[music/spotify/player/queue] couldn't mint an access token:", err);
    return json({ error: "Spotify didn't return a token. Try again in a moment." }, 502);
  }

  if (token.outcome === "not-connected") {
    return json({ connected: false, error: "No Spotify account is connected." }, 409);
  }
  if (token.outcome === "reconnect-required") {
    return json({ connected: true, error: token.reason, reconnectRequired: true }, 409);
  }

  try {
    const result = await getQueue(token.accessToken);
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
    console.error("[music/spotify/player/queue] couldn't read the queue:", err);
    return json({ error: "Spotify didn't return your queue. Try again in a moment." }, 502);
  }
}
