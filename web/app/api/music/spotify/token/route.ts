// The token-serving endpoint (docs/architecture/api.md §3i). This is the one
// route with no Google Calendar analogue, and the reason it exists is the Web
// Playback SDK's own architecture.
//
// The browser constructs its player with:
//
//     new Spotify.Player({ getOAuthToken: cb => { cb(token) }, ... })
//
// `getOAuthToken` is a callback the SDK invokes whenever it needs a token --
// at initialisation, on device transfer, when the current one expires, after
// any reconnect. So the browser cannot be handed a token once at connect time
// and left with it; it needs a way to ask for a CURRENT one at any moment.
// That is this route. The frontend's callback fetches here and passes
// `access_token` straight to `cb`.
//
// THE INVARIANT THIS ROUTE EXISTS TO HOLD: the refresh token NEVER leaves the
// server. Only the short-lived access token is ever in a response body. The
// refresh token is decrypted in lib/music/spotify/connection.ts, spent against
// Spotify, and discarded -- it has no path into any shape this file returns.
//
// `no-store`, unconditionally and including on the error paths. A cached
// access token served to a second request would be a credential sitting in a
// shared cache, and a cached error would strand a user whose connection has
// since been repaired.
import { createClient } from "@/lib/supabase/server";
import { createServiceClient } from "@/lib/supabase/service";
import { resolveSpotifyConfig } from "@/lib/music/spotify/config";
import { acquireAccessToken } from "@/lib/music/spotify/connection";

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

  let result;
  try {
    result = await acquireAccessToken(service, user.id, resolved.config);
  } catch (err) {
    // A genuine Spotify outage or network failure -- NOT a dead authorization,
    // which acquireAccessToken() returns as `reconnect-required` rather than
    // throwing. 502 is the honest code: this server is fine, its upstream is
    // not, and the client's correct response is to retry later rather than to
    // send the user through OAuth again.
    console.error("[music/spotify/token] couldn't mint an access token:", err);
    return json({ error: "Spotify didn't return a token. Try again in a moment." }, 502);
  }

  if (result.outcome === "not-connected") {
    // 409, matching /api/calendar/sync's use of it for the same situation: the
    // request is well-formed and authenticated, but the precondition (a
    // connection) is absent. Not a 404 -- the endpoint exists -- and not a
    // 401, which would read as a session problem and send a client into a
    // sign-in loop.
    return json({ connected: false, error: "No Spotify account is connected." }, 409);
  }

  if (result.outcome === "reconnect-required") {
    // Distinct from 409 on purpose. The UI response differs: 409 means "offer
    // a Connect button"; this means "your connection died, here is why, offer
    // Reconnect". Spotify refresh tokens genuinely expire (six months from
    // authorization, not extended by refreshing), so this is an expected
    // end-state for every long-lived connection, not an anomaly.
    return json({ connected: true, error: result.reason, reconnectRequired: true }, 409);
  }

  return json({
    access_token: result.accessToken,
    // Seconds, snake_case to match both Spotify's own token response and what
    // the SDK's surrounding code reads. The client should treat this as a
    // hint, not a guarantee, and simply re-fetch when the SDK asks again.
    expires_in: result.expiresIn,
  });
}
