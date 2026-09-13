-- Review page, Phase A: review_daily_summary() -- the three daily rings
-- (Focus / Execute / Progress) behind the new Review page.
-- See docs/designs/mtdo-web-review-study-profile-plan.md sec4 Phase A and
-- docs/architecture/api.md sec3j.
--
-- WHY THIS DOES NOT DUPLICATE weekly_performance() OR daily_rollups().
-- Same "no metric gets a second implementation" rule api.md sec3f/3g already
-- states, applied to three new numbers:
--   * FOCUS and EXECUTE need per-CATEGORY, per-DAY numbers that neither
--     existing table carries: daily_rollups (0009) is user+day only, with no
--     plan/category breakdown at all, and weekly_performance() (0021) is
--     week-grain. So this function re-runs a NARROWED version of
--     weekly_performance()'s own block/session aggregation, for exactly one
--     date instead of a week. It deliberately borrows that function's rules
--     wholesale (ledger last-event-wins, the elapsed/planned_duration_s cap,
--     the estimated-minutes-and-a-session pace guard is NOT needed here since
--     FOCUS/EXECUTE do not compute pace) rather than reinventing them.
--   * PROGRESS does NOT get a new formula at all. It calls weekly_performance
--     ITSELF for the ISO week containing the requested date and reports that
--     week's score/score_max as of right now. "How much of this week's goal
--     is satisfied, read on this particular day" is an honest, non-invented
--     reading of "did today's work move the goal forward" -- see the plan
--     doc's Phase A note on why a true route/milestone progress model is a
--     later, separate, explicitly-named V2, not built here.
--
-- WHY READ-COMPUTED, NOT MATERIALIZED. Same reasoning as daily_rollups
-- (decisions.md 2026-09-06) and weekly_performance (0021): read a handful of
-- times per user per day, on demand, by a human looking at the Review page.
-- No freshness argument for a table a cron job would maintain.
--
-- WHAT "TARGET" MEANS FOR FOCUS, V1. There is no per-user daily focus-minutes
-- setting anywhere in this schema, and inventing one (a flat constant, or a
-- guess from weekly_target_blocks) would be exactly the "invent availability"
-- mistake 0021's header warns against for weekly_target_blocks. V1 target is
-- therefore the sum of estimated_minutes over TODAY's picked blocks that have
-- one set -- real data the user (or plan generation) already entered, never a
-- made-up number. If not one of today's blocks has an estimate, target_minutes
-- is NULL, and the ring must render "no target set", not a fake percentage
-- against zero. Revisit if/when a real per-user daily-focus preference exists.

create function public.review_daily_summary(p_date date default null)
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

  -- Same coalesce(profiles.timezone, 'UTC') fallback as recompute_daily_rollups
  -- (0013), pick_curriculum_item (0014) and weekly_performance (0021) -- one
  -- vocabulary for "which zone is this user's day in" across the schema.
  select coalesce(pr.timezone, 'UTC') into v_tz
  from public.profiles pr where pr.id = v_uid;
  v_tz := coalesce(v_tz, 'UTC');

  v_date := coalesce(p_date, (now() at time zone v_tz)::date);

  -- The active plan, not a parameter -- plans_one_active (0001) guarantees at
  -- most one, and the Review page has no reason to ask the caller to know a
  -- plan id it can look up itself. A retired/no plan is a real, common state
  -- (a fresh account, or between goals), not an error.
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
  -- Ledger's verdict per block, exactly weekly_performance's `ledger` CTE:
  -- the last task_completed/task_regressed event of any time wins.
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

  -- Real focus time, capped per session at planned_duration_s -- identical
  -- rule to recompute_daily_rollups (0009) and weekly_performance (0021):
  -- the app never exaggerates the user's record. Attributed to the day the
  -- session STARTED, same attribution rule as both of those.
  select
    coalesce(sum(least(
      greatest(0, floor(extract(epoch from (fs.completed_at - fs.started_at)))::bigint),
      fs.planned_duration_s::bigint
    )), 0),
    count(*),
    count(*) filter (where fs.state = 'completed'),
    coalesce(max(least(
      greatest(0, floor(extract(epoch from (fs.completed_at - fs.started_at)))::bigint),
      fs.planned_duration_s::bigint
    )), 0)
  into
    v_focus_seconds, v_session_count, v_completed_sessions, v_longest_session_seconds
  from public.focus_sessions fs
  where fs.user_id = v_uid
    and fs.state in ('completed', 'abandoned')
    and fs.completed_at is not null
    and (fs.started_at at time zone v_tz)::date = v_date;

  -- PROGRESS: reuse weekly_performance() outright, never a second formula.
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
      -- NULL, not 0, when nothing today carried an estimate -- see header.
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
      -- NULL when nothing was picked today -- "nothing planned" is not "0%
      -- executed", same null-vs-zero rule weekly_performance already applies.
      'percentage', case when v_tasks_picked > 0
        then round(v_tasks_done::numeric / v_tasks_picked * 100, 1) end,
      -- Weighted by category score_weight, matching weekly_performance's
      -- own score formula, exposed alongside the raw count so a UI can
      -- choose either -- they will differ only when today's categories
      -- carry unequal weights, by design, not by accident.
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

alter function public.review_daily_summary(date) owner to postgres;
revoke execute on function public.review_daily_summary(date) from public, anon;
grant execute on function public.review_daily_summary(date) to authenticated;

comment on function public.review_daily_summary(date) is
  'Focus/Execute/Progress rings for one day (schema mtdo.review_daily_summary.v1). Derives the user from auth.uid() and resolves their own active plan -- takes no plan id. Re-derives Focus/Execute from activity_events + focus_sessions at day grain (weekly_performance''s rules narrowed to one date); Progress reuses weekly_performance() outright for the containing ISO week rather than a second formula. Every percentage is NULL when its denominator is zero or absent, never 0. Returns status=no_active_plan with null rings when the user has no active plan. See docs/architecture/api.md sec3j.';
