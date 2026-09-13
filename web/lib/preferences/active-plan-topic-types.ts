// The distinct topic types the current user's active plan's categories
// actually use -- what Settings' soundtrack-mapping section offers, so it
// never shows a type (e.g. "System design") the user's own route has no
// category for. Plain client query, not a new RPC: this is a simple
// owned-row read already covered by plan_categories' existing RLS, the same
// posture today-deck.tsx's own active-plan lookup already has.
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/database.types";

export type ActiveTopicTypesResult =
  | { ok: true; topicTypes: string[] }
  // Distinct from an empty topicTypes list: this means there is no active
  // plan at all, not "a plan with zero typed categories" -- the caller
  // renders a different honest-empty message for each.
  | { ok: true; topicTypes: []; noActivePlan: true }
  | { ok: false; message: string };

export async function listActiveTopicTypes(supabase: SupabaseClient<Database>): Promise<ActiveTopicTypesResult> {
  const {
    data: { user },
    error: userError,
  } = await supabase.auth.getUser();
  if (userError || !user) {
    return { ok: false, message: "No authenticated session." };
  }

  const { data: activePlan, error: planError } = await supabase
    .from("plans")
    .select("id")
    .eq("user_id", user.id)
    .eq("is_active", true)
    .maybeSingle();
  if (planError) {
    console.error("[active-plan-topic-types] failed to load the active route:", planError);
    return { ok: false, message: "Couldn't check your active route." };
  }
  if (!activePlan) {
    return { ok: true, topicTypes: [], noActivePlan: true };
  }

  const { data: categories, error: categoriesError } = await supabase
    .from("plan_categories")
    .select("topic_type")
    .eq("plan_id", activePlan.id)
    .not("topic_type", "is", null);
  if (categoriesError) {
    console.error("[active-plan-topic-types] failed to load categories:", categoriesError);
    return { ok: false, message: "Couldn't load your route's categories." };
  }

  // `not(topic_type, is, null)` already filters nulls, but the generated
  // type still carries `string | null` -- narrow explicitly rather than
  // asserting, and de-dupe (a plan can have several categories sharing one
  // topic type, e.g. two DSA categories).
  const topicTypes = [...new Set(categories.map((row) => row.topic_type).filter((value): value is string => value !== null))];
  return { ok: true, topicTypes };
}
