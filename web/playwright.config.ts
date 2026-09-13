import { defineConfig, devices } from "@playwright/test";

const baseURL = process.env.PLAYWRIGHT_BASE_URL ?? "http://localhost:3000";

// Real end-to-end tests -- an actual browser driving the actual dev server,
// not a component or unit test. See e2e/README.md for scope.
export default defineConfig({
  testDir: "./e2e",
  // The onboarding spec submits the wizard, which calls the real Anthropic
  // API server-side (route.ts's maxDuration is 60s) -- give the client-side
  // wait real headroom above the 30s default instead of racing that call.
  timeout: 90_000,
  // These are live browser tests against one shared Supabase project. Every
  // fresh context becomes an anonymous user through proxy.ts; running every
  // spec at once regularly exceeds that project's anonymous-auth rate limit
  // and turns unrelated UI assertions into 401/empty-state flakes. Keep CI
  // deliberately serial so each test gets a real authenticated session.
  fullyParallel: false,
  workers: process.env.CI ? 1 : undefined,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  // "github" alone writes nothing to disk -- CI's own "Upload Playwright
  // report on failure" step has been uploading an empty directory this
  // whole time (silently: actions/upload-artifact only warns, doesn't fail
  // the job), so every past CI failure investigation had no trace/video/
  // screenshot to look at, only the text assertion error. Add "html" so a
  // real report (with embedded traces) actually lands in playwright-report/.
  reporter: process.env.CI ? [["github"], ["html", { open: "never" }]] : "list",
  use: {
    baseURL,
    trace: "on-first-retry",
    // Belt-and-suspenders alongside the trace: a screenshot and video are
    // readable at a glance without opening the trace viewer, useful for a
    // quick first look at what was actually on screen when a CI-only
    // failure happened that hasn't reproduced locally.
    screenshot: "only-on-failure",
    video: "retain-on-failure",
  },
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"] } },
  ],
  webServer: process.env.PLAYWRIGHT_BASE_URL ? undefined : {
    // A production build, not `next dev`: Turbopack dev mode compiles routes
    // lazily on first hit, and that compile can race the test's first
    // interaction on a cold server (observed: a filled field reads back
    // empty because the route remounted mid-compile). Building first also
    // means this test exercises the same artifact the `web-build` CI job
    // already produces.
    command: "npm run build && npm run start",
    url: baseURL,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});
