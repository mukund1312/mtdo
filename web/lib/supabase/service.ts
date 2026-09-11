// Service-role Supabase client. This is the "separate service-role client"
// server.ts's own comment reserves for a Route Handler that legitimately has
// to bypass RLS and table grants -- built for the first time here, by Phase
// 6's calendar routes, which write calendar_connections (a table no client
// role can touch at all, migrations/0020).
//
// THREE RULES, in order of how badly each one bites:
//   1. Never import this from a Client Component, a Server Component that
//      renders user-controlled content, or anything under app/(marketing)/**.
//      Route Handlers only. SUPABASE_SERVICE_ROLE_KEY has no NEXT_PUBLIC_
//      prefix precisely so Next cannot inline it into a client bundle, but
//      that is a guard against accident, not a substitute for this rule.
//   2. This client carries NO user session, so auth.uid() is null and RLS
//      does not apply. Every query made through it must scope itself by
//      user_id explicitly, using an id the caller proved with the *anon*
//      client's getUser(). Forgetting that turns a row filter into a
//      full-table read.
//   3. It returns null rather than throwing when the key is absent, so a
//      deployment without one degrades to a clean "not configured" instead of
//      a 500 -- the same posture lib/ai/service.ts takes for a missing
//      provider (CLAUDE.md's "never block the core loop on an external call").
import { createClient as createSupabaseClient, type SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "./database.types";

export type ServiceClient = SupabaseClient<Database>;

export function createServiceClient(): ServiceClient | null {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !serviceRoleKey) return null;

  return createSupabaseClient<Database>(url, serviceRoleKey, {
    auth: {
      // No session to persist or refresh -- this client is a machine
      // identity, not a logged-in user, and leaving these on would have it
      // writing to whatever storage adapter it could find on the server.
      autoRefreshToken: false,
      persistSession: false,
    },
  });
}
