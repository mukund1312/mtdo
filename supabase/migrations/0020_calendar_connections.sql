-- Phase 6 of the operating-engine plan: Google Calendar. Two tables, no
-- functions -- every write here goes through a service-role Route Handler
-- (web/app/api/calendar/**), because both of them hold or point at data a
-- browser must not be able to touch.
--
-- Google Calendar is ONE-WAY, MTDO -> Google, in V1 (decisions.md,
-- 2026-09-11). MTDO is the source of truth; Google-side edits do not flow
-- back, and no webhook/poll receiver exists. AI may only ever *suggest* a
-- slot, never create an event unattended -- nothing in this migration is a
-- write path an unattended job could reach, which is what keeps that true
-- structurally rather than by convention.

-- 1. calendar_connections --------------------------------------------------
-- SERVICE-ROLE ONLY. This is the strictest posture any table in this schema
-- carries: RLS is enabled with NO policies at all, *and* every privilege is
-- revoked from anon and authenticated. Either one alone would be a weaker
-- claim than it looks -- schema.md sec6 spells out why "there is no policy"
-- is only an incidental denial under Supabase's default privileges, and a
-- grant with no policy would be an equally incidental one. Both together
-- make it structural: a browser client cannot read this table even for its
-- own row, which is the point. A user's Google refresh token is a long-lived
-- credential to a third-party account; it has no business in a bundle.
--
-- The closest existing precedent is tutor_messages ("a client can: nothing",
-- schema.md sec6). This is that, plus the encryption below.

create table calendar_connections (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  -- Open-ended enough to add a second provider without a migration to the
  -- CHECK, closed enough that a typo is a 23514 rather than a silently
  -- unsyncable row. Only 'google' is implemented (lib/calendar/google.ts).
  provider text not null default 'google' check (provider in ('google')),

  -- ENCRYPTED AT REST, BY THE APPLICATION, NOT BY THE DATABASE.
  -- Opaque ciphertext in a self-describing envelope: 'v1:<iv>:<tag>:<ct>',
  -- AES-256-GCM, produced and consumed only by web/lib/calendar/crypto.ts
  -- under CALENDAR_TOKEN_ENCRYPTION_KEY. The version prefix is what makes a
  -- later key rotation possible without a schema change.
  --
  -- Why not pgcrypto's pgp_sym_encrypt (the obvious choice)? Three reasons,
  -- recorded in full in decisions.md's 2026-09-11 entry:
  --   1. 0001_seam.sql's own header says pgcrypto is deliberately NOT
  --      installed (extension_in_public advisor) -- this is not the migration
  --      to silently reverse that.
  --   2. No pgsodium/Vault precedent exists in this project to be consistent
  --      with, and Supabase has itself moved away from in-database TCE.
  --   3. Decisive: without Vault, the symmetric key would have to be passed
  --      INTO SQL as an argument on every read and write, crossing PostgREST
  --      and the wire every time. Encrypting in the Route Handler means the
  --      database never holds or sees the key at all -- so a database dump is
  --      not a token compromise, which is the actual threat this column is
  --      encrypted against.
  refresh_token_encrypted text not null,

  -- Which calendar events land on. 'primary' is Google's own alias for the
  -- account's default calendar, so this is a real value rather than a
  -- placeholder even before any calendar picker UI exists.
  calendar_id text not null default 'primary',
  -- What the user actually consented to, as returned by Google -- not what we
  -- asked for. Stored so a scope added later can be detected as missing and
  -- re-consented, rather than failing at event-creation time with a 403 that
  -- reads like an outage.
  scopes text[] not null default '{}',
  connected_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  -- One connection per user per provider. The OAuth callback upserts on this:
  -- re-consenting replaces the stored token rather than accumulating dead
  -- ones, and Google only returns a refresh_token on first consent (or with
  -- prompt=consent), so "newest wins" is the only correct merge.
  constraint calendar_connections_user_provider_key unique (user_id, provider)
);

alter table calendar_connections enable row level security;
-- No policies, deliberately. Do not add one. See the header above.

revoke all on public.calendar_connections from anon, authenticated;
revoke truncate, references, trigger on public.calendar_connections from anon, authenticated;
grant select, insert, update, delete on public.calendar_connections to service_role;

create trigger calendar_connections_set_updated_at
  before update on calendar_connections
  for each row execute function public.set_updated_at();

comment on table calendar_connections is
  'A user''s OAuth connection to an external calendar. SERVICE-ROLE ONLY: RLS enabled with no policies AND all privileges revoked from anon/authenticated, so the refresh token never reaches a browser -- not even its owner''s. Written exclusively by web/app/api/calendar/callback. See docs/architecture/api.md sec3e.';
comment on column calendar_connections.refresh_token_encrypted is
  'AES-256-GCM ciphertext in a self-describing ''v1:<iv>:<tag>:<ct>'' envelope, encrypted and decrypted by web/lib/calendar/crypto.ts under CALENDAR_TOKEN_ENCRYPTION_KEY. Never plaintext, never client-readable, and the key is never sent to the database. Access tokens are deliberately not stored at all -- they are short-lived and re-minted from this token per sync call.';
comment on column calendar_connections.scopes is
  'The scopes Google actually granted (from the token response), not the ones requested -- so a later scope addition is detectable as missing consent rather than a 403 at event-creation time.';

-- 2. calendar_event_links --------------------------------------------------
-- The idempotency record for one-way sync: "this block is represented by that
-- event over there". It is ALSO the per-block opt-in itself -- there is no
-- blocks.calendar_sync_enabled column, deliberately. A block is synced iff a
-- row exists here, exactly the way "picked" means "a block exists with this
-- curriculum_item_id" (decisions.md 2026-09-07). A second mutable copy of "is
-- this on the calendar" can disagree with the calendar, and that failure is
-- invisible.

create table calendar_event_links (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  block_id uuid not null,
  provider text not null default 'google' check (provider in ('google')),
  external_event_id text not null,
  -- Denormalised from calendar_connections.calendar_id at sync time, on
  -- purpose: a Google event id is only addressable together with the calendar
  -- it lives in, so a user who later switches calendars must still be able to
  -- delete the events already created in the old one. Reading the current
  -- connection instead would strand them.
  external_calendar_id text not null default 'primary',
  created_at timestamptz not null default now(),
  synced_at timestamptz not null default now(),

  -- The idempotency constraint the one-way sync is built on: re-syncing a
  -- block updates the existing event instead of creating a duplicate.
  constraint calendar_event_links_block_provider_key unique (block_id, provider),

  -- OWNERSHIP CHAIN, same composite-FK pattern as focus_sessions/proofs
  -- (0001 sec3): user_id alone would only prove "this row claims to be mine".
  -- Pointing at blocks_id_user_key proves the referenced block is the same
  -- user's, structurally, so the SELECT policy below can be a plain
  -- user_id check rather than an EXISTS subquery re-walking the chain.
  --
  -- ON DELETE CASCADE, and the honest cost of it: deleting a synced block
  -- drops this row and ORPHANS the Google event, because Postgres cannot make
  -- an HTTP call from a cascade. The call-site contract is therefore "unsync
  -- before deleting" (api.md sec3e); no reaper for events orphaned by a client
  -- that didn't is built. Named as debt in decisions.md rather than left to be
  -- discovered. RESTRICT was rejected: a user must always be able to delete
  -- their own block, calendar or no calendar.
  constraint calendar_event_links_block_fk foreign key (block_id, user_id)
    references blocks (id, user_id) on delete cascade
);

create index calendar_event_links_user_idx on calendar_event_links (user_id);

alter table calendar_event_links enable row level security;

-- Read-only to the owning user. "Is this block on my calendar, and which
-- event is it?" is a legitimate thing for the Time deck to render -- an
-- external event id is not a credential. Writes stay service-role: the row is
-- only meaningful if the matching Google API call actually happened, and only
-- the Route Handler knows that.
create policy "calendar_event_links_select_own" on calendar_event_links
  for select to authenticated using ((select auth.uid()) = user_id);

revoke all on public.calendar_event_links from anon, authenticated;
revoke truncate, references, trigger on public.calendar_event_links from anon, authenticated;
grant select on public.calendar_event_links to authenticated;
grant select, insert, update, delete on public.calendar_event_links to service_role;

comment on table calendar_event_links is
  'One row per block that is mirrored to an external calendar -- the idempotency record for one-way MTDO -> Google sync, and the per-block opt-in itself (a block is synced iff a row exists here; there is no blocks.calendar_sync_enabled column). SELECT-own to the client, service-role write only. See docs/architecture/api.md sec3e.';
comment on column calendar_event_links.external_calendar_id is
  'The calendar the event was actually created in, captured at sync time rather than read from the current connection -- a Google event id is only addressable alongside its calendar, so a user who later switches calendars must still be able to delete events created in the old one.';
