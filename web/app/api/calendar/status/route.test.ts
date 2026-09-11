// Tests for GET /api/calendar/status (see route.ts's header for the
// contract). The `configured: false` branch is the one that matters most:
// it is what this environment genuinely returns today, with no Google
// credentials present, and it must be a clean 200 describing reality rather
// than an error.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { randomBytes } from "node:crypto";

const { mockGetUser } = vi.hoisted(() => ({ mockGetUser: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({
  createClient: vi.fn(async () => ({ auth: { getUser: mockGetUser } })),
}));

const { mockCreateServiceClient } = vi.hoisted(() => ({ mockCreateServiceClient: vi.fn() }));
vi.mock("@/lib/supabase/service", () => ({ createServiceClient: mockCreateServiceClient }));

const { mockReadConnectionSummary } = vi.hoisted(() => ({ mockReadConnectionSummary: vi.fn() }));
vi.mock("@/lib/calendar/connection", () => ({
  CALENDAR_PROVIDER: "google",
  readConnectionSummary: mockReadConnectionSummary,
}));

const { GET } = await import("./route");

const REQUEST = new Request("https://mtdo.example/api/calendar/status");
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

beforeEach(() => {
  vi.clearAllMocks();
  for (const name of ENV_VARS) {
    saved[name] = process.env[name];
    delete process.env[name];
  }
  mockGetUser.mockResolvedValue({ data: { user: { id: "user-123" } }, error: null });
  mockCreateServiceClient.mockReturnValue({});
  mockReadConnectionSummary.mockResolvedValue(null);
});

afterEach(() => {
  for (const name of ENV_VARS) {
    if (saved[name] === undefined) delete process.env[name];
    else process.env[name] = saved[name];
  }
});

describe("GET /api/calendar/status", () => {
  it("401s without a session -- `missing` is deployment detail, not public information", async () => {
    mockGetUser.mockResolvedValue({ data: { user: null }, error: null });
    const response = await GET(REQUEST);
    expect(response.status).toBe(401);
    expect(mockCreateServiceClient).not.toHaveBeenCalled();
  });

  it("reports 'not configured' as a clean 200 naming the missing variables", async () => {
    const response = await GET(REQUEST);
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      configured: false,
      connected: false,
      connection: null,
      missing: [
        "GOOGLE_CLIENT_ID",
        "GOOGLE_CLIENT_SECRET",
        "CALENDAR_TOKEN_ENCRYPTION_KEY",
        "SUPABASE_SERVICE_ROLE_KEY",
      ],
      provider: "google",
    });
  });

  it("does not touch the database when it isn't configured", async () => {
    await GET(REQUEST);
    expect(mockReadConnectionSummary).not.toHaveBeenCalled();
  });

  it("reports configured-but-not-connected honestly", async () => {
    configureAll();
    const response = await GET(REQUEST);
    await expect(response.json()).resolves.toEqual({
      configured: true,
      connected: false,
      connection: null,
      missing: [],
      provider: "google",
    });
  });

  it("reports a live connection without ever including a token", async () => {
    configureAll();
    const connection = { calendarId: "primary", connectedAt: "2026-09-11T00:00:00Z", scopes: ["scope"] };
    mockReadConnectionSummary.mockResolvedValue(connection);
    const response = await GET(REQUEST);
    const body = await response.json();
    expect(body).toEqual({ configured: true, connected: true, connection, missing: [], provider: "google" });
    expect(JSON.stringify(body)).not.toContain("refresh");
  });

  it("is never cached", async () => {
    configureAll();
    expect((await GET(REQUEST)).headers.get("Cache-Control")).toBe("no-store");
  });
});
