-- mtdo web -- feedback widget (docs/architecture/schema.md §2 conventions)
-- Small, contained addition per the web plan's instrumentation section: a
-- lightweight "leave feedback from wherever you are" widget. Captures the
-- submitting user and the screen/route they were on when they submitted.
--
-- This table needs NO security-definer RPC. Unlike activity_events/
-- focus_sessions, nothing downstream (rank, rollups, the tutor cap) depends on
-- feedback being unforgeable -- a user can only ever attribute a row to
-- themselves (RLS/`with check` enforces that, same as notes/companies), and
-- there is no incentive to lie about which screen you were on. So this follows
-- the ordinary client-writable-table pattern (api.md §2a's "these tables don't
-- need one"), not the ledger/session pattern.
--
-- No UPDATE/DELETE policy, deliberately: a submitted feedback item is a
-- point-in-time fact ("here's what I saw/thought on this screen"), not a
-- record a user should be able to edit or retract after the fact -- mirrors
-- the plans/plan_categories "no DELETE" choice, for the same
-- don't-let-history-quietly-change reason, though the RESTRICT-vs-CASCADE
-- question there doesn't apply (nothing references feedback rows).

create table feedback (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  -- Route/screen identifier the widget was opened from, e.g. "/app/today" or
  -- a neutral screen key -- whatever the calling component already has in
  -- hand (window.location.pathname, or a route-group-derived constant). Free
  -- text, not an enum: unlike activity_events.kind, nothing branches on this
  -- value server-side, so a closed vocabulary would only add friction for no
  -- safety benefit.
  screen text not null,
  message text not null,
  created_at timestamptz not null default now(),

  constraint feedback_screen_not_blank check (length(btrim(screen)) > 0),
  constraint feedback_message_not_blank check (length(btrim(message)) > 0),
  -- Same reasoning as record_event's 4 KB payload cap (0001_seam.sql §4): this
  -- table has no DELETE path, so an unbounded message is permanent storage
  -- growth from a cheap, low-friction call. 4 KB is generous for feedback text.
  constraint feedback_message_bounded check (octet_length(message) <= 4096)
);

create index feedback_user_created_idx on feedback (user_id, created_at desc);

alter table feedback enable row level security;

-- Insert your own, read your own. No update/update policy -- see header.
create policy "feedback_select_own" on feedback
  for select to authenticated using ((select auth.uid()) = user_id);
create policy "feedback_insert_own" on feedback
  for insert to authenticated with check ((select auth.uid()) = user_id);

-- Structural, not incidental (schema.md §6 security model): Supabase's
-- default privileges already grant UPDATE/DELETE/TRUNCATE/REFERENCES/TRIGGER
-- on this table to anon/authenticated, so the absence of a matching policy is
-- only an incidental denial until these are revoked explicitly.
revoke update, delete, truncate, references, trigger on public.feedback
  from anon, authenticated;

-- Repeat of 0001_seam.sql §9 for this table specifically (the blanket
-- statement there only covers tables that already existed at that point).
-- Every future migration that adds a table to `public` should end this way.
revoke truncate, references, trigger on public.feedback from anon, authenticated;
