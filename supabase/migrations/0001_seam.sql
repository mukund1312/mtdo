-- mtdo web -- seam schema (docs/architecture/schema.md §1-2)
-- The seam between the solo webapp and group study: activity_events and
-- focus_sessions both carry a nullable room_id (null = solo, set = room).
-- Room-only tables (rooms, room_members, etc.) are deliberately NOT here yet --
-- see docs/architecture/schema.md §2 "Deliberately not designed yet".

create extension if not exists "pgcrypto";

-- 1. identity ----------------------------------------------------------

create table profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  display_name text,
  is_anonymous boolean not null default true,
  created_at timestamptz not null default now()
);

alter table profiles enable row level security;

create policy "profiles_select_own" on profiles
  for select using (auth.uid() = id);
create policy "profiles_insert_own" on profiles
  for insert with check (auth.uid() = id);
create policy "profiles_update_own" on profiles
  for update using (auth.uid() = id);

-- 2. the plan (ports goals.json) ----------------------------------------

create table plans (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  app_name text not null,
  goal_line text not null,
  is_active boolean not null default true,
  created_at timestamptz not null default now()
);

create table plan_categories (
  id uuid primary key default gen_random_uuid(),
  plan_id uuid not null references plans (id) on delete cascade,
  name text not null,
  label text not null,
  days smallint[] not null default '{}',
  min_blocks integer not null default 0,
  score_weight numeric not null default 1,
  topic_type text,
  coaching_framework jsonb not null default '{}'::jsonb,
  sort_order integer not null default 0
);

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

alter table plans enable row level security;
alter table plan_categories enable row level security;
alter table curriculum_items enable row level security;

create policy "plans_owner_all" on plans
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

create policy "plan_categories_owner_all" on plan_categories
  for all using (
    exists (select 1 from plans p where p.id = plan_categories.plan_id and p.user_id = auth.uid())
  ) with check (
    exists (select 1 from plans p where p.id = plan_categories.plan_id and p.user_id = auth.uid())
  );

create policy "curriculum_items_owner_all" on curriculum_items
  for all using (
    exists (
      select 1 from plan_categories pc
      join plans p on p.id = pc.plan_id
      where pc.id = curriculum_items.category_id and p.user_id = auth.uid()
    )
  ) with check (
    exists (
      select 1 from plan_categories pc
      join plans p on p.id = pc.plan_id
      where pc.id = curriculum_items.category_id and p.user_id = auth.uid()
    )
  );

-- 3. daily work (ports state.json per-date entries) ----------------------

create table blocks (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  plan_id uuid not null references plans (id) on delete cascade,
  category_id uuid not null references plan_categories (id) on delete cascade,
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
  unique (user_id, date, category_id, position)
);

alter table blocks enable row level security;

create policy "blocks_owner_all" on blocks
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- 4. THE LEDGER (D14) -- append-only, source of truth --------------------

create table activity_events (
  id bigint generated always as identity primary key,
  user_id uuid not null references auth.users (id) on delete cascade,
  room_id uuid, -- null = solo, set = room activity. Room tables not created yet.
  session_id uuid,
  kind text not null,
  occurred_at timestamptz not null default now(),
  payload jsonb not null default '{}'::jsonb
);

create index activity_events_user_occurred_idx on activity_events (user_id, occurred_at desc);
create index activity_events_room_occurred_idx on activity_events (room_id, occurred_at desc)
  where room_id is not null;

alter table activity_events enable row level security;

-- INSERT + SELECT only. No UPDATE, no DELETE, ever (schema.md §5).
-- Corrections are compensating events appended to the ledger, not mutations of history.
create policy "activity_events_select_own" on activity_events
  for select using (auth.uid() = user_id);
create policy "activity_events_insert_own" on activity_events
  for insert with check (auth.uid() = user_id);
-- Deliberately no update/delete policy: RLS defaults to deny, which makes the
-- ledger immutable to every role except a service-role migration path.

-- 5. server-authoritative sessions (D12) ----------------------------------

create table focus_sessions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  room_id uuid, -- null = solo, set = room session
  block_id uuid references blocks (id) on delete set null,
  started_at timestamptz not null default now(), -- SERVER stamps, never the client
  planned_duration_s integer not null,
  state text not null default 'running' check (state in ('running', 'completed', 'abandoned')),
  completed_at timestamptz,
  grace_expires_at timestamptz
);

alter table focus_sessions enable row level security;

create policy "focus_sessions_owner_all" on focus_sessions
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- 6. proof (D7) ------------------------------------------------------------

create table proofs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  session_id uuid references focus_sessions (id) on delete cascade,
  block_id uuid references blocks (id) on delete set null,
  body text,
  artifact_url text,
  -- Only 'private' is built in solo phases; 'squad'/'public' wait for rooms.
  visibility text not null default 'private' check (visibility in ('private', 'squad', 'public')),
  created_at timestamptz not null default now()
);

alter table proofs enable row level security;

create policy "proofs_owner_all" on proofs
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

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

create table companies ( -- ports state.json's _companies (career CRM)
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  name text not null,
  status text not null,
  date_added date not null default current_date,
  notes text
);

alter table notes enable row level security;
alter table companies enable row level security;

create policy "notes_owner_all" on notes
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "companies_owner_all" on companies
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- 8. derived rollups (D13) -- NEVER hand-written, only materialized from the ledger ----

create table daily_rollups (
  user_id uuid not null references auth.users (id) on delete cascade,
  date date not null,
  blocks_done integer not null default 0,
  focus_seconds integer not null default 0,
  sessions_completed integer not null default 0,
  primary key (user_id, date)
);

alter table daily_rollups enable row level security;

create policy "daily_rollups_select_own" on daily_rollups
  for select using (auth.uid() = user_id);
-- No insert/update/delete policy for regular users: this table is written only
-- by a service-role job that derives it from activity_events (D13).
