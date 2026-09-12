// resolveSpotifyConfig(): unconfigured must be a clean, honest, enumerated
// result -- never a throw. That is not a defensive nicety here, it is the
// state this environment is actually in (no Spotify developer credentials
// exist), so it is the branch every route below it genuinely runs today.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { randomBytes } from "node:crypto";

import { SPOTIFY_SCOPES, resolveSpotifyConfig } from "./config";

const ENV_VARS = [
  "SPOTIFY_CLIENT_ID",
  "SPOTIFY_TOKEN_ENCRYPTION_KEY",
  "SPOTIFY_OAUTH_REDIRECT_URI",
  "SUPABASE_SERVICE_ROLE_KEY",
] as const;
const saved: Record<string, string | undefined> = {};

const ORIGIN = "https://mtdo.example";

function configureAll() {
  process.env.SPOTIFY_CLIENT_ID = "spotify-client-id";
  process.env.SPOTIFY_TOKEN_ENCRYPTION_KEY = randomBytes(32).toString("base64");
  process.env.SUPABASE_SERVICE_ROLE_KEY = "service-role-key";
}

beforeEach(() => {
  for (const name of ENV_VARS) {
    saved[name] = process.env[name];
    delete process.env[name];
  }
});

afterEach(() => {
  for (const name of ENV_VARS) {
    if (saved[name] === undefined) delete process.env[name];
    else process.env[name] = saved[name];
  }
});

describe("resolveSpotifyConfig", () => {
  it("reports every missing variable at once, rather than the first one", () => {
    const result = resolveSpotifyConfig(ORIGIN);
    expect(result.configured).toBe(false);
    if (result.configured) throw new Error("unreachable");
    expect(result.missing).toEqual(
      expect.arrayContaining([
        "SPOTIFY_CLIENT_ID",
        "SPOTIFY_TOKEN_ENCRYPTION_KEY",
        "SUPABASE_SERVICE_ROLE_KEY",
      ]),
    );
  });

  it("never asks for a SPOTIFY_CLIENT_SECRET -- PKCE does not use one", () => {
    // The real risk this guards against is an author copying
    // resolveCalendarConfig() wholesale. Requiring a secret here would leave a
    // correctly-configured deployment permanently reporting "unconfigured".
    const result = resolveSpotifyConfig(ORIGIN);
    if (result.configured) throw new Error("unreachable");
    expect(result.missing).not.toContain("SPOTIFY_CLIENT_SECRET");
  });

  it("treats a present-but-wrong-length encryption key as missing", () => {
    // Discovering a bad key at the moment a real user finishes Spotify's
    // consent screen -- when the grant cannot be stored -- is the outcome
    // this prevents.
    configureAll();
    process.env.SPOTIFY_TOKEN_ENCRYPTION_KEY = randomBytes(16).toString("base64");
    const result = resolveSpotifyConfig(ORIGIN);
    expect(result.configured).toBe(false);
    if (result.configured) throw new Error("unreachable");
    expect(result.missing).toEqual(["SPOTIFY_TOKEN_ENCRYPTION_KEY"]);
  });

  it("treats an unparseable encryption key as missing too", () => {
    configureAll();
    process.env.SPOTIFY_TOKEN_ENCRYPTION_KEY = "not-a-key";
    const result = resolveSpotifyConfig(ORIGIN);
    expect(result.configured).toBe(false);
  });

  it("resolves when everything is present, deriving the redirect URI from the origin", () => {
    configureAll();
    const result = resolveSpotifyConfig(ORIGIN);
    expect(result.configured).toBe(true);
    if (!result.configured) throw new Error("unreachable");
    expect(result.config.clientId).toBe("spotify-client-id");
    expect(result.config.redirectUri).toBe("https://mtdo.example/api/music/spotify/callback");
    expect(result.config.encryptionKey.length).toBe(32);
  });

  it("prefers an explicit redirect URI over the derived one", () => {
    // Spotify matches the registered redirect URI byte-for-byte, and a preview
    // deployment's generated hostname will never be on that list.
    configureAll();
    process.env.SPOTIFY_OAUTH_REDIRECT_URI = "https://mtdo.app/api/music/spotify/callback";
    const result = resolveSpotifyConfig("https://preview-abc123.vercel.app");
    if (!result.configured) throw new Error("unreachable");
    expect(result.config.redirectUri).toBe("https://mtdo.app/api/music/spotify/callback");
  });

  it("never throws, whatever the environment looks like", () => {
    process.env.SPOTIFY_TOKEN_ENCRYPTION_KEY = "!!!not base64 at all!!!";
    expect(() => resolveSpotifyConfig(ORIGIN)).not.toThrow();
    expect(() => resolveSpotifyConfig("not-a-url")).not.toThrow();
  });
});

describe("SPOTIFY_SCOPES", () => {
  it("requests exactly the three scopes the Web Playback SDK needs, and nothing more", () => {
    // Least privilege, asserted rather than assumed: no playlist, library,
    // follow or user-modify scope. This app plays audio; it does not read or
    // alter the user's Spotify account.
    expect([...SPOTIFY_SCOPES]).toEqual(["streaming", "user-read-email", "user-read-private"]);
  });
});
