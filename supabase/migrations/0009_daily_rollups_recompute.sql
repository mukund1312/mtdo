-- The recompute job for daily_rollups (mtdo-bugs #93).
--
-- 0001_seam.sql created the table, its RLS (select-own) and its grants
-- (select only, to authenticated) and left a comment saying it would be
-- "written by a future service-role recompute job". This is that job. Until
-- now nothing wrote a single row, so the Progress heatmap (mtdo-bugs #89,
-- docs/designs/wave1-frontend-briefs.md §3) could only ever render its empty
-- state no matter how correct the UI was.
--
-- WHY A SCHEDULED RECOMPUTE AND NOT A TRIGGER ON THE LEDGER
-- A trigger on activity_events insert that incremented counters was the
-- obvious alternative and is wrong here for three separate reasons:
--   1. It puts aggregation on the user's write path. append_event() runs
--      inside start_session()/complete_session()/record_event(); a trigger
--      that errors -- a check violation, a lock wait, a bad payload cast --
--      would fail the user's session or task write for the sake of a derived
--      number. The ledger append must not be able to fail for a rollup's
--      sake.
--   2. Incremental counters drift and cannot self-heal. Any missed, double-
--      fired or out-of-order increment is permanent, because the only way to
--      repair it is... a full recompute. So the recompute has to exist
--      anyway, at which point the trigger is a second, divergeable write
--      path into a table whose whole design rule is "derived, NEVER
--      hand-written (D13)".
--   3. daily_rollups.computed_at exists specifically so a reader can tell
--      "zero because nothing happened" from "zero because it hasn't run".
--      That column is job-shaped; a trigger would make it meaningless.
-- This function is therefore a pure, idempotent, full REPLACE of every
-- (user_id, date, room_id) row in a bounded date window. Running it twice
-- produces the same numbers; running it after a backfill of old events
-- corrects the old rows. It never reads its own output.
--
-- WHERE THE SCHEDULE LIVES
-- Deliberately not in this file. The unit of correctness is this function;
-- how often it is invoked is a deployment detail, and pinning it to one
-- mechanism here would make the correctness depend on that mechanism being
-- available. 0010 attaches pg_cron when the extension is present, and any
-- external caller (Supabase Edge Function, Vercel cron route) can drive the
-- exact same function with a service-role key instead -- see
-- docs/architecture/api.md §3a.

-- Window scans for the job. Both existing indexes on these tables lead with
-- user_id (activity_events_user_occurred_idx,
-- activity_events_user_kind_occurred_idx, focus_sessions_user_state_idx),
-- which is right for "this user's recent rows" and useless for the job's
-- access pattern: "every user's rows in this time window". Without these the
-- job seq-scans the whole ledger every run, which is fine today and stops
-- being fine at exactly the point where nobody is watching.
create index activity_events_occurred_idx on activity_events (occurred_at);
create index focus_sessions_started_idx on focus_sessions (started_at);

create function public.recompute_daily_rollups(
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
  -- Half-open [v_lo, v_hi) instant bounds for the requested local-date range.
  -- The date predicates are expressed against these rather than as
  -- `(occurred_at at time zone tz)::date between ...` so they can actually
  -- use the indexes above -- a function call on the indexed column is not
  -- sargable, and this job's cost is entirely in those two window scans.
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

  -- Fail with something readable instead of an "unrecognized time zone"
  -- error thrown from the middle of the aggregate query.
  begin
    perform now() at time zone p_timezone;
  exception when invalid_parameter_value or invalid_datetime_format then
    raise exception 'recompute_daily_rollups: unknown time zone %', p_timezone
      using errcode = '22023';
  end;

  -- Default window: today and the two days before it, in the bucketing zone.
  -- Three days rather than one because a rollup row can still change after
  -- its own date has passed: a session started at 23:50 and settled at 00:10
  -- belongs to the earlier day (see the attribution note below), and a
  -- session left running overnight is not settled -- and so contributes
  -- nothing -- until the user comes back the next day and abandons it.
  v_to := coalesce(p_to, (now() at time zone p_timezone)::date);
  v_from := coalesce(p_from, v_to - 2);

  if v_from > v_to then
    raise exception 'recompute_daily_rollups: p_from (%) is after p_to (%)', v_from, v_to
      using errcode = '22023';
  end if;

  v_lo := (v_from::timestamp) at time zone p_timezone;
  v_hi := ((v_to + 1)::timestamp) at time zone p_timezone;

  -- Serialize recomputes against each other. Two overlapping runs (the cron
  -- tick landing on top of a manual backfill) would upsert the same
  -- (user_id, date, room_id) rows in different orders and can deadlock; they
  -- would also each be writing a correct-but-different-window answer over
  -- the other. Transaction-scoped, so it releases on commit or on any raise
  -- below -- same pattern and same reasoning as activate_plan() (0005).
  -- Blocking rather than pg_try_advisory_xact_lock: a backfill that silently
  -- did nothing because a cron tick held the lock is a far worse failure
  -- than one that waits a few seconds.
  perform pg_advisory_xact_lock(hashtext('mtdo.recompute_daily_rollups'));

  with
  -- ---- task facts: from the ledger ------------------------------------
  -- SOURCE CHOICE. blocks.status = 'done' is the tempting shortcut and is
  -- not usable: blocks is an ordinary client-writable table under RLS, so
  -- completed_at is whatever the client says it is and can be back-dated
  -- freely. task_completed's occurred_at is stamped by append_event() from
  -- the server clock into an append-only table (schema.md §4). Same reason
  -- schema.md already flags blocks.elapsed_seconds as an untrustworthy
  -- mirror for focus time.
  task_events as (
    select
      e.user_id,
      e.room_id,
      (e.occurred_at at time zone p_timezone)::date as day,
      -- DEDUP KEY. Blocks are identified by payload->>'block_id' (the
      -- contract for these two kinds, api.md §2d). Events that carry no
      -- block_id fall back to the ledger's own id, which makes each of them
      -- its own key -- so a malformed event is counted once on its own
      -- rather than either being dropped or collapsing every other
      -- block_id-less event of that day into a single unit. nullif() so an
      -- empty-string block_id takes that same path: without it, every such
      -- event in a day would share the key '' and collapse to one, which is
      -- a silent undercount rather than a visible one.
      coalesce(nullif(e.payload ->> 'block_id', ''), e.id::text) as block_key,
      e.kind,
      e.occurred_at,
      e.id
    from public.activity_events e
    where e.kind in ('task_completed', 'task_regressed')
      and e.occurred_at >= v_lo
      and e.occurred_at < v_hi
  ),
  -- Last event per block per day wins. This is what keeps the number
  -- honest in both directions, and DESIGN.md's "the app never exaggerates
  -- the user's record" is not a suggestion: completing the same block five
  -- times (a double-fired click, an over-eager re-render) counts once, and
  -- completing then un-completing a block within the day counts zero.
  -- Scoped to the day on purpose -- a block completed Monday and regressed
  -- Tuesday leaves Monday's cell alone. Monday's record is "you finished a
  -- block on Monday", and Tuesday's correction of the block's state is not
  -- a claim that Monday's work never happened. It also means past heatmap
  -- cells do not silently change under the user.
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
  -- ---- session facts: from focus_sessions -----------------------------
  -- SOURCE CHOICE, and a deliberate departure from the literal wording of
  -- mtdo-bugs #93 ("aggregates activity_events"). The session_completed /
  -- session_abandoned ledger events and these rows cannot diverge -- both
  -- are written by settle_session() inside one transaction, and neither
  -- table has a client write path (schema.md §5) -- so this is not a second
  -- source of truth, it is the typed projection of the same one. What the
  -- table has that the ledger does not:
  --   * started_at, which the events do not carry at all and which is the
  --     attribution timestamp this job actually needs (below);
  --   * typed, constraint-backed columns. The ledger's elapsed_s and
  --     planned_duration_s live in a jsonb payload with no constraint on
  --     them; reading focus time out of `payload->>'elapsed_s'` would
  --     silently start producing NULLs the day that payload's shape
  --     changed, and a heatmap that quietly reads zero is the worst
  --     possible failure for this table.
  -- D14 still holds: the ledger remains the record of what happened. This
  -- reads the server-authoritative session rows for the numbers, which is
  -- the same guarantee the events derive from.
  sessions as (
    select
      s.user_id,
      s.room_id,
      -- ATTRIBUTION: the day the session STARTED, not the day it settled.
      -- These differ in the two cases that matter and the start day is the
      -- honest answer in both: a session spanning midnight (counted whole
      -- on the day the work began -- splitting it across the boundary is
      -- not worth the complexity for a day-granularity heatmap), and a
      -- session left running overnight because the user closed the tab,
      -- which start_session()'s 55006 recovery contract has them abandon
      -- the *next* day. Attributing that by settle time would credit
      -- yesterday's work to today.
      (s.started_at at time zone p_timezone)::date as day,
      -- CAP AT PLANNED. settle_session() measures elapsed from the
      -- server-stamped started_at, and its own comment anticipates this:
      -- "planned_duration_s ships alongside it so the job can decide its
      -- own policy (e.g. least(elapsed, planned)) for a session left open
      -- long past its planned end." A 25-minute block whose tab stayed open
      -- for nine hours is 25 minutes of focus, not nine hours. Recomputed
      -- here from the two server-stamped columns rather than read out of
      -- the event payload -- identical by construction, same formula.
      sum(
        least(
          greatest(0, floor(extract(epoch from (s.completed_at - s.started_at)))::bigint),
          s.planned_duration_s::bigint
        )
      ) as focus_seconds,
      -- Completed only. An abandoned session's real elapsed time still
      -- counts toward focus_seconds -- the user was there -- but it is not
      -- a completed session and this column must not say it was.
      count(*) filter (where s.state = 'completed') as sessions_completed
    from public.focus_sessions s
    where s.state in ('completed', 'abandoned')
      and s.completed_at is not null
      and s.started_at >= v_lo
      and s.started_at < v_hi
    group by s.user_id, s.room_id, (s.started_at at time zone p_timezone)::date
  ),
  -- FULL join: a day can have task completions with no session (a block
  -- ticked off without a timer) or a session with no task completions
  -- (unscheduled focus). `is not distinct from` on room_id, not `=` --
  -- room_id is null for every row today and `null = null` would drop every
  -- match, which is a bug that would not appear until W4a sets one.
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
  -- The NULLS NOT DISTINCT unique constraint from 0001 is the conflict
  -- target, which is exactly what its comment there said it was for: one
  -- ON CONFLICT target instead of a separate code path for the solo
  -- (room_id is null) rows and the room rows.
  on conflict on constraint daily_rollups_key do update
    set blocks_done = excluded.blocks_done,
        focus_seconds = excluded.focus_seconds,
        sessions_completed = excluded.sessions_completed,
        -- Bumped even when the numbers are unchanged, deliberately: this
        -- column's job is to answer "how fresh is this row", not "when did
        -- it last change". A reader deciding whether the heatmap is stale
        -- needs the former, so there is no `where ... is distinct from`
        -- guard suppressing the no-op updates.
        computed_at = excluded.computed_at;

  get diagnostics v_rows = row_count;
  return v_rows;
end;
$$;

alter function public.recompute_daily_rollups(date, date, text) owner to postgres;

-- `from public` alone is not enough -- anon and authenticated hold their own
-- explicit EXECUTE grant from Supabase's default privileges, and must be
-- revoked by name (0001's security-model header, consequence 2). Nothing
-- here is exploitable in the "write another user's row" sense (the function
-- takes no user id and derives everything from the source tables), but it is
-- an unbounded full-window aggregate over every user's ledger, and a client
-- that can call it at will has a free amplification lever against the
-- database. Service role only.
revoke execute on function public.recompute_daily_rollups(date, date, text)
  from public, anon, authenticated;
grant execute on function public.recompute_daily_rollups(date, date, text)
  to service_role;

comment on function public.recompute_daily_rollups(date, date, text) is
  'Materializes daily_rollups from activity_events (task completions) and focus_sessions (focus time) for the local-date window [p_from, p_to] in p_timezone, defaulting to the last three days in UTC. Idempotent full replace per (user_id, date, room_id); returns the number of rollup rows written. Service role only. See supabase/migrations/0009 and docs/architecture/api.md §3a.';
