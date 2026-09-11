// The Google Calendar API surface this app actually uses -- OAuth 2.0
// authorization-code exchange plus three event operations. Written against
// `fetch` with no SDK, the same choice lib/ai/providers/ollama.ts made and
// for the same reason: four endpoints do not justify a dependency, and the
// request shapes are stable, documented, and easier to test when they are
// visible in the file.
//
// ONE-WAY, MTDO -> Google (decisions.md 2026-09-11). There is deliberately no
// listEvents/getEvent here: nothing reads the user's calendar back, so no
// read scope is requested (lib/calendar/config.ts) and no Google-side edit can
// silently overwrite a block. If a future phase adds AI slot *suggestions*,
// they must remain suggestions -- a suggestion is a rendered option, not a
// call to createEvent().
import { GOOGLE_CALENDAR_SCOPES, type CalendarConfig } from "./config";

const AUTH_ENDPOINT = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
const CALENDAR_API = "https://www.googleapis.com/calendar/v3";

export class GoogleCalendarError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

export type GoogleTokenGrant = {
  accessToken: string;
  /** Absent when Google decides it has already issued one for this
   * client/user pair. `prompt=consent` below is what forces it to be present
   * on every consent, which matters because we store nothing else that could
   * mint an access token later. */
  refreshToken: string | null;
  scopes: string[];
};

export type CalendarEventInput = {
  description?: string;
  endAt: string;
  startAt: string;
  summary: string;
  /** IANA zone. Google accepts an offset-carrying RFC3339 timestamp on its
   * own, but sending the zone alongside is what makes a recurring/all-day
   * rendering and a DST transition behave the way the user expects. */
  timeZone: string;
};

export function buildAuthUrl(config: CalendarConfig, state: string): string {
  const url = new URL(AUTH_ENDPOINT);
  url.searchParams.set("client_id", config.clientId);
  url.searchParams.set("redirect_uri", config.redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", GOOGLE_CALENDAR_SCOPES.join(" "));
  // offline: we need a refresh token, because sync happens from a Route
  // Handler long after the user closed the consent tab.
  url.searchParams.set("access_type", "offline");
  // consent: without it Google omits refresh_token on every re-authorisation
  // after the first, and a user who disconnects and reconnects would end up
  // with a connection row that cannot mint an access token.
  url.searchParams.set("prompt", "consent");
  url.searchParams.set("include_granted_scopes", "true");
  url.searchParams.set("state", state);
  return url.toString();
}

async function postToken(body: URLSearchParams): Promise<Record<string, unknown>> {
  const response = await fetch(TOKEN_ENDPOINT, {
    body,
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    method: "POST",
  });
  const payload: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const detail =
      payload && typeof payload === "object" && "error_description" in payload
        ? String((payload as { error_description: unknown }).error_description)
        : `HTTP ${response.status}`;
    throw new GoogleCalendarError(`Google rejected the token request: ${detail}`, response.status);
  }
  return (payload ?? {}) as Record<string, unknown>;
}

export async function exchangeCodeForTokens(config: CalendarConfig, code: string): Promise<GoogleTokenGrant> {
  const payload = await postToken(
    new URLSearchParams({
      client_id: config.clientId,
      client_secret: config.clientSecret,
      code,
      grant_type: "authorization_code",
      redirect_uri: config.redirectUri,
    }),
  );
  const accessToken = typeof payload.access_token === "string" ? payload.access_token : null;
  if (!accessToken) {
    throw new GoogleCalendarError("Google's token response had no access_token.", 502);
  }
  return {
    accessToken,
    refreshToken: typeof payload.refresh_token === "string" ? payload.refresh_token : null,
    // Stored as granted, not as requested -- see calendar_connections.scopes'
    // own comment in migrations/0020.
    scopes: typeof payload.scope === "string" ? payload.scope.split(" ").filter(Boolean) : [],
  };
}

/** Access tokens are deliberately not persisted anywhere: they last an hour,
 * and a stored one is just another credential to protect for no benefit. Each
 * sync call mints a fresh one from the stored refresh token. */
export async function refreshAccessToken(config: CalendarConfig, refreshToken: string): Promise<string> {
  const payload = await postToken(
    new URLSearchParams({
      client_id: config.clientId,
      client_secret: config.clientSecret,
      grant_type: "refresh_token",
      refresh_token: refreshToken,
    }),
  );
  const accessToken = typeof payload.access_token === "string" ? payload.access_token : null;
  if (!accessToken) {
    throw new GoogleCalendarError("Google's refresh response had no access_token.", 502);
  }
  return accessToken;
}

function eventBody(event: CalendarEventInput) {
  return {
    description: event.description,
    end: { dateTime: event.endAt, timeZone: event.timeZone },
    start: { dateTime: event.startAt, timeZone: event.timeZone },
    summary: event.summary,
  };
}

async function callCalendar(
  accessToken: string,
  path: string,
  init: { body?: unknown; method: string },
): Promise<Record<string, unknown> | null> {
  const response = await fetch(`${CALENDAR_API}${path}`, {
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
    headers: {
      Authorization: `Bearer ${accessToken}`,
      ...(init.body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    method: init.method,
  });
  // A DELETE of an event that is already gone returns 410 (and sometimes 404).
  // Both mean "the desired end state already holds", which is success for an
  // idempotent unsync, not a failure to report to the user.
  if (init.method === "DELETE" && (response.ok || response.status === 404 || response.status === 410)) {
    return null;
  }
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new GoogleCalendarError(
      `Google Calendar returned ${response.status}${detail ? `: ${detail.slice(0, 300)}` : ""}`,
      response.status,
    );
  }
  return (await response.json().catch(() => null)) as Record<string, unknown> | null;
}

export async function createEvent(
  accessToken: string,
  calendarId: string,
  event: CalendarEventInput,
): Promise<string> {
  const created = await callCalendar(accessToken, `/calendars/${encodeURIComponent(calendarId)}/events`, {
    body: eventBody(event),
    method: "POST",
  });
  const id = created && typeof created.id === "string" ? created.id : null;
  if (!id) {
    throw new GoogleCalendarError("Google created an event but returned no id.", 502);
  }
  return id;
}

export async function updateEvent(
  accessToken: string,
  calendarId: string,
  eventId: string,
  event: CalendarEventInput,
): Promise<void> {
  // PATCH, not PUT: a user may have adjusted the event's colour, reminders or
  // guests on Google's side. Sync is one-way for the fields MTDO owns
  // (summary/description/start/end) -- it is not a licence to wipe fields MTDO
  // never set.
  await callCalendar(
    accessToken,
    `/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`,
    { body: eventBody(event), method: "PATCH" },
  );
}

export async function deleteEvent(accessToken: string, calendarId: string, eventId: string): Promise<void> {
  await callCalendar(
    accessToken,
    `/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`,
    { method: "DELETE" },
  );
}
