-- mtdo web -- seam schema (docs/architecture/schema.md §1-2)
-- The seam between the solo webapp and group study: activity_events and
-- focus_sessions both carry a nullable room_id (null = solo, set = room).
-- Room-only tables (rooms, room_members, etc.) are deliberately NOT here yet --
-- see docs/architecture/schema.md §2 "Deliberately not designed yet".
--
-- REQUIRES PostgreSQL 15+. Two PG15 features are used deliberately:
--   * UNIQUE ... NULLS NOT DISTINCT            (daily_rollups, §8)
--   * ON DELETE SET NULL (<column list>)       (composite FKs, §5/§6)
-- Supabase's minimum is PG15 and new projects provision PG17, so this is safe.
--
-- SECURITY MODEL (read before adding a policy or a grant to this file):
--   1. RLS is the read-side control. Every policy is scoped `to authenticated`
--      and uses `(select auth.uid())` so Postgres evaluates it once per query
--      (InitPlan) instead of once per row.
--      NOTE: Supabase's anonymous sign-in issues a JWT whose role is
--      `authenticated` (with is_anonymous=true in the claims). The `anon` role
--      is only for requests carrying no JWT at all. Because this product uses
--      anonymous-auth-from-first-visit, `to authenticated` is the correct
--      scoping for real users -- do not "fix" it to `anon`.
--   2. Table GRANTs are the write-side control. Supabase's default privileges
--      are `alter default privileges for role postgres in schema public grant
--      all on tables/functions/sequences to postgres, anon, authenticated,
--      service_role`, so "there is no policy" is NOT a durable denial -- a
--      future `for all` policy added by copy-paste habit would silently
--      reopen writes. Every table whose writes must be server-authoritative
--      therefore carries an explicit REVOKE below.
--      Two consequences that are easy to miss and are handled at the bottom of
--      this file:
--        * `grant all on tables` includes TRUNCATE, and RLS does not apply to
--          TRUNCATE. PostgREST never emits one today, but the privilege is
--          real and it would empty the append-only ledger for every user.
--        * `grant all on functions` means `revoke execute ... from public` is
--          NOT enough to hide an internal function: anon/authenticated hold
--          their own explicit grant and must be revoked by name.
--   3. The sanctioned write path for server-authoritative data is the
--      `security definer` functions in §4/§5. They are owned by `postgres`,
--      which also owns these tables, so they are exempt from RLS.
--      => Do NOT add `alter table ... force row level security` to any table
--         written by those functions; it would break the only write path.
--
-- gen_random_uuid() is core Postgres since v13 -- the pgcrypto extension is
-- deliberately NOT installed (installing it into `public` trips Supabase's
-- `extension_in_public` security advisor for no benefit).

-- 0. shared trigger helpers ----------------------------------------------

-- Auto-touch updated_at. Written by hand rather than via the `moddatetime`
-- extension, for the same extension_in_public reason as pgcrypto above.
create function public.set_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

alter function public.set_updated_at() owner to postgres;
revoke execute on function public.set_updated_at() from public, anon, authenticated;

-- 1. identity ----------------------------------------------------------

create table profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  display_name text,
  -- INFORMATIONAL ONLY. This column is client-updatable via
  -- profiles_update_own and must never be used as an authorization signal.
  -- The trustworthy source is the JWT claim (auth.jwt() ->> 'is_anonymous').
  -- Nothing currently depends on it, which is why it is left as-is.
  is_anonymous boolean not null default true,
  created_at timestamptz not null default now()
);

alter table profiles enable row level security;

create policy "profiles_select_own" on profiles
  for select to authenticated using ((select auth.uid()) = id);
create policy "profiles_insert_own" on profiles
  for insert to authenticated with check ((select auth.uid()) = id);
create policy "profiles_update_own" on profiles
  for update to authenticated
  using ((select auth.uid()) = id)
  -- Explicit, even though Postgres would reuse USING as WITH CHECK when
  -- omitted: without it, the row-can't-be-reassigned rule reads like an
  -- oversight rather than a decision.
  with check ((select auth.uid()) = id);

-- Every auth path (including anonymous sign-in on first visit) must land a
-- profiles row; nothing else creates one.
create function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.profiles (id, display_name, is_anonymous)
  values (
    new.id,
    nullif(new.raw_user_meta_data ->> 'display_name', ''),
    coalesce(new.is_anonymous, true)
  )
  on conflict (id) do nothing;
  return new;
end;
$$;

alter function public.handle_new_user() owner to postgres;
revoke execute on function public.handle_new_user() from public, anon, authenticated;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- 2. the plan (ports goals.json) ----------------------------------------

create table plans (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  app_name text not null,
  goal_line text not null,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  -- Redundant with the primary key on its own, but required as the target of
  -- blocks' composite FK: it is what makes "this block's plan belongs to this
  -- block's user" a database-enforced invariant rather than a hope.
  constraint plans_id_user_key unique (id, user_id)
);

create index plans_user_idx on plans (user_id);

-- Free tier is "one goal" (mtdo-web-v1-plan.md §4). Enforced structurally
-- rather than in app code, where it would be one forgotten check away.
-- NOTE: Pro's "unlimited goals" (W6) requires dropping this index and moving
-- the limit into the billing/entitlement layer. Dropping it is a catalog-only
-- operation; it is deliberately cheap to reverse.
create unique index plans_one_active on plans (user_id) where is_active;

create table plan_categories (
  id uuid primary key default gen_random_uuid(),
  plan_id uuid not null references plans (id) on delete cascade,
  name text not null,
  label text not null,
  -- int[] (not smallint[]) to match docs/architecture/schema.md §2; there is
  -- no meaningful storage win from smallint on an array this small.
  days int[] not null default '{}',
  min_blocks integer not null default 0,
  score_weight numeric not null default 1,
  topic_type text,
  coaching_framework jsonb not null default '{}'::jsonb,
  sort_order integer not null default 0,
  constraint plan_categories_plan_name_key unique (plan_id, name),
  -- Target of blocks' second composite FK (category must belong to the same
  -- plan the block claims).
  constraint plan_categories_id_plan_key unique (id, plan_id)
);

create index plan_categories_plan_idx on plan_categories (plan_id);

create table curriculum_items (
  id uuid primary key default gen_random_uuid(),
  category_id uuid not null references plan_categories (id) on delete cascade,
  week_index integer not null,
  position integer not null,
  task text not null,
  -- meta keeps focus_points/questions/mistakes/tips/mental_models as jsonb:
  -- rich, nested, always read whole. Do not over-normalize (schema.md §2).
  meta jsonb not null default '{}'::jsonb
);

-- Also backs the FK to plan_categories (Postgres does not auto-index FK columns).
create index curriculum_items_category_idx
  on curriculum_items (category_id, week_index, position);

alter table plans enable row level security;
alter table plan_categories enable row level security;
alter table curriculum_items enable row level security;

-- Plans and categories are SELECT/INSERT/UPDATE only -- deliberately no DELETE
-- policy. Retiring a goal is `is_active = false`, never a delete: blocks hold
-- the user's entire progress history and hang off plan_id/category_id, and the
-- free tier's headline promise is 30 days of history. A "delete goal" button
-- wired to a real DELETE would silently destroy exactly that.
-- (Postgres allows only one command per policy, so this is three policies.)
create policy "plans_select_own" on plans
  for select to authenticated using ((select auth.uid()) = user_id);
create policy "plans_insert_own" on plans
  for insert to authenticated with check ((select auth.uid()) = user_id);
create policy "plans_update_own" on plans
  for update to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

create policy "plan_categories_select_own" on plan_categories
  for select to authenticated using (
    exists (select 1 from plans p where p.id = plan_categories.plan_id and p.user_id = (select auth.uid()))
  );
create policy "plan_categories_insert_own" on plan_categories
  for insert to authenticated with check (
    exists (select 1 from plans p where p.id = plan_categories.plan_id and p.user_id = (select auth.uid()))
  );
create policy "plan_categories_update_own" on plan_categories
  for update to authenticated
  using (
    exists (select 1 from plans p where p.id = plan_categories.plan_id and p.user_id = (select auth.uid()))
  )
  with check (
    exists (select 1 from plans p where p.id = plan_categories.plan_id and p.user_id = (select auth.uid()))
  );

-- Curriculum items keep full CRUD: they are replaceable plan *content*, and
-- nothing references them (blocks copy their text), so deleting one loses no
-- history. This policy already walks the FK chain back to user_id correctly.
create policy "curriculum_items_owner_all" on curriculum_items
  for all to authenticated using (
    exists (
      select 1 from plan_categories pc
      join plans p on p.id = pc.plan_id
      where pc.id = curriculum_items.category_id and p.user_id = (select auth.uid())
    )
  ) with check (
    exists (
      select 1 from plan_categories pc
      join plans p on p.id = pc.plan_id
      where pc.id = curriculum_items.category_id and p.user_id = (select auth.uid())
    )
  );

-- 3. daily work (ports state.json per-date entries) ----------------------

create table blocks (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  plan_id uuid not null,
  category_id uuid not null,
  date date not null,
  position integer not null,
  text text not null,
  status text not null default 'todo' check (status in ('todo', 'in_progress', 'done')),
  notes text,
  coaching jsonb,
  claimed boolean not null default false,
  started_at timestamptz,
  elapsed_seconds integer not null default 0,
  completed_at timestamptz,

  constraint blocks_elapsed_nonneg check (elapsed_seconds >= 0),

  -- DEFERRABLE so a drag-and-drop reorder can swap two rows' positions inside
  -- one transaction without tripping a violation on the intermediate state.
  -- Caveat for implementers: ON CONFLICT cannot infer a deferrable constraint,
  -- so upserts on blocks must be written as explicit UPDATE-then-INSERT.
  constraint blocks_slot_key unique (user_id, date, category_id, position)
    deferrable initially deferred,

  -- Target of focus_sessions' and proofs' composite FKs.
  constraint blocks_id_user_key unique (id, user_id),

  -- OWNERSHIP CHAIN (the point of the composite FKs): user_id alone proved
  -- only "this row claims to be mine". These prove the row's *references* are
  -- mine too -- the block's plan is owned by the same user, and the block's
  -- category belongs to that same plan. Without them, a client that learns
  -- another user's plan/category id could attach rows across the boundary.
  --
  -- ON DELETE RESTRICT, not CASCADE: see the plans policy comment above.
  -- Verified: this does NOT break account deletion. `delete from auth.users`
  -- cascades to plans and to blocks within one statement, and RI checks are
  -- drained at the end of that statement, by which time the blocks are gone.
  constraint blocks_plan_fk foreign key (plan_id, user_id)
    references plans (id, user_id) on delete restrict,
  constraint blocks_category_fk foreign key (category_id, plan_id)
    references plan_categories (id, plan_id) on delete restrict
);

-- Back the composite FKs. Without these, every plan/category delete attempt
-- (and every account deletion) sequential-scans all of blocks.
create index blocks_plan_user_idx on blocks (plan_id, user_id);
create index blocks_category_plan_idx on blocks (category_id, plan_id);
-- blocks (user_id, date) needs no index of its own: blocks_slot_key leads
-- with exactly those columns.

alter table blocks enable row level security;

-- Blocks keep full CRUD including DELETE: removing a task you added by mistake
-- today is a legitimate, non-destructive action, unlike deleting a whole plan.
create policy "blocks_owner_all" on blocks
  for all to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

-- 4. THE LEDGER (D14) -- append-only, source of truth --------------------

create table activity_events (
  id bigint generated always as identity primary key,
  -- !! DATA-RETENTION WARNING (read before enabling anonymous-user cleanup) !!
  -- ON DELETE CASCADE from auth.users is correct for a real account deletion
  -- (GDPR "delete my data" has to actually work). But Supabase can also reap
  -- *anonymous* users on a schedule, and this product creates an anonymous
  -- user on first visit. Reaping them deletes exactly the activation-funnel
  -- population -- visitors who never signed up -- which is the denominator of
  -- the two metrics the product plan says are the only ones that matter
  -- (activation rate, D1/D7 retention). Whoever wires up anonymous-user
  -- cleanup must first decide the retention policy (disable the reaper, or
  -- roll events into an anonymized aggregate before the reap). This is a
  -- product decision, deliberately not pre-empted here.
  user_id uuid not null references auth.users (id) on delete cascade,
  room_id uuid, -- null = solo, set = room activity. Room tables not created yet.
  session_id uuid,
  kind text not null,
  occurred_at timestamptz not null default now(),
  payload jsonb not null default '{}'::jsonb,

  -- CANONICAL EVENT VOCABULARY (solo v1). See schema.md §4 for the rules that
  -- produced this list and for what was deliberately left out. Kept as a CHECK
  -- rather than an enum so adding a kind is a plain ALTER.
  --
  -- Of these, session_started / session_completed / session_abandoned and
  -- tutor_message_sent are SERVER-MINTED ONLY -- record_event() refuses them.
  -- That is what makes focus time and tutor usage unfarmable (D17, D21) and
  -- the free-tier cap enforceable.
  constraint activity_events_kind_check check (kind in (
    'signup',
    'goal_created',
    'plan_generated',
    'task_completed',
    'task_regressed',
    'proof_submitted',
    'note_created',
    'screen_opened',
    'focus_mode_toggled',
    'paywall_viewed',
    'session_started',
    'session_completed',
    'session_abandoned',
    'tutor_message_sent'
  )),

  constraint activity_events_payload_is_object
    check (jsonb_typeof(payload) = 'object'),

  -- TEMPORARY (drop in the W4a room migration). room_id exists now so the room
  -- feature is additive rather than a rewrite, but until rooms/room_members
  -- exist there is no membership check to validate it against -- and the
  -- ledger has no DELETE path by design, so any garbage written now is stuck
  -- forever. Dropping a CHECK is catalog-only and instant.
  constraint activity_events_no_rooms_yet check (room_id is null)
);

create index activity_events_user_occurred_idx on activity_events (user_id, occurred_at desc);
-- Unused while activity_events_no_rooms_yet holds; kept so the W4a migration
-- is a one-line CHECK drop rather than a CHECK drop plus an index build.
create index activity_events_room_occurred_idx on activity_events (room_id, occurred_at desc)
  where room_id is not null;
-- Backs the free-tier tutor cap: "how many X events did this user emit today".
create index activity_events_user_kind_occurred_idx
  on activity_events (user_id, kind, occurred_at desc);

alter table activity_events enable row level security;

-- SELECT only. The ledger is append-only and *server*-append-only: a client
-- that could choose its own occurred_at/kind/payload could date events into
-- the past and fabricate focus time, and because UPDATE/DELETE are denied the
-- forgery would be permanent. Appends go through record_event() below.
create policy "activity_events_select_own" on activity_events
  for select to authenticated using ((select auth.uid()) = user_id);

-- Structural, not incidental: without these REVOKEs the only thing stopping a
-- write is the *absence* of a policy, and Supabase's default privileges have
-- already granted the underlying table rights. See the security model header.
revoke all on public.activity_events from anon, authenticated;
grant select on public.activity_events to authenticated;

-- Internal ledger append. NOT callable by clients (it takes an explicit
-- user_id, which is exactly the parameter a caller must never control) --
-- EXECUTE is revoked from PUBLIC below and never granted back.
create function public.append_event(
  p_user_id uuid,
  p_kind text,
  p_payload jsonb,
  p_session_id uuid default null,
  p_room_id uuid default null
)
returns public.activity_events
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_row public.activity_events;
begin
  insert into public.activity_events (user_id, room_id, session_id, kind, occurred_at, payload)
  values (
    p_user_id,
    p_room_id,
    p_session_id,
    p_kind,
    now(),                                  -- server clock, never a parameter
    coalesce(p_payload, '{}'::jsonb)
  )
  returning * into v_row;
  return v_row;
end;
$$;

alter function public.append_event(uuid, text, jsonb, uuid, uuid) owner to postgres;
-- `from public` alone would leave Supabase's explicit default grants to
-- anon/authenticated in place -- which on THIS function would hand every
-- client the ability to attribute a ledger event to any user id it can name.
revoke execute on function public.append_event(uuid, text, jsonb, uuid, uuid)
  from public, anon, authenticated;

-- THE ONLY client-facing way to append to the ledger.
-- user_id and occurred_at are derived here and are not parameters at all, so
-- there is no version of this call that back-dates an event or attributes one
-- to another user.
create function public.record_event(
  p_kind text,
  p_payload jsonb default '{}'::jsonb
)
returns public.activity_events
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
begin
  if v_uid is null then
    raise exception 'record_event: no authenticated user' using errcode = '42501';
  end if;

  -- Client-appendable subset of activity_events_kind_check. Everything omitted
  -- here (session_*, tutor_message_sent) is minted server-side by the session
  -- functions in §5 or by the tutor backend, so that focus time and metered
  -- AI usage cannot be self-reported. KEEP IN SYNC with that CHECK.
  if p_kind is null or p_kind not in (
    'signup',
    'goal_created',
    'plan_generated',
    'task_completed',
    'task_regressed',
    'proof_submitted',
    'note_created',
    'screen_opened',
    'focus_mode_toggled',
    'paywall_viewed'
  ) then
    raise exception 'record_event: kind % is not client-appendable', p_kind
      using errcode = '22023';
  end if;

  if p_payload is not null and jsonb_typeof(p_payload) <> 'object' then
    raise exception 'record_event: payload must be a JSON object' using errcode = '22023';
  end if;

  -- Not in the audit, found while attacking this function: without a bound, a
  -- client can push megabyte payloads into a table that has no DELETE path by
  -- design. That is permanent storage growth on a free-tier database, from an
  -- unauthenticated-cheap call. Ledger payloads are facts about an event, not
  -- documents; 4 KB is generous for every kind in the whitelist. The bound is
  -- deliberately here rather than on the table, so the service-role writers
  -- (which are our own code, not untrusted input) are not constrained by it.
  if p_payload is not null and octet_length(p_payload::text) > 4096 then
    raise exception 'record_event: payload exceeds 4096 bytes' using errcode = '22023';
  end if;

  -- session_id/room_id stay null: a client has no business attributing its own
  -- event to a session or a room.
  return public.append_event(v_uid, p_kind, coalesce(p_payload, '{}'::jsonb));
end;
$$;

alter function public.record_event(text, jsonb) owner to postgres;
revoke execute on function public.record_event(text, jsonb) from public, anon, authenticated;
grant execute on function public.record_event(text, jsonb) to authenticated;

-- 5. server-authoritative sessions (D12) ----------------------------------

create table focus_sessions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  room_id uuid, -- null = solo, set = room session
  block_id uuid,
  started_at timestamptz not null default now(), -- SERVER stamps, never the client
  planned_duration_s integer not null,
  state text not null default 'running' check (state in ('running', 'completed', 'abandoned')),
  completed_at timestamptz,
  grace_expires_at timestamptz,

  constraint focus_sessions_planned_duration_sane
    check (planned_duration_s > 0 and planned_duration_s <= 86400),

  -- A running session has no completion time; a settled one always has one.
  -- (start_session/complete_session/abandon_session maintain both halves.)
  constraint focus_sessions_state_completed_at
    check ((state = 'running') = (completed_at is null)),

  -- Same temporary constraint, same reason, as on activity_events. Drop in W4a.
  constraint focus_sessions_no_rooms_yet check (room_id is null),

  -- Target of proofs' composite FK.
  constraint focus_sessions_id_user_key unique (id, user_id),

  -- Ownership chain: the block a session claims must belong to the same user.
  -- ON DELETE SET NULL (block_id) -- the column list is required because the
  -- FK spans (block_id, user_id) and user_id is NOT NULL; a bare SET NULL
  -- would try to null both and fail at delete time. A session outliving its
  -- block is correct: the focus time really happened.
  constraint focus_sessions_block_fk foreign key (block_id, user_id)
    references blocks (id, user_id) on delete set null (block_id)
);

-- One running session per user, full stop. Two would double-count focus time
-- in the rollups and leave the UI with no defensible answer to "which timer is
-- mine". NOTE for W4a: if a user should later be able to run one solo session
-- AND one room session at once, this becomes
--   (user_id, coalesce(room_id, '00000000-0000-0000-0000-000000000000'::uuid))
-- -- but one-at-a-time is both correct and simpler today.
create unique index focus_sessions_one_running
  on focus_sessions (user_id) where state = 'running';

create index focus_sessions_user_state_idx on focus_sessions (user_id, state);
create index focus_sessions_block_user_idx on focus_sessions (block_id, user_id)
  where block_id is not null;

alter table focus_sessions enable row level security;

-- SELECT only. D12 says sessions are server-authoritative; a `for all` policy
-- made that a comment rather than a rule -- started_at was only a DEFAULT, so
-- a client could supply any value on INSERT, or UPDATE a running session's
-- start time, or insert a fabricated multi-hour completed session outright.
create policy "focus_sessions_select_own" on focus_sessions
  for select to authenticated using ((select auth.uid()) = user_id);

revoke all on public.focus_sessions from anon, authenticated;
grant select on public.focus_sessions to authenticated;

-- The client sends intents (start / complete / abandon); the server owns time
-- and state. These three functions are the entire write surface, called from
-- the app via supabase.rpc() with the ordinary anon key -- no service-role
-- client is needed for the session loop.
create function public.start_session(
  p_block_id uuid,
  p_planned_duration_s integer
)
returns public.focus_sessions
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_row public.focus_sessions;
begin
  if v_uid is null then
    raise exception 'start_session: no authenticated user' using errcode = '42501';
  end if;

  if p_planned_duration_s is null or p_planned_duration_s <= 0 or p_planned_duration_s > 86400 then
    raise exception 'start_session: planned_duration_s must be between 1 and 86400'
      using errcode = '22023';
  end if;

  -- Belt and braces: focus_sessions_block_fk would reject a foreign block too,
  -- but as an opaque FK violation. Fail with something an implementer can read.
  if p_block_id is not null and not exists (
    select 1 from public.blocks b where b.id = p_block_id and b.user_id = v_uid
  ) then
    raise exception 'start_session: block % not found for this user', p_block_id
      using errcode = '42501';
  end if;

  if exists (
    select 1 from public.focus_sessions s
    where s.user_id = v_uid and s.state = 'running'
  ) then
    -- focus_sessions_one_running enforces this under concurrency; this branch
    -- exists only to return a meaningful error in the common case.
    --
    -- RECOVERY CONTRACT for the UI: a user who closes the tab mid-session
    -- leaves a `running` row behind, and this error is what they hit the next
    -- day. Deliberately an error rather than a silent auto-abandon -- throwing
    -- away a session the user may still want to complete is not a decision the
    -- database should make. The client can SELECT the running session (that
    -- read is allowed) and must offer resume-or-discard, calling
    -- abandon_session() before starting a new one. errcode 55006 is
    -- distinguishable so the UI can branch on it.
    raise exception 'start_session: a session is already running'
      using errcode = '55006';
  end if;

  insert into public.focus_sessions (user_id, room_id, block_id, started_at, planned_duration_s, state, completed_at)
  values (v_uid, null, p_block_id, now(), p_planned_duration_s, 'running', null)
  returning * into v_row;

  perform public.append_event(
    v_uid,
    'session_started',
    jsonb_build_object('block_id', p_block_id, 'planned_duration_s', p_planned_duration_s),
    v_row.id
  );

  return v_row;
end;
$$;

alter function public.start_session(uuid, integer) owner to postgres;
revoke execute on function public.start_session(uuid, integer) from public, anon, authenticated;
grant execute on function public.start_session(uuid, integer) to authenticated;

-- Shared settle path for complete/abandon so the two can never drift.
create function public.settle_session(p_id uuid, p_state text)
returns public.focus_sessions
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_row public.focus_sessions;
  v_elapsed integer;
begin
  if v_uid is null then
    raise exception 'settle_session: no authenticated user' using errcode = '42501';
  end if;

  -- Ownership is re-checked here, not just in RLS: this function runs as its
  -- owner and is therefore exempt from RLS, so `user_id = v_uid` in the WHERE
  -- clause IS the access control.
  update public.focus_sessions s
     set state = p_state,
         completed_at = now()
   where s.id = p_id
     and s.user_id = v_uid
     and s.state = 'running'
  returning * into v_row;

  if v_row.id is null then
    -- Deliberately does not distinguish "not yours" from "not running": a
    -- distinguishable error would confirm the existence of another user's id.
    raise exception 'settle_session: no running session % for this user', p_id
      using errcode = '42501';
  end if;

  -- Elapsed time is measured from the server-stamped started_at, so it is the
  -- one number the rollup job can trust. planned_duration_s ships alongside it
  -- so the job can decide its own policy (e.g. least(elapsed, planned)) for a
  -- session left open long past its planned end.
  v_elapsed := greatest(0, floor(extract(epoch from (v_row.completed_at - v_row.started_at)))::integer);

  perform public.append_event(
    v_uid,
    case when p_state = 'completed' then 'session_completed' else 'session_abandoned' end,
    jsonb_build_object(
      'block_id', v_row.block_id,
      'planned_duration_s', v_row.planned_duration_s,
      'elapsed_s', v_elapsed
    ),
    v_row.id
  );

  return v_row;
end;
$$;

alter function public.settle_session(uuid, text) owner to postgres;
-- Never granted back: p_state is a free parameter here, and the two entry
-- points below pin it to a literal. (Not that a bogus p_state could do much --
-- focus_sessions' state CHECK would reject it -- but a settle path whose
-- resulting state the caller chooses is not a shape worth exposing.)
revoke execute on function public.settle_session(uuid, text) from public, anon, authenticated;

create function public.complete_session(p_id uuid)
returns public.focus_sessions
language plpgsql
security definer
set search_path = ''
as $$
begin
  return public.settle_session(p_id, 'completed');
end;
$$;

alter function public.complete_session(uuid) owner to postgres;
revoke execute on function public.complete_session(uuid) from public, anon, authenticated;
grant execute on function public.complete_session(uuid) to authenticated;

create function public.abandon_session(p_id uuid)
returns public.focus_sessions
language plpgsql
security definer
set search_path = ''
as $$
begin
  return public.settle_session(p_id, 'abandoned');
end;
$$;

alter function public.abandon_session(uuid) owner to postgres;
revoke execute on function public.abandon_session(uuid) from public, anon, authenticated;
grant execute on function public.abandon_session(uuid) to authenticated;

-- 6. proof (D7) ------------------------------------------------------------

create table proofs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  session_id uuid,
  block_id uuid,
  -- D7 is "required proof-of-progress after sessions (note + optional
  -- artifact)": the note is the required part, the artifact is the optional
  -- add-on. So body is NOT NULL and must be non-blank; an artifact-only proof
  -- is deliberately not storable.
  body text not null,
  artifact_url text,
  -- Only 'private' is built in solo phases; 'squad'/'public' wait for rooms.
  visibility text not null default 'private' check (visibility in ('private', 'squad', 'public')),
  created_at timestamptz not null default now(),

  constraint proofs_body_not_blank check (length(btrim(body)) > 0),

  -- Ownership chain + SET NULL on both, matching each other. A proof outlives
  -- the session and the block it was attached to: the work really happened,
  -- and D7 makes proof the durable artifact of it. (The session case is mostly
  -- moot now that clients cannot delete focus_sessions at all -- kept for a
  -- future service-role cleanup path.)
  constraint proofs_session_fk foreign key (session_id, user_id)
    references focus_sessions (id, user_id) on delete set null (session_id),
  constraint proofs_block_fk foreign key (block_id, user_id)
    references blocks (id, user_id) on delete set null (block_id)
);

create index proofs_user_created_idx on proofs (user_id, created_at desc);
-- Also backs proofs_session_fk / proofs_block_fk (leading column is the FK's).
create index proofs_session_user_idx on proofs (session_id, user_id)
  where session_id is not null;
create index proofs_block_user_idx on proofs (block_id, user_id)
  where block_id is not null;

alter table proofs enable row level security;

create policy "proofs_owner_all" on proofs
  for all to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

-- 7. direct ports of state.json reserved keys -------------------------------

create table notes ( -- ports state.json's _notes
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  title text not null,
  body text,
  tags text[] not null default '{}',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index notes_user_updated_idx on notes (user_id, updated_at desc);

create trigger notes_set_updated_at
  before update on notes
  for each row execute function public.set_updated_at();

create table companies ( -- ports state.json's _companies (career CRM)
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  name text not null,
  -- Mirrors CAREER_STATUSES in src/mtdo/core.py, so the terminal app's CRM and
  -- the web CRM stay one vocabulary (the Phase 5 `mtdo serve --bridge` shares
  -- this data). Extend both together, or not at all.
  status text not null default 'applied'
    check (status in ('applied', 'oa', 'interview', 'offer', 'rejected', 'ghosted')),
  date_added date not null default current_date,
  notes text
);

create index companies_user_status_idx on companies (user_id, status);

alter table notes enable row level security;
alter table companies enable row level security;

create policy "notes_owner_all" on notes
  for all to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);
create policy "companies_owner_all" on companies
  for all to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

-- 8. derived rollups (D13) -- NEVER hand-written, only materialized from the ledger ----

create table daily_rollups (
  id uuid primary key default gen_random_uuid(),
  -- Same anonymous-user-cleanup warning as activity_events (§4): this table is
  -- the aggregated form of exactly the funnel data a reaper would delete.
  user_id uuid not null references auth.users (id) on delete cascade,
  date date not null,
  -- The seam (schema.md §1) applied to the derived table too: null = the
  -- user's solo totals for that day, set = their totals inside one room. The
  -- old (user_id, date) primary key structurally could not hold both, and a
  -- surrogate key plus a NULLS NOT DISTINCT unique is far cheaper to add now
  -- than after this table has rows.
  room_id uuid,
  blocks_done integer not null default 0,
  focus_seconds integer not null default 0,
  sessions_completed integer not null default 0,
  -- Lets the recompute job detect staleness (and lets a reader tell "zero
  -- because nothing happened" from "zero because it hasn't run").
  computed_at timestamptz not null default now(),

  constraint daily_rollups_blocks_done_nonneg check (blocks_done >= 0),
  constraint daily_rollups_focus_seconds_nonneg check (focus_seconds >= 0),
  constraint daily_rollups_sessions_completed_nonneg check (sessions_completed >= 0),

  -- NULLS NOT DISTINCT (PG15+) so the solo row -- room_id IS NULL -- is unique
  -- per (user_id, date) instead of being freely duplicable, which is what the
  -- default NULLS DISTINCT would allow. Chosen over the two-partial-unique-
  -- index alternative because Supabase's floor is PG15 and because a single
  -- named constraint gives the recompute job one ON CONFLICT target instead of
  -- two code paths. (If this ever has to run on PG14 or older, replace with:
  --   create unique index ... on daily_rollups (user_id, date) where room_id is null;
  --   create unique index ... on daily_rollups (user_id, date, room_id) where room_id is not null;)
  constraint daily_rollups_key unique nulls not distinct (user_id, date, room_id)
);

alter table daily_rollups enable row level security;

create policy "daily_rollups_select_own" on daily_rollups
  for select to authenticated using ((select auth.uid()) = user_id);

-- Written only by a service-role job that derives it from activity_events
-- (D13). Explicit rather than relying on "no policy = deny", for the reason in
-- the security-model header: the grants are already there by default.
revoke all on public.daily_rollups from anon, authenticated;
grant select on public.daily_rollups to authenticated;

-- 9. privileges that no PostgREST client ever needs ------------------------

-- Supabase's `grant all on tables` hands anon/authenticated TRUNCATE,
-- REFERENCES and TRIGGER on every table in `public`. None of the three is
-- reachable through the PostgREST API today, but all three are real
-- privileges, and TRUNCATE in particular is NOT subject to row level security
-- -- a single TRUNCATE would empty the append-only ledger for every user at
-- once, with no policy in its way. Revoked here for the tables that already
-- exist, and removed from the default for tables added later.
revoke truncate, references, trigger on all tables in schema public
  from anon, authenticated;

-- Applies to `for role postgres`, which is the role migrations run as and the
-- role whose defaults Supabase configured -- so this narrows exactly those
-- grants. Deliberately scoped to these three privileges only: the
-- SELECT/INSERT/UPDATE/DELETE defaults are what the user-owned tables rely on.
-- NOTE: every future migration that creates a table in `public` should re-run
-- the REVOKE above, since a project restore can reset default privileges.
alter default privileges in schema public
  revoke truncate, references, trigger on tables from anon, authenticated;
