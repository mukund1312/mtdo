-- Fix: review_daily_summary() (0025) and review_consistency() (0026) both
-- re-spelled the focus-seconds formula (least(greatest(0, elapsed), planned))
-- instead of calling session_focus_seconds() -- which 0023's own comment is
-- explicit about: "recompute_daily_rollups(), weekly_performance() and
-- settle_session()'s ledger payload all call this -- do not re-spell the
-- formula anywhere." Both of these were written after 0023 shipped and
-- missed it. Net effect in production: any session with a real pause would
-- have its full wall-clock time counted toward Focus/Effort, not its actual
-- paused-time-subtracted focus time, disagreeing with daily_rollups and
-- weekly_performance for the exact same session.
--
-- Caught while building Phase C (docs/designs/mtdo-web-review-study-profile-plan.md),
-- which also needs session_focus_seconds() and would have propagated the same
-- bug a third time if this had gone unnoticed.
--
-- No existing test caught this because focus_sessions.total_paused_s is
-- `not null default 0` (0023) and every existing fixture in
-- 17_review_daily_summary.sql / 18_review_consistency.sql happens to use
-- sessions with no pause -- so the bug and the correct formula produce
-- identical numbers on every fixture written so far. New assertions are
-- added to both files, using a genuinely paused session, to close that gap.
--
-- create or replace preserves the function's owner and grants (same OID) --
-- nothing below re-states security definer/owner/revoke/grant.

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

  v_tasks_picked integer;
  v_tasks_done integer;
  v_target_minutes numeric;
  v_estimated_task_count integer;
  v_score_today numeric;
  v_score_max_today numeric;

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

  -- FIX: session_focus_seconds() (0023), not a re-spelled cap. Subtracts
  -- total_paused_s before capping at planned_duration_s -- see this
  -- migration's header.
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
      'longest_session_minutes', round(v_longest_session_seconds / 60.0, 1)
    ),

    'execute', jsonb_build_object(
      'metric_version', 'execute_v1',
      'tasks_done', v_tasks_done,
      'tasks_picked', v_tasks_picked,
      'percentage', case when v_tasks_picked > 0
        then round(v_tasks_done::numeric / v_tasks_picked * 100, 1) end,
      'score', v_score_today,
      'score_max', v_score_max_today
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
  'Focus/Execute/Progress rings for one day (schema mtdo.review_daily_summary.v1). Derives the user from auth.uid() and resolves their own active plan -- takes no plan id. Re-derives Focus/Execute from activity_events + focus_sessions at day grain (weekly_performance''s rules narrowed to one date), using session_focus_seconds() (0023) for focus time -- never a re-spelled cap (fixed 0030). Progress reuses weekly_performance() outright for the containing ISO week rather than a second formula. Every percentage is NULL when its denominator is zero or absent, never 0. Returns status=no_active_plan with null rings when the user has no active plan. See docs/architecture/api.md sec3j.';

create or replace function public.review_consistency(p_start date, p_end date)
returns jsonb
language plpgsql
security definer
stable
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_tz text;
  v_plan_id uuid;
  v_week_scores jsonb := '{}'::jsonb;
  v_wp jsonb;
  v_rec record;
  v_days jsonb;
begin
  if v_uid is null then
    raise exception 'review_consistency: no authenticated user' using errcode = '42501';
  end if;

  if p_start is null or p_end is null or p_start > p_end then
    raise exception 'review_consistency: p_start (%) must be a real date on or before p_end (%)', p_start, p_end
      using errcode = '22023';
  end if;

  if (p_end - p_start) > 400 then
    raise exception 'review_consistency: range too wide (% days, max 400)', (p_end - p_start)
      using errcode = '22023';
  end if;

  select coalesce(pr.timezone, 'UTC') into v_tz
  from public.profiles pr where pr.id = v_uid;
  v_tz := coalesce(v_tz, 'UTC');

  select pl.id into v_plan_id
  from public.plans pl
  where pl.user_id = v_uid and pl.is_active
  limit 1;

  if v_plan_id is not null then
    for v_rec in
      select distinct to_char(b.date, 'IYYY-"W"IW') as iso_week
      from public.blocks b
      where b.user_id = v_uid
        and b.plan_id = v_plan_id
        and b.date between p_start and p_end
    loop
      v_wp := public.weekly_performance(v_plan_id, v_rec.iso_week);
      v_week_scores := v_week_scores || jsonb_build_object(
        v_rec.iso_week,
        jsonb_build_object('score', v_wp->'plan'->'score', 'score_max', v_wp->'plan'->'score_max')
      );
    end loop;
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
  day_blocks as (
    select b.date,
           b.id,
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
      and b.date between p_start and p_end
  ),
  exec_agg as (
    select date,
           count(*) as tasks_picked,
           count(*) filter (where is_done) as tasks_done,
           coalesce(sum(estimated_minutes) filter (where estimated_minutes is not null), 0) as target_minutes,
           count(*) filter (where estimated_minutes is not null) as estimated_task_count
    from day_blocks
    group by date
  ),
  -- FIX: session_focus_seconds() (0023), not a re-spelled cap -- see header.
  focus_agg as (
    select (fs.started_at at time zone v_tz)::date as date,
           coalesce(sum(public.session_focus_seconds(
             fs.started_at, fs.completed_at, fs.total_paused_s, fs.planned_duration_s
           )), 0) as focus_seconds
    from public.focus_sessions fs
    where fs.user_id = v_uid
      and fs.state in ('completed', 'abandoned')
      and fs.completed_at is not null
      and (fs.started_at at time zone v_tz)::date between p_start and p_end
    group by 1
  ),
  weeks as (
    select key as iso_week,
           (value->>'score')::numeric as week_score,
           (value->>'score_max')::numeric as week_score_max
    from jsonb_each(v_week_scores)
  ),
  days as (
    select generate_series(p_start, p_end, interval '1 day')::date as d
  ),
  shaped as (
    select
      d.d as date,
      case when ea.estimated_task_count > 0 and ea.target_minutes > 0
        then round(least(999, (coalesce(fa.focus_seconds, 0) / 60.0) / ea.target_minutes * 100), 1)
      end as focus_pct,
      case when ea.tasks_picked > 0
        then round(ea.tasks_done::numeric / ea.tasks_picked * 100, 1)
      end as execute_pct,
      case when w.week_score_max > 0
        then round(w.week_score / w.week_score_max * 100, 1)
      end as progress_pct
    from days d
    left join exec_agg ea on ea.date = d.d
    left join focus_agg fa on fa.date = d.d
    left join weeks w on w.iso_week = to_char(d.d, 'IYYY-"W"IW')
  ),
  scored as (
    select
      s.date, s.focus_pct, s.execute_pct, s.progress_pct,
      (case when s.focus_pct is not null then 0.35 else 0 end
       + case when s.execute_pct is not null then 0.45 else 0 end
       + case when s.progress_pct is not null then 0.20 else 0 end) as avail_weight,
      (coalesce(s.focus_pct, 0) * (case when s.focus_pct is not null then 0.35 else 0 end)
       + coalesce(s.execute_pct, 0) * (case when s.execute_pct is not null then 0.45 else 0 end)
       + coalesce(s.progress_pct, 0) * (case when s.progress_pct is not null then 0.20 else 0 end)
      ) as weighted_sum
    from shaped s
  )
  select jsonb_agg(
    jsonb_build_object(
      'date', sc.date,
      'focus_percentage', sc.focus_pct,
      'execute_percentage', sc.execute_pct,
      'progress_percentage', sc.progress_pct,
      'effort_score',
        case
          when v_plan_id is null then null
          when sc.avail_weight = 0 then 0
          else round(sc.weighted_sum / sc.avail_weight, 1)
        end,
      'level',
        case
          when v_plan_id is null then null
          when sc.avail_weight = 0 then 0
          else least(4, floor(round(sc.weighted_sum / sc.avail_weight, 1) / 20)::int)
        end
    ) order by sc.date
  ) into v_days
  from scored sc;

  return jsonb_build_object(
    'schema_version', 'mtdo.review_consistency.v1',
    'from', p_start,
    'to', p_end,
    'timezone', v_tz,
    'plan_id', v_plan_id,
    'computed_at', now(),
    'metric_version', 'effort_v1',
    'days', coalesce(v_days, '[]'::jsonb)
  );
end;
$$;

comment on function public.review_consistency(date, date) is
  'Per-day Effort Score (schema mtdo.review_consistency.v1, formula effort_v1) behind the Consistency heatmap, for one date range. Focus/Execute are scoped to the whole USER across every plan they have ever had (never re-filtered to the current active plan) so switching goals does not zero out history, using session_focus_seconds() (0023) for focus time -- never a re-spelled cap (fixed 0030). Progress reuses weekly_performance() per distinct ISO week the current plan touched in range, and is NULL outside that. effort_score is NULL only when the user has no active plan at all; otherwise a day with no computable component is a real 0, not missing data. Range capped at 400 days. See docs/architecture/api.md sec3k.';
