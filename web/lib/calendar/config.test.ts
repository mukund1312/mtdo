// resolveCalendarConfig() is the whole "degrades gracefully when the provider
// isn't set up" contract in one function (the lib/ai/service.ts pattern,
// applied to Google). These tests exist because `configured: false` is the
// path this environment genuinely runs today -- there are no real Google
// credentials here -- so it is the branch most likely to be wrong and least
// likely to be caught by anything else.
import { randomBytes } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { resolveCalendarConfig } from "./config";

const ORIGIN = "https://mtdo.example";
const VARS = [
  "GOOGLE_CLIENT_ID",
  "GOOGLE_CLIENT_SECRET",
  "CALENDAR_TOKEN_ENCRYPTION_KEY",
  "SUPABASE_SERVICE_ROLE_KEY",
  "GOOGLE_OAUTH_REDIRECT_URI",
] as const;

const saved: Record<string, string | undefined> = {};

function configureAll() {
  process.env.GOOGLE_CLIENT_ID = "client-id";
  process.env.GOOGLE_CLIENT_SECRET = "client-secret";
  process.env.CALENDAR_TOKEN_ENCRYPTION_KEY = randomBytes(32).toString("base64");
  process.env.SUPABASE_SERVICE_ROLE_KEY = "service-role-key";
}

beforeEach(() => {
  for (const name of VARS) {
    saved[name] = process.env[name];
    delete process.env[name];
  }
});

afterEach(() => {
  for (const name of VARS) {
    if (saved[name] === undefined) delete process.env[name];
    else process.env[name] = saved[name];
  }
});

describe("resolveCalendarConfig", () => {
  it("reports every missing variable by name rather than just failing", () => {
    const result = resolveCalendarConfig(ORIGIN);
    expect(result.configured).toBe(false);
    expect(result.configured === false && result.missing).toEqual([
      "GOOGLE_CLIENT_ID",
      "GOOGLE_CLIENT_SECRET",
      "CALENDAR_TOKEN_ENCRYPTION_KEY",
      "SUPABASE_SERVICE_ROLE_KEY",
    ]);
  });

  it("reports exactly the one variable that is missing", () => {
    configureAll();
    delete process.env.GOOGLE_CLIENT_SECRET;
    const result = resolveCalendarConfig(ORIGIN);
    expect(result.configured === false && result.missing).toEqual(["GOOGLE_CLIENT_SECRET"]);
  });

  it("treats a present-but-wrong-length encryption key as not configured", () => {
    // Discovering this at the moment a real user finishes Google's consent
    // screen -- with a grant we then cannot store -- is the failure this
    // check exists to prevent.
    configureAll();
    process.env.CALENDAR_TOKEN_ENCRYPTION_KEY = randomBytes(16).toString("base64");
    const result = resolveCalendarConfig(ORIGIN);
    expect(result.configured === false && result.missing).toEqual(["CALENDAR_TOKEN_ENCRYPTION_KEY"]);
  });

  it("resolves fully when everything is present, deriving the redirect URI from the origin", () => {
    configureAll();
    const result = resolveCalendarConfig(ORIGIN);
    expect(result.configured).toBe(true);
    expect(result.configured === true && result.config.redirectUri).toBe(
      "https://mtdo.example/api/calendar/callback",
    );
    expect(result.configured === true && result.config.encryptionKey.length).toBe(32);
  });

  it("prefers an explicit GOOGLE_OAUTH_REDIRECT_URI over the derived one", () => {
    configureAll();
    process.env.GOOGLE_OAUTH_REDIRECT_URI = "https://registered.example/api/calendar/callback";
    const result = resolveCalendarConfig(ORIGIN);
    expect(result.configured === true && result.config.redirectUri).toBe(
      "https://registered.example/api/calendar/callback",
    );
  });
});
