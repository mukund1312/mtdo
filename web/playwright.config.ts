import { defineConfig, devices } from "@playwright/test";

// Real end-to-end tests -- an actual browser driving the actual dev server,
// not a component or unit test. See e2e/README.md for what's in/out of
// scope while onboarding's plan-generation step is blocked (gh95).
export default defineConfig({
  testDir: "./e2e",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  reporter: process.env.CI ? "github" : "list",
  use: {
    baseURL: "http://localhost:3000",
    trace: "on-first-retry",
  },
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"] } },
  ],
  webServer: {
    // A production build, not `next dev`: Turbopack dev mode compiles routes
    // lazily on first hit, and that compile can race the test's first
    // interaction on a cold server (observed: a filled field reads back
    // empty because the route remounted mid-compile). Building first also
    // means this test exercises the same artifact the `web-build` CI job
    // already produces.
    command: "npm run build && npm run start",
    url: "http://localhost:3000",
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});
