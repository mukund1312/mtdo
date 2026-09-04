import { createBrowserClient } from "@supabase/ssr";

// Browser-side Supabase client. Anonymous auth (docs/architecture/schema.md
// §6) is initiated from a call site that needs a session, not here — this
// file only constructs the client.
//
// Sessions and ledger events are NOT written through .from(...).insert() —
// those tables are select-only to clients by design. Use the RPCs listed in
// docs/architecture/api.md §3 (start_session, complete_session,
// abandon_session, record_event, tutor_context).
export function createClient() {
  return createBrowserClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
  );
}
