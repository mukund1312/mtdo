import { expect, test, type Page } from "@playwright/test";

// The Listen deck's Spotify frontend, built against the real backend merged
// in PR #169 (docs/architecture/api.md §3i). There are no real Spotify
// developer credentials in this environment (same situation Google Calendar
// was in through Phase 6), so GET /api/music/spotify/status genuinely
// returns configured:false here -- this is the one path fully exercisable
// end to end without mocking, and it's this project's honesty contract at
// work: a clean, specific message, never a crash, never a Connect button
// that would 503 without explanation.
//
// ONE shared page/anonymous session for the whole file (test.describe.serial
// + a manually created page, the same pattern -- and for the same reason --
// as e2e/phase6b-calendar-editing.spec.ts: this project's own Supabase
// project has a real, tight anonymous-auth rate limit, and CI (PR #170) hit
// it running this file's four tests as four separate fresh sign-ins
// alongside the rest of the suite. Cutting to one sign-in for four tests is
// a real reduction in this file's own contribution to that shared budget.

async function closeWalkthroughIfPresent(page: Page) {
  const close = page.getByRole("button", { name: /close walkthrough/i });
  // See fixed-layer-safety.spec.ts's copy of this helper for why the wait
  // matters: the walkthrough opens on a setTimeout(0) gated on auth
  // resolving, never synchronously at mount, so an immediate check can race
  // ahead of it.
  await close.waitFor({ state: "visible", timeout: 2000 }).catch(() => {});
  if (await close.isVisible().catch(() => false)) await close.click();
}

test.describe.serial("Spotify: Listen deck and Settings honesty states", () => {
  let page: Page;

  test.beforeAll(async ({ browser }) => {
    page = await browser.newPage();
    // Establishes the anonymous session (proxy.ts) once for every test below.
    // The reload matters: settings.spec.ts's own comments document this same
    // race elsewhere in this suite -- the first response after page.goto()
    // isn't guaranteed to have the session's auth cookie attached yet on a
    // real production server, so an authenticated fetch made immediately
    // after (like the Spotify status panel's own mount-time call) can race
    // it. One reload here is cheaper than every downstream test having to
    // account for a possibly-unauthenticated first request.
    await page.goto("/architecture-02");
    await page.reload();
  });

  test.afterAll(async () => {
    await page.close();
  });

  test("Listen deck's Spotify source reports 'not configured' cleanly when Spotify isn't set up", async () => {
    await page.goto("/architecture-02?deck=listen");
    await closeWalkthroughIfPresent(page);

    await page.locator(".a02-listen-source").filter({ hasText: "Spotify" }).click();
    await expect(page.getByText(/not configured/i)).toBeVisible({ timeout: 20_000 });
    await expect(page.getByText(/spotify isn.t configured on this server yet/i)).toBeVisible();
    await expect(page.getByRole("link", { name: /connect spotify/i })).toHaveCount(0);

    // The other two providers are untouched by any of this.
    await page.locator(".a02-listen-source").filter({ hasText: "Apple Music" }).click();
    await expect(page.getByRole("heading", { name: /connect your apple music account/i })).toBeVisible();
  });

  test("Settings -> Music reports 'not configured' cleanly when Spotify isn't set up", async () => {
    await page.goto("/architecture-02/settings");
    await expect(page.getByRole("heading", { name: /under the hood/i })).toBeVisible();
    await page.getByRole("button", { name: "Integrations" }).click();
    await expect(page.getByText("Music", { exact: true })).toBeVisible();

    const spotifyRow = page.locator(".a02-settings-row").filter({ hasText: "Spotify" });
    await expect(spotifyRow).toBeVisible({ timeout: 20_000 });
    await expect(spotifyRow.getByText(/not configured/i)).toBeVisible();
    await expect(page.getByText(/Listen deck.s other sources still work/i)).toBeVisible();
    await expect(page.getByRole("link", { name: /connect spotify/i })).toHaveCount(0);
    // Task-tied soundtracks (Phase 2): the whole section is gated on
    // spotify.configured -- an unconfigured server shows nothing here, not a
    // second copy of the "not configured" message.
    await expect(page.getByText("Focus Soundtracks")).toHaveCount(0);
  });

  // Real routes must degrade, not crash -- an unconfigured server answers with
  // a real status code and a machine-readable reason, matching every other
  // integration in this app (Calendar's own equivalent test is the template).
  test("Spotify routes degrade cleanly when not configured", async () => {
    const status = await page.request.get("/api/music/spotify/status");
    expect(status.status()).toBe(200);
    const body = await status.json();
    expect(body.configured).toBe(false);
    expect(body.connected).toBe(false);
    expect(body.connection).toBeNull();
    expect(body.missing.length).toBeGreaterThan(0);

    const connect = await page.request.get("/api/music/spotify/connect", { maxRedirects: 0 });
    expect(connect.status()).toBe(503);
    expect((await connect.json()).configured).toBe(false);

    const token = await page.request.get("/api/music/spotify/token");
    expect(token.status()).toBe(503);
    expect((await token.json()).configured).toBe(false);

    const disconnect = await page.request.post("/api/music/spotify/disconnect");
    expect(disconnect.status()).toBe(503);

    // Phase 1 (playlists/queue/devices/playback-control) routes must degrade
    // identically -- same resolveSpotifyConfig() gate every other route uses.
    const playlists = await page.request.get("/api/music/spotify/playlists");
    expect(playlists.status()).toBe(503);
    expect((await playlists.json()).configured).toBe(false);

    const playlistTracks = await page.request.get("/api/music/spotify/playlists/does-not-matter/tracks");
    expect(playlistTracks.status()).toBe(503);
    expect((await playlistTracks.json()).configured).toBe(false);

    const queue = await page.request.get("/api/music/spotify/player/queue");
    expect(queue.status()).toBe(503);
    expect((await queue.json()).configured).toBe(false);

    const devices = await page.request.get("/api/music/spotify/player/devices");
    expect(devices.status()).toBe(503);
    expect((await devices.json()).configured).toBe(false);

    const play = await page.request.post("/api/music/spotify/player/play", { data: { uris: ["spotify:track:1"] } });
    expect(play.status()).toBe(503);
    expect((await play.json()).configured).toBe(false);

    const transfer = await page.request.post("/api/music/spotify/player/transfer", { data: { deviceId: "d1" } });
    expect(transfer.status()).toBe(503);
    expect((await transfer.json()).configured).toBe(false);
  });

  // The real Connect affordance -- a plain <a href> real top-level navigation,
  // never a fetch() -- exists and points at the right route once the server
  // reports it's actually configured. Confirmed via GET /api/music/spotify/status
  // intercepted with the exact locked contract shape (api.md §3i); nothing
  // about the real OAuth hop itself is exercised or claimed to be. Not the
  // last mocking test anymore (see the playlist-browse test below) -- calls
  // its own page.unroute() so the next test starts clean either way.
  test("Spotify Connect is a real link to /api/music/spotify/connect once configured", async () => {
    await page.route("**/api/music/spotify/status", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ configured: true, connected: false, connection: null, missing: [], provider: "spotify" }),
      });
    });

    await page.goto("/architecture-02?deck=listen");
    await closeWalkthroughIfPresent(page);
    await page.locator(".a02-listen-source").filter({ hasText: "Spotify" }).click();

    const connectLink = page.getByRole("link", { name: /connect spotify/i });
    await expect(connectLink).toBeVisible({ timeout: 20_000 });
    await expect(connectLink).toHaveAttribute("href", /^\/api\/music\/spotify\/connect/);

    await page.unroute("**/api/music/spotify/status");
  });

  // Phase 1's playlist browser (PR #172's backend, this PR's frontend): pure
  // frontend-against-mocked-fetch, the same technique the test above uses --
  // genuinely testable without a live Premium account/device, unlike actual
  // audible playback. Run last: the shared page is torn down (afterAll)
  // right after, so nothing downstream can inherit these route handlers.
  test("Playlist browser lists playlists, drills into tracks, and fires a real play request", async () => {
    await page.route("**/api/music/spotify/status", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          configured: true,
          connected: true,
          connection: {
            connectedAt: new Date().toISOString(),
            displayName: "Test Listener",
            expired: false,
            premium: true,
            product: "premium",
            refreshTokenExpiresAt: null,
            scopes: [],
          },
          missing: [],
          provider: "spotify",
        }),
      });
    });
    await page.route("**/api/music/spotify/playlists", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          items: [{ id: "p1", name: "Deep Focus", trackCount: 2, imageUrl: null, uri: "spotify:playlist:p1" }],
          next: null,
        }),
      });
    });
    await page.route("**/api/music/spotify/playlists/p1/tracks", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          items: [
            { uri: "spotify:track:t1", name: "Two Sum", artists: ["Test Artist"], album: "Test Album", imageUrl: null, durationMs: 210000 },
          ],
          next: null,
        }),
      });
    });
    let playRequestBody: unknown = null;
    await page.route("**/api/music/spotify/player/play", async (route) => {
      playRequestBody = route.request().postDataJSON();
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true }) });
    });

    await page.goto("/architecture-02?deck=listen");
    await closeWalkthroughIfPresent(page);
    await page.locator(".a02-listen-source").filter({ hasText: "Spotify" }).click();

    await expect(page.getByText("YOUR PLAYLISTS")).toBeVisible({ timeout: 20_000 });
    await expect(page.getByText("Deep Focus")).toBeVisible();

    await page.getByRole("button", { name: "Open Deep Focus" }).click();
    await expect(page.getByText("Two Sum")).toBeVisible();
    await expect(page.getByRole("button", { name: "← Playlists" })).toBeVisible();

    await page.getByRole("button", { name: "Play Two Sum" }).click();
    await expect.poll(() => playRequestBody).toEqual({ contextUri: "spotify:playlist:p1", offset: { uri: "spotify:track:t1" } });

    await page.getByRole("button", { name: "← Playlists" }).click();
    await expect(page.getByText("YOUR PLAYLISTS")).toBeVisible();
    await expect(page.getByText("Deep Focus")).toBeVisible();

    await page.unroute("**/api/music/spotify/status");
    await page.unroute("**/api/music/spotify/playlists");
    await page.unroute("**/api/music/spotify/playlists/p1/tracks");
    await page.unroute("**/api/music/spotify/player/play");
  });

  // Phase 1's Queue/Device tabs (Phase 1, PR 3), same mocked-fetch technique
  // as the playlist-browser test above. Run last for the same reason.
  test("Queue and Device tabs render real data and transferring playback fires the right request", async () => {
    await page.route("**/api/music/spotify/status", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          configured: true,
          connected: true,
          connection: {
            connectedAt: new Date().toISOString(),
            displayName: "Test Listener",
            expired: false,
            premium: true,
            product: "premium",
            refreshTokenExpiresAt: null,
            scopes: [],
          },
          missing: [],
          provider: "spotify",
        }),
      });
    });
    await page.route("**/api/music/spotify/playlists", async (route) => {
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ items: [], next: null }) });
    });
    await page.route("**/api/music/spotify/player/queue", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          currentlyPlaying: { uri: "spotify:track:now", name: "Currently Playing Track", artists: ["Artist"], album: null, imageUrl: null, durationMs: 180000 },
          queue: [{ uri: "spotify:track:next", name: "Up Next Track", artists: ["Artist"], album: null, imageUrl: null, durationMs: 200000 }],
        }),
      });
    });
    await page.route("**/api/music/spotify/player/devices", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          devices: [
            { id: "d1", name: "MacBook", type: "Computer", isActive: false, volumePercent: 60 },
            { id: "d2", name: "Kitchen Speaker", type: "Speaker", isActive: true, volumePercent: 40 },
          ],
        }),
      });
    });
    let transferRequestBody: unknown = null;
    await page.route("**/api/music/spotify/player/transfer", async (route) => {
      transferRequestBody = route.request().postDataJSON();
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true }) });
    });

    await page.goto("/architecture-02?deck=listen");
    await closeWalkthroughIfPresent(page);
    await page.locator(".a02-listen-source").filter({ hasText: "Spotify" }).click();
    await expect(page.getByText("No playlists found on this Spotify account.")).toBeVisible({ timeout: 20_000 });

    const tablist = page.getByRole("tablist", { name: "Spotify playback view" });
    await tablist.getByRole("tab", { name: "Queue" }).click();
    await expect(page.getByText("Up Next Track")).toBeVisible();
    await expect(page.locator(".a02-listen-queue-now").filter({ hasText: "Currently Playing Track" })).toBeVisible();

    await tablist.getByRole("tab", { name: "Device" }).click();
    await expect(page.getByRole("button", { name: "Switch playback to MacBook" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Switch playback to Kitchen Speaker" })).toBeDisabled();

    await page.getByRole("button", { name: "Switch playback to MacBook" }).click();
    await expect.poll(() => transferRequestBody).toEqual({ deviceId: "d1", play: true });

    await page.unroute("**/api/music/spotify/status");
    await page.unroute("**/api/music/spotify/playlists");
    await page.unroute("**/api/music/spotify/player/queue");
    await page.unroute("**/api/music/spotify/player/devices");
    await page.unroute("**/api/music/spotify/player/transfer");
  });
});

// Task-tied soundtracks (Phase 2, PR B): the Settings mapping UI. Creates a
// real plan with a real topic-typed category via Manual Setup -- unlike
// every test above, this can NOT share the file's one session:
// plan_categories.topic_type only exists on a real, owned plan, and this
// project enforces one active plan per user. Own standalone session, the
// same reasoning this project's other plan-creating tests already follow
// (see phase3-plan-pipeline.spec.ts's own header comment).
test("Settings: Focus Soundtracks maps a real topic-typed category to a playlist", async ({ page }) => {
  await page.goto("/architecture-02/onboarding/manual");
  await page.getByPlaceholder(/get fluent in sql joins/i).fill("Prepare for backend interviews");
  await page.getByPlaceholder("e.g. SQL Joins").fill("Arrays");
  await page.getByLabel(/topic type/i).selectOption("dsa");
  await page.getByPlaceholder("Add a task").fill("Two-pointer basics");
  await page.getByRole("button", { name: "Add", exact: true }).click();
  const submit = page.getByRole("button", { name: /create my route/i });
  await expect(submit).toBeEnabled();
  await submit.click();
  await expect(page).toHaveURL(/\/architecture-02\?deck=work$/);

  await page.route("**/api/music/spotify/status", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        configured: true,
        connected: true,
        connection: {
          connectedAt: new Date().toISOString(),
          displayName: "Test Listener",
          expired: false,
          premium: true,
          product: "premium",
          refreshTokenExpiresAt: null,
          scopes: [],
        },
        missing: [],
        provider: "spotify",
      }),
    });
  });
  await page.route("**/api/music/spotify/playlists", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        items: [{ id: "p1", name: "Deep Focus", trackCount: 12, imageUrl: null, uri: "spotify:playlist:p1" }],
        next: null,
      }),
    });
  });

  await page.goto("/architecture-02/settings");
  await expect(page.getByRole("heading", { name: /under the hood/i })).toBeVisible();
  await page.getByRole("button", { name: "Integrations" }).click();

  await expect(page.getByText("Focus Soundtracks")).toBeVisible({ timeout: 20_000 });
  await expect(page.getByText("DSA", { exact: true })).toBeVisible();

  const select = page.getByLabel("Soundtrack for dsa");
  await select.selectOption("p1");
  await expect(page.getByRole("button", { name: "Clear" })).toBeVisible();

  // Reload with the same routes still mocked -- confirms the mapping
  // actually persisted to soundtrack_preferences, not just local state.
  await page.reload();
  await page.getByRole("button", { name: "Integrations" }).click();
  await expect(page.getByLabel("Soundtrack for dsa")).toHaveValue("p1", { timeout: 20_000 });

  await page.getByRole("button", { name: "Clear" }).click();
  await expect(page.getByRole("button", { name: "Clear" })).toHaveCount(0);
  await page.reload();
  await page.getByRole("button", { name: "Integrations" }).click();
  await expect(page.getByLabel("Soundtrack for dsa")).toHaveValue("", { timeout: 20_000 });

  await page.unroute("**/api/music/spotify/status");
  await page.unroute("**/api/music/spotify/playlists");
});
