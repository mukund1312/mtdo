// Tests for GET /api/calendar/connect. Two claims worth holding onto:
// unconfigured is a clean 503 rather than a redirect to a half-built Google
// URL, and a configured start sets the httpOnly CSRF state cookie that
// /api/calendar/callback later compares against.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { randomBytes } from "node:crypto";
import { NextRequest, type NextResponse } from "next/server";

const { mockGetUser } = vi.hoisted(() => ({ mockGetUser: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({
  createClient: vi.fn(async () => ({ auth: { getUser: mockGetUser } })),
}));

const { GET } = await import("./route");

const ENV_VARS = [
  "GOOGLE_CLIENT_ID",
  "GOOGLE_CLIENT_SECRET",
  "CALENDAR_TOKEN_ENCRYPTION_KEY",
  "SUPABASE_SERVICE_ROLE_KEY",
  "GOOGLE_OAUTH_REDIRECT_URI",
] as const;
const saved: Record<string, string | undefined> = {};

function request(url = "https://mtdo.example/api/calendar/connect") {
  return new NextRequest(new Request(url));
}

function configureAll() {
  process.env.GOOGLE_CLIENT_ID = "client-id";
  process.env.GOOGLE_CLIENT_SECRET = "client-secret";
  process.env.CALENDAR_TOKEN_ENCRYPTION_KEY = randomBytes(32).toString("base64");
  process.env.SUPABASE_SERVICE_ROLE_KEY = "service-role-key";
}

beforeEach(() => {
  vi.clearAllMocks();
  for (const name of ENV_VARS) {
    saved[name] = process.env[name];
    delete process.env[name];
  }
  mockGetUser.mockResolvedValue({ data: { user: { id: "user-123" } }, error: null });
});

afterEach(() => {
  for (const name of ENV_VARS) {
    if (saved[name] === undefined) delete process.env[name];
    else process.env[name] = saved[name];
  }
});

describe("GET /api/calendar/connect", () => {
  it("401s without a session", async () => {
    mockGetUser.mockResolvedValue({ data: { user: null }, error: null });
    expect((await GET(request())).status).toBe(401);
  });

  it("503s with the missing variables when Google isn't configured, rather than crashing", async () => {
    const response = await GET(request());
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({
      configured: false,
      missing: expect.arrayContaining(["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET"]),
    });
  });

  it("redirects to Google's consent screen with the right scope and offline access", async () => {
    configureAll();
    const response = await GET(request());
    expect(response.status).toBe(307);
    const location = new URL(response.headers.get("location")!);
    expect(location.origin + location.pathname).toBe("https://accounts.google.com/o/oauth2/v2/auth");
    expect(location.searchParams.get("scope")).toBe("https://www.googleapis.com/auth/calendar.events");
    expect(location.searchParams.get("access_type")).toBe("offline");
    // Without prompt=consent Google omits refresh_token on re-authorisation,
    // which would leave a connection that dies within the hour.
    expect(location.searchParams.get("prompt")).toBe("consent");
    expect(location.searchParams.get("redirect_uri")).toBe("https://mtdo.example/api/calendar/callback");
  });

  it("sets an httpOnly state cookie matching the state it sent to Google", async () => {
    configureAll();
    const response = (await GET(request())) as NextResponse;
    const cookie = response.cookies.get("mtdo-calendar-oauth-state");
    const state = new URL(response.headers.get("location")!).searchParams.get("state");
    expect(cookie?.value).toBe(state);
    expect(cookie?.httpOnly).toBe(true);
    // lax, not strict: Google's redirect back is a cross-site top-level GET,
    // and strict would withhold the cookie on exactly that request.
    expect(cookie?.sameSite).toBe("lax");
  });

  it("issues a different state on every start", async () => {
    configureAll();
    const first = (await GET(request())) as NextResponse;
    const second = (await GET(request())) as NextResponse;
    expect(first.cookies.get("mtdo-calendar-oauth-state")?.value).not.toBe(
      second.cookies.get("mtdo-calendar-oauth-state")?.value,
    );
  });

  it("marks the cookie insecure only over plain http (local development)", async () => {
    configureAll();
    const secure = (await GET(request())) as NextResponse;
    expect(secure.cookies.get("mtdo-calendar-oauth-state")?.secure).toBe(true);
    const local = (await GET(request("http://localhost:3000/api/calendar/connect"))) as NextResponse;
    expect(local.cookies.get("mtdo-calendar-oauth-state")?.secure).toBe(false);
  });
});
