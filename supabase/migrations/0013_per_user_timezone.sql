-- Per-user time zones (decisions.md "Open, not yet decided" -> resolved
-- 2026-09-07, full version chosen over the deferred/watch-only option).
--
-- Two things must move together, or Today and Progress disagree about what
-- "today" is (the exact bug the original decisions.md entry warned against):
--   1. profiles.timezone -- where a user's own zone is stored.
--   2. recompute_daily_rollups() -- must bucket each user's rows by THEIR
--      OWN zone in one run, not one shared p_timezone for everyone.
-- blocks.date (Today's own boundary) is a client-computed value at insert
-- time (pick_curriculum_item(), migrations/0012) -- the frontend read-path
-- for "what date is today" is updated alongside this migration, not here;
-- there is no SQL-side equivalent to fix, blocks.date is just a date column.

-- 1. profiles.timezone --------------------------------------------------

-- NULLABLE, no default -- this is the load-bearing choice, not an
-- oversight. "Never set a preference" and "explicitly chose UTC" must be
-- two different states: recompute_daily_rollups() falls back to its own
-- p_timezone parameter only when a user's stored value is genuinely NULL
-- (coalesce(p.timezone, p_timezone)). A NOT NULL DEFAULT 'UTC' here would
-- mean every user always has a stored value, so that coalesce would always
-- pick the profile and never fall through -- silently breaking any caller
-- that passes an explicit p_timezone override (exactly what mtdo-bugs'
-- own recompute test suite does to verify cross-zone bucketing at all).
alter table public.profiles
  add column timezone text;

-- CHECK constraints cannot subquery pg_timezone_names (Postgres rejects
-- subqueries in CHECK), so real validation has to be a trigger. Rejects
-- outright rather than silently coercing to UTC -- a client that thinks it
-- successfully set "America/Los_Angeles" but got silently stored as "UTC"
-- is a worse failure than a loud 22023.
create function public.validate_profile_timezone()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  -- NULL is the legitimate "no preference set" state, not an invalid value
  -- -- see the column's own comment for why this must stay nullable rather
  -- than defaulting to 'UTC'. Nothing to validate.
  if new.timezone is null then
    return new;
  end if;

  begin
    perform now() at time zone new.timezone;
  exception when invalid_parameter_value or invalid_datetime_format then
    raise exception 'profiles.timezone: unknown time zone %', new.timezone
      using errcode = '22023';
  end;
  return new;
end;
$$;

alter function public.validate_profile_timezone() owner to postgres;

create trigger profiles_validate_timezone
  before insert or update of timezone on public.profiles
  for each row execute function public.validate_profile_timezone();

comment on column public.profiles.timezone is
  'IANA time zone name (e.g. "America/Los_Angeles"), or NULL if the user has never set one -- NULL is a real "no preference" state, not a default''d-away UTC, so recompute_daily_rollups()''s coalesce(timezone, p_timezone) can actually fall through when appropriate. Validated by profiles_validate_timezone when non-null -- an invalid value is rejected (22023), never silently coerced. Client-updatable (profiles_update_own, 0001) like display_name; feeds recompute_daily_rollups() per-user bucketing (0013) and the frontend''s own "what is today" computation.';

-- 2. recompute_daily_rollups(): per-user bucketing -----------------------
--
-- WHY THE WINDOW BOUNDS WIDEN INSTEAD OF NARROW. 0009's v_lo/v_hi exist so
-- the WHERE clauses stay sargable against activity_events_occurred_idx and
-- focus_sessions_started_idx -- a function call on the indexed column
-- defeats that, which is why the day computation happens in the SELECT list
-- and the raw instant stays in the WHERE clause. With one shared
-- p_timezone, [v_lo, v_hi) could be computed exactly. With per-user zones,
-- no single exact bound exists -- a user in UTC+14 and a user in UTC-12 have
-- local-day boundaries 26 hours apart in absolute time. The fix is padding
-- the scan window by the full possible UTC offset range (-12:00..+14:00)
-- so no user's real local-date range is ever clipped by the index scan,
-- then filtering down to the exact requested [p_from, p_to] per-user in the
-- CTEs below (cheap at that point -- the padded window has already done the
-- expensive narrowing). This is still sargable: it is still a plain
-- literal-bound comparison on occurred_at/started_at, just wider bounds,
-- not a function call on the column.
create or replace function public.recompute_daily_rollups(
  p_from date default null,
  p_to date default null,
  p_timezone text default 'UTC'
)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_lo timestamptz;
  v_hi timestamptz;
  v_from date;
  v_to date;
  v_rows integer;
begin
  if p_timezone is null then
    raise exception 'recompute_daily_rollups: p_timezone must not be null'
      using errcode = '22023';
  end if;

  begin
    perform now() at time zone p_timezone;
  exception when invalid_parameter_value or invalid_datetime_format then
    raise exception 'recompute_daily_rollups: unknown time zone %', p_timezone
      using errcode = '22023';
  end;

  -- Default window: today and the two days before it, in the caller's
  -- p_timezone -- unchanged from 0009. This is only the *nominal* window
  -- (what "recent" means for cron's unparameterized calls); the actual
  -- per-user bucketing below uses each user's own stored zone, not this
  -- one. A user whose local "recent 3 days" sits outside this nominal
  -- window because their zone differs from p_timezone is still covered
  -- correctly by the padded scan bounds two paragraphs down.
  v_to := coalesce(p_to, (now() at time zone p_timezone)::date);
  v_from := coalesce(p_from, v_to - 2);

  if v_from > v_to then
    raise exception 'recompute_daily_rollups: p_from (%) is after p_to (%)', v_from, v_to
      using errcode = '22023';
  end if;

  -- Padded by the full IANA UTC-offset range (-12:00 to +14:00) so every
  -- user's real per-zone local-date range is fully inside this scan window
  -- regardless of what zone their profile has, then the exact per-user
  -- [p_from, p_to] filter happens in the CTEs below.
  v_lo := (v_from::timestamp) at time zone p_timezone - interval '14 hours';
  v_hi := ((v_to + 1)::timestamp) at time zone p_timezone + interval '12 hours';

  perform pg_advisory_xact_lock(hashtext('mtdo.recompute_daily_rollups'));

  with
  task_events as (
    select
      e.user_id,
      e.room_id,
      -- PER-USER ZONE. coalesce(profile, param): a user with no profile row
      -- (should not happen post-0001's handle_new_user trigger, but this is
      -- a security-definer aggregate over every user's data and must not
      -- 500 on a hypothetically missing one) or an unset timezone (the
      -- 0013 default is 'UTC' so this coalesce is almost always redundant
      -- in practice, but is the same defensive pattern as the rest of this
      -- function) falls back to p_timezone, matching 0009's exact prior
      -- behavior for anyone who never set a personal zone.
      (e.occurred_at at time zone coalesce(p.timezone, p_timezone))::date as day,
      coalesce(nullif(e.payload ->> 'block_id', ''), e.id::text) as block_key,
      e.kind,
      e.occurred_at,
      e.id
    from public.activity_events e
    left join public.profiles p on p.id = e.user_id
    where e.kind in ('task_completed', 'task_regressed')
      and e.occurred_at >= v_lo
      and e.occurred_at < v_hi
      -- Exact per-user filter, applied after the per-user day is known.
      -- Cheap here: the padded window above has already done the real
      -- narrowing via the sargable index scan.
      and (e.occurred_at at time zone coalesce(p.timezone, p_timezone))::date
        between v_from and v_to
  ),
  task_final as (
    select distinct on (user_id, room_id, day, block_key)
      user_id, room_id, day, kind
    from task_events
    order by user_id, room_id, day, block_key, occurred_at desc, id desc
  ),
  tasks as (
    select
      user_id,
      room_id,
      day,
      count(*) filter (where kind = 'task_completed') as blocks_done
    from task_final
    group by user_id, room_id, day
  ),
  sessions as (
    select
      s.user_id,
      s.room_id,
      (s.started_at at time zone coalesce(p.timezone, p_timezone))::date as day,
      sum(
        least(
          greatest(0, floor(extract(epoch from (s.completed_at - s.started_at)))::bigint),
          s.planned_duration_s::bigint
        )
      ) as focus_seconds,
      count(*) filter (where s.state = 'completed') as sessions_completed
    from public.focus_sessions s
    left join public.profiles p on p.id = s.user_id
    where s.state in ('completed', 'abandoned')
      and s.completed_at is not null
      and s.started_at >= v_lo
      and s.started_at < v_hi
      and (s.started_at at time zone coalesce(p.timezone, p_timezone))::date
        between v_from and v_to
    group by s.user_id, s.room_id, (s.started_at at time zone coalesce(p.timezone, p_timezone))::date
  ),
  merged as (
    select
      coalesce(t.user_id, s.user_id) as user_id,
      coalesce(t.room_id, s.room_id) as room_id,
      coalesce(t.day, s.day) as day,
      coalesce(t.blocks_done, 0) as blocks_done,
      coalesce(s.focus_seconds, 0) as focus_seconds,
      coalesce(s.sessions_completed, 0) as sessions_completed
    from tasks t
    full join sessions s
      on t.user_id = s.user_id
     and t.room_id is not distinct from s.room_id
     and t.day = s.day
  )
  insert into public.daily_rollups
    (user_id, date, room_id, blocks_done, focus_seconds, sessions_completed, computed_at)
  select
    m.user_id,
    m.day,
    m.room_id,
    m.blocks_done::integer,
    m.focus_seconds::integer,
    m.sessions_completed::integer,
    now()
  from merged m
  on conflict on constraint daily_rollups_key do update
    set blocks_done = excluded.blocks_done,
        focus_seconds = excluded.focus_seconds,
        sessions_completed = excluded.sessions_completed,
        computed_at = excluded.computed_at;

  get diagnostics v_rows = row_count;
  return v_rows;
end;
$$;

alter function public.recompute_daily_rollups(date, date, text) owner to postgres;
revoke execute on function public.recompute_daily_rollups(date, date, text)
  from public, anon, authenticated;
grant execute on function public.recompute_daily_rollups(date, date, text)
  to service_role;

comment on function public.recompute_daily_rollups(date, date, text) is
  'Materializes daily_rollups from activity_events (task completions) and focus_sessions (focus time). Each user''s rows are bucketed into local dates using THAT user''s own profiles.timezone (falling back to p_timezone for a user with none), not one shared zone for everyone -- see 0013. Idempotent full replace per (user_id, date, room_id); returns the number of rollup rows written. Service role only. See supabase/migrations/0009, 0013 and docs/architecture/api.md §3a.';
