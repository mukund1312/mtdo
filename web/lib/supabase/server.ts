import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";

// Server Component / Route Handler Supabase client. RLS *and table grants*
// (docs/architecture/schema.md §6) do the real access control — this client
// just carries the user's session via cookies so `auth.uid()` resolves
// correctly in Postgres.
//
// Note this is the anon-key client, so it is subject to both. Writes to
// focus_sessions, activity_events, daily_rollups and tutor_messages are
// revoked from `authenticated` and go through RPCs instead — see
// docs/architecture/api.md §3. A Route Handler that legitimately needs to
// bypass that (the W3b tutor backend) must build a separate service-role
// client; do not add the service key here.
export async function createClient() {
  const cookieStore = await cookies();

  return createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return cookieStore.getAll();
        },
        setAll(cookiesToSet) {
          try {
            cookiesToSet.forEach(({ name, value, options }) =>
              cookieStore.set(name, value, options),
            );
          } catch {
            // Called from a Server Component that can't set cookies (no
            // active response) — safe to ignore as long as the proxy also
            // refreshes the session, which it does (see proxy.ts).
          }
        },
      },
    },
  );
}
