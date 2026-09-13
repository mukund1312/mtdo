// Google Calendar status (Phase 6; docs/architecture/api.md §3e). The direct
// analogue of GET /api/ai/status: it reports what the server-env-driven
// configuration actually resolves to right now, and whether this user has a
// live connection -- it never fakes a success.
//
// Real GOOGLE_CLIENT_ID/GOOGLE_CLIENT_SECRET do not exist in this environment
// yet, so `configured: false` is the response this route genuinely returns
// today, and `missing` names exactly which variables are absent rather than
// leaving an operator to guess. Nothing in the core loop depends on this
// coming back true: schedule_block() (migrations/0019) works whether or not a
// calendar is connected.
//
// Once configured, this is auth-gated: connection state belongs to the user.
// The unconfigured response is intentionally public so an optional
// integration can explain itself while first-visit anonymous auth settles.
import { createClient } from "@/lib/supabase/server";
import { createServiceClient } from "@/lib/supabase/service";
import { resolveCalendarConfig } from "@/lib/calendar/config";
import { readConnectionSummary } from "@/lib/calendar/connection";

export async function GET(request: Request) {
  const noStore = { headers: { "Cache-Control": "no-store" } };
  const resolved = resolveCalendarConfig(new URL(request.url).origin);
  // An unavailable integration is a server capability, not account data.
  // Report that honest no-op state before looking up a user so Settings and
  // the calendar UI can degrade cleanly while anonymous auth is still being
  // established on a first visit.
  if (!resolved.configured) {
    return Response.json(
      { configured: false, connected: false, connection: null, missing: resolved.missing, provider: "google" },
      noStore,
    );
  }

  const supabase = await createClient();
  const {
    data: { user },
    error: userError,
  } = await supabase.auth.getUser();
  if (userError || !user) {
    return Response.json({ error: "No authenticated session." }, { status: 401 });
  }

  const service = createServiceClient();
  if (!service) {
    // Unreachable in practice -- resolveCalendarConfig() already lists
    // SUPABASE_SERVICE_ROLE_KEY in `missing` -- but reported as unconfigured
    // rather than thrown, so a future change to either check can't turn this
    // into a 500 on the settings screen.
    return Response.json(
      { configured: false, connected: false, connection: null, missing: ["SUPABASE_SERVICE_ROLE_KEY"], provider: "google" },
      noStore,
    );
  }

  let connection = null;
  try {
    connection = await readConnectionSummary(service, user.id);
  } catch (err) {
    console.error("[calendar/status] failed to read the connection:", err);
    return Response.json({ error: "Couldn't read the calendar connection." }, { status: 500 });
  }

  return Response.json(
    { configured: true, connected: connection !== null, connection, missing: [], provider: "google" },
    noStore,
  );
}
