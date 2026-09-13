-- Extends review_daily_summary() with two fields "TODAY'S SIGNAL" (the
-- founder's original reference mock) needs that the RPC didn't expose yet:
-- focus.pause_count and execute.regressed_count.
--
-- pause_count = today's real session_paused ledger events (0023). This is a
-- genuinely new signal, not previously computed anywhere -- how many times
-- focus was actually interrupted today, not how many sessions had ANY
-- pause.
--
-- regressed_count = today's task_regressed ledger events. Named honestly:
-- this schema has NO "task rescheduled" event at all (schema.md/api.md
-- sec3f's own note: a cross-date schedule_block() move "leaves no trace at
-- all" -- a known, named gap, not something invented here). A walked-back
-- "done" task is the closest real, tracked signal to what a reference UI
-- might label "rescheduled" -- using it is a deliberate, disclosed mapping,
-- not a fabricated number. If a genuine reschedule-tracking event is added
-- later, this field should be revisited, not silently reinterpreted.

create or replace function public.review_daily_summary(p_date date default null)
returns jsonb
language plpgsql
security definer
stable
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_tz text;
  v_date date;
  v_plan_id uuid;
  v_iso_week text;
  v_weekly jsonb;

  v_focus_seconds numeric;
  v_session_count integer;
  v_completed_sessions integer;
  v_longest_session_seconds numeric;
  v_pause_count integer;

  v_tasks_picked integer;
  v_tasks_done integer;
  v_target_minutes numeric;
  v_estimated_task_count integer;
  v_score_today numeric;
  v_score_max_today numeric;
  v_regressed_count integer;

  v_week_score numeric;
  v_week_score_max numeric;
begin
  if v_uid is null then
    raise exception 'review_daily_summary: no authenticated user' using errcode = '42501';
  end if;

  select coalesce(pr.timezone, 'UTC') into v_tz
  from public.profiles pr where pr.id = v_uid;
  v_tz := coalesce(v_tz, 'UTC');

  v_date := coalesce(p_date, (now() at time zone v_tz)::date);

  select pl.id into v_plan_id
  from public.plans pl
  where pl.user_id = v_uid and pl.is_active
  limit 1;

  if v_plan_id is null then
    return jsonb_build_object(
      'schema_version', 'mtdo.review_daily_summary.v1',
      'date', v_date,
      'timezone', v_tz,
      'computed_at', now(),
      'status', 'no_active_plan',
      'focus', null,
      'execute', null,
      'progress', null
    );
  end if;

  with
  ledger as (
    select (e.payload->>'block_id')::uuid as block_id,
           (array_agg(e.kind order by e.occurred_at desc, e.id desc))[1] as last_kind
    from public.activity_events e
    where e.user_id = v_uid
      and e.kind in ('task_completed', 'task_regressed')
      and e.payload ? 'block_id'
      and (e.payload->>'block_id') ~ '^[0-9a-fA-F-]{36}$'
    group by 1
  ),
  today_blocks as (
    select b.id,
           b.estimated_minutes,
           coalesce(pc.score_weight, 0) as score_weight,
           case
             when l.last_kind is not null then l.last_kind = 'task_completed'
             else b.status = 'done'
           end as is_done
    from public.blocks b
    left join public.plan_categories pc on pc.id = b.category_id
    left join ledger l on l.block_id = b.id
    where b.user_id = v_uid
      and b.plan_id = v_plan_id
      and b.date = v_date
  )
  select
    count(*),
    count(*) filter (where is_done),
    coalesce(sum(estimated_minutes) filter (where estimated_minutes is not null), 0),
    count(*) filter (where estimated_minutes is not null),
    coalesce(sum(score_weight) filter (where true), 0),
    coalesce(sum(score_weight) filter (where is_done), 0)
  into
    v_tasks_picked, v_tasks_done, v_target_minutes, v_estimated_task_count,
    v_score_max_today, v_score_today
  from today_blocks;

  -- Today's real task_regressed events (whole-ledger scope, not just
  -- today's picked blocks -- a block picked yesterday but regressed today
  -- is a real event that happened today).
  select count(*) into v_regressed_count
  from public.activity_events e
  where e.user_id = v_uid
    and e.kind = 'task_regressed'
    and (e.occurred_at at time zone v_tz)::date = v_date;

  -- Today's real session_paused events -- "interruptions", genuinely new.
  select count(*) into v_pause_count
  from public.activity_events e
  where e.user_id = v_uid
    and e.kind = 'session_paused'
    and (e.occurred_at at time zone v_tz)::date = v_date;

  select
    coalesce(sum(public.session_focus_seconds(
      fs.started_at, fs.completed_at, fs.total_paused_s, fs.planned_duration_s
    )), 0),
    count(*),
    count(*) filter (where fs.state = 'completed'),
    coalesce(max(public.session_focus_seconds(
      fs.started_at, fs.completed_at, fs.total_paused_s, fs.planned_duration_s
    )), 0)
  into
    v_focus_seconds, v_session_count, v_completed_sessions, v_longest_session_seconds
  from public.focus_sessions fs
  where fs.user_id = v_uid
    and fs.state in ('completed', 'abandoned')
    and fs.completed_at is not null
    and (fs.started_at at time zone v_tz)::date = v_date;

  v_iso_week := to_char(v_date, 'IYYY-"W"IW');
  v_weekly := public.weekly_performance(v_plan_id, v_iso_week);
  v_week_score := (v_weekly->'plan'->>'score')::numeric;
  v_week_score_max := (v_weekly->'plan'->>'score_max')::numeric;

  return jsonb_build_object(
    'schema_version', 'mtdo.review_daily_summary.v1',
    'date', v_date,
    'timezone', v_tz,
    'plan_id', v_plan_id,
    'iso_week', v_iso_week,
    'computed_at', now(),
    'status', 'ok',

    'focus', jsonb_build_object(
      'metric_version', 'focus_v1',
      'focus_minutes', round(v_focus_seconds / 60.0, 1),
      'target_minutes', case when v_estimated_task_count > 0 then round(v_target_minutes, 1) end,
      'percentage', case when v_estimated_task_count > 0 and v_target_minutes > 0
        then round(least(999, (v_focus_seconds / 60.0) / v_target_minutes * 100), 1) end,
      'session_count', v_session_count,
      'completed_sessions', v_completed_sessions,
      'longest_session_minutes', round(v_longest_session_seconds / 60.0, 1),
      'pause_count', v_pause_count
    ),

    'execute', jsonb_build_object(
      'metric_version', 'execute_v1',
      'tasks_done', v_tasks_done,
      'tasks_picked', v_tasks_picked,
      'percentage', case when v_tasks_picked > 0
        then round(v_tasks_done::numeric / v_tasks_picked * 100, 1) end,
      'score', v_score_today,
      'score_max', v_score_max_today,
      'regressed_count', v_regressed_count
    ),

    'progress', jsonb_build_object(
      'metric_version', 'progress_v1',
      'week_score', v_week_score,
      'week_score_max', v_week_score_max,
      'percentage', case when v_week_score_max > 0
        then round(v_week_score / v_week_score_max * 100, 1) end
    )
  );
end;
$$;

comment on function public.review_daily_summary(date) is
  'Focus/Execute/Progress rings for one day (schema mtdo.review_daily_summary.v1). Derives the user from auth.uid() and resolves their own active plan -- takes no plan id. focus.pause_count is today''s real session_paused ledger events; execute.regressed_count is today''s real task_regressed events (the closest tracked signal to "rescheduled" -- this schema has no reschedule event at all, a named gap, not invented data). Every percentage is NULL when its denominator is zero or absent, never 0. Returns status=no_active_plan with null rings when the user has no active plan. See docs/architecture/api.md sec3j.';
