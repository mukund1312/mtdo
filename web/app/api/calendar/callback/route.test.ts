// Tests for GET /api/calendar/callback. Focused on the one behavior added
// alongside the signup-time calendar prompt (app/auth/callback/route.ts):
// an optional next-destination cookie, set by /api/calendar/connect, that
// overrides the default Settings landing -- every existing outcome (no
// session, declined, state mismatch, success) still needs to honor it, or a
// signup-chained user would silently get dropped back on Settings instead
// of wherever the app actually wanted them.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { randomBytes } from "node:crypto";
import { NextRequest, type NextResponse } from "next/server";

const { mockGetUser, mockExchangeCodeForTokens, mockStoreConnection, mockCreateServiceClient } = vi.hoisted(() => ({
  mockGetUser: vi.fn(),
  mockExchangeCodeForTokens: vi.fn(),
  mockStoreConnection: vi.fn(),
  mockCreateServiceClient: vi.fn(),
}));
vi.mock("@/lib/supabase/server", () => ({
  createClient: vi.fn(async () => ({ auth: { getUser: mockGetUser } })),
}));
vi.mock("@/lib/supabase/service", () => ({
  createServiceClient: mockCreateServiceClient,
}));
vi.mock("@/lib/calendar/connection", () => ({
  storeConnection: mockStoreConnection,
}));
vi.mock("@/lib/calendar/google", () => ({
  exchangeCodeForTokens: mockExchangeCodeForTokens,
}));

const { GET } = await import("./route");

const ENV_VARS = ["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET", "CALENDAR_TOKEN_ENCRYPTION_KEY", "SUPABASE_SERVICE_ROLE_KEY"] as const;
const saved: Record<string, string | undefined> = {};

function configureAll() {
  process.env.GOOGLE_CLIENT_ID = "client-id";
  process.env.GOOGLE_CLIENT_SECRET = "client-secret";
  process.env.CALENDAR_TOKEN_ENCRYPTION_KEY = randomBytes(32).toString("base64");
  process.env.SUPABASE_SERVICE_ROLE_KEY = "service-role-key";
}

function request(url: string, cookies?: Record<string, string>) {
  const req = new NextRequest(new Request(url));
  for (const [name, value] of Object.entries(cookies ?? {})) req.cookies.set(name, value);
  return req;
}

beforeEach(() => {
  vi.clearAllMocks();
  for (const name of ENV_VARS) {
    saved[name] = process.env[name];
    delete process.env[name];
  }
  mockGetUser.mockResolvedValue({ data: { user: { id: "user-123" } }, error: null });
  mockCreateServiceClient.mockReturnValue({});
  mockExchangeCodeForTokens.mockResolvedValue({ refreshToken: "refresh-token", scopes: ["calendar.events"] });
  mockStoreConnection.mockResolvedValue(undefined);
});

afterEach(() => {
  for (const name of ENV_VARS) {
    if (saved[name] === undefined) delete process.env[name];
    else process.env[name] = saved[name];
  }
});

describe("GET /api/calendar/callback", () => {
  it("defaults to Settings when no next-cookie is present (a plain Connect-button start)", async () => {
    const response = (await GET(request("https://mtdo.example/api/calendar/callback?error=access_denied"))) as NextResponse;
    const location = new URL(response.headers.get("location")!);
    expect(location.pathname).toBe("/architecture-02/settings");
    expect(location.searchParams.get("calendar")).toBe("declined");
  });

  it("honors the next-cookie set by /api/calendar/connect on a declined consent", async () => {
    const response = (await GET(
      request("https://mtdo.example/api/calendar/callback?error=access_denied", {
        "mtdo-calendar-oauth-next": "/architecture-02?auth=confirmed",
      }),
    )) as NextResponse;
    const location = new URL(response.headers.get("location")!);
    expect(location.pathname).toBe("/architecture-02");
    expect(location.searchParams.get("auth")).toBe("confirmed");
    expect(location.searchParams.get("calendar")).toBe("declined");
  });

  it("honors the next-cookie on a real successful exchange, and deletes both OAuth cookies", async () => {
    configureAll();
    mockGetUser.mockResolvedValue({ data: { user: { id: "user-123" } }, error: null });
    const response = (await GET(
      request("https://mtdo.example/api/calendar/callback?code=abc&state=xyz", {
        "mtdo-calendar-oauth-state": "xyz",
        "mtdo-calendar-oauth-next": "/architecture-02?auth=confirmed",
      }),
    )) as NextResponse;
    const location = new URL(response.headers.get("location")!);
    expect(location.pathname).toBe("/architecture-02");
    expect(location.searchParams.get("calendar")).toBe("connected");
    expect(response.cookies.get("mtdo-calendar-oauth-state")?.value).toBe("");
    expect(response.cookies.get("mtdo-calendar-oauth-next")?.value).toBe("");
  });

  it("still 401s to the next-cookie destination when there's no session", async () => {
    mockGetUser.mockResolvedValue({ data: { user: null }, error: null });
    const response = (await GET(
      request("https://mtdo.example/api/calendar/callback", { "mtdo-calendar-oauth-next": "/architecture-02?auth=confirmed" }),
    )) as NextResponse;
    const location = new URL(response.headers.get("location")!);
    expect(location.pathname).toBe("/architecture-02");
    expect(location.searchParams.get("calendar")).toBe("no-session");
  });
});
