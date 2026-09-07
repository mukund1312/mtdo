// Client-side observability init (Next.js instrumentation-client convention
// -- runs after the HTML loads, before hydration; see
// node_modules/next/dist/docs/01-app/03-api-reference/03-file-conventions/instrumentation-client.md).
// Deliberately not wired through app/layout.tsx: that file is single-owner
// (its own header comment) and neither Sentry nor PostHog needs a React
// provider -- both are plain side-effecting init calls, which is exactly
// what this file convention exists for.
//
// Both integrations are optional and degrade silently: an unset env var
// means the tool never initializes, never throws, and never blocks the app
// (M's failure contract -- an unconfigured integration is not a startup
// error). Local dev without these keys works exactly as it did before this
// file existed.
if (process.env.NEXT_PUBLIC_SENTRY_DSN) {
  void import("@sentry/nextjs").then((Sentry) => {
    Sentry.init({
      dsn: process.env.NEXT_PUBLIC_SENTRY_DSN,
      tracesSampleRate: 0.1,
    });
  });
}

if (process.env.NEXT_PUBLIC_POSTHOG_KEY) {
  void import("posthog-js").then(({ default: posthog }) => {
    posthog.init(process.env.NEXT_PUBLIC_POSTHOG_KEY!, {
      api_host: process.env.NEXT_PUBLIC_POSTHOG_HOST || "https://us.i.posthog.com",
      // capture_pageview:true alone was verified NOT to fire on first load
      // in this app (task #6: live-checked against the deployed site with
      // Playwright network interception -- posthog-js's own config.js
      // loaded and initialized cleanly, zero errors, but no event ever hit
      // api_host). This is a known rough edge of automatic pageview
      // detection under Next.js App Router client-side routing, not
      // specific to this app. capture_pageview:true is kept so a real
      // client-side route change (if the router's pushState is patched
      // successfully) still gets picked up; the explicit capture() below is
      // what guarantees the *first* pageview -- the one this file's own
      // execution timing (before hydration) is centered on -- is never
      // silently dropped. mtdo already has its own explicit screen_opened
      // ledger event (schema.md §4, web/lib/analytics/record-event.ts) as
      // the source of truth for product analytics; PostHog's autocapture
      // stays purely supplementary (funnels/heatmaps), not a duplicate
      // event pipeline.
      capture_pageview: true,
      person_profiles: "identified_only",
      // init() returns before the SDK has actually finished its own async
      // bootstrap (fetching remote config -- the /array/<key>/config.js
      // request observed during verification). A capture() call placed
      // right after the synchronous init() return was verified live to
      // still produce zero network requests; `loaded` is posthog-js's own
      // documented "the SDK is now actually ready" hook.
      loaded: (ph) => ph.capture("$pageview"),
    });
  });
}
