-- Task-tied soundtracks (Spotify music control center, Phase 2, docs/designs
-- the plan lives outside the repo at ~/.claude/plans/adaptive-sleeping-turing.md).
--
-- Maps a per-user "topic type" (plan_categories.topic_type -- DSA / Backend /
-- Database / System design / null, a de-facto closed vocabulary the
-- manual-setup UI already offers, though not DB-enforced) to a Spotify
-- playlist the user picked in Settings. The Session screen reads this to
-- show a "Suggested soundtrack" card with a Play button -- never auto-play.
--
-- Deliberately keyed on topic_type, not plan_categories.id: topic_type is
-- the only cross-plan-category signal that survives a user editing their
-- plan setup, and it's already selected by the session screen's own block
-- query with no extra join.
--
-- Deliberately an ORDINARY client-writable table, not service-role-gated
-- like music_connections/calendar_connections: a chosen playlist id/name/uri
-- is a preference the user picked, not a credential. Same security posture
-- as blocks.notes (see calendar-deck.tsx's saveBlockNotes), not the OAuth
-- token tables.
create table soundtrack_preferences (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  topic_type text not null,
  spotify_playlist_id text not null,
  spotify_playlist_name text not null,
  spotify_playlist_uri text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- One mapping per topic type per user -- Settings' UI upserts on this pair
  -- rather than ever accumulating duplicate rows for the same type.
  constraint soundtrack_preferences_user_topic_key unique (user_id, topic_type)
);

alter table soundtrack_preferences enable row level security;

create policy "soundtrack_preferences_select_own" on soundtrack_preferences
  for select to authenticated using ((select auth.uid()) = user_id);
create policy "soundtrack_preferences_insert_own" on soundtrack_preferences
  for insert to authenticated with check ((select auth.uid()) = user_id);
create policy "soundtrack_preferences_update_own" on soundtrack_preferences
  for update to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);
-- DELETE is allowed here, unlike plans/plan_categories' insert/select/update-
-- only shape: clearing a soundtrack mapping loses no history, the same
-- posture as nulling out blocks.notes via UPDATE.
create policy "soundtrack_preferences_delete_own" on soundtrack_preferences
  for delete to authenticated using ((select auth.uid()) = user_id);

-- public.set_updated_at() already exists (0001_seam.sql) and is reused by
-- other tables (e.g. notes) -- same trigger pattern, not a new one.
create trigger soundtrack_preferences_set_updated_at
  before update on soundtrack_preferences
  for each row execute function public.set_updated_at();
