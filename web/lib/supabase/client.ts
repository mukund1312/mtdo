import { createBrowserClient } from "@supabase/ssr";

// Browser-side Supabase client. Anonymous auth (docs/architecture/schema.md
// §5) is initiated from a call site that needs a session, not here — this
// file only constructs the client.
export function createClient() {
  return createBrowserClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
  );
}
