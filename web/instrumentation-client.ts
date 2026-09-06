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
      // capture_pageview is on by default via a history-API patch;
      // mtdo already has its own explicit screen_opened ledger event
      // (schema.md §4, web/lib/analytics/record-event.ts) as the source of
      // truth for product analytics -- PostHog's autocapture stays purely
      // supplementary (funnels/heatmaps), not a duplicate event pipeline.
      capture_pageview: true,
      person_profiles: "identified_only",
    });
  });
}
