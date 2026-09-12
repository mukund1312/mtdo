// Tests for GET /auth/callback, focused on the signup-time calendar prompt
// added alongside PR (Option B: "keep login and calendar-connect as two
// separate, real OAuth grants, but chain them immediately after a brand-new
// Google signup instead of leaving Calendar for the user to find later in
// Settings"). Everything about the plain exchange-and-redirect behavior
// this route already had is unchanged and untested here -- no prior test
// file existed for it.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { randomBytes } from "node:crypto";
import { NextRequest, type NextResponse } from "next/server";

const { mockExchangeCodeForSession, mockSyncIsAnonymousFlag } = vi.hoisted(() => ({
  mockExchangeCodeForSession: vi.fn(),
  mockSyncIsAnonymousFlag: vi.fn(),
}));
vi.mock("@/lib/supabase/server", () => ({
  createClient: vi.fn(async () => ({ auth: { exchangeCodeForSession: mockExchangeCodeForSession } })),
}));
vi.mock("@/lib/auth/upgradeAccount", () => ({
  syncIsAnonymousFlag: mockSyncIsAnonymousFlag,
}));

const { GET } = await import("./route");

const ENV_VARS = ["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET", "CALENDAR_TOKEN_ENCRYPTION_KEY", "SUPABASE_SERVICE_ROLE_KEY"] as const;
const saved: Record<string, string | undefined> = {};

function configureCalendar() {
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
  mockExchangeCodeForSession.mockResolvedValue({ error: null });
  mockSyncIsAnonymousFlag.mockResolvedValue({ isAnonymous: false });
});

afterEach(() => {
  for (const name of ENV_VARS) {
    if (saved[name] === undefined) delete process.env[name];
    else process.env[name] = saved[name];
  }
});

describe("GET /auth/callback", () => {
  it("redirects straight to next when promptCalendar isn't set (plain login, GitHub signup)", async () => {
    const response = (await GET(
      new NextRequest(new Request("https://mtdo.example/auth/callback?code=abc&next=%2Farchitecture-02%3Fdeck%3Dwork")),
    )) as NextResponse;
    expect(new URL(response.headers.get("location")!).pathname).toBe("/architecture-02");
  });

  it("chains into /api/calendar/connect when promptCalendar=1 and Google Calendar is configured", async () => {
    configureCalendar();
    const response = (await GET(
      new NextRequest(
        new Request("https://mtdo.example/auth/callback?code=abc&next=%2Farchitecture-02%3Fauth%3Dconfirmed&promptCalendar=1"),
      ),
    )) as NextResponse;
    const location = new URL(response.headers.get("location")!);
    expect(location.pathname).toBe("/api/calendar/connect");
    expect(location.searchParams.get("next")).toBe("/architecture-02?auth=confirmed");
  });

  it("skips the calendar chain silently when promptCalendar=1 but Google Calendar isn't configured", async () => {
    const response = (await GET(
      new NextRequest(
        new Request("https://mtdo.example/auth/callback?code=abc&next=%2Farchitecture-02%3Fauth%3Dconfirmed&promptCalendar=1"),
      ),
    )) as NextResponse;
    const location = new URL(response.headers.get("location")!);
    expect(location.pathname).toBe("/architecture-02");
    expect(location.searchParams.get("auth")).toBe("confirmed");
  });

  it("never chains on a failed exchange, regardless of promptCalendar", async () => {
    configureCalendar();
    mockExchangeCodeForSession.mockResolvedValue({ error: { message: "bad code" } });
    const response = (await GET(
      new NextRequest(
        new Request("https://mtdo.example/auth/callback?code=abc&next=%2Farchitecture-02%3Fauth%3Dconfirmed&promptCalendar=1"),
      ),
    )) as NextResponse;
    const location = new URL(response.headers.get("location")!);
    expect(location.pathname).toBe("/architecture-02");
    expect(location.searchParams.get("auth")).toBe("confirmation-error");
  });
});
