// Reading and writing calendar_connections (migrations/0020) -- the only
// module in the codebase that touches that table. It is service-role only and
// its refresh token is encrypted, so keeping every access in one file is what
// makes "the token never reaches a browser" checkable by reading one file
// rather than auditing every route.
//
// Every function here takes an already-verified `userId`. That id must come
// from the *anon* client's getUser() in the calling Route Handler, never from
// a request body or query string: the service client carries no session, so
// auth.uid() is null and RLS is not filtering anything (lib/supabase/
// service.ts rule 2).
import type { CalendarConfig } from "./config";
import { decryptRefreshToken, encryptRefreshToken } from "./crypto";
import { refreshAccessToken } from "./google";
import type { ServiceClient } from "@/lib/supabase/service";

export const CALENDAR_PROVIDER = "google";

export type CalendarConnectionSummary = {
  calendarId: string;
  connectedAt: string;
  scopes: string[];
};

/** Client-safe projection: everything a Settings panel legitimately needs,
 * and nothing that is a credential. The encrypted token is not in this type
 * on purpose -- there is no shape a route can accidentally spread into a
 * Response that carries it. */
export async function readConnectionSummary(
  service: ServiceClient,
  userId: string,
): Promise<CalendarConnectionSummary | null> {
  const { data, error } = await service
    .from("calendar_connections")
    .select("calendar_id, scopes, connected_at")
    .eq("user_id", userId)
    .eq("provider", CALENDAR_PROVIDER)
    .maybeSingle();
  if (error) throw error;
  if (!data) return null;
  return { calendarId: data.calendar_id, connectedAt: data.connected_at, scopes: data.scopes };
}

export async function storeConnection(
  service: ServiceClient,
  userId: string,
  config: CalendarConfig,
  grant: { refreshToken: string; scopes: string[] },
): Promise<void> {
  const { error } = await service.from("calendar_connections").upsert(
    {
      user_id: userId,
      provider: CALENDAR_PROVIDER,
      refresh_token_encrypted: encryptRefreshToken(grant.refreshToken, config.encryptionKey),
      scopes: grant.scopes,
    },
    // Re-consent replaces the stored token rather than accumulating dead ones
    // -- Google only returns a refresh_token on consent, so newest wins is the
    // only correct merge (migrations/0020, calendar_connections_user_provider_key).
    { onConflict: "user_id,provider" },
  );
  if (error) throw error;
}

/**
 * Mints a fresh access token for a user's connection. Returns null when there
 * is no connection at all -- a normal state (the user never connected), not
 * an error, and the caller turns it into a 409 rather than a 500.
 */
export async function acquireAccessToken(
  service: ServiceClient,
  userId: string,
  config: CalendarConfig,
): Promise<{ accessToken: string; calendarId: string } | null> {
  const { data, error } = await service
    .from("calendar_connections")
    .select("refresh_token_encrypted, calendar_id")
    .eq("user_id", userId)
    .eq("provider", CALENDAR_PROVIDER)
    .maybeSingle();
  if (error) throw error;
  if (!data) return null;

  const refreshToken = decryptRefreshToken(data.refresh_token_encrypted, config.encryptionKey);
  return {
    accessToken: await refreshAccessToken(config, refreshToken),
    calendarId: data.calendar_id,
  };
}

export async function deleteConnection(service: ServiceClient, userId: string): Promise<void> {
  const { error } = await service
    .from("calendar_connections")
    .delete()
    .eq("user_id", userId)
    .eq("provider", CALENDAR_PROVIDER);
  if (error) throw error;
}
