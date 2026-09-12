// Tests for GET /api/music/spotify/token -- the endpoint the Web Playback
// SDK's getOAuthToken callback fetches from.
//
// The invariant that matters more than any status code here: THE REFRESH TOKEN
// NEVER APPEARS IN A RESPONSE. There is an explicit test for that below, and
// it is deliberately written against the serialised body rather than a typed
// field, because the failure mode being guarded is someone spreading a wider
// object into the response later.
//
// The second theme is that the four not-OK outcomes stay distinct: 503
// (server unconfigured), 409 not-connected (offer Connect), 409
// reconnect-required (the authorization died -- offer Reconnect), and 502
// (Spotify is down -- retry, do NOT send the user through OAuth again).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { randomBytes } from "node:crypto";

const { mockGetUser } = vi.hoisted(() => ({ mockGetUser: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({
  createClient: vi.fn(async () => ({ auth: { getUser: mockGetUser } })),
}));

const { mockCreateServiceClient } = vi.hoisted(() => ({ mockCreateServiceClient: vi.fn() }));
vi.mock("@/lib/supabase/service", () => ({ createServiceClient: mockCreateServiceClient }));

const { mockAcquireAccessToken } = vi.hoisted(() => ({ mockAcquireAccessToken: vi.fn() }));
vi.mock("@/lib/music/spotify/connection", () => ({
  SPOTIFY_PROVIDER: "spotify",
  acquireAccessToken: mockAcquireAccessToken,
}));

const { GET } = await import("./route");

const REQUEST = new Request("https://mtdo.example/api/music/spotify/token");
const ENV_VARS = [
  "SPOTIFY_CLIENT_ID",
  "SPOTIFY_TOKEN_ENCRYPTION_KEY",
  "SPOTIFY_OAUTH_REDIRECT_URI",
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
  mockAcquireAccessToken.mockResolvedValue({
    accessToken: "fresh-access-token",
    expiresIn: 3600,
    outcome: "ok",
  });
});

afterEach(() => {
  for (const name of ENV_VARS) {
    if (saved[name] === undefined) delete process.env[name];
    else process.env[name] = saved[name];
  }
});

describe("the happy path", () => {
  it("returns a current access token in the shape the SDK callback needs", async () => {
    const response = await GET(REQUEST);
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      access_token: "fresh-access-token",
      expires_in: 3600,
    });
  });

  it("scopes the lookup to the session's own user id, never a caller-supplied one", async () => {
    // The service client carries no session, so auth.uid() is null and RLS
    // filters nothing -- the user id MUST come from getUser().
    await GET(REQUEST);
    expect(mockAcquireAccessToken).toHaveBeenCalledWith(expect.anything(), "user-123", expect.anything());
  });

  it("is no-store, so a credential never lands in a shared cache", async () => {
    expect((await GET(REQUEST)).headers.get("cache-control")).toBe("no-store");
  });
});

describe("the invariant: no refresh token, ever", () => {
  it("returns only the access token, even when the connection layer knows more", async () => {
    // Simulates a future change that widens what acquireAccessToken() returns.
    // The route must still project narrowly rather than spread it.
    mockAcquireAccessToken.mockResolvedValue({
      accessToken: "fresh-access-token",
      expiresIn: 3600,
      outcome: "ok",
      refreshToken: "SECRET-REFRESH-TOKEN",
    });
    const body = await (await GET(REQUEST)).text();
    expect(body).not.toContain("SECRET-REFRESH-TOKEN");
    expect(body).not.toContain("refresh");
    expect(JSON.parse(body)).toEqual({ access_token: "fresh-access-token", expires_in: 3600 });
  });
});

describe("the not-OK outcomes, kept distinct", () => {
  it("401s without a session", async () => {
    mockGetUser.mockResolvedValue({ data: { user: null }, error: null });
    const response = await GET(REQUEST);
    expect(response.status).toBe(401);
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  it("503s with the missing variables when Spotify isn't configured", async () => {
    delete process.env.SPOTIFY_CLIENT_ID;
    const response = await GET(REQUEST);
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({
      configured: false,
      missing: ["SPOTIFY_CLIENT_ID"],
    });
  });

  it("503s when the service client is unavailable", async () => {
    mockCreateServiceClient.mockReturnValue(null);
    expect((await GET(REQUEST)).status).toBe(503);
  });

  it("409s with connected:false when no Spotify account is connected -- offer Connect", async () => {
    // Not 404 (the endpoint exists) and not 401 (which would read as a session
    // problem and send a client into a sign-in loop).
    mockAcquireAccessToken.mockResolvedValue({ outcome: "not-connected" });
    const response = await GET(REQUEST);
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({ connected: false });
  });

  it("409s with reconnectRequired when the authorization died -- offer Reconnect", async () => {
    // Spotify refresh tokens genuinely expire (six months, not extended by
    // refreshing), so this is an expected end-state, not an anomaly. The UI
    // response differs from not-connected, which is why the codes differ.
    mockAcquireAccessToken.mockResolvedValue({
      outcome: "reconnect-required",
      reason: "Your Spotify authorization has expired. Reconnect to keep playing.",
    });
    const response = await GET(REQUEST);
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      connected: true,
      error: "Your Spotify authorization has expired. Reconnect to keep playing.",
      reconnectRequired: true,
    });
  });

  it("502s -- NOT reconnect-required -- when Spotify is simply down", async () => {
    // The distinction that matters most: a bad thirty seconds at Spotify must
    // not send a user through OAuth again. The client's correct response here
    // is to retry later.
    mockAcquireAccessToken.mockRejectedValue(new Error("network down"));
    const response = await GET(REQUEST);
    expect(response.status).toBe(502);
    const body = (await response.json()) as { error: string; reconnectRequired?: boolean };
    expect(body.reconnectRequired).toBeUndefined();
  });

  it("never echoes an internal error message to the caller", async () => {
    mockAcquireAccessToken.mockRejectedValue(new Error("postgres://user:password@host"));
    const body = await (await GET(REQUEST)).text();
    expect(body).not.toContain("password");
  });
});
