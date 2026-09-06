-- start_session's p_block_id genuinely accepts NULL at runtime (a general
-- focus session with no associated block -- see the "p_block_id is not null
-- and not exists (...)" check in the function body below, unchanged from
-- 0001_seam.sql). But the original signature declared it with no DEFAULT,
-- which is what a caller must supply, not whether the value itself may be
-- null -- Supabase's type generator infers RPC arg nullability from DEFAULT
-- presence, not from body logic, so `supabase gen types` emitted
-- `p_block_id: string` (non-nullable) even though `web/app/session/page.tsx`
-- correctly calls this RPC with `p_block_id: null` for an unscheduled
-- session. Adding `default null` makes the generated type match the real,
-- already-audited runtime contract -- no behavior change, purely a signature
-- annotation for the type generator's benefit.
--
-- CREATE OR REPLACE, not a new function: same OID, same grants/ownership,
-- same body verbatim from 0001_seam.sql. Postgres allows changing a
-- parameter's default via REPLACE as long as the parameter types/order are
-- unchanged.
--
-- p_planned_duration_s also gets `default null` here -- not because it's
-- meant to be omitted (the real call site always passes it explicitly), but
-- because Postgres only allows defaults on *trailing* parameters, and
-- p_block_id (which genuinely needs one) comes first. This changes nothing
-- at runtime: the very first check in the body already rejects a null
-- p_planned_duration_s with a clear 22023 error, so a hypothetical caller
-- that omitted it gets the same validation failure it would have gotten
-- passing null explicitly -- this is not a behavior change, just what SQL
-- syntax requires to give p_block_id the default it actually needs.
create or replace function public.start_session(
  p_block_id uuid default null,
  p_planned_duration_s integer default null
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

-- Grants/ownership are unaffected by CREATE OR REPLACE (same OID), but
-- restated here for a reader who only skims migrations for security
-- posture, matching every other function definition in this repo.
alter function public.start_session(uuid, integer) owner to postgres;
revoke execute on function public.start_session(uuid, integer) from public, anon, authenticated;
grant execute on function public.start_session(uuid, integer) to authenticated;
