// Reading and writing music_connections (migrations/0024) -- the only module
// in the codebase that touches that table, exactly as lib/calendar/
// connection.ts is for calendar_connections. It is service-role only and both
// of its tokens are encrypted, so keeping every access in one file is what
// makes "no token ever reaches a browser" checkable by reading one file rather
// than auditing every route.
//
// Every function here takes an already-verified `userId`. That id must come
// from the *anon* client's getUser() in the calling Route Handler, never from
// a request body or query string: the service client carries no session, so
// auth.uid() is null and RLS is not filtering anything (lib/supabase/
// service.ts rule 2).
import { decryptToken, encryptToken } from "@/lib/crypto/token-envelope";
import type { SpotifyConfig } from "./config";
import {
  REFRESH_TOKEN_LIFETIME_DAYS,
  SpotifyError,
  refreshAccessToken,
  type SpotifyProfile,
  type SpotifyTokenGrant,
} from "./spotify";
import type { Database } from "@/lib/supabase/database.types";
import type { ServiceClient } from "@/lib/supabase/service";

type MusicConnectionUpdate = Database["public"]["Tables"]["music_connections"]["Update"];

export const SPOTIFY_PROVIDER = "spotify";

const LABELS = { reconnect: "Reconnect Spotify.", stored: "Spotify token" } as const;

/**
 * How long before a cached access token's stated expiry it is treated as
 * already dead.
 *
 * Not arbitrary: the token is handed to a browser that then uses it for some
 * unknown period afterwards (the Web Playback SDK holds what it is given until
 * its own next callback). Returning a token with four seconds left would be
 * technically truthful and practically useless. Sixty seconds covers clock
 * skew between this server and Spotify's plus the round trip to the client,
 * and costs at most one extra refresh per hour.
 */
const EXPIRY_SKEW_SECONDS = 60;

/** Client-safe projection: everything a Settings panel or the Listen deck
 * legitimately needs, and nothing that is a credential. Neither encrypted
 * token is in this type on purpose -- there is no shape a route can
 * accidentally spread into a Response that carries one. */
export type SpotifyConnectionSummary = {
  connectedAt: string;
  displayName: string | null;
  /** True once the refresh token's six-month window has passed. Playback is
   * already broken at this point and the only fix is reconnecting; surfaced so
   * the UI can say that rather than showing a connected state that fails on
   * first use. */
  expired: boolean;
  /** 'premium' | 'free' | 'open' | null, captured at connect time. */
  product: string | null;
  /** Whether the Web Playback SDK can actually work for this account.
   * Computed here rather than left to each caller so the Premium rule is
   * stated once. Null product means unknown -- reported as null, not as
   * false, because "we could not read your tier" and "your tier cannot play"
   * are different things to show a user. */
  premium: boolean | null;
  refreshTokenExpiresAt: string | null;
  scopes: string[];
};

type ConnectionRow = {
  access_token_encrypted: string | null;
  access_token_expires_at: string | null;
  refresh_token_encrypted: string;
  refresh_token_expires_at: string | null;
};

function premiumFrom(product: string | null): boolean | null {
  return product === null ? null : product === "premium";
}

export async function readConnectionSummary(
  service: ServiceClient,
  userId: string,
): Promise<SpotifyConnectionSummary | null> {
  const { data, error } = await service
    .from("music_connections")
    .select("connected_at, display_name, product, refresh_token_expires_at, scopes")
    .eq("user_id", userId)
    .eq("provider", SPOTIFY_PROVIDER)
    .maybeSingle();
  if (error) throw error;
  if (!data) return null;
  return {
    connectedAt: data.connected_at,
    displayName: data.display_name,
    expired:
      data.refresh_token_expires_at !== null &&
      new Date(data.refresh_token_expires_at).getTime() <= Date.now(),
    premium: premiumFrom(data.product),
    product: data.product,
    refreshTokenExpiresAt: data.refresh_token_expires_at,
    scopes: data.scopes,
  };
}

/**
 * Stores a fresh consent. Called only from the OAuth callback.
 *
 * The access token from the initial exchange is cached alongside the refresh
 * token rather than thrown away -- the user is about to load the Listen deck,
 * which will immediately ask for one, and discarding a valid token we already
 * hold just to re-request it a second later would be pure waste.
 */
export async function storeConnection(
  service: ServiceClient,
  userId: string,
  config: SpotifyConfig,
  grant: { profile: SpotifyProfile | null; refreshToken: string } & Pick<
    SpotifyTokenGrant,
    "accessToken" | "expiresIn" | "scopes"
  >,
): Promise<void> {
  const now = Date.now();
  const { error } = await service.from("music_connections").upsert(
    {
      access_token_encrypted: encryptToken(grant.accessToken, config.encryptionKey),
      access_token_expires_at: new Date(now + grant.expiresIn * 1000).toISOString(),
      display_name: grant.profile?.displayName ?? null,
      product: grant.profile?.product ?? null,
      provider: SPOTIFY_PROVIDER,
      provider_account_id: grant.profile?.id ?? null,
      refresh_token_encrypted: encryptToken(grant.refreshToken, config.encryptionKey),
      // The six-month clock starts at THIS authorization, which is why
      // re-consenting has to replace the row rather than merge into it: the
      // old token carried the old, earlier deadline.
      refresh_token_expires_at: new Date(
        now + REFRESH_TOKEN_LIFETIME_DAYS * 24 * 60 * 60 * 1000,
      ).toISOString(),
      scopes: grant.scopes,
      user_id: userId,
    },
    { onConflict: "user_id,provider" },
  );
  if (error) throw error;
}

/** Distinguishes "this user never connected Spotify" (a normal state the
 * caller turns into a 409, not a 500) from "their connection is dead and they
 * must reconnect". Both are expected; neither is an error to log as one. */
export type AccessTokenResult =
  | { accessToken: string; expiresIn: number; outcome: "ok" }
  | { outcome: "not-connected" }
  | { outcome: "reconnect-required"; reason: string };

/**
 * THE CORE OF THE TOKEN ROUTE: returns a currently-valid access token for a
 * user, refreshing server-side only when the cached one is gone or within
 * EXPIRY_SKEW_SECONDS of expiry.
 *
 * WHY CACHE AT ALL (the alternative was refreshing on every call, which
 * lib/calendar/connection.ts does and which is genuinely simpler). The
 * calendar mints one token per explicit, user-initiated sync -- a handful a
 * day. The Web Playback SDK is the opposite: it invokes its getOAuthToken
 * callback on its own schedule -- initialisation, device transfer, token
 * expiry, every reconnect after a network blip -- so "refresh every call"
 * would turn ordinary listening into a stream of token requests to Spotify,
 * with the rate-limiting and latency that implies on a callback the SDK is
 * blocking on. Caching bounds it to roughly one refresh per hour per user.
 *
 * THE COST OF CACHING, accepted with eyes open: a cached token can be revoked
 * on Spotify's side (the user disconnects the app from their Spotify account
 * settings) and this server will keep serving it until it expires. The blast
 * radius is bounded by the one-hour lifetime and by the fact that a revoked
 * token simply fails at the SDK, which asks for another -- and THAT call
 * refreshes, hits `invalid_grant`, and correctly reports reconnect-required.
 * So the failure self-heals into the honest state within one callback.
 * decisions.md 2026-09-13.
 */
export async function acquireAccessToken(
  service: ServiceClient,
  userId: string,
  config: SpotifyConfig,
): Promise<AccessTokenResult> {
  const { data, error } = await service
    .from("music_connections")
    .select(
      "access_token_encrypted, access_token_expires_at, refresh_token_encrypted, refresh_token_expires_at",
    )
    .eq("user_id", userId)
    .eq("provider", SPOTIFY_PROVIDER)
    .maybeSingle();
  if (error) throw error;
  if (!data) return { outcome: "not-connected" };

  const row = data as ConnectionRow;

  const cached = readCachedAccessToken(row, config);
  if (cached) return { accessToken: cached.accessToken, expiresIn: cached.expiresIn, outcome: "ok" };

  // Checked BEFORE spending a round trip on a refresh that cannot succeed.
  // Spotify would answer invalid_grant anyway, so this is an optimisation
  // rather than the safety net -- the catch below is the safety net, because
  // a token can also be revoked long before its stated expiry.
  if (
    row.refresh_token_expires_at !== null &&
    new Date(row.refresh_token_expires_at).getTime() <= Date.now()
  ) {
    return {
      outcome: "reconnect-required",
      reason: "Your Spotify authorization has expired. Reconnect to keep playing.",
    };
  }

  let refreshToken: string;
  try {
    refreshToken = decryptToken(row.refresh_token_encrypted, config.encryptionKey, LABELS);
  } catch {
    // A stored token we cannot decrypt (rotated or mis-set key) is
    // indistinguishable from no connection, from the user's point of view.
    // Reporting reconnect-required is the only actionable answer; a 500 would
    // tell them nothing they can act on.
    return {
      outcome: "reconnect-required",
      reason: "Your stored Spotify credentials could not be read. Reconnect to continue.",
    };
  }

  let grant: SpotifyTokenGrant;
  try {
    grant = await refreshAccessToken(config, refreshToken);
  } catch (err) {
    if (err instanceof SpotifyError && err.requiresReconnect) {
      return {
        outcome: "reconnect-required",
        reason: "Spotify rejected the stored authorization. Reconnect to keep playing.",
      };
    }
    // A genuine outage or network failure. Rethrown so the route answers 502
    // -- deliberately NOT folded into reconnect-required, because telling a
    // user to redo their OAuth grant because Spotify had a bad thirty seconds
    // is both wrong and annoying.
    throw err;
  }

  await storeRefreshedTokens(service, userId, config, grant);
  return { accessToken: grant.accessToken, expiresIn: grant.expiresIn, outcome: "ok" };
}

function readCachedAccessToken(
  row: ConnectionRow,
  config: SpotifyConfig,
): { accessToken: string; expiresIn: number } | null {
  if (!row.access_token_encrypted || !row.access_token_expires_at) return null;
  const expiresAt = new Date(row.access_token_expires_at).getTime();
  if (Number.isNaN(expiresAt)) return null;
  const remainingSeconds = Math.floor((expiresAt - Date.now()) / 1000);
  if (remainingSeconds <= EXPIRY_SKEW_SECONDS) return null;
  try {
    return {
      accessToken: decryptToken(row.access_token_encrypted, config.encryptionKey, LABELS),
      expiresIn: remainingSeconds,
    };
  } catch {
    // An undecryptable CACHED token is recoverable in a way an undecryptable
    // refresh token is not -- fall through to a refresh rather than forcing a
    // reconnect over a disposable value.
    return null;
  }
}

/**
 * Writes back the result of a refresh.
 *
 * THE RULE THIS FUNCTION EXISTS TO ENFORCE: Spotify may or may not return a
 * new refresh_token on a refresh call. When it does not, the stored one stays
 * -- the column is simply not included in the update. Writing
 * `refresh_token_encrypted: null` (or encrypting an empty string) on a
 * successful refresh would destroy a working six-month connection on the first
 * refresh that happened not to rotate, which is most of them.
 */
async function storeRefreshedTokens(
  service: ServiceClient,
  userId: string,
  config: SpotifyConfig,
  grant: SpotifyTokenGrant,
): Promise<void> {
  // Typed against the generated row shape rather than Record<string, unknown>:
  // this is a partial update built conditionally, which is exactly the case
  // where a typo'd column name would otherwise be silently ignored by
  // PostgREST and leave the cache never updating.
  const patch: MusicConnectionUpdate = {
    access_token_encrypted: encryptToken(grant.accessToken, config.encryptionKey),
    access_token_expires_at: new Date(Date.now() + grant.expiresIn * 1000).toISOString(),
  };
  if (grant.refreshToken) {
    patch.refresh_token_encrypted = encryptToken(grant.refreshToken, config.encryptionKey);
    // Deliberately NOT extending refresh_token_expires_at. Spotify's six
    // months runs from the original authorization and refreshing does not
    // reset it; pushing the deadline out here would manufacture a false
    // expiry and turn a predictable "reconnect soon" into a surprise outage.
  }

  const { error } = await service
    .from("music_connections")
    .update(patch)
    .eq("user_id", userId)
    .eq("provider", SPOTIFY_PROVIDER);
  // Non-fatal on purpose: the caller already HAS a valid access token in hand.
  // Failing the whole request because the cache write failed would deny the
  // user playback over a performance optimisation.
  if (error) console.error("[spotify/connection] couldn't cache the refreshed token:", error);
}

export async function deleteConnection(service: ServiceClient, userId: string): Promise<void> {
  const { error } = await service
    .from("music_connections")
    .delete()
    .eq("user_id", userId)
    .eq("provider", SPOTIFY_PROVIDER);
  if (error) throw error;
}
