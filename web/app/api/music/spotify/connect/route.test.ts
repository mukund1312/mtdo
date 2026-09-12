// Tests for GET /api/music/spotify/connect. Three claims worth holding onto:
// unconfigured is a clean 503 rather than a redirect to a half-built Spotify
// URL; the PKCE verifier is stored in an httpOnly cookie whose SHA-256 matches
// the challenge actually sent to Spotify (the round trip the callback depends
// on); and the CSRF state cookie matches the state in the URL.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { randomBytes } from "node:crypto";
import { NextRequest, type NextResponse } from "next/server";

import { deriveCodeChallenge, isValidCodeVerifier } from "@/lib/music/spotify/pkce";

const { mockGetUser } = vi.hoisted(() => ({ mockGetUser: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({
  createClient: vi.fn(async () => ({ auth: { getUser: mockGetUser } })),
}));

const { GET } = await import("./route");

const ENV_VARS = [
  "SPOTIFY_CLIENT_ID",
  "SPOTIFY_TOKEN_ENCRYPTION_KEY",
  "SPOTIFY_OAUTH_REDIRECT_URI",
  "SUPABASE_SERVICE_ROLE_KEY",
] as const;
const saved: Record<string, string | undefined> = {};

const STATE_COOKIE = "mtdo-spotify-oauth-state";
const VERIFIER_COOKIE = "mtdo-spotify-oauth-verifier";
const NEXT_COOKIE = "mtdo-spotify-oauth-next";

function request(url = "https://mtdo.example/api/music/spotify/connect") {
  return new NextRequest(new Request(url));
}

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
});

afterEach(() => {
  for (const name of ENV_VARS) {
    if (saved[name] === undefined) delete process.env[name];
    else process.env[name] = saved[name];
  }
});

describe("GET /api/music/spotify/connect", () => {
  it("401s without a session", async () => {
    mockGetUser.mockResolvedValue({ data: { user: null }, error: null });
    expect((await GET(request())).status).toBe(401);
  });

  it("503s with the missing variables when Spotify isn't configured, rather than crashing", async () => {
    // The path this environment genuinely takes today -- no Spotify developer
    // credentials exist here.
    const response = await GET(request());
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({
      configured: false,
      missing: expect.arrayContaining(["SPOTIFY_CLIENT_ID", "SPOTIFY_TOKEN_ENCRYPTION_KEY"]),
    });
  });

  it("never reports a missing SPOTIFY_CLIENT_SECRET -- PKCE doesn't use one", async () => {
    const response = await GET(request());
    const body = (await response.json()) as { missing: string[] };
    expect(body.missing).not.toContain("SPOTIFY_CLIENT_SECRET");
  });

  it("redirects to Spotify's consent screen with the right scopes and S256 PKCE", async () => {
    configureAll();
    const response = await GET(request());
    expect(response.status).toBe(307);
    const location = new URL(response.headers.get("location")!);
    expect(location.origin + location.pathname).toBe("https://accounts.spotify.com/authorize");
    expect(location.searchParams.get("response_type")).toBe("code");
    expect(location.searchParams.get("scope")).toBe("streaming user-read-email user-read-private");
    // 'plain' would put the verifier itself into the user's browser history
    // and Spotify's logs, defeating the point of PKCE.
    expect(location.searchParams.get("code_challenge_method")).toBe("S256");
    expect(location.searchParams.get("code_challenge")).toBeTruthy();
    expect(location.searchParams.get("redirect_uri")).toBe(
      "https://mtdo.example/api/music/spotify/callback",
    );
  });

  it("never puts a client secret in the authorize URL", async () => {
    configureAll();
    const response = await GET(request());
    expect(response.headers.get("location")).not.toContain("client_secret");
  });

  it("stores a PKCE verifier whose challenge is the one actually sent to Spotify", async () => {
    // THE round-trip the callback depends on. If these two ever drift apart,
    // the flow fails only at code exchange -- after the user has already
    // granted consent -- so it is worth pinning here.
    configureAll();
    const response = (await GET(request())) as NextResponse;
    const verifier = response.cookies.get(VERIFIER_COOKIE)?.value;
    const challenge = new URL(response.headers.get("location")!).searchParams.get("code_challenge");
    expect(isValidCodeVerifier(verifier)).toBe(true);
    expect(deriveCodeChallenge(verifier!)).toBe(challenge);
  });

  it("keeps the verifier httpOnly and scoped to the spotify routes", async () => {
    // Anyone holding both the verifier and the authorization code can complete
    // the exchange, so it is a secret for the life of one consent screen.
    configureAll();
    const response = (await GET(request())) as NextResponse;
    const cookie = response.cookies.get(VERIFIER_COOKIE);
    expect(cookie?.httpOnly).toBe(true);
    expect(cookie?.sameSite).toBe("lax");
    expect(cookie?.path).toBe("/api/music/spotify");
    expect(cookie?.maxAge).toBe(600);
  });

  it("never leaks the verifier into the redirect URL", async () => {
    configureAll();
    const response = (await GET(request())) as NextResponse;
    const verifier = response.cookies.get(VERIFIER_COOKIE)!.value;
    expect(response.headers.get("location")).not.toContain(verifier);
  });

  it("sets an httpOnly state cookie matching the state it sent to Spotify", async () => {
    configureAll();
    const response = (await GET(request())) as NextResponse;
    const cookie = response.cookies.get(STATE_COOKIE);
    const state = new URL(response.headers.get("location")!).searchParams.get("state");
    expect(cookie?.value).toBe(state);
    expect(cookie?.httpOnly).toBe(true);
    // lax, not strict: Spotify's redirect back is a cross-site top-level GET,
    // and strict would withhold the cookies on exactly that request.
    expect(cookie?.sameSite).toBe("lax");
  });

  it("issues a different state AND a different verifier on every start", async () => {
    // A reused verifier would let one leaked value redeem a later code.
    configureAll();
    const first = (await GET(request())) as NextResponse;
    const second = (await GET(request())) as NextResponse;
    expect(first.cookies.get(STATE_COOKIE)?.value).not.toBe(second.cookies.get(STATE_COOKIE)?.value);
    expect(first.cookies.get(VERIFIER_COOKIE)?.value).not.toBe(
      second.cookies.get(VERIFIER_COOKIE)?.value,
    );
  });

  it("marks the cookies insecure only over plain http (local development)", async () => {
    configureAll();
    const secure = (await GET(request())) as NextResponse;
    expect(secure.cookies.get(STATE_COOKIE)?.secure).toBe(true);
    expect(secure.cookies.get(VERIFIER_COOKIE)?.secure).toBe(true);
    const local = (await GET(
      request("http://localhost:3000/api/music/spotify/connect"),
    )) as NextResponse;
    expect(local.cookies.get(VERIFIER_COOKIE)?.secure).toBe(false);
  });

  it("sets the next-destination cookie, validated same-origin, when ?next is given", async () => {
    configureAll();
    const response = (await GET(
      request("https://mtdo.example/api/music/spotify/connect?next=%2Farchitecture-02%3Fdeck%3Dlisten"),
    )) as NextResponse;
    expect(response.cookies.get(NEXT_COOKIE)?.value).toBe("/architecture-02?deck=listen");
    expect(response.cookies.get(NEXT_COOKIE)?.httpOnly).toBe(true);
  });

  it("rejects an off-origin ?next rather than storing an open-redirect target", async () => {
    configureAll();
    const response = (await GET(
      request("https://mtdo.example/api/music/spotify/connect?next=https%3A%2F%2Fevil.example%2Fphish"),
    )) as NextResponse;
    expect(response.cookies.get(NEXT_COOKIE)?.value).toBe("/");
  });

  it("sets no next-destination cookie for a plain Connect click with no ?next", async () => {
    configureAll();
    const response = (await GET(request())) as NextResponse;
    expect(response.cookies.get(NEXT_COOKIE)).toBeUndefined();
  });
});
