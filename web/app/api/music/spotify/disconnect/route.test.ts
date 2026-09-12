// Tests for POST /api/music/spotify/disconnect. Short, because the route is
// short -- Spotify playback creates nothing on the user's account, so unlike
// the calendar's disconnect there is no external state to tear down first.
// The claims worth pinning are that it is idempotent and that it always
// deletes the row scoped to the session's own user.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { randomBytes } from "node:crypto";

const { mockGetUser } = vi.hoisted(() => ({ mockGetUser: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({
  createClient: vi.fn(async () => ({ auth: { getUser: mockGetUser } })),
}));

const { mockCreateServiceClient } = vi.hoisted(() => ({ mockCreateServiceClient: vi.fn() }));
vi.mock("@/lib/supabase/service", () => ({ createServiceClient: mockCreateServiceClient }));

const { mockDeleteConnection } = vi.hoisted(() => ({ mockDeleteConnection: vi.fn() }));
vi.mock("@/lib/music/spotify/connection", () => ({
  SPOTIFY_PROVIDER: "spotify",
  deleteConnection: mockDeleteConnection,
}));

const { POST } = await import("./route");

const REQUEST = new Request("https://mtdo.example/api/music/spotify/disconnect", { method: "POST" });
const ENV_VARS = [
  "SPOTIFY_CLIENT_ID",
  "SPOTIFY_TOKEN_ENCRYPTION_KEY",
  "SUPABASE_SERVICE_ROLE_KEY",
] as const;
const saved: Record<string, string | undefined> = {};

function configureAll() {
  process.env.SPOTIFY_CLIENT_ID = "spotify-client-id";
  process.env.SPOTIFY_TOKEN_ENCRYPTION_KEY = randomBytes(32).toString("base64");
  process.env.SUPABASE_SERVICE_ROLE_KEY = "service-role-key";
}

beforeEach(() => {
  vi.clearAllMocks();
  for (const name of ENV_VARS) {
    saved[name] = process.env[name];
    delete process.env[name];
  }
  configureAll();
  mockGetUser.mockResolvedValue({ data: { user: { id: "user-123" } }, error: null });
  mockCreateServiceClient.mockReturnValue({});
  mockDeleteConnection.mockResolvedValue(undefined);
});

afterEach(() => {
  for (const name of ENV_VARS) {
    if (saved[name] === undefined) delete process.env[name];
    else process.env[name] = saved[name];
  }
});

describe("POST /api/music/spotify/disconnect", () => {
  it("401s without a session", async () => {
    mockGetUser.mockResolvedValue({ data: { user: null }, error: null });
    expect((await POST(REQUEST)).status).toBe(401);
    expect(mockDeleteConnection).not.toHaveBeenCalled();
  });

  it("deletes the connection for the session's own user", async () => {
    const response = await POST(REQUEST);
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ disconnected: true });
    expect(mockDeleteConnection).toHaveBeenCalledWith(expect.anything(), "user-123");
  });

  it("is idempotent -- disconnecting twice is a 200 both times", async () => {
    // A DELETE matching no rows is a success: the caller asked for a state,
    // and that state holds. A 404 here would make a double-click an error.
    await POST(REQUEST);
    const second = await POST(REQUEST);
    expect(second.status).toBe(200);
    await expect(second.json()).resolves.toEqual({ disconnected: true });
  });

  it("503s with the missing variables when Spotify isn't configured", async () => {
    delete process.env.SPOTIFY_CLIENT_ID;
    const response = await POST(REQUEST);
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({
      configured: false,
      missing: ["SPOTIFY_CLIENT_ID"],
    });
  });

  it("503s naming the service key when only that is unavailable", async () => {
    mockCreateServiceClient.mockReturnValue(null);
    await expect((await POST(REQUEST)).json()).resolves.toMatchObject({
      missing: ["SUPABASE_SERVICE_ROLE_KEY"],
    });
  });

  it("500s with a generic message when the delete fails", async () => {
    mockDeleteConnection.mockRejectedValue(new Error("db down"));
    const response = await POST(REQUEST);
    expect(response.status).toBe(500);
    expect(await response.text()).not.toContain("db down");
  });
});
