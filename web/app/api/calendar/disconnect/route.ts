// Disconnect Google Calendar (Phase 6; docs/architecture/api.md §3e).
//
// Order matters and is the whole content of this route: the events MTDO
// created are deleted BEFORE the connection row is, because deleting the
// connection first destroys the only refresh token that could have deleted
// them -- leaving a pile of orphaned events on the user's real calendar with
// nothing left in this system able to reach them.
//
// Event deletion is best-effort and non-fatal: a user disconnecting wants to
// be disconnected, and refusing to revoke access because one stale event
// returned a 500 would be the wrong trade. Whatever couldn't be removed is
// reported in `orphanedEvents` rather than silently swallowed.
import { createClient } from "@/lib/supabase/server";
import { createServiceClient } from "@/lib/supabase/service";
import { resolveCalendarConfig } from "@/lib/calendar/config";
import { CALENDAR_PROVIDER, acquireAccessToken, deleteConnection } from "@/lib/calendar/connection";
import { deleteEvent } from "@/lib/calendar/google";

export async function POST(request: Request) {
  const supabase = await createClient();
  const {
    data: { user },
    error: userError,
  } = await supabase.auth.getUser();
  if (userError || !user) {
    return Response.json({ error: "No authenticated session." }, { status: 401 });
  }

  const resolved = resolveCalendarConfig(new URL(request.url).origin);
  const service = createServiceClient();
  if (!resolved.configured || !service) {
    return Response.json(
      {
        configured: false,
        error: "Google Calendar isn't configured on this server.",
        missing: resolved.configured ? ["SUPABASE_SERVICE_ROLE_KEY"] : resolved.missing,
      },
      { status: 503 },
    );
  }

  const { data: links, error: linksError } = await service
    .from("calendar_event_links")
    .select("block_id, external_event_id, external_calendar_id")
    .eq("user_id", user.id)
    .eq("provider", CALENDAR_PROVIDER);
  if (linksError) {
    console.error("[calendar/disconnect] failed to list links:", linksError);
    return Response.json({ error: "Couldn't read your calendar links." }, { status: 500 });
  }

  let orphanedEvents = 0;
  const connection = await acquireAccessToken(service, user.id, resolved.config).catch((err: unknown) => {
    // Already revoked on Google's side, or an unreadable stored token. Both
    // mean "no way to clean up remotely" -- carry on and disconnect locally,
    // which is what the user asked for.
    console.error("[calendar/disconnect] couldn't acquire an access token; disconnecting locally anyway:", err);
    return null;
  });

  if (connection) {
    for (const link of links ?? []) {
      try {
        await deleteEvent(connection.accessToken, link.external_calendar_id, link.external_event_id);
      } catch (err) {
        orphanedEvents += 1;
        console.error(`[calendar/disconnect] couldn't delete event ${link.external_event_id}:`, err);
      }
    }
  } else {
    orphanedEvents = (links ?? []).length;
  }

  // The link rows go regardless -- they describe a connection that is about
  // to stop existing, and keeping them would make a later reconnect try to
  // PATCH events under a different account's ids.
  const { error: deleteLinksError } = await service
    .from("calendar_event_links")
    .delete()
    .eq("user_id", user.id)
    .eq("provider", CALENDAR_PROVIDER);
  if (deleteLinksError) {
    console.error("[calendar/disconnect] failed to clear links:", deleteLinksError);
    return Response.json({ error: "Couldn't clear your calendar links." }, { status: 500 });
  }

  try {
    await deleteConnection(service, user.id);
  } catch (err) {
    console.error("[calendar/disconnect] failed to delete the connection:", err);
    return Response.json({ error: "Couldn't disconnect the calendar." }, { status: 500 });
  }

  return Response.json({ disconnected: true, orphanedEvents });
}
