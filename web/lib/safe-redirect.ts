// Shared by every route that redirects to a caller-supplied `next` path
// after an auth-adjacent round trip (app/auth/callback, api/calendar/connect
// + callback). Extracted here because Next's route-export validation means a
// route.ts file cannot export a stray helper alongside GET/POST -- the same
// reason lib/calendar/config.ts holds OAUTH_STATE_COOKIE instead of the route
// file that uses it.

/**
 * `rawNext` is caller-supplied (round-tripped through an OAuth provider), so
 * it must never be trusted as a ready-to-use redirect target -- an
 * unvalidated `next` turns this into an open redirect (e.g. `next=@evil.com`
 * string-concatenated onto `origin` parses as `http://<origin>@evil.com`, a
 * userinfo@host trick a browser will happily follow to evil.com right after a
 * legitimate auth exchange). Resolving it against `origin` and checking the
 * result actually stays on this origin closes that off; the redirect always
 * goes through the resolved URL object, never raw string concatenation.
 */
export function safeNextPath(rawNext: string | null, origin: string): string {
  if (!rawNext) return "/";
  try {
    const resolved = new URL(rawNext, origin);
    if (resolved.origin !== origin) return "/";
    return `${resolved.pathname}${resolved.search}${resolved.hash}`;
  } catch {
    return "/";
  }
}
