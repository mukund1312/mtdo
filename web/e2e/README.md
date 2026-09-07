# E2E tests (Playwright)

Real browser, real production build (`playwright.config.ts` runs `npm run
build && npm run start` and waits for it) -- not a component test, not a
mocked fetch.

For local browser verification against an already-running server, set
`PLAYWRIGHT_BASE_URL` (for example,
`PLAYWRIGHT_BASE_URL=http://localhost:3000 npx playwright test`). This skips
the test runner's managed production server only; CI retains the production-build path above.

## Scope

`onboarding.spec.ts` drives the Signal Deck onboarding wizard
(`/architecture-02/onboarding`) through the full happy path: intent -> rhythm
-> submit -> a persisted plan is ready -> "Enter Today" -> a curriculum item
is picked into a real block -> that block moves to In progress.

The Review scenario uses a fresh anonymous user with no `daily_rollups` rows
and asserts the honest empty heatmap plus a view-only Record Card. It does not
seed activity or fabricate progress data.

Submitting calls the real `POST /api/onboarding/plan`, which needs an
authenticated Supabase session (anonymous sign-in, via `proxy.ts`) and calls
the real Anthropic API server-side. Both are live requirements of this test,
not mocked:

- Anonymous sign-in was disabled on the connected Supabase project until it
  was fixed (mtdo-bugs#95, closed) -- before that, this test could only cover
  the client-only steps up to the "Build my route" button.
- If the Anthropic call itself fails or times out, `route.ts`'s own failure
  contract falls back to a static plan and still returns a usable "done"
  event -- the test asserts on "a plan became ready", not on which path
  produced it, so it stays green either way.
