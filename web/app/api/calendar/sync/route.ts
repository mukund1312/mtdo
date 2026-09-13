// One-way calendar sync, MTDO -> Google (Phase 6; docs/architecture/api.md
// §3e). Per-block opt-in: the client calls this with `enabled: true` to mirror
// a scheduled block onto the user's calendar, and `enabled: false` to remove
// it again.
//
// There is no blocks.calendar_sync_enabled column, deliberately -- a block is
// synced iff a calendar_event_links row exists for it, the same way "picked"
// means "a block exists with this curriculum_item_id" (decisions.md
// 2026-09-07). A second mutable copy of "is this on the calendar" can disagree
// with the calendar, and that failure is invisible.
//
// ONE-WAY. Nothing here reads Google's copy back: an edit made on Google's
// side is overwritten by the next sync of that block, and MTDO stays the
// source of truth. AI may only ever *suggest* a slot -- this route is reached
// by an explicit user action carrying an explicit block id, which is what
// keeps an unattended job from creating events structurally rather than by
// policy.
//
// Contract:
//   POST { blockId: string, enabled: boolean }
//   200 { synced: true,  eventId, calendarId } -- created or updated
//   200 { synced: false }                      -- removed, or already absent
//   400 malformed body, or enabled:true for a block with no schedule
//   401 no session
//   404 the block isn't the caller's (or doesn't exist -- not distinguished)
//   409 { connected: false } -- Google Calendar isn't connected for this user
//   502 Google rejected the call
//   503 { configured: false, missing } -- not configured on this server
//
// Nothing here blocks the core loop: schedule_block() (migrations/0019) sets a
// block's date and time with no reference to any of this, and a user who never
// connects a calendar never touches this route.
import { createClient } from "@/lib/supabase/server";
import { createServiceClient } from "@/lib/supabase/service";
import { resolveCalendarConfig } from "@/lib/calendar/config";
import { CALENDAR_PROVIDER, acquireAccessToken } from "@/lib/calendar/connection";
import { GoogleCalendarError, createEvent, deleteEvent, updateEvent } from "@/lib/calendar/google";
import { fetchProfileTimezone } from "@/app/(marketing)/architecture-02/profile-timezone";

type SyncRequest = { blockId: string; enabled: boolean };

function parseBody(body: unknown): SyncRequest | null {
  if (!body || typeof body !== "object") return null;
  const { blockId, enabled } = body as Record<string, unknown>;
  if (typeof blockId !== "string" || blockId.length === 0) return null;
  if (typeof enabled !== "boolean") return null;
  return { blockId, enabled };
}

export async function POST(request: Request) {
  const resolved = resolveCalendarConfig(new URL(request.url).origin);
  // There is no sync work to authorize when Calendar is unavailable. Return
  // the documented 503 consistently while an anonymous session is still
  // propagating, rather than turning an optional integration into a 401.
  if (!resolved.configured) {
    return Response.json(
      { configured: false, error: "Google Calendar isn't configured on this server.", missing: resolved.missing },
      { status: 503 },
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

  const parsed = parseBody(await request.json().catch(() => null));
  if (!parsed) {
    return Response.json({ error: "Expected { blockId: string, enabled: boolean }." }, { status: 400 });
  }

  const service = createServiceClient();
  if (!service) {
    return Response.json(
      { configured: false, error: "Google Calendar isn't configured on this server.", missing: ["SUPABASE_SERVICE_ROLE_KEY"] },
      { status: 503 },
    );
  }

  // Read the block through the USER's own RLS-scoped client, not the service
  // client -- that is what proves the caller owns this block, and it is the
  // reason no user_id from the request body is ever trusted below.
  const { data: block, error: blockError } = await supabase
    .from("blocks")
    .select("id, text, notes, scheduled_start_at, scheduled_end_at")
    .eq("id", parsed.blockId)
    .maybeSingle();
  if (blockError) {
    return Response.json({ error: blockError.message }, { status: 500 });
  }
  if (!block) {
    return Response.json({ error: "That task isn't available." }, { status: 404 });
  }

  const { data: existingLink, error: linkError } = await service
    .from("calendar_event_links")
    .select("external_event_id, external_calendar_id")
    .eq("user_id", user.id)
    .eq("block_id", block.id)
    .eq("provider", CALENDAR_PROVIDER)
    .maybeSingle();
  if (linkError) {
    console.error("[calendar/sync] failed to read the existing link:", linkError);
    return Response.json({ error: "Couldn't read this task's calendar link." }, { status: 500 });
  }

  // Nothing to remove, so nothing to ask Google for. This branch is what
  // makes the documented "safe to call unconditionally" promise actually
  // true: the client fires `enabled: false` alongside every un-schedule, and
  // a user who has never connected a calendar -- or who just disconnected,
  // which already deleted their links -- must get a clean no-op here rather
  // than a 409 telling them to connect a calendar they don't want.
  if (!parsed.enabled && !existingLink) {
    return Response.json({ synced: false });
  }

  // Checked before spending a token round trip, and before any Google call:
  // the fix is entirely local (schedule_block()), so there is no reason to
  // involve Google to discover it. Destructured into locals rather than
  // re-read later so the narrowing survives into the sync branch below --
  // `block.scheduled_start_at` alone doesn't, because this guard is also
  // conditioned on `parsed.enabled`.
  const { scheduled_end_at: endAt, scheduled_start_at: startAt } = block;
  if (parsed.enabled && (!startAt || !endAt)) {
    // Scheduling is the prerequisite, and it is a separate, purely local
    // action. Saying so plainly beats inventing a default hour for a task
    // the user never put on a clock.
    return Response.json(
      { error: "Give this task a date and time before adding it to your calendar." },
      { status: 400 },
    );
  }

  const connection = await acquireAccessToken(service, user.id, resolved.config).catch((err: unknown) => {
    console.error("[calendar/sync] couldn't acquire an access token:", err);
    return undefined;
  });
  if (connection === undefined) {
    return Response.json({ error: "Couldn't reach Google Calendar. Reconnect and try again." }, { status: 502 });
  }
  if (connection === null) {
    return Response.json({ connected: false, error: "Google Calendar isn't connected." }, { status: 409 });
  }

  try {
    // ---- unsync -----------------------------------------------------------
    if (!parsed.enabled) {
      // existingLink is non-null here -- the no-link case returned above.
      // Deleting the Google event FIRST, then the row: if the row went first
      // and the API call then failed, the event would be orphaned with
      // nothing left pointing at it. This order can leave a stale row
      // instead, which a retry cleans up (deleteEvent treats 404/410 as
      // success, so the retry is safe).
      await deleteEvent(connection.accessToken, existingLink!.external_calendar_id, existingLink!.external_event_id);
      const { error } = await service
        .from("calendar_event_links")
        .delete()
        .eq("user_id", user.id)
        .eq("block_id", block.id)
        .eq("provider", CALENDAR_PROVIDER);
      if (error) throw error;
      return Response.json({ synced: false });
    }

    // ---- sync -------------------------------------------------------------
    const timeZone = await fetchProfileTimezone(supabase, user.id);
    const event = {
      description: block.notes ?? undefined,
      endAt: endAt!,
      startAt: startAt!,
      summary: block.text,
      timeZone,
    };

    if (existingLink) {
      // Idempotent by construction: calendar_event_links' unique
      // (block_id, provider) means a re-sync can only ever update the one
      // event this block already owns, never fan out duplicates.
      await updateEvent(
        connection.accessToken,
        existingLink.external_calendar_id,
        existingLink.external_event_id,
        event,
      );
      const { error } = await service
        .from("calendar_event_links")
        .update({ synced_at: new Date().toISOString() })
        .eq("user_id", user.id)
        .eq("block_id", block.id)
        .eq("provider", CALENDAR_PROVIDER);
      if (error) throw error;
      return Response.json({
        calendarId: existingLink.external_calendar_id,
        eventId: existingLink.external_event_id,
        synced: true,
      });
    }

    const eventId = await createEvent(connection.accessToken, connection.calendarId, event);
    const { error } = await service.from("calendar_event_links").insert({
      block_id: block.id,
      external_calendar_id: connection.calendarId,
      external_event_id: eventId,
      provider: CALENDAR_PROVIDER,
      user_id: user.id,
    });
    if (error) throw error;
    return Response.json({ calendarId: connection.calendarId, eventId, synced: true });
  } catch (err) {
    if (err instanceof GoogleCalendarError) {
      console.error("[calendar/sync] Google Calendar rejected the call:", err);
      return Response.json({ error: "Google Calendar rejected that change. Try again shortly." }, { status: 502 });
    }
    console.error("[calendar/sync] sync failed:", err);
    return Response.json({ error: "Couldn't update your calendar. Try again." }, { status: 500 });
  }
}
