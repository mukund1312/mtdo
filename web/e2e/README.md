# E2E tests (Playwright)

Real browser, real dev server (`playwright.config.ts` boots `npm run dev` and
waits for it) -- not a component test, not a mocked fetch.

## Scope

`onboarding.spec.ts` drives the Signal Deck onboarding wizard
(`/architecture-02/onboarding`) through the **client-only** steps: intent ->
rhythm -> the route is ready to build. It stops short of clicking "Build my
route".

That's deliberate, not an oversight: clicking it calls `POST
/api/onboarding/plan`, which requires an authenticated Supabase session.
Anonymous sign-in is currently disabled on the connected Supabase project
(tracked in mtdo-bugs#95 -- `proxy.ts`'s `signInAnonymously()` fails there and
the 401 propagates to the client). Driving past that point today would make
this test flaky against real project config rather than against the code
under test. Once #95 is resolved, extend this spec to submit the form and
assert on the "Route Ready" step + the persisted plan.
