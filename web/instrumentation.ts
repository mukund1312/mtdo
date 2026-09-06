// Server-side Sentry init (Next.js instrumentation convention -- see
// node_modules/next/dist/docs/01-app/02-guides/instrumentation.md).
// Client-side init lives in instrumentation-client.ts, a separate Next.js
// convention that runs before hydration; the two files are not related by
// import, each is auto-detected independently.
//
// No NEXT_PUBLIC_SENTRY_DSN in the environment means Sentry stays off --
// this must never throw or block server startup on a missing key (M's own
// failure contract: an unconfigured integration degrades silently, it never
// blocks the app).
import type * as SentryNextjs from "@sentry/nextjs";

export async function register() {
  if (!process.env.NEXT_PUBLIC_SENTRY_DSN) return;

  if (process.env.NEXT_RUNTIME === "nodejs") {
    const Sentry = await import("@sentry/nextjs");
    Sentry.init({
      dsn: process.env.NEXT_PUBLIC_SENTRY_DSN,
      tracesSampleRate: 0.1,
    });
  }

  if (process.env.NEXT_RUNTIME === "edge") {
    const Sentry = await import("@sentry/nextjs");
    Sentry.init({
      dsn: process.env.NEXT_PUBLIC_SENTRY_DSN,
      tracesSampleRate: 0.1,
    });
  }
}

// Required by @sentry/nextjs to attribute server-side errors (thrown in a
// Route Handler, Server Component, etc.) that Next.js's own error handling
// would otherwise swallow without reporting.
export const onRequestError = async (
  ...args: Parameters<typeof SentryNextjs.captureRequestError>
) => {
  if (!process.env.NEXT_PUBLIC_SENTRY_DSN) return;
  const Sentry = await import("@sentry/nextjs");
  Sentry.captureRequestError(...args);
};
