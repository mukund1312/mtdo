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
  if (await close.count()) await close.click();
}

test.describe.serial("Spotify: Listen deck and Settings honesty states", () => {
  let page: Page;

  test.beforeAll(async ({ browser }) => {
    page = await browser.newPage();
    // Establishes the anonymous session (proxy.ts) once for every test below.
    await page.goto("/architecture-02");
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
  });

  // The real Connect affordance -- a plain <a href> real top-level navigation,
  // never a fetch() -- exists and points at the right route once the server
  // reports it's actually configured. Confirmed via GET /api/music/spotify/status
  // intercepted with the exact locked contract shape (api.md §3i); nothing
  // about the real OAuth hop itself is exercised or claimed to be. Run last:
  // it's the only test in this file that mocks a response, and the shared
  // page is torn down (afterAll) right after, so nothing downstream can
  // inherit this route handler.
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
});
