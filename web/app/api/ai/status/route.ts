// AI provider status (docs/architecture/api.md §2, Phase 2 of the
// operating-engine plan): what the server-env-driven selection in
// lib/ai/service.ts actually resolved to right now, whether it's reachable,
// and which models it has -- backs Settings -> AI. Read-only: this route
// does not accept a body or change anything, it just reports the same
// decision generateGoalPlan() would make for the next call.
//
// Requires an authenticated session, same as onboarding/plan -- there is no
// per-user data in the response today (selection is env-driven, not yet
// read from ai_provider_settings), but this stays auth-gated rather than
// public so it doesn't become the one open route that leaks which local
// model a self-hoster has installed to an unauthenticated caller.
import { createClient } from "@/lib/supabase/server";
import { resolveProvider } from "@/lib/ai/service";

export async function GET() {
  const supabase = await createClient();
  const {
    data: { user },
    error: userError,
  } = await supabase.auth.getUser();
  if (userError || !user) {
    return Response.json({ error: "No authenticated session." }, { status: 401 });
  }

  const provider = await resolveProvider();
  const [reachable, models] = await Promise.all([provider.healthCheck(), provider.listModels()]);

  return Response.json(
    { models, provider: provider.id, reachable },
    { headers: { "Cache-Control": "no-store" } },
  );
}
