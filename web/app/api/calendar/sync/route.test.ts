// Tests for POST /api/calendar/sync (see route.ts's header for the full
// contract). Google itself and the connection/token plumbing are mocked --
// what is under test here is the routing logic between them: which Google
// call a given (link exists?, enabled?) combination makes, and the refusals
// that must happen before any of it.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { randomBytes } from "node:crypto";

const { mockGetUser, mockFrom } = vi.hoisted(() => ({ mockGetUser: vi.fn(), mockFrom: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({
  createClient: vi.fn(async () => ({ auth: { getUser: mockGetUser }, from: mockFrom })),
}));

const { mockServiceFrom, mockCreateServiceClient } = vi.hoisted(() => ({
  mockServiceFrom: vi.fn(),
  mockCreateServiceClient: vi.fn(),
}));
vi.mock("@/lib/supabase/service", () => ({ createServiceClient: mockCreateServiceClient }));

const { mockAcquireAccessToken } = vi.hoisted(() => ({ mockAcquireAccessToken: vi.fn() }));
vi.mock("@/lib/calendar/connection", () => ({
  CALENDAR_PROVIDER: "google",
  acquireAccessToken: mockAcquireAccessToken,
}));

const { mockCreateEvent, mockUpdateEvent, mockDeleteEvent } = vi.hoisted(() => ({
  mockCreateEvent: vi.fn(),
  mockUpdateEvent: vi.fn(),
  mockDeleteEvent: vi.fn(),
}));
vi.mock("@/lib/calendar/google", async () => {
  const actual = await vi.importActual<typeof import("@/lib/calendar/google")>("@/lib/calendar/google");
  return {
    GoogleCalendarError: actual.GoogleCalendarError,
    createEvent: mockCreateEvent,
    deleteEvent: mockDeleteEvent,
    updateEvent: mockUpdateEvent,
  };
});

const { POST } = await import("./route");
const { GoogleCalendarError } = await import("@/lib/calendar/google");

// Supabase's builder is a long fluent chain whose shape isn't what's under
// test here. This returns a thenable that answers every chained call with
// itself and resolves to one fixed result -- so a test can say "the blocks
// query returns this row" without reproducing .select().eq().maybeSingle().
function chain(result: unknown) {
  const proxy: unknown = new Proxy(
    {},
    {
      get(_target, prop) {
        if (prop === "then") {
          return (resolve: (value: unknown) => unknown, reject: (reason: unknown) => unknown) =>
            Promise.resolve(result).then(resolve, reject);
        }
        return () => proxy;
      },
    },
  );
  return proxy;
}

const BLOCK = {
  id: "block-1",
  notes: "revise two-pointer template",
  scheduled_end_at: "2026-09-14T10:30:00+00:00",
  scheduled_start_at: "2026-09-14T09:00:00+00:00",
  text: "Arrays: two pointers",
};
const LINK = { external_calendar_id: "primary", external_event_id: "goog-1" };

const ENV_VARS = [
  "GOOGLE_CLIENT_ID",
  "GOOGLE_CLIENT_SECRET",
  "CALENDAR_TOKEN_ENCRYPTION_KEY",
  "SUPABASE_SERVICE_ROLE_KEY",
] as const;
const saved: Record<string, string | undefined> = {};

function configureAll() {
  process.env.GOOGLE_CLIENT_ID = "client-id";
  process.env.GOOGLE_CLIENT_SECRET = "client-secret";
  process.env.CALENDAR_TOKEN_ENCRYPTION_KEY = randomBytes(32).toString("base64");
  process.env.SUPABASE_SERVICE_ROLE_KEY = "service-role-key";
}

function post(body: unknown) {
  return new Request("https://mtdo.example/api/calendar/sync", {
    body: JSON.stringify(body),
    headers: { "Content-Type": "application/json" },
    method: "POST",
  });
}

/** `block` null => the caller doesn't own it; `link` null => not yet synced. */
function wire({ block = BLOCK, link = null }: { block?: typeof BLOCK | null; link?: typeof LINK | null } = {}) {
  mockFrom.mockImplementation((table: string) => {
    if (table === "blocks") return chain({ data: block, error: null });
    if (table === "profiles") return chain({ data: { timezone: "Europe/London" }, error: null });
    return chain({ data: null, error: null });
  });
  mockServiceFrom.mockImplementation(() => chain({ data: link, error: null }));
  mockCreateServiceClient.mockReturnValue({ from: mockServiceFrom });
}

beforeEach(() => {
  vi.clearAllMocks();
  for (const name of ENV_VARS) {
    saved[name] = process.env[name];
    delete process.env[name];
  }
  configureAll();
  mockGetUser.mockResolvedValue({ data: { user: { id: "user-123" } }, error: null });
  mockAcquireAccessToken.mockResolvedValue({ accessToken: "access-token", calendarId: "primary" });
  mockCreateEvent.mockResolvedValue("goog-new");
  wire();
});

afterEach(() => {
  for (const name of ENV_VARS) {
    if (saved[name] === undefined) delete process.env[name];
    else process.env[name] = saved[name];
  }
});

describe("POST /api/calendar/sync -- refusals", () => {
  it("401s without a session", async () => {
    mockGetUser.mockResolvedValue({ data: { user: null }, error: null });
    expect((await POST(post({ blockId: "block-1", enabled: true }))).status).toBe(401);
  });

  it("400s on a malformed body", async () => {
    expect((await POST(post({ blockId: "block-1" }))).status).toBe(400);
    expect((await POST(post({ enabled: true }))).status).toBe(400);
    expect((await POST(post({ blockId: 7, enabled: true }))).status).toBe(400);
  });

  it("503s with the missing variables when Google isn't configured", async () => {
    delete process.env.GOOGLE_CLIENT_ID;
    const response = await POST(post({ blockId: "block-1", enabled: true }));
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({ configured: false, missing: ["GOOGLE_CLIENT_ID"] });
    expect(mockCreateEvent).not.toHaveBeenCalled();
  });

  it("404s for a block the caller doesn't own, without saying which it was", async () => {
    wire({ block: null });
    const response = await POST(post({ blockId: "someone-elses", enabled: true }));
    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({ error: "That task isn't available." });
  });

  it("409s when the user has no calendar connected", async () => {
    mockAcquireAccessToken.mockResolvedValue(null);
    const response = await POST(post({ blockId: "block-1", enabled: true }));
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({ connected: false });
  });

  it("400s rather than inventing an hour for a block with no schedule", async () => {
    wire({ block: { ...BLOCK, scheduled_end_at: null as never, scheduled_start_at: null as never } });
    const response = await POST(post({ blockId: "block-1", enabled: true }));
    expect(response.status).toBe(400);
    expect(mockCreateEvent).not.toHaveBeenCalled();
  });
});

describe("POST /api/calendar/sync -- syncing", () => {
  it("creates an event for a block that has never been synced", async () => {
    const response = await POST(post({ blockId: "block-1", enabled: true }));
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      calendarId: "primary",
      eventId: "goog-new",
      synced: true,
    });
    expect(mockUpdateEvent).not.toHaveBeenCalled();
    expect(mockCreateEvent).toHaveBeenCalledWith("access-token", "primary", {
      description: "revise two-pointer template",
      endAt: BLOCK.scheduled_end_at,
      startAt: BLOCK.scheduled_start_at,
      summary: BLOCK.text,
      // The user's own profiles.timezone, via the shared fetchProfileTimezone()
      // helper -- not the server's zone, and not UTC-by-assumption.
      timeZone: "Europe/London",
    });
  });

  it("updates the existing event instead of creating a duplicate", async () => {
    wire({ link: LINK });
    const response = await POST(post({ blockId: "block-1", enabled: true }));
    await expect(response.json()).resolves.toEqual({
      calendarId: "primary",
      eventId: "goog-1",
      synced: true,
    });
    expect(mockCreateEvent).not.toHaveBeenCalled();
    expect(mockUpdateEvent).toHaveBeenCalledWith("access-token", "primary", "goog-1", expect.anything());
  });

  it("deletes the event when the block is unsynced", async () => {
    wire({ link: LINK });
    const response = await POST(post({ blockId: "block-1", enabled: false }));
    await expect(response.json()).resolves.toEqual({ synced: false });
    expect(mockDeleteEvent).toHaveBeenCalledWith("access-token", "primary", "goog-1");
  });

  it("treats unsyncing an unsynced block as success, so the call is safe to make unconditionally", async () => {
    const response = await POST(post({ blockId: "block-1", enabled: false }));
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ synced: false });
    expect(mockDeleteEvent).not.toHaveBeenCalled();
    // Nothing to remove means nothing to ask Google for -- no token round
    // trip at all.
    expect(mockAcquireAccessToken).not.toHaveBeenCalled();
  });

  it("unsyncs cleanly for a user with no calendar connected at all", async () => {
    // The client fires enabled:false alongside every un-schedule. A user who
    // never connected a calendar -- or who just disconnected, which already
    // deleted their links -- must get a clean no-op, not a 409 telling them
    // to connect a calendar they don't want. This is the documented
    // "safe to call unconditionally" promise (api.md §3e).
    mockAcquireAccessToken.mockResolvedValue(null);
    const response = await POST(post({ blockId: "block-1", enabled: false }));
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ synced: false });
  });

  it("rejects an unscheduled block before spending a Google token round trip", async () => {
    wire({ block: { ...BLOCK, scheduled_end_at: null as never, scheduled_start_at: null as never } });
    const response = await POST(post({ blockId: "block-1", enabled: true }));
    expect(response.status).toBe(400);
    // The fix is entirely local (schedule_block()), so there is no reason to
    // have involved Google to discover it.
    expect(mockAcquireAccessToken).not.toHaveBeenCalled();
  });

  it("502s when Google rejects the call, without leaking Google's message to the user", async () => {
    mockCreateEvent.mockRejectedValue(new GoogleCalendarError("Google Calendar returned 403: quota", 403));
    const response = await POST(post({ blockId: "block-1", enabled: true }));
    expect(response.status).toBe(502);
    await expect(response.json()).resolves.toEqual({
      error: "Google Calendar rejected that change. Try again shortly.",
    });
  });
});
