// Shared read of profiles.timezone (Phase 1: "wire profiles.timezone
// through utcToday(timezone) at both call sites" -- decisions.md's
// 2026-09-07 entry left this as the one explicitly open item once the
// backend half landed). One helper, three call sites (home-deck.tsx,
// today-deck.tsx, progress-deck.tsx) -- keeps the fallback identical
// everywhere rather than re-deriving it per screen.
import type { SupabaseClient } from "@supabase/supabase-js";

import type { Database } from "@/lib/supabase/database.types";

// Mirrors the coalesce(profiles.timezone, 'UTC') fallback already used
// server-side (recompute_daily_rollups()/pick_curriculum_item(),
// migrations 0013/0014): NULL is a real "never set a preference" state,
// not an error, and UTC is the documented fallback for it -- see
// profiles.timezone's own column comment for why the column is nullable
// with no default in the first place.
export async function fetchProfileTimezone(supabase: SupabaseClient<Database>, userId: string): Promise<string> {
  const { data, error } = await supabase.from("profiles").select("timezone").eq("id", userId).maybeSingle();
  if (error) {
    console.error("[profile-timezone] failed to read profiles.timezone, falling back to UTC:", error);
    return "UTC";
  }
  return data?.timezone ?? "UTC";
}
