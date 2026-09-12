// Tests for GET /api/music/spotify/status. The `configured: false` branch is
// the one that matters most: it is what this environment genuinely returns
// today, with no Spotify credentials present, and it must be a clean 200
// describing reality rather than an error.
//
// The other theme is the PREMIUM SIGNAL. The Web Playback SDK requires Spotify
// Premium -- a permanent platform restriction, not a bug -- so this route has
// to carry the real captured tier, including the "unknown" case, so the Listen
// deck can render an honest state instead of a player that never plays.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { randomBytes } from "node:crypto";

const { mockGetUser } = vi.hoisted(() => ({ mockGetUser: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({
  createClient: vi.fn(async () => ({ auth: { getUser: mockGetUser } })),
}));

const { mockCreateServiceClient } = vi.hoisted(() => ({ mockCreateServiceClient: vi.fn() }));
vi.mock("@/lib/supabase/service", () => ({ createServiceClient: mockCreateServiceClient }));

const { mockReadConnectionSummary } = vi.hoisted(() => ({ mockReadConnectionSummary: vi.fn() }));
vi.mock("@/lib/music/spotify/connection", () => ({
  SPOTIFY_PROVIDER: "spotify",
  readConnectionSummary: mockReadConnectionSummary,
}));

const { GET } = await import("./route");

const REQUEST = new Request("https://mtdo.example/api/music/spotify/status");
const ENV_VARS = [
  "SPOTIFY_CLIENT_ID",
  "SPOTIFY_TOKEN_ENCRYPTION_KEY",
  "SUPABASE_SERVICE_ROLE_KEY",
] as const;
const saved: Record<string, string | undefined> = {};

const CONNECTED = {
  connectedAt: "2026-09-13T00:00:00.000Z",
  displayName: "Ada",
  expired: false,
  premium: true,
  product: "premium",
  refreshTokenExpiresAt: "2027-03-12T00:00:00.000Z",
  scopes: ["streaming", "user-read-email", "user-read-private"],
};

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

describe("GET /api/music/spotify/status", () => {
  it("401s without a session -- `missing` is deployment detail, not public information", async () => {
    mockGetUser.mockResolvedValue({ data: { user: null }, error: null });
    expect((await GET(REQUEST)).status).toBe(401);
  });

  it("reports unconfigured as a clean 200 naming the absent variables", async () => {
    // The genuinely-exercised path in this environment. An error here would
    // make the Listen deck look broken when it is merely not set up.
    const response = await GET(REQUEST);
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      configured: false,
      connected: false,
      connection: null,
      missing: expect.arrayContaining(["SPOTIFY_CLIENT_ID", "SPOTIFY_TOKEN_ENCRYPTION_KEY"]),
      provider: "spotify",
    });
  });

  it("is no-store, so one user's connection state is never served to another", async () => {
    expect((await GET(REQUEST)).headers.get("cache-control")).toBe("no-store");
  });

  it("reports configured-but-not-connected when the user has never connected", async () => {
    configureAll();
    await expect((await GET(REQUEST)).json()).resolves.toEqual({
      configured: true,
      connected: false,
      connection: null,
      missing: [],
      provider: "spotify",
    });
  });

  it("reports a live connection with the premium signal intact", async () => {
    configureAll();
    mockReadConnectionSummary.mockResolvedValue(CONNECTED);
    await expect((await GET(REQUEST)).json()).resolves.toMatchObject({
      configured: true,
      connected: true,
      connection: expect.objectContaining({ premium: true, product: "premium" }),
    });
  });

  it("passes through premium:false for a free account rather than hiding it", async () => {
    // The Listen deck needs this to say "Spotify Premium is required for
    // in-app playback" instead of rendering a silent, non-working player.
    configureAll();
    mockReadConnectionSummary.mockResolvedValue({ ...CONNECTED, premium: false, product: "free" });
    const body = (await (await GET(REQUEST)).json()) as { connection: { premium: boolean } };
    expect(body.connection.premium).toBe(false);
  });

  it("passes through premium:null when the tier was never captured", async () => {
    configureAll();
    mockReadConnectionSummary.mockResolvedValue({ ...CONNECTED, premium: null, product: null });
    const body = (await (await GET(REQUEST)).json()) as { connection: { premium: boolean | null } };
    expect(body.connection.premium).toBeNull();
  });

  it("keeps connected:true for an EXPIRED authorization, with expired carrying the distinction", async () => {
    // Collapsing the two would lose real information: "you never connected"
    // and "your six-month authorization ran out" need different words, and
    // only the second can say when.
    configureAll();
    mockReadConnectionSummary.mockResolvedValue({ ...CONNECTED, expired: true });
    const body = (await (await GET(REQUEST)).json()) as {
      connected: boolean;
      connection: { expired: boolean };
    };
    expect(body.connected).toBe(true);
    expect(body.connection.expired).toBe(true);
  });

  it("never returns a token field of any kind", async () => {
    configureAll();
    mockReadConnectionSummary.mockResolvedValue(CONNECTED);
    const body = await (await GET(REQUEST)).text();
    expect(body).not.toContain("refresh_token");
    expect(body).not.toContain("access_token");
  });

  it("reports unconfigured, not a 500, if the service client is unavailable", async () => {
    configureAll();
    mockCreateServiceClient.mockReturnValue(null);
    await expect((await GET(REQUEST)).json()).resolves.toMatchObject({
      configured: false,
      missing: ["SUPABASE_SERVICE_ROLE_KEY"],
    });
  });

  it("500s with a generic message when the connection read fails", async () => {
    configureAll();
    mockReadConnectionSummary.mockRejectedValue(new Error("db down"));
    const response = await GET(REQUEST);
    expect(response.status).toBe(500);
    expect(await response.text()).not.toContain("db down");
  });
});
