/**
 * The one place that calls GET /api/music/spotify/token (docs/architecture/
 * api.md §3i). The Web Playback SDK's `getOAuthToken` callback fires
 * repeatedly over the player's whole lifetime -- init, transfer, expiry,
 * every reconnect -- so this has to correctly classify all four response
 * shapes every single time it runs, not just on first mount.
 *
 * The four states are deliberately kept distinct rather than collapsed into
 * one generic "couldn't get a token" error (api.md §3i, "call-site contract"
 * point 3): a dead six-month authorization (`reconnect-required`) needs a
 * real re-consent, a Spotify-side hiccup (`transient`) needs a retry and
 * nothing else, "never connected" (`not-connected`) needs a Connect
 * affordance, and "server has no Spotify credentials" (`not-configured`)
 * needs the same honest missing-env-vars message every other integration in
 * this app uses. Mixing any two of these up produces a wrong UI, not just an
 * imprecise one.
 */
export type SpotifyTokenResult =
  | { ok: true; accessToken: string; expiresIn: number }
  | { ok: false; kind: "not-connected" }
  | { ok: false; kind: "reconnect-required" }
  | { ok: false; kind: "transient" }
  | { ok: false; kind: "not-configured"; missing: string[] }
  | { ok: false; kind: "no-session" }
  | { ok: false; kind: "unknown"; status: number };

export async function fetchSpotifyAccessToken(): Promise<SpotifyTokenResult> {
  let response: Response;
  try {
    response = await fetch("/api/music/spotify/token", { cache: "no-store" });
  } catch (err) {
    // A network failure reaching our own server is the same shape of problem
    // as Spotify itself being briefly unreachable: retry, don't re-OAuth.
    console.error("[spotify-token] fetch failed:", err);
    return { ok: false, kind: "transient" };
  }

  if (response.ok) {
    const body = (await response.json()) as { access_token: string; expires_in: number };
    return { ok: true, accessToken: body.access_token, expiresIn: body.expires_in };
  }

  if (response.status === 401) return { ok: false, kind: "no-session" };
  if (response.status === 502) return { ok: false, kind: "transient" };
  if (response.status === 503) {
    const body = (await response.json().catch(() => ({}))) as { missing?: string[] };
    return { ok: false, kind: "not-configured", missing: body.missing ?? [] };
  }
  if (response.status === 409) {
    const body = (await response.json().catch(() => ({}))) as { connected?: boolean; reconnectRequired?: boolean };
    return body.connected && body.reconnectRequired
      ? { ok: false, kind: "reconnect-required" }
      : { ok: false, kind: "not-connected" };
  }

  return { ok: false, kind: "unknown", status: response.status };
}
