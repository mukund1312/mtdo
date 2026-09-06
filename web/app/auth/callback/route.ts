import { NextResponse, type NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { syncIsAnonymousFlag } from "@/lib/auth/upgradeAccount";

// `next` is caller-supplied (round-tripped through the OAuth provider), so it
// must never be trusted as a ready-to-use redirect target -- an unvalidated
// `next` turns this into an open redirect (e.g. `next=@evil.com` string-
// concatenated onto `origin` parses as `http://<origin>@evil.com`, a
// userinfo@host trick a browser will happily follow to evil.com right after
// a legitimate auth exchange). Resolving it against `origin` and checking the
// result actually stays on this origin closes that off; the redirect always
// goes through the resolved URL object, never raw string concatenation.
function safeNextPath(rawNext: string | null, origin: string): string {
  if (!rawNext) return "/";
  try {
    const resolved = new URL(rawNext, origin);
    if (resolved.origin !== origin) return "/";
    return `${resolved.pathname}${resolved.search}${resolved.hash}`;
  } catch {
    return "/";
  }
}

// Lands here after upgradeWithOAuth()'s linkIdentity() redirect completes
// (lib/auth/upgradeAccount.ts). Exchanges the auth code for the session --
// same auth.uid(), now with the OAuth identity attached -- and mirrors the
// resulting is_anonymous state onto profiles the same way the email/password
// path does, so both upgrade paths leave that column consistent.
export async function GET(request: NextRequest) {
  const { searchParams, origin } = new URL(request.url);
  const code = searchParams.get("code");
  // Where the trigger UI wants the user back; defaults to home. Set via
  // upgradeWithOAuth's redirectTo (?next=<path> appended by the caller).
  const next = safeNextPath(searchParams.get("next"), origin);

  if (code) {
    const supabase = await createClient();
    const { error } = await supabase.auth.exchangeCodeForSession(code);
    if (!error) {
      await syncIsAnonymousFlag(supabase);
      return NextResponse.redirect(new URL(next, origin));
    }
  }

  return NextResponse.redirect(new URL("/?upgrade_error=1", origin));
}
