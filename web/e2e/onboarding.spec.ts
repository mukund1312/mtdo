import { test, expect } from "@playwright/test";

// Real end-to-end happy path: landing page -> onboarding entry -> intent step
// -> rhythm step -> submit -> a persisted plan is ready. gh95 (anonymous
// sign-ins disabled on the connected Supabase project, blocking the
// POST /api/onboarding/plan call this test now drives) is fixed -- see
// README.md for history.
test("onboarding wizard: intent -> rhythm -> build a route end-to-end", async ({ page }) => {
  await page.goto("/architecture-02");
  // First visit shows the Signal Deck walkthrough tour as a modal overlay --
  // dismiss it before interacting with the page underneath.
  await page.getByRole("button", { name: /close walkthrough/i }).click();
  await page.getByRole("link", { name: /set up your route/i }).click();
  await expect(page).toHaveURL(/\/architecture-02\/onboarding$/);

  // Step 1: Intent. The primary button stays disabled until a goal is typed
  // and at least one focus area is added.
  const continueButton = page.getByRole("button", { name: /set the rhythm/i });
  await expect(continueButton).toBeDisabled();

  await page.getByLabel(/your goal/i).fill("Prepare for software engineering interviews by December");
  await page.getByRole("button", { name: "+ Data Structures" }).click();
  await page.getByRole("button", { name: "+ System Design" }).click();
  await expect(page.getByRole("button", { name: /^data structures ×$/i })).toBeVisible();

  await expect(continueButton).toBeEnabled();
  await continueButton.click();

  // Step 2: Rhythm. Defaults (intermediate, Mon-Fri) are already valid --
  // the happy path is "accept the sane defaults and go", not "must configure
  // everything by hand".
  await expect(page.getByRole("heading", { name: /build for the/i })).toBeVisible();
  await expect(page.getByRole("button", { name: "intermediate" })).toHaveClass(/is-selected/);
  for (const day of ["MON", "TUE", "WED", "THU", "FRI"]) {
    await expect(page.getByRole("button", { name: day, exact: true })).toHaveClass(/is-selected/);
  }

  const buildButton = page.getByRole("button", { name: /build my route/i });
  await expect(buildButton).toBeVisible();
  await expect(buildButton).toBeEnabled();

  // Step 3: submit and wait for a persisted plan. This calls the real
  // Anthropic API and Supabase (route.ts's own failure contract falls back
  // to a static plan if either misbehaves, so "ready" is the right thing to
  // assert on here, not "used the AI-generated plan specifically").
  await buildButton.click();
  await expect(page.getByText(/route engine active/i)).toBeVisible();

  const readyHeading = page.getByRole("heading", { name: /route is ready/i });
  await expect(readyHeading).toBeVisible({ timeout: 60_000 });
  await expect(page.getByText("Prepare for software engineering interviews by December")).toBeVisible();

  // At least one category card from the persisted plan renders.
  await expect(page.locator("article").first()).toBeVisible();

  const enterTodayButton = page.getByRole("button", { name: /enter today/i });
  await expect(enterTodayButton).toBeEnabled();
  await enterTodayButton.click();
  await expect(page).toHaveURL(/\/architecture-02\?deck=work$/);
  await expect(page.getByRole("heading", { name: /move the right pieces/i })).toBeVisible();

  // The active plan's curriculum is retrieved through ensure_curriculum_menu.
  // Pulling an item onto Today uses the lock-safe, idempotent picker RPC -- it
  // must become a real block, not a client-only card.
  await page.getByRole("button", { name: /add from route/i }).click();
  const routeMenu = page.getByRole("dialog", { name: /choose the next piece/i });
  await expect(routeMenu).toBeVisible();
  const routeItem = routeMenu.locator(".a02-curriculum-item").first();
  await expect(routeItem).toBeVisible();
  const task = (await routeItem.locator("b").textContent())?.trim();
  expect(task).toBeTruthy();
  await routeItem.click();
  await expect(routeMenu).toBeHidden();

  const addedBlock = page.locator(".a02-live-block").filter({ hasText: task! });
  await expect(addedBlock).toBeVisible();
  await addedBlock.dragTo(page.locator(".a02-today-lane--in_progress"));
  await expect(page.locator(".a02-today-lane--in_progress")).toContainText(task!);
});

test("Review shows an honest empty heatmap and view-only Record Card", async ({ page }) => {
  await page.goto("/architecture-02");
  await page.getByRole("button", { name: /close walkthrough/i }).click();
  await page.getByRole("navigation", { name: "Signal deck navigation" }).getByRole("button", { name: /review/i }).click();

  await expect(page.getByRole("heading", { name: /make effort legible/i })).toBeVisible();
  await expect(page.getByLabel("Six-week focus heatmap")).toBeVisible();
  await expect(page.getByText(/no recorded focus in this window yet/i)).toBeVisible();

  await page.getByRole("button", { name: /view record/i }).click();
  const record = page.getByRole("dialog", { name: /the work is real/i });
  await expect(record).toBeVisible();
  await expect(record.getByText("0m", { exact: true })).toBeVisible();
  await expect(record.getByRole("button", { name: /download|export/i })).toHaveCount(0);
});

test("Listen keeps Music previews separate while loading Terminal's real radio streams", async ({ page }) => {
  await page.goto("/architecture-02");
  await page.getByRole("button", { name: /close walkthrough/i }).click();
  const listenButton = page.getByRole("navigation", { name: "Signal deck navigation" }).getByRole("button", { name: /listen/i });
  await listenButton.click();

  await expect(page.getByRole("heading", { name: /stay in the flow/i })).toBeVisible();
  await expect(page.getByText(/preview mode/i)).toBeVisible();
  await expect(page.getByText(/local interactions only/i)).toBeVisible();
  await page.getByRole("button", { name: /connect apple music/i }).click();
  const appleDialog = page.getByRole("dialog", { name: /connect apple music/i });
  await expect(appleDialog).toBeVisible();
  await expect(appleDialog.getByText(/does not contact a service or access this device/i)).toBeVisible();
  await appleDialog.getByRole("button", { name: /connect apple music/i }).click();
  await expect(page.getByText(/connected \/ demo/i)).toBeVisible();
  await appleDialog.getByRole("button", { name: /open demo library/i }).click();
  await expect(page.getByRole("button", { name: /play moonlit index preview/i })).toBeVisible();

  const sources = page.getByLabel("Music sources");
  await sources.getByRole("button", { name: /spotify/i }).click();
  await expect(page.getByRole("heading", { name: /connect spotify/i })).toBeVisible();
  await sources.getByRole("button", { name: /local music/i }).click();
  await expect(page.getByRole("heading", { name: /no local library connected/i })).toBeVisible();
  await page.getByRole("button", { name: /show demo library/i }).click();
  const localDialog = page.getByRole("dialog", { name: /connect local music/i });
  await localDialog.getByRole("button", { name: /show demo library/i }).click();
  await expect(page.getByRole("button", { name: /open demo library/i })).toBeVisible();
  await page.getByRole("button", { name: /open demo library/i }).click();
  await page.getByRole("button", { name: /play desk lamp preview/i }).click();
  await expect(page.getByRole("button", { name: /pause mock track/i })).toBeVisible();
  await page.getByRole("button", { name: /pause mock track/i }).click();
  await expect(page.getByRole("button", { name: /play mock track/i })).toBeVisible();
  await sources.getByRole("button", { name: /apple music/i }).click();
  await expect(page.getByLabel("Current music source: Local Music")).toBeVisible();

  await page.getByRole("tab", { name: /radio/i }).click();
  await expect(page.getByText("Lofi Hip Hop Radio", { exact: true })).toBeVisible();
  await expect(page.getByText("Hacker Radio", { exact: true })).toBeVisible();
  const radioAudio = page.getByTestId("signal-deck-radio-audio");
  // Every station in the Terminal's eleven-frequency catalog must wire into
  // the one browser-native player. The final selection then proves that this
  // is not only a static source mapping: it reaches native playing state.
  const terminalFrequencies = [
    ["Lofi Hip Hop Radio", "https://ice1.somafm.com/groovesalad-128-mp3"],
    ["EDM Pulse", "https://ice1.somafm.com/thetrip-128-mp3"],
    ["Synthwave Nights", "https://stream.nightride.fm/nightride.mp3"],
    ["House Grooves", "https://ice1.somafm.com/beatblender-128-mp3"],
    ["Dubstep Underground", "https://ice1.somafm.com/dubstep-128-mp3"],
    ["Drum & Bass", "https://ice1.somafm.com/fluid-128-mp3"],
    ["Darksynth", "https://stream.nightride.fm/darksynth.mp3"],
    ["Chillsynth", "https://stream.nightride.fm/chillsynth.mp3"],
    ["Vaporwave", "https://ice1.somafm.com/vaporwaves-128-mp3"],
    ["Indie Pop", "https://ice1.somafm.com/poptron-128-mp3"],
    ["Hacker Radio", "https://ice1.somafm.com/defcon-128-mp3"],
  ] as const;
  for (const [station, url] of terminalFrequencies) {
    await page.locator(".a02-radio-stations button").filter({ hasText: station }).click();
    await expect(radioAudio).toHaveAttribute("src", url);
  }
  // Give one actual public signal time to buffer after the mapping pass. A
  // user selects one station, rather than cancelling ten live requests in a
  // single event loop as the mapping check above intentionally does.
  await page.locator(".a02-radio-stations button").filter({ hasText: "Chillsynth" }).click();
  await expect(radioAudio).toHaveAttribute("src", "https://stream.nightride.fm/chillsynth.mp3");
  await expect(page.getByLabel("Live radio signal analyzer")).toBeVisible();
  await expect(page.getByRole("button", { name: /pause radio/i })).toBeVisible({ timeout: 30_000 });
  await page.getByRole("button", { name: /pause radio/i }).click();
  await expect(page.getByRole("button", { name: /^play radio$/i })).toBeVisible();
  await page.getByRole("button", { name: "Next station" }).click();
  await expect(page.getByRole("button", { name: /vaporwave/i })).toHaveAttribute("aria-pressed", "true");
  await expect(radioAudio).toHaveAttribute("src", "https://ice1.somafm.com/vaporwaves-128-mp3");
  await page.keyboard.press("f");
  await expect(page.getByRole("button", { name: "Favorite current station" })).toHaveAttribute("aria-pressed", "true");
});

test("Listen keeps controls inside the mobile Signal Deck viewport", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/architecture-02");
  await page.getByRole("button", { name: /close walkthrough/i }).click();
  const listenButton = page.getByRole("navigation", { name: "Signal deck navigation" }).getByRole("button", { name: /listen/i });
  await listenButton.click();
  await expect(page.getByRole("tab", { name: /music/i })).toBeVisible();
  await expect(page.getByLabel("Music sources")).toBeVisible();
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await expect(page.getByRole("navigation", { name: "Signal deck navigation" })).toBeVisible();
});

test("Listen radio stays within the tablet Signal Deck viewport", async ({ page }) => {
  await page.setViewportSize({ width: 834, height: 1024 });
  await page.goto("/architecture-02");
  await page.getByRole("button", { name: /close walkthrough/i }).click();
  const listenButton = page.getByRole("navigation", { name: "Signal deck navigation" }).getByRole("button", { name: /listen/i });
  await listenButton.focus();
  await listenButton.press("Enter");
  await page.getByRole("tab", { name: /music/i }).press("ArrowRight");
  await expect(page.getByRole("tab", { name: /radio/i })).toHaveAttribute("aria-selected", "true");
  await expect(page.getByText("Hacker Radio", { exact: true })).toBeVisible();
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});

// There is deliberately no synthetic confirmation token in browser tests:
// Supabase owns those single-use tokens. This exercises the real callback's
// no-code/invalid-link branch and verifies it never claims the guest session
// has been confirmed.
test("an invalid confirmation callback stays in Signal Deck with account recovery", async ({ page }) => {
  await page.goto("/auth/callback?next=%2Farchitecture-02%3Fauth%3Dconfirmed");

  await expect(page).toHaveURL(/\/architecture-02\?auth=confirmation-error$/);
  await expect(page.getByText(/confirmation link is invalid or has expired/i)).toBeVisible();
  await expect(page.getByRole("heading", { name: /keep the route/i })).toBeVisible();
  await expect(page.getByText(/you’re in/i)).toHaveCount(0);
});
