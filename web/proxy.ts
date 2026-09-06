import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";

// Refreshes the Supabase session on every request, and signs in anonymously
// on first visit (docs/architecture/decisions.md: "Supabase anonymous auth
// from first visit, upgraded in place"). Every activity_events row needs a
// real user_id from event #1 — this is where that identity is created.
export async function proxy(request: NextRequest) {
  let response = NextResponse.next({ request });

  // A local UI prototype should still be viewable before a developer connects
  // a Supabase project. Once the public credentials exist, the normal
  // anonymous-auth/session-refresh path below remains mandatory.
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!supabaseUrl || !supabaseAnonKey) {
    return response;
  }

  const supabase = createServerClient(
    supabaseUrl,
    supabaseAnonKey,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(cookiesToSet) {
          cookiesToSet.forEach(({ name, value }) =>
            request.cookies.set(name, value),
          );
          response = NextResponse.next({ request });
          cookiesToSet.forEach(({ name, value, options }) =>
            response.cookies.set(name, value, options),
          );
        },
      },
    },
  );

  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    // First visit: create the anonymous identity now, not at signup, so the
    // ledger never has a pre-signup gap. The matching `profiles` row is
    // created by an `after insert on auth.users` trigger (schema.md §6) —
    // don't insert one from here.
    await supabase.auth.signInAnonymously();
  }

  return response;
}

export const config = {
  matcher: [
    // Run on everything except static assets and Next.js internals.
    "/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)",
  ],
};
