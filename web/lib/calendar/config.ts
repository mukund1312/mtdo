// Google Calendar configuration resolution, modelled directly on
// lib/ai/service.ts's resolveProvider(): an external dependency that may
// simply not be set up, reported honestly rather than crashed on or faked.
//
// Nothing in the core loop may hard-require this. Scheduling a block onto a
// date/time (schedule_block(), migrations/0019) works completely
// independently of whether a calendar is connected -- Google is a mirror of
// the schedule, never its home. Every route in app/api/calendar/** checks
// this first and returns a clean 503 with the real reason when it comes back
// unconfigured.
//
// Real GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET credentials do NOT exist in
// this environment yet (see .env.example and PROGRESS.md's Phase 6 entry), so
// "unconfigured" is the path that was actually exercised end to end during
// development, not a speculative branch.
import { parseEncryptionKey } from "./crypto";

/** Least privilege: create/update/delete events on calendars the user already
 * has, and nothing else. Notably NOT `calendar` (full read/write of calendar
 * metadata) or any readonly scope -- V1 sync is one-way, MTDO -> Google, so
 * this app never needs to read the user's existing events. Widening this list
 * later is a re-consent, which is why the granted scopes are stored on the
 * connection row rather than assumed. */
export const GOOGLE_CALENDAR_SCOPES = ["https://www.googleapis.com/auth/calendar.events"] as const;

/** Name of the httpOnly cookie carrying the OAuth `state` nonce between
 * /api/calendar/connect and /api/calendar/callback. Lives here rather than in
 * either route file because Next validates the export shape of `route.ts` --
 * a stray named export there is a build error, not a shared constant. */
export const OAUTH_STATE_COOKIE = "mtdo-calendar-oauth-state";

export type CalendarConfig = {
  clientId: string;
  clientSecret: string;
  encryptionKey: Buffer;
  /** Exactly what must be registered in the Google Cloud console as an
   * authorised redirect URI. Google matches it byte-for-byte. */
  redirectUri: string;
};

export type CalendarConfigResult =
  | { configured: true; config: CalendarConfig }
  | { configured: false; missing: string[] };

/**
 * `origin` is used only to derive a redirect URI when GOOGLE_OAUTH_REDIRECT_URI
 * is not set -- convenient for local development, where the origin is stable.
 * Set the env var explicitly for any real deployment: Google compares the
 * redirect URI against its registered list exactly, and a preview deployment's
 * generated hostname will never be on it.
 */
export function resolveCalendarConfig(origin: string): CalendarConfigResult {
  const missing: string[] = [];

  const clientId = process.env.GOOGLE_CLIENT_ID;
  if (!clientId) missing.push("GOOGLE_CLIENT_ID");

  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  if (!clientSecret) missing.push("GOOGLE_CLIENT_SECRET");

  // A present-but-malformed key counts as missing, deliberately. The
  // alternative is discovering it at the moment a real user finishes Google's
  // consent screen and we cannot store what they just granted.
  const encryptionKey = parseEncryptionKey(process.env.CALENDAR_TOKEN_ENCRYPTION_KEY);
  if (!encryptionKey) missing.push("CALENDAR_TOKEN_ENCRYPTION_KEY");

  // Listed here rather than only inside createServiceClient() because a
  // missing service key makes calendar *specifically* unusable (tokens have
  // nowhere to be stored that a browser cannot reach), and the operator
  // reading the status panel needs to be told which of the four is absent.
  if (!process.env.SUPABASE_SERVICE_ROLE_KEY) missing.push("SUPABASE_SERVICE_ROLE_KEY");

  if (missing.length > 0 || !clientId || !clientSecret || !encryptionKey) {
    return { configured: false, missing };
  }

  return {
    configured: true,
    config: {
      clientId,
      clientSecret,
      encryptionKey,
      redirectUri: process.env.GOOGLE_OAUTH_REDIRECT_URI ?? new URL("/api/calendar/callback", origin).toString(),
    },
  };
}
