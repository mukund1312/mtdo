import type { SupabaseClient } from "@supabase/supabase-js";

// Insert path for the feedback widget (docs/architecture/schema.md's
// `feedback` table, added in supabase/migrations/0003_feedback.sql).
//
// `feedback` is an ordinary client-writable table under RLS (like
// notes/companies), not a security-definer-RPC table like focus_sessions or
// activity_events — nothing downstream depends on it being unforgeable, and
// RLS's `with check ((select auth.uid()) = user_id)` already prevents a user
// from attributing a row to anyone else. So this is a plain `.insert()`, not
// a Route Handler or RPC: no secret is involved, and the anon-key client
// (browser or server, either works) enforces ownership on its own.
//
// Deliberately takes an already-constructed SupabaseClient rather than
// constructing one itself, so the same helper works from a Client Component
// (lib/supabase/client.ts) or a Server Component/Route Handler
// (lib/supabase/server.ts) — callers pick whichever client fits where the
// widget lives.
export interface SubmitFeedbackInput {
  /** Route/screen identifier the widget was opened from, e.g.
   *  `window.location.pathname` or a neutral screen key the caller already
   *  has in hand. Free text — see the column comment in the migration. */
  screen: string;
  /** The feedback text itself. Trimmed before sending; the DB also rejects
   *  blank or >4KB messages (feedback_message_not_blank /
   *  feedback_message_bounded), but failing fast client-side avoids a round
   *  trip for the common "empty textarea" case. */
  message: string;
}

export class SubmitFeedbackError extends Error {}

export async function submitFeedback(
  supabase: SupabaseClient,
  input: SubmitFeedbackInput,
): Promise<void> {
  const screen = input.screen.trim();
  const message = input.message.trim();

  if (!screen) {
    throw new SubmitFeedbackError("screen must not be blank");
  }
  if (!message) {
    throw new SubmitFeedbackError("message must not be blank");
  }
  if (new TextEncoder().encode(message).length > 4096) {
    throw new SubmitFeedbackError("message exceeds 4096 bytes");
  }

  const {
    data: { user },
    error: userError,
  } = await supabase.auth.getUser();

  if (userError || !user) {
    throw new SubmitFeedbackError("submitFeedback: no authenticated user");
  }

  // user_id is sent explicitly (RLS's `with check` is what actually enforces
  // it can only ever be the caller's own id — this is not the RPC pattern
  // where the server derives it and the client never supplies it at all).
  const { error } = await supabase
    .from("feedback")
    .insert({ user_id: user.id, screen, message });

  if (error) {
    throw new SubmitFeedbackError(`submitFeedback: ${error.message}`);
  }
}
