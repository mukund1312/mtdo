-- Focus Mode, round two: pause/resume, scheduled breaks, mid-session
-- extension, and the block-status outcome that settling a session has never
-- had. Sessions stay server-authoritative (D12) -- every new write here is an
-- RPC, and `focus_sessions` keeps SELECT-only grants.
--
-- THE ONE ASSUMPTION THIS MIGRATION BREAKS, stated up front because two other
-- migrations silently depend on it: until now a settled session's focus time
-- was `least(completed_at - started_at, planned_duration_s)`, which is only
-- correct because nothing could stop the clock. Pause introduces gaps. Both
-- existing consumers (0009's recompute_daily_rollups, 0021's
-- weekly_performance) are rewritten below to call one shared helper instead of
-- each spelling the formula out, so the next change to it cannot reach one and
-- miss the other. That drift is not hypothetical: the two copies of the
-- formula today already differ in return type (bigint vs numeric) and in
-- whether they clamp negatives.
--
-- ---------------------------------------------------------------------------
-- WHY PAUSE IS NOT A NEW `state` VALUE
-- ---------------------------------------------------------------------------
-- A paused session is still an open session: it holds the user's one-running
-- slot, it can be completed or abandoned directly from paused, and a tab that
-- dies mid-pause must be recoverable. Modeling it as `state = 'paused'` would
-- have meant touching all four of the invariants that make §5 trustworthy --
-- focus_sessions_one_running, focus_sessions_state_completed_at,
-- settle_session()'s `state = 'running'` guard, and start_session()'s 55006
-- conflict probe -- and would have silently broken the client's existing
-- stale-session recovery query (`.eq('state','running')`, session/page.tsx),
-- which would stop finding a paused session and happily start a second one.
--
-- So pause is a sub-state: `paused_at is not null` on a session that is still
-- `running`. Zero invariants change, every existing consumer keeps working,
-- and the recovery contract keeps holding for a session paused two days ago.

-- 1. the new columns -------------------------------------------------------

alter table public.focus_sessions
  -- Null = the clock is running. Non-null = when it stopped. Never survives
  -- settling: settle_session() folds the open interval into total_paused_s
  -- and clears this, so a settled row always carries its full paused total in
  -- one place rather than in one column plus an implied open interval.
  add column paused_at timestamptz,
  -- Accumulated, closed paused intervals in seconds.
  add column total_paused_s integer not null default 0,
  -- How much of planned_duration_s arrived via extend_session() rather than
  -- being committed to up front. planned_duration_s itself is bumped (it is
  -- the cap every consumer already reads, and an accepted extension is real
  -- time the user really committed to), so this exists purely so reporting can
  -- still tell "planned 25, then asked for 10 more" from "planned 35" -- the
  -- difference between those two is a genuine signal about estimation, and
  -- collapsing them would destroy it irrecoverably.
  add column extended_s integer not null default 0,
  -- The session's configured work/break pattern, frozen at start. See the
  -- BREAKS ARE SCHEDULED PAUSES note below for the shape and for why this is
  -- persisted rather than held in the browser.
  add column break_plan jsonb;

alter table public.focus_sessions
  add constraint focus_sessions_total_paused_nonneg check (total_paused_s >= 0),
  add constraint focus_sessions_extended_nonneg check (extended_s >= 0),
  -- A settled session is never left mid-pause. Without this, a row could
  -- claim to be both completed and currently paused, and session_focus_seconds
  -- would under-report it forever with nothing to flag the inconsistency.
  add constraint focus_sessions_paused_only_while_running
    check (paused_at is null or state = 'running'),
  -- Structural only; start_session() does the real validation with a readable
  -- error. Both exist for the same reason the block-ownership probe does.
  add constraint focus_sessions_break_plan_is_object
    check (break_plan is null or jsonb_typeof(break_plan) = 'object');

comment on column public.focus_sessions.paused_at is
  'When the clock was stopped, or NULL while it runs. A paused session is still state = ''running'' -- pause is a sub-state, not a fourth state (see migrations/0023''s header for why). Cleared by resume_session() and by settling, both of which fold the open interval into total_paused_s.';
comment on column public.focus_sessions.total_paused_s is
  'Accumulated closed paused intervals, seconds. Subtracted from wall-clock elapsed by session_focus_seconds(), which is the only thing any consumer should use to turn a session into focus time.';
comment on column public.focus_sessions.extended_s is
  'How many of planned_duration_s''s seconds were added mid-session by extend_session(). planned_duration_s already includes them; this records how the user got there.';
comment on column public.focus_sessions.break_plan is
  'Frozen-at-start break schedule: {"breaks":[{"at_s":900,"duration_s":300}, ...]}. at_s is FOCUS seconds elapsed (paused time excluded), not wall clock, so a manual pause shifts the whole schedule with the user rather than eating a break. NULL = no scheduled breaks.';

-- 2. the one formula -------------------------------------------------------

-- Every consumer of "how much focus time was this session worth" calls this.
-- Two rules, both inherited unchanged from the code it replaces:
--   * paused time is not focus time (new -- the whole point of this migration);
--   * the result is capped at planned_duration_s, so a tab left open for nine
--     hours after a 25-minute block is 25 minutes (0009's CAP AT PLANNED note,
--     DESIGN.md's "the app never exaggerates the user's record").
-- IMMUTABLE and given plain scalar arguments rather than a focus_sessions row:
-- callers pass columns, and an immutable scalar function inlines into the
-- aggregate queries in 0009/0021 instead of forcing a per-row call.
create function public.session_focus_seconds(
  p_started_at timestamptz,
  p_completed_at timestamptz,
  p_total_paused_s integer,
  p_planned_duration_s integer
)
returns integer
language sql
immutable
set search_path = ''
as $$
  select least(
    greatest(
      0,
      floor(extract(epoch from (p_completed_at - p_started_at)))::bigint
        - coalesce(p_total_paused_s, 0)::bigint
    ),
    p_planned_duration_s::bigint
  )::integer
$$;

alter function public.session_focus_seconds(timestamptz, timestamptz, integer, integer)
  owner to postgres;
-- Pure arithmetic over values the caller already holds; reads nothing, so
-- there is nothing to leak and no reason to lock it down.
grant execute on function public.session_focus_seconds(timestamptz, timestamptz, integer, integer)
  to authenticated, service_role;

comment on function public.session_focus_seconds(timestamptz, timestamptz, integer, integer) is
  'The single definition of a settled session''s focus time: wall clock minus accumulated paused seconds, capped at planned_duration_s, floored at 0. recompute_daily_rollups(), weekly_performance() and settle_session()''s ledger payload all call this -- do not re-spell the formula anywhere.';

-- 3. the ledger gains three kinds ------------------------------------------

-- Server-minted like every other session_* kind, and deliberately NOT added to
-- record_event()'s client-appendable whitelist: pause is what makes focus time
-- honest, so a client that could self-report "I resumed" could farm it, which
-- is the exact thing D17's server-minted rule exists to prevent.
alter table public.activity_events
  drop constraint activity_events_kind_check,
  add constraint activity_events_kind_check check (kind in (
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
    'session_paused',
    'session_resumed',
    'session_extended',
    'tutor_message_sent'
  ));

-- 4. pause / resume --------------------------------------------------------
--
-- ---------------------------------------------------------------------------
-- BREAKS ARE SCHEDULED PAUSES -- one mechanic, not two
-- ---------------------------------------------------------------------------
-- A break and a pause do exactly the same thing to the only thing the server
-- owns: they stop the clock. The single difference is who decided when -- a
-- break was planned at start, a pause was chosen in the moment. That is a
-- property of the *reason*, not of the mechanism, so there is one pair of RPCs
-- and a `p_reason` tag on the ledger event rather than a parallel
-- start_break/end_break pair that would need its own interval accounting,
-- its own settle-time cleanup, and its own bugs.
--
-- The schedule itself IS persisted (break_plan), which is the half of the
-- brief's option (a)/(b) split that had a real argument on both sides. Option
-- (a) -- client-computed auto-triggers, no schema -- is genuinely cheaper and
-- the server needs nothing from the plan to be correct. But a session's break
-- points are exactly as much "what this session is" as planned_duration_s is,
-- and planned_duration_s is already persisted for one reason: the client is
-- not trusted to remember it across a reload, a phone sleep, or a reconnect
-- (D12). A user who configures 45min + 2x5min, reloads at minute 30, and finds
-- their breaks gone has hit the precise failure this whole subsystem exists to
-- prevent -- and would hit it silently, with the timer still looking correct.
-- One nullable jsonb column is a very cheap way not to have that bug.
--
-- at_s is measured in FOCUS seconds (paused time excluded), not wall clock, so
-- that a manual pause slides the remaining breaks along with the user instead
-- of consuming one. The client computes "is a break due" as
-- `focus_elapsed >= at_s`, where focus_elapsed is
-- `now() - started_at - total_paused_s - (now() - paused_at if paused)`.

create function public.pause_session(p_id uuid, p_reason text default 'manual')
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
    raise exception 'pause_session: no authenticated user' using errcode = '42501';
  end if;

  if p_reason is null or p_reason not in ('manual', 'break') then
    raise exception 'pause_session: reason must be manual or break' using errcode = '22023';
  end if;

  -- Ownership is the WHERE clause, not RLS: this runs as its owner and is
  -- exempt from RLS (same rule as settle_session()).
  --
  -- `paused_at is null` in the predicate makes a double-pause a no-op that
  -- fails loudly rather than silently resetting the pause start and erasing
  -- however long the user was already away. A scheduled break firing while
  -- the user happens to have manually paused is a real race, not a
  -- hypothetical one, and losing time to it would inflate focus_seconds --
  -- the one direction this system must never be wrong in.
  update public.focus_sessions s
     set paused_at = now()
   where s.id = p_id
     and s.user_id = v_uid
     and s.state = 'running'
     and s.paused_at is null
  returning * into v_row;

  if v_row.id is null then
    -- Same non-disclosure rule as settle_session(): "not yours", "not
    -- running" and "already paused" are one error, because distinguishing
    -- them confirms another user's session id exists.
    raise exception 'pause_session: no running, unpaused session % for this user', p_id
      using errcode = '42501';
  end if;

  perform public.append_event(
    v_uid,
    'session_paused',
    jsonb_build_object(
      'block_id', v_row.block_id,
      'reason', p_reason,
      -- Focus seconds banked so far. Computed against now() rather than a
      -- completion that has not happened, and capped the same way the settled
      -- number will be, so a reader of the ledger alone sees the same scale.
      'focus_s_so_far', public.session_focus_seconds(
        v_row.started_at, now(), v_row.total_paused_s, v_row.planned_duration_s
      )
    ),
    v_row.id
  );

  return v_row;
end;
$$;

alter function public.pause_session(uuid, text) owner to postgres;
revoke execute on function public.pause_session(uuid, text) from public, anon, authenticated;
grant execute on function public.pause_session(uuid, text) to authenticated;

create function public.resume_session(p_id uuid)
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
    raise exception 'resume_session: no authenticated user' using errcode = '42501';
  end if;

  -- greatest(0, ...) on the interval: a backwards clock jump between pause and
  -- resume must never *reduce* total_paused_s, which would hand the user free
  -- focus time. now() is transaction-start time and started_at/paused_at are
  -- server-stamped, so this is defensive rather than expected -- but the
  -- failure it guards is silent and permanent, and the guard is free.
  update public.focus_sessions s
     set total_paused_s = s.total_paused_s
           + greatest(0, floor(extract(epoch from (now() - s.paused_at)))::integer),
         paused_at = null
   where s.id = p_id
     and s.user_id = v_uid
     and s.state = 'running'
     and s.paused_at is not null
  returning * into v_row;

  if v_row.id is null then
    raise exception 'resume_session: no paused session % for this user', p_id
      using errcode = '42501';
  end if;

  perform public.append_event(
    v_uid,
    'session_resumed',
    jsonb_build_object(
      'block_id', v_row.block_id,
      'total_paused_s', v_row.total_paused_s
    ),
    v_row.id
  );

  return v_row;
end;
$$;

alter function public.resume_session(uuid) owner to postgres;
revoke execute on function public.resume_session(uuid) from public, anon, authenticated;
grant execute on function public.resume_session(uuid) to authenticated;

-- 5. extend_session --------------------------------------------------------

-- "Do you need more time to finish this task?" -- accepted. The *prompt's*
-- timing (last N minutes) is entirely the client's business; this is only what
-- applying the answer calls. Allowed while paused, because a user who paused
-- to think and then realises they need longer is a completely ordinary thing
-- to do and refusing it would be an arbitrary rule the UI would have to
-- explain.
create function public.extend_session(p_id uuid, p_additional_s integer)
returns public.focus_sessions
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_row public.focus_sessions;
  v_current integer;
begin
  if v_uid is null then
    raise exception 'extend_session: no authenticated user' using errcode = '42501';
  end if;

  if p_additional_s is null or p_additional_s <= 0 or p_additional_s > 86400 then
    raise exception 'extend_session: additional_s must be between 1 and 86400'
      using errcode = '22023';
  end if;

  -- Read the current cap before the update so the ceiling can be reported as a
  -- readable 22023 rather than surfacing focus_sessions_planned_duration_sane
  -- as an opaque 23514 the UI would have to pattern-match on. Locked, so a
  -- double-tapped "add 10 minutes" cannot read the same starting value twice
  -- and let the pair sneak past the ceiling together.
  select s.planned_duration_s into v_current
    from public.focus_sessions s
   where s.id = p_id and s.user_id = v_uid and s.state = 'running'
   for update;

  if v_current is null then
    raise exception 'extend_session: no running session % for this user', p_id
      using errcode = '42501';
  end if;

  if v_current + p_additional_s > 86400 then
    raise exception 'extend_session: planned_duration_s would exceed 86400 (currently %)', v_current
      using errcode = '22023';
  end if;

  update public.focus_sessions s
     set planned_duration_s = s.planned_duration_s + p_additional_s,
         extended_s = s.extended_s + p_additional_s
   where s.id = p_id
     and s.user_id = v_uid
     and s.state = 'running'
  returning * into v_row;

  perform public.append_event(
    v_uid,
    'session_extended',
    jsonb_build_object(
      'block_id', v_row.block_id,
      'additional_s', p_additional_s,
      'planned_duration_s', v_row.planned_duration_s,
      'extended_s', v_row.extended_s
    ),
    v_row.id
  );

  return v_row;
end;
$$;

alter function public.extend_session(uuid, integer) owner to postgres;
revoke execute on function public.extend_session(uuid, integer) from public, anon, authenticated;
grant execute on function public.extend_session(uuid, integer) to authenticated;

-- 6. the block outcome -----------------------------------------------------
--
-- ---------------------------------------------------------------------------
-- WHY THIS IS AN RPC EVEN THOUGH `blocks` IS CLIENT-WRITABLE
-- ---------------------------------------------------------------------------
-- Checked rather than assumed: `blocks_owner_all` (0001) is a `for all` policy
-- and `blocks` keeps full CRUD grants, so a client genuinely *can*
-- `.update({ status, notes })` -- session/page.tsx already does exactly that
-- to mark a block in_progress at start. So this is not an RLS workaround.
-- It is an RPC for a different, sharper reason:
--
--   `blocks.status` is NOT what decides whether a task counts as done.
--   weekly_performance() (0021) reads the LEDGER's verdict -- the last
--   task_completed/task_regressed event for that block -- and only falls back
--   to blocks.status for a block the ledger has never seen. A client that set
--   status = 'done' without minting task_completed would therefore be visible
--   on the Kanban board and invisible to Phase 7 for any block that had ever
--   been touched by the ledger. The status write and the ledger event are one
--   fact and must be one transaction; two client calls (which is what
--   today-deck.tsx does today) can half-apply.
--
-- ---------------------------------------------------------------------------
-- WHY task_regressed IS CONDITIONAL -- the bug this nearly shipped
-- ---------------------------------------------------------------------------
-- weekly_performance() computes postponement_count as regressed_count +
-- stale_open_count. Minting task_regressed on every "something's left" answer
-- would mean every honest, ordinary unfinished session permanently inflates
-- that user's postponement signal -- the engine would read a person who works
-- steadily on hard tasks as someone who keeps putting things off, and would
-- act on it. So task_regressed is minted ONLY when the block was actually
-- done before (per the ledger, falling back to blocks.status exactly as 0021
-- does) and is now being walked back. A task that was never done moving to
-- in_progress is not a regression, and the ledger does not claim it is.
--
-- ---------------------------------------------------------------------------
-- NO ADVISORY LOCK, and the reasoning rather than the omission
-- ---------------------------------------------------------------------------
-- The per-user lock (activate_plan, 0005) exists where one statement must be
-- consistent against a *set* of the user's rows -- exactly one active plan,
-- one coherent curriculum menu. Nothing like that is true here: this writes
-- one block row and appends one event, and Postgres' own row lock on that
-- block already serializes two concurrent calls. The two orderings both end
-- with the same status and with a ledger whose LAST verdict matches it, which
-- is the only property any reader depends on. Taking hashtext(uid) would
-- queue a one-row status update behind plan activation and curriculum picks
-- for no correctness gain, so it is deliberately not taken.

create function public.settle_block_outcome(
  p_session_id uuid,
  p_outcome text,
  p_leftover_note text default null
)
returns public.blocks
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_session public.focus_sessions;
  v_block public.blocks;
  v_was_done boolean;
  v_note text;
  v_tz text;
begin
  if v_uid is null then
    raise exception 'settle_block_outcome: no authenticated user' using errcode = '42501';
  end if;

  if p_outcome is null or p_outcome not in ('done', 'in_progress') then
    raise exception 'settle_block_outcome: outcome must be done or in_progress'
      using errcode = '22023';
  end if;

  -- Must be a SETTLED session of this user's. Deferring the outcome until
  -- after the session closes is the founder's flow ("time runs out, session
  -- closes, THEN it asks"), so this deliberately does not require the session
  -- to be recent -- but it does require it to be over, because "what happened
  -- to the task" is not a question about a session still in progress.
  select * into v_session
    from public.focus_sessions s
   where s.id = p_session_id
     and s.user_id = v_uid
     and s.state in ('completed', 'abandoned');

  if v_session.id is null then
    raise exception 'settle_block_outcome: no settled session % for this user', p_session_id
      using errcode = '42501';
  end if;

  -- An unlinked session (Home's generic "Start focus") has no task whose
  -- status could change. Returning NULL rather than raising: the client
  -- should be able to run the same outcome flow for every session without
  -- first branching on whether one happened to be linked.
  if v_session.block_id is null then
    return null;
  end if;

  -- 0021's exact done-ness rule, reused rather than re-derived: the ledger's
  -- last verdict wins where it has one, blocks.status only where it does not.
  select
    coalesce(
      (select e.kind = 'task_completed'
         from public.activity_events e
        where e.user_id = v_uid
          and e.kind in ('task_completed', 'task_regressed')
          and e.payload->>'block_id' = v_session.block_id::text
        order by e.occurred_at desc, e.id desc
        limit 1),
      b.status = 'done'
    )
  into v_was_done
  from public.blocks b
  where b.id = v_session.block_id and b.user_id = v_uid;

  v_note := nullif(btrim(coalesce(p_leftover_note, '')), '');

  if v_note is not null then
    if p_outcome <> 'in_progress' then
      -- A note that says what is left only makes sense on the path where
      -- something is left. Silently dropping it would lose the user's typing.
      raise exception 'settle_block_outcome: a leftover note only applies to the in_progress outcome'
        using errcode = '22023';
    end if;
    if length(v_note) > 2000 then
      raise exception 'settle_block_outcome: leftover note must be 2000 characters or fewer'
        using errcode = '22023';
    end if;

    select coalesce(p.timezone, 'UTC') into v_tz
      from public.profiles p where p.id = v_uid;
    v_tz := coalesce(v_tz, 'UTC');
  end if;

  update public.blocks b
     set status = p_outcome,
         -- APPEND, never overwrite. blocks.notes is an ordinary user-editable
         -- field that the session screen already renders as the task's
         -- description -- clobbering it would destroy text the user wrote
         -- somewhere else entirely, and there is no undo. Dated so a note from
         -- three sessions ago reads as history rather than as current state.
         notes = case
           when v_note is null then b.notes
           when nullif(btrim(coalesce(b.notes, '')), '') is null
             then to_char((now() at time zone v_tz)::date, 'YYYY-MM-DD') || ' — ' || v_note
           else b.notes || E'\n\n'
                || to_char((now() at time zone v_tz)::date, 'YYYY-MM-DD') || ' — ' || v_note
         end,
         -- The block is no longer claimed by a live timer either way: the
         -- session that claimed it is over.
         claimed = false
   where b.id = v_session.block_id
     and b.user_id = v_uid
  returning * into v_block;

  if v_block.id is null then
    -- The composite FK sets block_id to NULL when a block is deleted, so this
    -- is only reachable in a genuine race (the block deleted between the
    -- session read and this update). Not an ownership failure.
    raise exception 'settle_block_outcome: block for session % is no longer available', p_session_id
      using errcode = '42501';
  end if;

  if p_outcome = 'done' and not v_was_done then
    perform public.append_event(
      v_uid, 'task_completed',
      jsonb_build_object('block_id', v_block.id::text, 'via', 'session'),
      v_session.id
    );
  elsif p_outcome = 'in_progress' and v_was_done then
    -- See the header note: only a real walk-back mints this.
    perform public.append_event(
      v_uid, 'task_regressed',
      jsonb_build_object('block_id', v_block.id::text, 'via', 'session'),
      v_session.id
    );
  end if;

  return v_block;
end;
$$;

alter function public.settle_block_outcome(uuid, text, text) owner to postgres;
revoke execute on function public.settle_block_outcome(uuid, text, text) from public, anon, authenticated;
grant execute on function public.settle_block_outcome(uuid, text, text) to authenticated;

-- 7. settle_session gains the outcome passthrough --------------------------
--
-- Two of the three product paths know the block's fate at the moment the user
-- clicks ("End session" -> done, "Leave early" -> in_progress), and for those
-- the settle and the block transition should be one atomic call rather than
-- two round trips with a window where the session is over and the board still
-- says in-progress. The third (natural expiry) cannot know yet -- the question
-- is asked after the session closes -- and calls settle_block_outcome()
-- separately.
--
-- This is a passthrough, not a second implementation: both paths run the exact
-- same function body. DROP then CREATE rather than CREATE OR REPLACE because
-- Postgres will not add parameters via REPLACE, and leaving the old
-- two-argument form in place would make `complete_session(p_id => ...)`
-- ambiguous to PostgREST.

drop function public.complete_session(uuid);
drop function public.abandon_session(uuid);
drop function public.settle_session(uuid, text);

create function public.settle_session(
  p_id uuid,
  p_state text,
  p_block_outcome text default null,
  p_leftover_note text default null
)
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
  --
  -- `state = 'running'` still admits a PAUSED session, by design -- ending a
  -- session you walked away from is the most ordinary thing there is, and
  -- pause is a sub-state of running precisely so this guard did not have to
  -- change. The open paused interval is closed into total_paused_s in the same
  -- statement, so a session ended from paused never leaks that interval into
  -- its focus time.
  update public.focus_sessions s
     set state = p_state,
         completed_at = now(),
         total_paused_s = s.total_paused_s
           + case
               when s.paused_at is null then 0
               else greatest(0, floor(extract(epoch from (now() - s.paused_at)))::integer)
             end,
         paused_at = null
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

  -- One formula, shared with recompute_daily_rollups() and
  -- weekly_performance(). Previously spelled out here and capped downstream;
  -- now the payload carries the same number those two will compute, so the
  -- ledger and the rollups cannot disagree about a session.
  v_elapsed := public.session_focus_seconds(
    v_row.started_at, v_row.completed_at, v_row.total_paused_s, v_row.planned_duration_s
  );

  perform public.append_event(
    v_uid,
    case when p_state = 'completed' then 'session_completed' else 'session_abandoned' end,
    jsonb_build_object(
      'block_id', v_row.block_id,
      'planned_duration_s', v_row.planned_duration_s,
      -- Kept as the wall-clock measure it has always been, so a reader
      -- comparing old and new rows is not silently comparing two different
      -- quantities under one name. focus_s is the new, pause-aware number and
      -- is the one to use.
      'elapsed_s', greatest(0, floor(extract(epoch from (v_row.completed_at - v_row.started_at)))::integer),
      'focus_s', v_elapsed,
      'total_paused_s', v_row.total_paused_s,
      'extended_s', v_row.extended_s
    ),
    v_row.id
  );

  if p_block_outcome is not null then
    perform public.settle_block_outcome(p_id, p_block_outcome, p_leftover_note);
  end if;

  return v_row;
end;
$$;

alter function public.settle_session(uuid, text, text, text) owner to postgres;
-- Never granted back: p_state is a free parameter here, and the two entry
-- points below pin it to a literal.
revoke execute on function public.settle_session(uuid, text, text, text)
  from public, anon, authenticated;

create function public.complete_session(
  p_id uuid,
  p_block_outcome text default null,
  p_leftover_note text default null
)
returns public.focus_sessions
language plpgsql
security definer
set search_path = ''
as $$
begin
  return public.settle_session(p_id, 'completed', p_block_outcome, p_leftover_note);
end;
$$;

alter function public.complete_session(uuid, text, text) owner to postgres;
revoke execute on function public.complete_session(uuid, text, text) from public, anon, authenticated;
grant execute on function public.complete_session(uuid, text, text) to authenticated;

create function public.abandon_session(
  p_id uuid,
  p_block_outcome text default null,
  p_leftover_note text default null
)
returns public.focus_sessions
language plpgsql
security definer
set search_path = ''
as $$
begin
  return public.settle_session(p_id, 'abandoned', p_block_outcome, p_leftover_note);
end;
$$;

alter function public.abandon_session(uuid, text, text) owner to postgres;
revoke execute on function public.abandon_session(uuid, text, text) from public, anon, authenticated;
grant execute on function public.abandon_session(uuid, text, text) to authenticated;

-- 8. start_session accepts a break plan ------------------------------------

-- p_planned_duration_s is unchanged and was ALREADY the editable-duration
-- lever the product brief asked for -- there was never a backend gap there,
-- only the absence of a time picker in the UI. The only new parameter is the
-- break plan.
create or replace function public.start_session(
  p_block_id uuid default null,
  p_planned_duration_s integer default null,
  p_break_plan jsonb default null
)
returns public.focus_sessions
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_row public.focus_sessions;
  v_break jsonb;
  v_total_break_s bigint := 0;
  v_prev_at bigint := -1;
begin
  if v_uid is null then
    raise exception 'start_session: no authenticated user' using errcode = '42501';
  end if;

  if p_planned_duration_s is null or p_planned_duration_s <= 0 or p_planned_duration_s > 86400 then
    raise exception 'start_session: planned_duration_s must be between 1 and 86400'
      using errcode = '22023';
  end if;

  -- Validate the break plan here rather than leaning on the structural CHECK,
  -- for the same reason the block-ownership probe exists below: a readable
  -- error beats an opaque constraint violation. A malformed plan is rejected
  -- at start, when the user can still fix it, rather than surfacing as a
  -- break that silently never fires 20 minutes in.
  if p_break_plan is not null then
    -- IS DISTINCT FROM, not <>. A missing key makes `p_break_plan->'breaks'`
    -- SQL NULL, jsonb_typeof(NULL) is NULL, and `NULL <> 'array'` is NULL --
    -- not true -- so a plain <> silently accepts exactly the malformed plans
    -- this block exists to reject. Caught by test 5g.
    if jsonb_typeof(p_break_plan) is distinct from 'object'
       or jsonb_typeof(p_break_plan->'breaks') is distinct from 'array' then
      raise exception 'start_session: break_plan must be an object with a "breaks" array'
        using errcode = '22023';
    end if;

    if jsonb_array_length(p_break_plan->'breaks') > 24 then
      raise exception 'start_session: break_plan may define at most 24 breaks'
        using errcode = '22023';
    end if;

    for v_break in select * from jsonb_array_elements(p_break_plan->'breaks') loop
      -- IS DISTINCT FROM for the same NULL reason as above: a break object
      -- missing at_s or duration_s entirely is the likeliest malformed shape,
      -- and a plain <> would wave it straight through.
      if jsonb_typeof(v_break) is distinct from 'object'
         or jsonb_typeof(v_break->'at_s') is distinct from 'number'
         or jsonb_typeof(v_break->'duration_s') is distinct from 'number' then
        raise exception 'start_session: each break needs numeric at_s and duration_s'
          using errcode = '22023';
      end if;

      -- at_s is focus-seconds from the start, so a break at or past the end of
      -- the planned work would never fire -- almost certainly a units mistake
      -- (minutes passed where seconds were meant), and silently accepting it
      -- would ship a session whose configured breaks simply never happen.
      if (v_break->>'at_s')::bigint <= 0
         or (v_break->>'at_s')::bigint >= p_planned_duration_s then
        raise exception 'start_session: break at_s must be between 1 and planned_duration_s - 1'
          using errcode = '22023';
      end if;

      if (v_break->>'duration_s')::bigint <= 0
         or (v_break->>'duration_s')::bigint > 86400 then
        raise exception 'start_session: break duration_s must be between 1 and 86400'
          using errcode = '22023';
      end if;

      -- Strictly increasing. The client walks this array in order to decide
      -- what is due next; an unsorted or duplicated at_s makes that walk
      -- ambiguous, and the ambiguity would show up as a break that fires twice
      -- or not at all.
      if (v_break->>'at_s')::bigint <= v_prev_at then
        raise exception 'start_session: break at_s values must be strictly increasing'
          using errcode = '22023';
      end if;
      v_prev_at := (v_break->>'at_s')::bigint;

      v_total_break_s := v_total_break_s + (v_break->>'duration_s')::bigint;
    end loop;

    -- Work plus breaks is the session's real wall-clock footprint; keeping it
    -- inside a day matches planned_duration_s's own ceiling.
    if p_planned_duration_s + v_total_break_s > 86400 then
      raise exception 'start_session: planned_duration_s plus total break time must not exceed 86400'
        using errcode = '22023';
    end if;
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
    -- day. Deliberately an error rather than a silent auto-abandon. Note this
    -- now also covers a PAUSED session, which is still state = 'running' --
    -- exactly as intended, since a paused session is one the user may well
    -- still want to finish. errcode 55006 is distinguishable so the UI can
    -- branch on it.
    raise exception 'start_session: a session is already running'
      using errcode = '55006';
  end if;

  insert into public.focus_sessions
    (user_id, room_id, block_id, started_at, planned_duration_s, state, completed_at, break_plan)
  values (v_uid, null, p_block_id, now(), p_planned_duration_s, 'running', null, p_break_plan)
  returning * into v_row;

  perform public.append_event(
    v_uid,
    'session_started',
    jsonb_build_object(
      'block_id', p_block_id,
      'planned_duration_s', p_planned_duration_s,
      'break_count', case
        when p_break_plan is null then 0
        else jsonb_array_length(p_break_plan->'breaks')
      end
    ),
    v_row.id
  );

  return v_row;
end;
$$;

alter function public.start_session(uuid, integer, jsonb) owner to postgres;
revoke execute on function public.start_session(uuid, integer, jsonb) from public, anon, authenticated;
grant execute on function public.start_session(uuid, integer, jsonb) to authenticated;

-- CREATE OR REPLACE cannot add a parameter, so the statement above created a
-- NEW three-argument function alongside 0004's two-argument one. Both would
-- match a `{ p_block_id, p_planned_duration_s }` call and PostgREST would fail
-- the request as ambiguous, so the old form goes.
drop function public.start_session(uuid, integer);


-- 9. the two duration consumers, now pause-aware ---------------------------

-- recompute_daily_rollups(): 0013's body VERBATIM except for one expression --
-- the `sessions` CTE's focus_seconds sum, which becomes a call to
-- session_focus_seconds(). Restated in full because a single CTE-chained
-- statement has no seam to patch; everything else (the padded-window
-- reasoning, the per-user timezone coalesce, the advisory lock, the exact
-- per-user date filters) is unchanged and should diff clean against 0013.
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

  v_to := coalesce(p_to, (now() at time zone p_timezone)::date);
  v_from := coalesce(p_from, v_to - 2);

  if v_from > v_to then
    raise exception 'recompute_daily_rollups: p_from (%) is after p_to (%)', v_from, v_to
      using errcode = '22023';
  end if;

  -- Padded by the full IANA UTC-offset range (-12:00 to +14:00); see 0013's
  -- header for why this widens rather than narrows.
  v_lo := (v_from::timestamp) at time zone p_timezone - interval '14 hours';
  v_hi := ((v_to + 1)::timestamp) at time zone p_timezone + interval '12 hours';

  perform pg_advisory_xact_lock(hashtext('mtdo.recompute_daily_rollups'));

  with
  task_events as (
    select
      e.user_id,
      e.room_id,
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
      -- THE ONE CHANGED EXPRESSION (0023). Was an inline
      -- least(greatest(0, completed_at - started_at), planned_duration_s),
      -- which silently counted paused wall-clock time as focus time once
      -- pause existed. Same two rules as before plus the pause subtraction,
      -- now defined once in session_focus_seconds() and shared with
      -- weekly_performance() so the two cannot drift apart again.
      sum(public.session_focus_seconds(
        s.started_at, s.completed_at, s.total_paused_s, s.planned_duration_s
      )::bigint) as focus_seconds,
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
  'Materializes daily_rollups from activity_events (task completions) and focus_sessions (focus time). Each user''s rows are bucketed into local dates using THAT user''s own profiles.timezone (falling back to p_timezone for a user with none), not one shared zone for everyone -- see 0013. Focus time is session_focus_seconds(), which subtracts paused time and caps at planned_duration_s (0023). Idempotent full replace per (user_id, date, room_id); returns the number of rollup rows written. Service role only. See supabase/migrations/0009, 0013, 0023 and docs/architecture/api.md §3a.';

-- weekly_performance(): 0021's body VERBATIM except for the `sess` CTE's
-- focus-time sum. Derived mechanically from 0021's own text and diff-verified
-- to contain exactly two deltas (the CREATE OR REPLACE, and the expression
-- below) -- restated in full for the same reason as above, a single
-- CTE-chained statement has no seam to patch.
create or replace function public.weekly_performance(p_plan_id uuid, p_iso_week text)
returns jsonb
language plpgsql
security definer
stable
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_tz text;
  v_week_start date;
  v_week_end date;
  v_planning_mode text;
  v_cursor_week text;
  v_result jsonb;
begin
  if v_uid is null then
    raise exception 'weekly_performance: no authenticated user' using errcode = '42501';
  end if;

  -- Ownership is re-checked here, not just in RLS: this function is owned by
  -- postgres and is therefore exempt from RLS, so this predicate IS the
  -- access control. A RETIRED plan is deliberately still readable -- reviewing
  -- the history of a goal you have since put down is legitimate, and unlike
  -- pick_curriculum_item() nothing here writes to the board.
  select p.planning_mode into v_planning_mode
  from public.plans p
  where p.id = p_plan_id and p.user_id = v_uid;

  if v_planning_mode is null then
    -- Deliberately does not distinguish "not yours" from "no such plan" --
    -- same posture as pick_curriculum_item()/schedule_block().
    raise exception 'weekly_performance: plan % not available for this user', p_plan_id
      using errcode = '42501';
  end if;

  v_week_start := public.iso_week_start(p_iso_week);
  v_week_end := v_week_start + 6;

  -- Same coalesce(profiles.timezone, 'UTC') fallback as
  -- recompute_daily_rollups() (0013) and pick_curriculum_item() (0014). NULL
  -- is "never set a preference", a real state distinct from "chose UTC" --
  -- see that column's own comment.
  select coalesce(p.timezone, 'UTC') into v_tz
  from public.profiles p where p.id = v_uid;
  v_tz := coalesce(v_tz, 'UTC');

  with
  -- Every category of this plan, including ones with no activity at all --
  -- a category that saw nothing this week is a real, reportable state
  -- ("not engaged"), not a missing row. The TS rules engine depends on
  -- seeing it (a left join, never an inner one).
  cat as (
    select pc.id, pc.name, pc.label, pc.sort_order, pc.min_blocks,
           pc.score_weight, pc.days, pc.menu_unlocked_week_index,
           pc.menu_unlocked_iso_week, pc.weekly_target_blocks, pc.created_at
    from public.plan_categories pc
    where pc.plan_id = p_plan_id
  ),

  -- The ledger's verdict per block: the last completion/regression event of
  -- any time, plus how many regressions happened INSIDE the target week.
  ledger as (
    select (e.payload->>'block_id')::uuid as block_id,
           (array_agg(e.kind order by e.occurred_at desc, e.id desc))[1] as last_kind,
           count(*) filter (
             where e.kind = 'task_regressed'
               and (e.occurred_at at time zone v_tz)::date between v_week_start and v_week_end
           ) as regressed_in_week
    from public.activity_events e
    where e.user_id = v_uid
      and e.kind in ('task_completed', 'task_regressed')
      and e.payload ? 'block_id'
      and (e.payload->>'block_id') ~ '^[0-9a-fA-F-]{36}$'
    group by 1
  ),

  -- Real focus time per block, from focus_sessions and never from
  -- blocks.elapsed_seconds (a client-maintained convenience mirror, schema.md
  -- sec2). Both rules are recompute_daily_rollups()' rules, unchanged:
  -- attributed to the day the session STARTED, and each session capped at
  -- planned_duration_s so a tab left open for nine hours is not nine hours of
  -- focus (DESIGN.md's "the app never exaggerates the user's record").
  sess as (
    select fs.block_id,
           -- THE ONE CHANGED EXPRESSION (0023). Was an inline
           -- least(completed_at - started_at, planned_duration_s), which
           -- counted paused wall-clock time as focus time the moment pause
           -- existed -- and would have quietly inflated pace_ratio, the
           -- signal this engine uses to decide someone is coasting and hand
           -- them MORE work. Same two rules as before plus the pause
           -- subtraction, defined once in session_focus_seconds() and shared
           -- with recompute_daily_rollups().
           sum(public.session_focus_seconds(
             fs.started_at, fs.completed_at, fs.total_paused_s, fs.planned_duration_s
           )::numeric) as seconds,
           count(*) filter (where fs.state = 'completed') as completed_sessions,
           count(*) as settled_sessions
    from public.focus_sessions fs
    where fs.user_id = v_uid
      and fs.state in ('completed', 'abandoned')
      and fs.completed_at is not null
      and fs.block_id is not null
      and (fs.started_at at time zone v_tz)::date between v_week_start and v_week_end
    group by 1
  ),

  -- This week's board: every block whose DATE falls in the week (see the
  -- header note on why date and not a creation timestamp).
  wk as (
    select b.id, b.category_id, b.date, b.status, b.estimated_minutes,
           coalesce(s.seconds, 0) / 60.0 as actual_minutes,
           coalesce(s.completed_sessions, 0) as completed_sessions,
           coalesce(s.settled_sessions, 0) as settled_sessions,
           coalesce(l.regressed_in_week, 0) as regressed_in_week,
           case
             when l.last_kind is not null then l.last_kind = 'task_completed'
             else b.status = 'done'
           end as is_done
    from public.blocks b
    left join ledger l on l.block_id = b.id
    left join sess s on s.block_id = b.id
    where b.user_id = v_uid
      and b.plan_id = p_plan_id
      and b.date between v_week_start and v_week_end
  ),

  -- Open (not-done) blocks as of the end of the week, for backlog size.
  -- Anything dated BEFORE the week and still open is also the second,
  -- detectable shape of "postponed" -- see postponement_count below.
  openb as (
    select b.id, b.category_id, b.date
    from public.blocks b
    left join ledger l on l.block_id = b.id
    where b.user_id = v_uid
      and b.plan_id = p_plan_id
      and b.date <= v_week_end
      and not (case
                 when l.last_kind is not null then l.last_kind = 'task_completed'
                 else b.status = 'done'
               end)
  ),

  -- WHAT THE MENU OFFERED THAT WEEK -- the honest reconstruction, and the one
  -- number in this function that is an ESTIMATE rather than a measurement.
  --
  -- Nothing records the unlock cursor's historical position; plan_categories
  -- holds only where it is NOW (menu_unlocked_week_index) and when it last
  -- moved (menu_unlocked_iso_week). The cursor advances at most once per ISO
  -- week (0012), so walking it back one per elapsed week gives a LOWER BOUND
  -- on what was unlocked during the target week -- it may have advanced less,
  -- never more.
  --
  -- The direction of that error is chosen, not accidental. Under-counting
  -- what was offered INFLATES pick_rate, which makes the "avoided" signal
  -- (pick_rate < 0.3) harder to trigger. Since "avoided" proposes asking the
  -- user whether a category still matters to them, biasing against a false
  -- accusation is the right way to be wrong.
  --
  -- In `overall` mode (0017) the cursor is never used at all and the whole
  -- curriculum is on the menu at once, so there is nothing to reconstruct.
  cursor_at as (
    select c.id,
           case
             when v_planning_mode = 'overall' then null::integer
             when c.menu_unlocked_iso_week is null then -1
             else greatest(
               0,
               c.menu_unlocked_week_index - greatest(
                 0,
                 ((public.iso_week_start(c.menu_unlocked_iso_week) - v_week_start) / 7)::integer
               )
             )
           end as unlocked_through
    from cat c
  ),

  -- An item was "offered" in the target week if it was unlocked by then and
  -- had not already been pulled onto the board in an EARLIER week. Items
  -- picked earlier are neither offered nor skipped now -- they are simply
  -- gone from the menu, which is exactly what ensure_curriculum_menu() does
  -- ("picked" is derived from a block existing, api.md sec3b).
  menu as (
    select ci.category_id,
           count(*) as offered,
           count(*) filter (where b_in_week.id is not null) as picked_from_menu
    from public.curriculum_items ci
    join cat c on c.id = ci.category_id
    join cursor_at ca on ca.id = ci.category_id
    left join public.blocks b_prior
      on b_prior.curriculum_item_id = ci.id
     and b_prior.user_id = v_uid
     and b_prior.date < v_week_start
    left join public.blocks b_in_week
      on b_in_week.curriculum_item_id = ci.id
     and b_in_week.user_id = v_uid
     and b_in_week.date between v_week_start and v_week_end
    where b_prior.id is null
      and (ca.unlocked_through is null or ci.week_index <= ca.unlocked_through)
    group by 1
  ),

  -- Distinct days with real activity, per category and plan-wide. Ported from
  -- compute_day_streaks()' notion of "a day with activity": a completion
  -- event or a settled focus session. A day on which the user only opened the
  -- app is not a study day.
  days_cat as (
    select b.category_id, count(distinct d.day) as study_days
    from (
      select (e.occurred_at at time zone v_tz)::date as day,
             (e.payload->>'block_id')::uuid as block_id
      from public.activity_events e
      where e.user_id = v_uid
        and e.kind = 'task_completed'
        and e.payload ? 'block_id'
        and (e.payload->>'block_id') ~ '^[0-9a-fA-F-]{36}$'
        and (e.occurred_at at time zone v_tz)::date between v_week_start and v_week_end
      union all
      select (fs.started_at at time zone v_tz)::date, fs.block_id
      from public.focus_sessions fs
      where fs.user_id = v_uid
        and fs.state in ('completed', 'abandoned')
        and fs.block_id is not null
        and (fs.started_at at time zone v_tz)::date between v_week_start and v_week_end
    ) d
    join public.blocks b on b.id = d.block_id and b.plan_id = p_plan_id
    group by 1
  ),

  -- Scoped to THIS plan via the same blocks join days_cat uses, not just to
  -- the user: a review of one plan must not count a day the user spent
  -- entirely on a different (or since-retired) plan. Consequence worth
  -- knowing: a focus session with a null block_id is attributable to no plan
  -- and so counts toward no plan's study days.
  days_plan as (
    select count(distinct d.day) as study_days
    from (
      select (e.occurred_at at time zone v_tz)::date as day,
             (e.payload->>'block_id')::uuid as block_id
      from public.activity_events e
      where e.user_id = v_uid
        and e.kind = 'task_completed'
        and e.payload ? 'block_id'
        and (e.payload->>'block_id') ~ '^[0-9a-fA-F-]{36}$'
        and (e.occurred_at at time zone v_tz)::date between v_week_start and v_week_end
      union all
      select (fs.started_at at time zone v_tz)::date, fs.block_id
      from public.focus_sessions fs
      where fs.user_id = v_uid
        and fs.state in ('completed', 'abandoned')
        and fs.block_id is not null
        and (fs.started_at at time zone v_tz)::date between v_week_start and v_week_end
    ) d
    join public.blocks b on b.id = d.block_id and b.plan_id = p_plan_id
  ),

  -- PACE. Two guards, both load-bearing.
  --
  -- 1. estimated_minutes is genuinely NULL for most tasks (0018: no authoring
  --    surface collects it yet), so a null-estimate task is EXCLUDED from the
  --    pace calculation entirely. It is never treated as a zero estimate --
  --    that would divide by zero, or worse, read as infinitely slow.
  -- 2. A done block with NO settled focus session is also excluded. Without
  --    this, someone who finishes their tasks without ever running the timer
  --    computes as ~0 minutes against a real estimate -- a pace ratio near
  --    zero -- and gets classified "coasting" and handed 25% MORE work for
  --    the crime of not using a Pomodoro. That is the single most damaging
  --    false positive this engine can produce, and it is closed here in the
  --    metric rather than patched around in the rules.
  paced as (
    select w.category_id,
           sum(w.estimated_minutes)::numeric as est_minutes,
           sum(w.actual_minutes)::numeric as act_minutes,
           avg(w.actual_minutes / w.estimated_minutes)::numeric as ratio_mean,
           count(*) as paced_tasks
    from wk w
    where w.is_done
      and w.estimated_minutes is not null
      and w.settled_sessions > 0
    group by 1
  ),

  per_cat as (
    select c.id, c.name, c.label, c.sort_order, c.min_blocks, c.score_weight,
           coalesce(array_length(c.days, 1), 0) as days_per_week,
           c.weekly_target_blocks,
           -- The resolved pace the rules engine takes +/-25% of. NULL
           -- weekly_target_blocks falls back to the plan's own natural pace
           -- (one unlocked week_index holds array_length(days,1) items), and
           -- to 1 for a degenerate category with an empty days array, so the
           -- baseline is never 0 -- a 0 baseline makes every percentage
           -- meaningless and every proposal a division by zero.
           greatest(1, coalesce(c.weekly_target_blocks, array_length(c.days, 1), 1))
             as current_target,
           c.created_at as category_created_at,
           -- Strictly before the week began: a category created ON the
           -- Wednesday of the week under review has only a partial week of
           -- data, which is exactly the gap that must not be read as a
           -- healthy signal.
           (c.created_at < v_week_start::timestamptz) as existed_before_week,
           count(w.id) as picked_count,
           count(w.id) filter (where w.is_done) as done_count,
           coalesce(sum(w.actual_minutes), 0)::numeric as actual_minutes,
           coalesce(sum(w.completed_sessions), 0) as sessions_completed,
           coalesce(sum(w.regressed_in_week), 0) as regressed_count,
           coalesce(m.offered, 0) as menu_offered_count,
           coalesce(m.picked_from_menu, 0) as menu_picked_count,
           coalesce(p.est_minutes, 0)::numeric as estimated_minutes,
           coalesce(p.act_minutes, 0)::numeric as paced_actual_minutes,
           p.ratio_mean,
           coalesce(p.paced_tasks, 0) as paced_task_count,
           coalesce(d.study_days, 0) as study_days,
           (select count(*) from openb o where o.category_id = c.id) as backlog_count,
           (select count(*) from openb o
             where o.category_id = c.id and o.date < v_week_start) as stale_open_count
    from cat c
    left join wk w on w.category_id = c.id
    left join menu m on m.category_id = c.id
    left join paced p on p.category_id = c.id
    left join days_cat d on d.category_id = c.id
    group by c.id, c.name, c.label, c.sort_order, c.min_blocks, c.score_weight,
             c.days, c.weekly_target_blocks, c.created_at,
             m.offered, m.picked_from_menu,
             p.est_minutes, p.act_minutes, p.ratio_mean, p.paced_tasks, d.study_days
  ),

  -- EVERY RATE IS NULL WHEN ITS DENOMINATOR IS ZERO, NEVER 0.0.
  -- This is the distinction the whole engine turns on: "picked nothing" and
  -- "picked everything and finished none of it" are different facts about a
  -- human being, and collapsing both to 0% would have the rules propose
  -- cutting the load of a category the user simply never opened. The TS side
  -- treats null as "uncomputable, excluded from classification" and must
  -- never coalesce it to zero.
  shaped as (
    select pc.*,
           case when pc.picked_count > 0
                then round(pc.done_count::numeric / pc.picked_count, 4) end as completion_rate,
           case when pc.paced_task_count > 0 and pc.estimated_minutes > 0
                then round(pc.paced_actual_minutes / pc.estimated_minutes, 4) end as pace_ratio,
           case when pc.paced_task_count > 0
                then round(pc.ratio_mean, 4) end as pace_ratio_mean,
           case when pc.menu_offered_count > 0
                then round(pc.menu_picked_count::numeric / pc.menu_offered_count, 4) end as pick_rate
    from per_cat pc
  )

  select jsonb_build_object(
    'schema_version', 'mtdo.weekly_performance.v1',
    'plan_id', p_plan_id,
    'iso_week', p_iso_week,
    'week_start', v_week_start,
    'week_end', v_week_end,
    'timezone', v_tz,
    'planning_mode', v_planning_mode,
    'computed_at', now(),
    'plan', jsonb_build_object(
      'picked_count', coalesce(sum(s.picked_count), 0),
      'done_count', coalesce(sum(s.done_count), 0),
      'completion_rate', case when coalesce(sum(s.picked_count), 0) > 0
        then round(sum(s.done_count)::numeric / sum(s.picked_count), 4) end,
      'estimated_minutes', round(coalesce(sum(s.estimated_minutes), 0), 1),
      'actual_minutes', round(coalesce(sum(s.actual_minutes), 0), 1),
      'paced_actual_minutes', round(coalesce(sum(s.paced_actual_minutes), 0), 1),
      'paced_task_count', coalesce(sum(s.paced_task_count), 0),
      'pace_ratio', case when coalesce(sum(s.paced_task_count), 0) > 0
                          and coalesce(sum(s.estimated_minutes), 0) > 0
        then round(sum(s.paced_actual_minutes) / sum(s.estimated_minutes), 4) end,
      'menu_offered_count', coalesce(sum(s.menu_offered_count), 0),
      'menu_picked_count', coalesce(sum(s.menu_picked_count), 0),
      'pick_rate', case when coalesce(sum(s.menu_offered_count), 0) > 0
        then round(sum(s.menu_picked_count)::numeric / sum(s.menu_offered_count), 4) end,
      'regressed_count', coalesce(sum(s.regressed_count), 0),
      'stale_open_count', coalesce(sum(s.stale_open_count), 0),
      'postponement_count', coalesce(sum(s.regressed_count), 0) + coalesce(sum(s.stale_open_count), 0),
      'backlog_count', coalesce(sum(s.backlog_count), 0),
      'sessions_completed', coalesce(sum(s.sessions_completed), 0),
      'study_days', (select study_days from days_plan),
      -- compute_daily_score(), at week granularity. Categories nobody picked
      -- from are skipped entirely (core.py's `if not blocks: continue`), so
      -- score_max moves with what was actually attempted -- a user is never
      -- scored against a category that was not on their board.
      'score', coalesce(sum(round(s.score_weight * s.done_count::numeric / nullif(s.picked_count, 0)))
                        filter (where s.picked_count > 0), 0),
      'score_max', coalesce(sum(s.score_weight) filter (where s.picked_count > 0), 0)
    ),
    'categories', coalesce(jsonb_agg(jsonb_build_object(
      'category_id', s.id,
      'name', s.name,
      'label', s.label,
      'sort_order', s.sort_order,
      'min_blocks', s.min_blocks,
      'score_weight', s.score_weight,
      'days_per_week', s.days_per_week,
      'weekly_target_blocks', s.weekly_target_blocks,
      'current_target', s.current_target,
      'category_created_at', s.category_created_at,
      'existed_before_week', s.existed_before_week,
      'picked_count', s.picked_count,
      'done_count', s.done_count,
      'completion_rate', s.completion_rate,
      'estimated_minutes', round(s.estimated_minutes, 1),
      'actual_minutes', round(s.actual_minutes, 1),
      'paced_actual_minutes', round(s.paced_actual_minutes, 1),
      'paced_task_count', s.paced_task_count,
      'pace_ratio', s.pace_ratio,
      'pace_ratio_mean', s.pace_ratio_mean,
      'menu_offered_count', s.menu_offered_count,
      'menu_picked_count', s.menu_picked_count,
      'skipped_count', s.menu_offered_count - s.menu_picked_count,
      'pick_rate', s.pick_rate,
      'regressed_count', s.regressed_count,
      'stale_open_count', s.stale_open_count,
      'postponement_count', s.regressed_count + s.stale_open_count,
      'backlog_count', s.backlog_count,
      'sessions_completed', s.sessions_completed,
      'study_days', s.study_days
    ) order by s.sort_order, s.label), '[]'::jsonb)
  ) into v_result
  from shaped s;

  return v_result;
end;
$$;

alter function public.weekly_performance(uuid, text) owner to postgres;
revoke execute on function public.weekly_performance(uuid, text) from public, anon;
grant execute on function public.weekly_performance(uuid, text) to authenticated;

comment on function public.weekly_performance(uuid, text) is
  'Deterministic per-category and plan-level metrics for one plan for one ISO week, as jsonb (schema mtdo.weekly_performance.v1). Ports src/mtdo/core.py''s compute_week_progress/compute_daily_score/compute_day_streaks. Read-computed, never trigger-maintained (same reasoning as daily_rollups, decisions.md 2026-09-06). Pure aggregation -- no AI, no network, no writes. Every rate is NULL when its denominator is zero, never 0.0. Focus time is session_focus_seconds(), pause-aware as of 0023. See docs/architecture/api.md sec3f.';
