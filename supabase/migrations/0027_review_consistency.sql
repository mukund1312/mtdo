-- Review page, Phase B: review_consistency() -- the Effort Score behind the
-- Consistency heatmap. See docs/designs/mtdo-web-review-study-profile-plan.md
-- sec4 Phase B and docs/architecture/api.md sec3k.
--
-- WHY A RANGE FUNCTION, AND WHY IT DOES NOT FILTER BY PLAN.
-- review_daily_summary() (0025, Phase A) resolves "today" against the
-- caller's CURRENT active plan, which is correct for a single day: there is
-- exactly one active plan right now (plans_one_active). It would be WRONG
-- for a historical range -- a user who switched goals scopes blocks/
-- categories to whichever plan was active on that date, and re-filtering
-- 200 days of history to today's plan_id would silently zero out every day
-- that belonged to a prior, since-retired plan. So Focus and Execute here are
-- scoped to the USER across the whole range, exactly like daily_rollups
-- already is (schema.md sec2/api.md sec3a) -- a block or session belongs to
-- whichever plan/category it was actually created under, and that is read
-- off the row itself, never assumed to be "whatever is active now".
--
-- PROGRESS IS THE ONE EXCEPTION, AND IT IS HONEST ABOUT WHY. Progress can
-- only be computed via weekly_performance(), which takes a plan id -- there
-- is no user-wide equivalent, and inventing one would be a second, divergent
-- definition of "progress" (the exact thing sec3f/3g's "no metric gets two
-- implementations" rule forbids). So progress_percentage is computed ONLY
-- for ISO weeks where the CURRENT active plan actually has a block dated
-- inside the requested range -- a defensible, narrow proxy for "this is
-- plausibly this goal's timeframe" -- and is NULL for every other week
-- (including the entirety of history if the user has no active plan right
-- now). This under-covers rather than misattributes, which is the same
-- direction of error 0021's menu_offered_count estimate deliberately chose.
--
-- WHY A LOOP OVER weekly_performance() RATHER THAN A NEW SET-BASED FORMULA.
-- A year is at most ~53 ISO weeks. Calling the existing, already-audited
-- function once per DISTINCT week actually present (not once per day) stays
-- bounded and, critically, guarantees this can never disagree with what the
-- weekly review itself shows for the same week -- one formula, one caller
-- count that scales with weeks, not days.
--
-- THE EFFORT SCORE ITSELF IS effort_v1 AND IS A STARTING POINT, NOT A
-- VALIDATED FORMULA. The weights below (Focus 35 / Execute 45 / Progress 20)
-- were chosen on reasoning, not measured against real usage: Execute is
-- weighted highest because "did the work actually happen" is the most
-- direct behavioral signal; Focus next because depth of effort still
-- matters independently of whether every task got ticked; Progress lowest
-- because it is a WEEKLY number that does not move day to day, and letting
-- it dominate would make six days of a seven-day week look identical.
-- Revisit once real daily_rollups history exists to check the score's
-- distribution isn't dominated by one component -- this is not that check,
-- it is v1. `metric_version: 'effort_v1'` is in every day's output so a
-- later `effort_v2` never silently reinterprets an old score.
--
-- NULL HANDLING: a component with no basis (see 0025's own null rules) is
-- EXCLUDED and the remaining weights are renormalized over what's actually
-- available -- not coalesced to 0, which would understate a day that
-- genuinely had, say, no estimated task but real completed work. If NONE of
-- the three have a basis, effort_score is 0 (a real, meaningful "nothing
-- happened" day) UNLESS the user has no active plan at all, in which case it
-- is NULL (there is no goal for this day to be measured against, a
-- different fact than "measured and empty").

create function public.review_consistency(p_start date, p_end date)
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

  -- Bounds the weekly_performance() loop below to at most ~54 calls and
  -- keeps the day series itself from becoming an unbounded scan.
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

  -- One weekly_performance() call per DISTINCT ISO week the current plan has
  -- a block in, inside the range -- not one per day. See header.
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
  -- Ledger's verdict per block, same rule as 0021/0025: the last
  -- task_completed/task_regressed event of any time wins.
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
  -- USER-scoped, not plan_id-filtered -- see header. Each block already
  -- carries its own category_id/score_weight from whichever plan it was
  -- created under.
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
  focus_agg as (
    select (fs.started_at at time zone v_tz)::date as date,
           coalesce(sum(least(
             greatest(0, floor(extract(epoch from (fs.completed_at - fs.started_at)))::bigint),
             fs.planned_duration_s::bigint
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
      -- effort_v1 weights -- see header for why these values and why they
      -- are not yet validated against real usage.
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

alter function public.review_consistency(date, date) owner to postgres;
revoke execute on function public.review_consistency(date, date) from public, anon;
grant execute on function public.review_consistency(date, date) to authenticated;

comment on function public.review_consistency(date, date) is
  'Per-day Effort Score (schema mtdo.review_consistency.v1, formula effort_v1) behind the Consistency heatmap, for one date range. Focus/Execute are scoped to the whole USER across every plan they have ever had (never re-filtered to the current active plan) so switching goals does not zero out history; Progress reuses weekly_performance() per distinct ISO week the current plan touched in range, and is NULL outside that. effort_score is NULL only when the user has no active plan at all; otherwise a day with no computable component is a real 0, not missing data. Range capped at 400 days. See docs/architecture/api.md sec3k.';
