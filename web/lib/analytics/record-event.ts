// Thin wrapper around the record_event() RPC (schema.md §4, api.md §3).
// Exists to give call sites a typed `kind` union instead of stringly-calling
// `.rpc('record_event', ...)` ad hoc, and to centralize the one rule that
// matters here: only client-appendable kinds belong in this union.
//
// Deliberately excluded from ClientEventKind (server-minted, rejected with
// 22023 if a client calls record_event with them -- the session RPCs, the
// check-in RPCs (migrations/0035), and the future W3b tutor backend already
// emit these themselves): session_started, session_completed,
// session_abandoned, session_paused, session_resumed, session_extended,
// tutor_message_sent, task_* (migrations/0033), plan_target_changed,
// category_target_changed (migrations/0034), session_check_in_offered,
// session_check_in_answered, session_check_in_declined (migrations/0035).
//
// Included but not yet wired to any call site (no screen exists yet to emit
// them -- see docs/architecture/api.md §2c for the tracking note): signup,
// task_completed, task_regressed, proof_submitted, note_created,
// paywall_viewed. They're kept in the union now so the type stays the single
// source of truth for "what record_event will accept," even before a caller
// exists.
import type { SupabaseClient } from "@supabase/supabase-js";

export type ClientEventKind =
  | "signup"
  | "goal_created"
  | "plan_generated"
  | "task_completed"
  | "task_regressed"
  | "proof_submitted"
  | "note_created"
  | "screen_opened"
  | "focus_mode_toggled"
  | "paywall_viewed"
  // migrations/0035 -- raw tab-visibility observation. See schema.md §4 and
  // api.md §3r for the framing rule: not focus time, not "distraction", not
  // consumed by any metric.
  | "session_visibility_changed";

/**
 * Calls the record_event() RPC. Payload must stay a plain JSON object under
 * 4KB (enforced server-side; this does not re-validate size). Never pass
 * user_id/occurred_at -- the RPC derives both from auth.uid()/now().
 *
 * `clientEventId` (migrations/0035) is an optional idempotency key -- pass a
 * `crypto.randomUUID()` generated once per logical event (not once per HTTP
 * attempt) so a retry replays the SAME id and the ledger inserts exactly one
 * row (see activity_events.client_event_id's own comment). Omit it for a
 * plain one-shot event with no retry concern, which is every existing call
 * site as of this migration.
 *
 * Errors are swallowed to a console.error rather than thrown: instrumentation
 * must never break the feature it's attached to (the same "never block the
 * core loop" contract CLAUDE.md states for the AI coaching path). Callers
 * that need to know whether the event landed can inspect the return value.
 */
export async function recordEvent(
  supabase: SupabaseClient,
  kind: ClientEventKind,
  payload: Record<string, unknown> = {},
  clientEventId?: string,
): Promise<boolean> {
  // try/catch around the call itself, not just the Postgrest {error} return:
  // a network-level failure (offline, DNS, timeout) makes the RPC promise
  // reject, not resolve-with-error -- every call site uses `void
  // recordEvent(...)` with no `.catch()`, so an uncaught rejection here would
  // become an unhandled promise rejection, contradicting the "errors are
  // swallowed, instrumentation never breaks the feature" contract below.
  try {
    const { error } = await supabase.rpc("record_event", {
      p_kind: kind,
      p_payload: payload,
      ...(clientEventId ? { p_client_event_id: clientEventId } : {}),
    });
    if (error) {
      // Browser instrumentation is explicitly best-effort. A missing grant,
      // an expired/anonymous session, or a transient network failure must not
      // surface as a Next.js runtime error over the product UI. Server-side
      // callers still log the failure where it is actionable.
      if (typeof window === "undefined") {
        console.error(`[analytics] record_event(${kind}) failed:`, error);
      }
      return false;
    }
    return true;
  } catch (err) {
    if (typeof window === "undefined") {
      console.error(`[analytics] record_event(${kind}) threw:`, err);
    }
    return false;
  }
}
