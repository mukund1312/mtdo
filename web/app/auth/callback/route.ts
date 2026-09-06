import { NextResponse, type NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { syncIsAnonymousFlag } from "@/lib/auth/upgradeAccount";

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
  const next = searchParams.get("next") ?? "/";

  if (code) {
    const supabase = await createClient();
    const { error } = await supabase.auth.exchangeCodeForSession(code);
    if (!error) {
      await syncIsAnonymousFlag(supabase);
      return NextResponse.redirect(`${origin}${next}`);
    }
  }

  return NextResponse.redirect(`${origin}/?upgrade_error=1`);
}
