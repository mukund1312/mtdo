import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";

// Server Component / Route Handler Supabase client. RLS (docs/architecture
// schema.md §5) does the real access control — this client just carries the
// user's session via cookies so `auth.uid()` resolves correctly in Postgres.
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
