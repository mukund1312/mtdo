// acquireAccessToken() is the piece with real logic in it, and these are the
// claims worth pinning down, roughly in order of how badly each would bite:
//
//   1. A still-valid cached token is served WITHOUT calling Spotify. That is
//      the entire reason the cache exists (the SDK's getOAuthToken callback
//      fires on its own schedule), so a regression here is invisible in
//      behaviour and expensive in practice.
//   2. Spotify's refresh response omitting `refresh_token` must NOT null out
//      the stored one. Spotify "may or may not" rotate; most refreshes do not.
//      Getting this wrong destroys a working six-month connection on the first
//      non-rotating refresh -- i.e. almost immediately, and permanently.
//   3. A dead authorization is `reconnect-required`, never a thrown 500 and
//      never retried. Spotify refresh tokens genuinely expire.
//   4. Refreshing must never extend refresh_token_expires_at -- Spotify's six
//      months runs from the original authorization.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { randomBytes } from "node:crypto";

import { decryptToken, encryptToken } from "@/lib/crypto/token-envelope";
import type { SpotifyConfig } from "./config";
import { acquireAccessToken, deleteConnection, readConnectionSummary, storeConnection } from "./connection";
import { SpotifyError } from "./spotify";

const { mockRefreshAccessToken } = vi.hoisted(() => ({ mockRefreshAccessToken: vi.fn() }));
vi.mock("./spotify", async () => {
  const actual = await vi.importActual<typeof import("./spotify")>("./spotify");
  return { ...actual, refreshAccessToken: mockRefreshAccessToken };
});

const CONFIG: SpotifyConfig = {
  clientId: "client-id",
  encryptionKey: randomBytes(32),
  redirectUri: "https://mtdo.example/api/music/spotify/callback",
};

const LABELS = { reconnect: "Reconnect Spotify.", stored: "Spotify token" };
const USER = "user-123";

type Row = Record<string, unknown> | null;

/** A minimal stand-in for the service client, recording what was written.
 * Mirrors only the two call shapes connection.ts actually uses. */
function serviceClient(row: Row, opts: { selectError?: unknown; updateError?: unknown } = {}) {
  const updates: Record<string, unknown>[] = [];
  const upserts: Record<string, unknown>[] = [];
  const deletes: string[] = [];

  const chainTo = <T,>(value: T) => {
    const chain = {
      eq: () => chain,
      maybeSingle: async () => value,
      then: undefined,
    };
    return chain;
  };

  const client = {
    from: () => ({
      delete: () => {
        deletes.push("delete");
        const chain = {
          eq: () => chain,
          then: (resolve: (v: { error: unknown }) => unknown) => resolve({ error: null }),
        };
        return chain;
      },
      select: () =>
        chainTo(
          opts.selectError ? { data: null, error: opts.selectError } : { data: row, error: null },
        ),
      update: (patch: Record<string, unknown>) => {
        updates.push(patch);
        const chain = {
          eq: () => chain,
          then: (resolve: (v: { error: unknown }) => unknown) =>
            resolve({ error: opts.updateError ?? null }),
        };
        return chain;
      },
      upsert: (payload: Record<string, unknown>) => {
        upserts.push(payload);
        return Promise.resolve({ error: null });
      },
    }),
  };

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { client: client as any, deletes, updates, upserts };
}

function connectionRow(over: Record<string, unknown> = {}) {
  return {
    access_token_encrypted: null,
    access_token_expires_at: null,
    refresh_token_encrypted: encryptToken("stored-refresh-token", CONFIG.encryptionKey),
    refresh_token_expires_at: new Date(Date.now() + 90 * 24 * 3600 * 1000).toISOString(),
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockRefreshAccessToken.mockResolvedValue({
    accessToken: "fresh-access-token",
    expiresIn: 3600,
    refreshToken: null,
    scopes: ["streaming"],
  });
});

afterEach(() => {
  vi.useRealTimers();
});

describe("acquireAccessToken -- the cache", () => {
  it("serves a still-valid cached token without calling Spotify at all", () => {
    const { client } = serviceClient(
      connectionRow({
        access_token_encrypted: encryptToken("cached-access-token", CONFIG.encryptionKey),
        access_token_expires_at: new Date(Date.now() + 1800 * 1000).toISOString(),
      }),
    );
    return acquireAccessToken(client, USER, CONFIG).then((result) => {
      expect(result.outcome).toBe("ok");
      if (result.outcome !== "ok") throw new Error("unreachable");
      expect(result.accessToken).toBe("cached-access-token");
      // The whole point of the cache.
      expect(mockRefreshAccessToken).not.toHaveBeenCalled();
      // And the remaining life is reported honestly, not as a fresh hour.
      expect(result.expiresIn).toBeGreaterThan(1700);
      expect(result.expiresIn).toBeLessThanOrEqual(1800);
    });
  });

  it("refreshes a token that is within the expiry skew, rather than serving a nearly-dead one", async () => {
    // 30 seconds of life left is technically non-zero and practically useless:
    // the browser holds what it is given for an unknown period afterwards.
    const { client } = serviceClient(
      connectionRow({
        access_token_encrypted: encryptToken("nearly-dead", CONFIG.encryptionKey),
        access_token_expires_at: new Date(Date.now() + 30 * 1000).toISOString(),
      }),
    );
    const result = await acquireAccessToken(client, USER, CONFIG);
    expect(result.outcome).toBe("ok");
    if (result.outcome !== "ok") throw new Error("unreachable");
    expect(result.accessToken).toBe("fresh-access-token");
    expect(mockRefreshAccessToken).toHaveBeenCalledOnce();
  });

  it("refreshes an already-expired cached token", async () => {
    const { client } = serviceClient(
      connectionRow({
        access_token_encrypted: encryptToken("expired", CONFIG.encryptionKey),
        access_token_expires_at: new Date(Date.now() - 60 * 1000).toISOString(),
      }),
    );
    const result = await acquireAccessToken(client, USER, CONFIG);
    if (result.outcome !== "ok") throw new Error("unreachable");
    expect(result.accessToken).toBe("fresh-access-token");
  });

  it("refreshes when there is no cached token at all", async () => {
    const { client } = serviceClient(connectionRow());
    const result = await acquireAccessToken(client, USER, CONFIG);
    if (result.outcome !== "ok") throw new Error("unreachable");
    expect(result.accessToken).toBe("fresh-access-token");
    expect(mockRefreshAccessToken).toHaveBeenCalledWith(CONFIG, "stored-refresh-token");
  });

  it("falls back to a refresh -- not a reconnect -- when the CACHED token can't be decrypted", async () => {
    // A disposable value encrypted under a rotated key. Forcing a full OAuth
    // round trip over it would be needlessly hostile when the refresh token
    // beside it is perfectly readable.
    const { client } = serviceClient(
      connectionRow({
        access_token_encrypted: encryptToken("cached", randomBytes(32)),
        access_token_expires_at: new Date(Date.now() + 1800 * 1000).toISOString(),
      }),
    );
    const result = await acquireAccessToken(client, USER, CONFIG);
    expect(result.outcome).toBe("ok");
  });

  it("caches the refreshed token back, encrypted, with a real expiry", async () => {
    const { client, updates } = serviceClient(connectionRow());
    await acquireAccessToken(client, USER, CONFIG);
    expect(updates).toHaveLength(1);
    const patch = updates[0]!;
    // Never in the clear, even in a service-role-only table.
    expect(patch.access_token_encrypted).not.toBe("fresh-access-token");
    expect(decryptToken(patch.access_token_encrypted as string, CONFIG.encryptionKey, LABELS)).toBe(
      "fresh-access-token",
    );
    expect(new Date(patch.access_token_expires_at as string).getTime()).toBeGreaterThan(Date.now());
  });

  it("still returns the token when caching it fails -- the caller already holds a valid one", async () => {
    // Denying a user playback because a performance optimisation failed would
    // be the wrong trade.
    const { client } = serviceClient(connectionRow(), { updateError: { message: "write failed" } });
    const result = await acquireAccessToken(client, USER, CONFIG);
    expect(result.outcome).toBe("ok");
  });
});

describe("acquireAccessToken -- refresh-token rotation", () => {
  it("KEEPS the stored refresh token when Spotify's response omits a new one", async () => {
    // Spotify "may or may not" return a new refresh_token. Writing a null (or
    // an empty encryption) here would destroy a working six-month connection
    // on the first non-rotating refresh, which is most of them.
    const { client, updates } = serviceClient(connectionRow());
    await acquireAccessToken(client, USER, CONFIG);
    expect(updates[0]).not.toHaveProperty("refresh_token_encrypted");
  });

  it("stores the new refresh token when Spotify DOES rotate", async () => {
    mockRefreshAccessToken.mockResolvedValue({
      accessToken: "fresh-access-token",
      expiresIn: 3600,
      refreshToken: "rotated-refresh-token",
      scopes: ["streaming"],
    });
    const { client, updates } = serviceClient(connectionRow());
    await acquireAccessToken(client, USER, CONFIG);
    expect(
      decryptToken(updates[0]!.refresh_token_encrypted as string, CONFIG.encryptionKey, LABELS),
    ).toBe("rotated-refresh-token");
  });

  it("never extends refresh_token_expires_at, even on a rotation", async () => {
    // Spotify's six months runs from the ORIGINAL authorization; refreshing
    // does not reset it. Pushing the deadline out would manufacture a false
    // expiry and turn a predictable "reconnect soon" into a surprise outage.
    mockRefreshAccessToken.mockResolvedValue({
      accessToken: "fresh-access-token",
      expiresIn: 3600,
      refreshToken: "rotated-refresh-token",
      scopes: ["streaming"],
    });
    const { client, updates } = serviceClient(connectionRow());
    await acquireAccessToken(client, USER, CONFIG);
    expect(updates[0]).not.toHaveProperty("refresh_token_expires_at");
  });
});

describe("acquireAccessToken -- the failure states, kept distinct", () => {
  it("reports not-connected for a user who never connected Spotify", async () => {
    const { client } = serviceClient(null);
    expect(await acquireAccessToken(client, USER, CONFIG)).toEqual({ outcome: "not-connected" });
  });

  it("reports reconnect-required for an expired refresh token WITHOUT calling Spotify", async () => {
    const { client } = serviceClient(
      connectionRow({ refresh_token_expires_at: new Date(Date.now() - 1000).toISOString() }),
    );
    const result = await acquireAccessToken(client, USER, CONFIG);
    expect(result.outcome).toBe("reconnect-required");
    // No point spending a round trip on a refresh that cannot succeed.
    expect(mockRefreshAccessToken).not.toHaveBeenCalled();
  });

  it("reports reconnect-required when Spotify answers invalid_grant (revoked before its expiry)", async () => {
    // The safety net the expiry check above is only an optimisation for: a
    // user can revoke the app from their Spotify account at any time.
    mockRefreshAccessToken.mockRejectedValue(
      new SpotifyError("Spotify rejected the token request: revoked", 400, true),
    );
    const { client } = serviceClient(connectionRow());
    const result = await acquireAccessToken(client, USER, CONFIG);
    expect(result.outcome).toBe("reconnect-required");
  });

  it("reports reconnect-required when the stored refresh token can't be decrypted", async () => {
    const { client } = serviceClient(
      connectionRow({ refresh_token_encrypted: encryptToken("x", randomBytes(32)) }),
    );
    const result = await acquireAccessToken(client, USER, CONFIG);
    expect(result.outcome).toBe("reconnect-required");
    expect(mockRefreshAccessToken).not.toHaveBeenCalled();
  });

  it("RETHROWS a transient Spotify failure instead of demanding a reconnect", async () => {
    // The distinction that matters most in this file: telling a user to redo
    // their OAuth grant because Spotify had a bad thirty seconds is both wrong
    // and annoying. A non-invalid_grant error must surface as a 502 upstream.
    mockRefreshAccessToken.mockRejectedValue(new SpotifyError("Spotify is down", 503, false));
    const { client } = serviceClient(connectionRow());
    await expect(acquireAccessToken(client, USER, CONFIG)).rejects.toThrow("Spotify is down");
  });

  it("propagates a database read error rather than reporting a false not-connected", async () => {
    const { client } = serviceClient(null, { selectError: { message: "db down" } });
    await expect(acquireAccessToken(client, USER, CONFIG)).rejects.toBeTruthy();
  });
});

describe("storeConnection", () => {
  it("encrypts both tokens and never writes either in the clear", async () => {
    const { client, upserts } = serviceClient(null);
    await storeConnection(client, USER, CONFIG, {
      accessToken: "plain-access",
      expiresIn: 3600,
      profile: { displayName: "Ada", email: "ada@example.com", id: "sp-1", product: "premium" },
      refreshToken: "plain-refresh",
      scopes: ["streaming"],
    });
    const row = upserts[0]!;
    expect(JSON.stringify(row)).not.toContain("plain-refresh");
    expect(JSON.stringify(row)).not.toContain("plain-access");
    expect(decryptToken(row.refresh_token_encrypted as string, CONFIG.encryptionKey, LABELS)).toBe(
      "plain-refresh",
    );
    expect(decryptToken(row.access_token_encrypted as string, CONFIG.encryptionKey, LABELS)).toBe(
      "plain-access",
    );
  });

  it("caches the access token from the initial exchange rather than discarding it", async () => {
    // The user is about to load the Listen deck, which asks for one
    // immediately. Throwing away a valid token to re-request it a second later
    // would be pure waste.
    const { client, upserts } = serviceClient(null);
    await storeConnection(client, USER, CONFIG, {
      accessToken: "plain-access",
      expiresIn: 3600,
      profile: null,
      refreshToken: "plain-refresh",
      scopes: [],
    });
    expect(upserts[0]!.access_token_expires_at).toBeTruthy();
  });

  it("sets a six-month refresh-token deadline at consent time", async () => {
    const { client, upserts } = serviceClient(null);
    await storeConnection(client, USER, CONFIG, {
      accessToken: "a",
      expiresIn: 3600,
      profile: null,
      refreshToken: "r",
      scopes: [],
    });
    const days =
      (new Date(upserts[0]!.refresh_token_expires_at as string).getTime() - Date.now()) /
      (24 * 3600 * 1000);
    expect(Math.round(days)).toBe(180);
  });

  it("stores a null profile without failing, so a failed /me read can't cost a consent", async () => {
    const { client, upserts } = serviceClient(null);
    await storeConnection(client, USER, CONFIG, {
      accessToken: "a",
      expiresIn: 3600,
      profile: null,
      refreshToken: "r",
      scopes: [],
    });
    expect(upserts[0]!.product).toBeNull();
    expect(upserts[0]!.display_name).toBeNull();
  });
});

describe("readConnectionSummary", () => {
  const base = {
    connected_at: "2026-09-13T00:00:00.000Z",
    display_name: "Ada",
    product: "premium",
    refresh_token_expires_at: new Date(Date.now() + 90 * 24 * 3600 * 1000).toISOString(),
    scopes: ["streaming"],
  };

  it("returns null when the user has no connection", async () => {
    const { client } = serviceClient(null);
    expect(await readConnectionSummary(client, USER)).toBeNull();
  });

  it("carries NO credential field -- this shape is returned to a browser", async () => {
    // Asserted against the ENCRYPTED COLUMN NAMES rather than the substring
    // "token": `refreshTokenExpiresAt` legitimately contains that word and is
    // a timestamp, not a secret. Matching on the word alone failed here and
    // would have had to be loosened into meaninglessness; matching on the
    // actual credential-bearing keys is the claim that matters.
    const { client } = serviceClient({
      ...base,
      access_token_encrypted: "v1:should:not:leak",
      refresh_token_encrypted: "v1:must:not:leak",
    });
    const summary = await readConnectionSummary(client, USER);
    const serialised = JSON.stringify(summary);
    expect(serialised).not.toContain("leak");
    expect(serialised).not.toContain("refresh_token_encrypted");
    expect(serialised).not.toContain("access_token_encrypted");
    // The select list is the real guard: the columns are never even read.
    expect(Object.keys(summary!).sort()).toEqual([
      "connectedAt",
      "displayName",
      "expired",
      "premium",
      "product",
      "refreshTokenExpiresAt",
      "scopes",
    ]);
  });

  it("resolves premium from the captured product tier", async () => {
    const { client } = serviceClient(base);
    expect((await readConnectionSummary(client, USER))?.premium).toBe(true);
  });

  it("reports premium false for a free account", async () => {
    const { client } = serviceClient({ ...base, product: "free" });
    expect((await readConnectionSummary(client, USER))?.premium).toBe(false);
  });

  it("reports premium as NULL, not false, when the tier is unknown", async () => {
    // "We couldn't read your tier" and "your tier can't play" are different
    // things to put on a screen.
    const { client } = serviceClient({ ...base, product: null });
    expect((await readConnectionSummary(client, USER))?.premium).toBeNull();
  });

  it("flags an expired authorization rather than reporting a healthy connection", async () => {
    const { client } = serviceClient({
      ...base,
      refresh_token_expires_at: new Date(Date.now() - 1000).toISOString(),
    });
    expect((await readConnectionSummary(client, USER))?.expired).toBe(true);
  });

  it("is not expired when the deadline is still ahead", async () => {
    const { client } = serviceClient(base);
    expect((await readConnectionSummary(client, USER))?.expired).toBe(false);
  });

  it("is not expired when there is no known deadline", async () => {
    const { client } = serviceClient({ ...base, refresh_token_expires_at: null });
    expect((await readConnectionSummary(client, USER))?.expired).toBe(false);
  });
});

describe("deleteConnection", () => {
  it("issues a delete", async () => {
    const { client, deletes } = serviceClient(null);
    await deleteConnection(client, USER);
    expect(deletes).toHaveLength(1);
  });
});
