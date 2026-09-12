// Tests for GET /api/music/spotify/callback. The security-critical claims are
// the state check (without it an attacker binds THEIR Spotify account to a
// victim's) and the PKCE verifier round trip (which, unlike Google's flow, is
// the only thing proving this client started the exchange -- there is no
// client_secret). Everything else is about never stranding a user on a blank
// page and never storing a connection that cannot work.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { randomBytes } from "node:crypto";
import { NextRequest, type NextResponse } from "next/server";

const { mockGetUser } = vi.hoisted(() => ({ mockGetUser: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({
  createClient: vi.fn(async () => ({ auth: { getUser: mockGetUser } })),
}));

const { mockCreateServiceClient } = vi.hoisted(() => ({ mockCreateServiceClient: vi.fn() }));
vi.mock("@/lib/supabase/service", () => ({ createServiceClient: mockCreateServiceClient }));

const { mockStoreConnection } = vi.hoisted(() => ({ mockStoreConnection: vi.fn() }));
vi.mock("@/lib/music/spotify/connection", () => ({
  SPOTIFY_PROVIDER: "spotify",
  storeConnection: mockStoreConnection,
}));

const { mockExchange, mockFetchProfile } = vi.hoisted(() => ({
  mockExchange: vi.fn(),
  mockFetchProfile: vi.fn(),
}));
vi.mock("@/lib/music/spotify/spotify", () => ({
  exchangeCodeForTokens: mockExchange,
  fetchProfile: mockFetchProfile,
}));

const { GET } = await import("./route");

const ENV_VARS = [
  "SPOTIFY_CLIENT_ID",
  "SPOTIFY_TOKEN_ENCRYPTION_KEY",
  "SPOTIFY_OAUTH_REDIRECT_URI",
  "SUPABASE_SERVICE_ROLE_KEY",
] as const;
const saved: Record<string, string | undefined> = {};

const STATE = "the-expected-state";
const VERIFIER = "a".repeat(64);
const SETTINGS = "/architecture-02/settings";

function configureAll() {
  process.env.SPOTIFY_CLIENT_ID = "spotify-client-id";
  process.env.SPOTIFY_TOKEN_ENCRYPTION_KEY = randomBytes(32).toString("base64");
  process.env.SUPABASE_SERVICE_ROLE_KEY = "service-role-key";
}

/** Builds a callback request with the cookies /connect would have set. */
function request(
  params: Record<string, string> = { code: "auth-code", state: STATE },
  cookies: Record<string, string> = {
    "mtdo-spotify-oauth-state": STATE,
    "mtdo-spotify-oauth-verifier": VERIFIER,
  },
) {
  const url = new URL("https://mtdo.example/api/music/spotify/callback");
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const req = new NextRequest(new Request(url));
  for (const [k, v] of Object.entries(cookies)) req.cookies.set(k, v);
  return req;
}

/** The `?spotify=<outcome>` code the route redirected with. */
function outcome(response: Response): string | null {
  return new URL(response.headers.get("location")!).searchParams.get("spotify");
}

function destination(response: Response): string {
  return new URL(response.headers.get("location")!).pathname;
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
  mockExchange.mockResolvedValue({
    accessToken: "access-token",
    expiresIn: 3600,
    refreshToken: "refresh-token",
    scopes: ["streaming", "user-read-email", "user-read-private"],
  });
  mockFetchProfile.mockResolvedValue({
    displayName: "Ada",
    email: "ada@example.com",
    id: "sp-1",
    product: "premium",
  });
  mockStoreConnection.mockResolvedValue(undefined);
});

afterEach(() => {
  for (const name of ENV_VARS) {
    if (saved[name] === undefined) delete process.env[name];
    else process.env[name] = saved[name];
  }
});

describe("the happy path", () => {
  it("exchanges the code with the STORED verifier and stores the connection", async () => {
    const response = await GET(request());
    // The PKCE round trip: the verifier from the cookie, not a fresh one.
    expect(mockExchange).toHaveBeenCalledWith(expect.anything(), "auth-code", VERIFIER);
    expect(mockStoreConnection).toHaveBeenCalledOnce();
    expect(outcome(response)).toBe("connected");
    expect(destination(response)).toBe(SETTINGS);
  });

  it("passes the captured profile through, so the Premium signal is stored", async () => {
    await GET(request());
    expect(mockStoreConnection.mock.calls[0]![3]).toMatchObject({
      profile: expect.objectContaining({ product: "premium" }),
      refreshToken: "refresh-token",
    });
  });

  it("clears all three OAuth cookies on success", async () => {
    const response = (await GET(request())) as NextResponse;
    // A verifier left behind is a spent secret sitting in the browser.
    expect(response.cookies.get("mtdo-spotify-oauth-verifier")?.value).toBe("");
    expect(response.cookies.get("mtdo-spotify-oauth-state")?.value).toBe("");
    expect(response.cookies.get("mtdo-spotify-oauth-next")?.value).toBe("");
  });

  it("never puts a token in the redirect URL", async () => {
    const response = await GET(request());
    const location = response.headers.get("location")!;
    expect(location).not.toContain("refresh-token");
    expect(location).not.toContain("access-token");
  });
});

describe("CSRF: the state check", () => {
  it("refuses the exchange when the returned state doesn't match the cookie", async () => {
    // This is what stops an attacker completing the callback with their own
    // authorization code and binding THEIR Spotify account to this user.
    const response = await GET(request({ code: "auth-code", state: "attacker-state" }));
    expect(outcome(response)).toBe("state-mismatch");
    expect(mockExchange).not.toHaveBeenCalled();
  });

  it("refuses when there is no state cookie at all", async () => {
    const response = await GET(request({ code: "auth-code", state: STATE }, {}));
    expect(outcome(response)).toBe("state-mismatch");
    expect(mockExchange).not.toHaveBeenCalled();
  });

  it("refuses when Spotify returned no state", async () => {
    const response = await GET(request({ code: "auth-code" }));
    expect(outcome(response)).toBe("state-mismatch");
    expect(mockExchange).not.toHaveBeenCalled();
  });
});

describe("PKCE: the verifier round trip", () => {
  it("refuses the exchange when the verifier cookie is missing", async () => {
    // Without it the exchange cannot succeed -- there is no client_secret to
    // fall back on -- so this is caught here rather than sent to Spotify to be
    // rejected with an opaque message.
    const response = await GET(
      request({ code: "auth-code", state: STATE }, { "mtdo-spotify-oauth-state": STATE }),
    );
    expect(outcome(response)).toBe("missing-verifier");
    expect(mockExchange).not.toHaveBeenCalled();
  });

  it("refuses a malformed (truncated) verifier rather than spending the code on it", async () => {
    const response = await GET(
      request(
        { code: "auth-code", state: STATE },
        { "mtdo-spotify-oauth-state": STATE, "mtdo-spotify-oauth-verifier": "too-short" },
      ),
    );
    expect(outcome(response)).toBe("missing-verifier");
    expect(mockExchange).not.toHaveBeenCalled();
  });

  it("refuses a verifier carrying characters outside the permitted set", async () => {
    const response = await GET(
      request(
        { code: "auth-code", state: STATE },
        {
          "mtdo-spotify-oauth-state": STATE,
          "mtdo-spotify-oauth-verifier": `${"a".repeat(60)}&injected=1`,
        },
      ),
    );
    expect(outcome(response)).toBe("missing-verifier");
  });
});

describe("the outcomes that are not errors", () => {
  it("reports a declined consent as `declined`, not as a failure", async () => {
    const response = await GET(request({ error: "access_denied" }));
    expect(outcome(response)).toBe("declined");
  });

  it("reports any other Spotify error distinctly", async () => {
    const response = await GET(request({ error: "server_error" }));
    expect(outcome(response)).toBe("spotify-error");
  });

  it("redirects rather than 401-ing when the session is gone", async () => {
    // The user arrives here by top-level navigation; a JSON body would strand
    // them on a blank page.
    mockGetUser.mockResolvedValue({ data: { user: null }, error: null });
    const response = await GET(request());
    expect(response.status).toBe(307);
    expect(outcome(response)).toBe("no-session");
  });

  it("reports a missing code", async () => {
    const response = await GET(request({ state: STATE }));
    expect(outcome(response)).toBe("no-code");
  });

  it("reports not-configured rather than crashing if the server is reconfigured mid-flow", async () => {
    delete process.env.SPOTIFY_CLIENT_ID;
    const response = await GET(request());
    expect(outcome(response)).toBe("not-configured");
  });

  it("reports not-configured when the service client is unavailable", async () => {
    mockCreateServiceClient.mockReturnValue(null);
    const response = await GET(request());
    expect(outcome(response)).toBe("not-configured");
  });

  it("reports exchange-failed when Spotify rejects the code", async () => {
    mockExchange.mockRejectedValue(new Error("bad code"));
    const response = await GET(request());
    expect(outcome(response)).toBe("exchange-failed");
    expect(mockStoreConnection).not.toHaveBeenCalled();
  });

  it("refuses to store a connection with no refresh token", async () => {
    // An access-token-only row would silently stop working within the hour.
    mockExchange.mockResolvedValue({
      accessToken: "access-token",
      expiresIn: 3600,
      refreshToken: null,
      scopes: [],
    });
    const response = await GET(request());
    expect(outcome(response)).toBe("no-refresh-token");
    expect(mockStoreConnection).not.toHaveBeenCalled();
  });
});

describe("the profile read is best-effort", () => {
  it("still stores the connection when /me fails -- a consent must not be lost over it", async () => {
    mockFetchProfile.mockRejectedValue(new Error("Spotify 503"));
    const response = await GET(request());
    expect(outcome(response)).toBe("connected");
    expect(mockStoreConnection).toHaveBeenCalledOnce();
    expect(mockStoreConnection.mock.calls[0]![3]).toMatchObject({ profile: null });
  });
});

describe("the next-destination cookie", () => {
  it("honours it on success", async () => {
    const response = await GET(
      request(
        { code: "auth-code", state: STATE },
        {
          "mtdo-spotify-oauth-next": "/architecture-02",
          "mtdo-spotify-oauth-state": STATE,
          "mtdo-spotify-oauth-verifier": VERIFIER,
        },
      ),
    );
    expect(destination(response)).toBe("/architecture-02");
    expect(outcome(response)).toBe("connected");
  });

  it("honours it on a FAILURE path too, not just the happy one", async () => {
    // A user who started from the Listen deck should land back there whatever
    // happened, rather than being dumped on Settings only when it went wrong.
    const response = await GET(
      request(
        { error: "access_denied" },
        {
          "mtdo-spotify-oauth-next": "/architecture-02",
          "mtdo-spotify-oauth-state": STATE,
          "mtdo-spotify-oauth-verifier": VERIFIER,
        },
      ),
    );
    expect(destination(response)).toBe("/architecture-02");
    expect(outcome(response)).toBe("declined");
  });

  it("honours it on the no-session path, which runs before every other check", async () => {
    mockGetUser.mockResolvedValue({ data: { user: null }, error: null });
    const response = await GET(
      request(
        { code: "auth-code", state: STATE },
        {
          "mtdo-spotify-oauth-next": "/architecture-02",
          "mtdo-spotify-oauth-state": STATE,
          "mtdo-spotify-oauth-verifier": VERIFIER,
        },
      ),
    );
    expect(destination(response)).toBe("/architecture-02");
  });

  it("falls back to Settings when absent", async () => {
    expect(destination(await GET(request()))).toBe(SETTINGS);
  });

  it("ignores a destination Spotify round-tripped back in the query string", async () => {
    // The redirect target comes from the cookie /connect set, never from
    // anything the provider echoed -- the open-redirect shape safeNextPath()
    // exists for.
    const response = await GET(
      request({ code: "auth-code", next: "https://evil.example/phish", state: STATE }),
    );
    expect(new URL(response.headers.get("location")!).origin).toBe("https://mtdo.example");
    expect(destination(response)).toBe(SETTINGS);
  });
});
