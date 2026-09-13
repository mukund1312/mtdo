-- Review page, Phase D: study_profile() -- one composed learner profile,
-- every field carrying sample_size/window_days/confidence. See
-- docs/designs/mtdo-web-review-study-profile-plan.md sec4 Phase D and
-- docs/architecture/api.md sec3n.
--
-- PURE COMPOSITION, NO NEW RAW METRICS. Every number here comes from an
-- already-audited RPC -- review_consistency() (0026/0027),
-- review_time_patterns() (0028), review_momentum() (0029), and
-- weekly_performance() (0021) -- summarized into one object. This function
-- adds exactly two things that don't already exist: (1) aggregating daily
-- Focus/Execute percentages and per-category completion/postponement
-- across a window, and (2) a shared confidence-tier convention
-- (study_profile_confidence()) for every aggregate it computes. Nothing
-- here recomputes an Effort Score, a session-completion rate, or a weekly
-- score a second, divergent way.
--
-- CONFIDENCE IS NOT OPTIONAL. The founder's own brief is explicit that a
-- trait stated from too little evidence is worse than not stating it at
-- all. Every aggregate below has a real minimum-sample gate; below it, the
-- field's value is NULL (not a guess), and confidence reads
-- 'insufficient_data', not a fabricated tier.

create function public.study_profile_confidence(p_sample_size bigint)
returns text
language sql
immutable
as $$
  select case
    when p_sample_size is null or p_sample_size < 5 then 'insufficient_data'
    when p_sample_size < 10 then 'low'
    when p_sample_size < 20 then 'medium'
    else 'high'
  end
$$;

comment on function public.study_profile_confidence(bigint) is
  'Shared confidence-tier convention for study_profile() (0031): insufficient_data (<5), low (5-9), medium (10-19), high (20+). Pure arithmetic, safe to expose broadly. See docs/architecture/api.md sec3n.';

grant execute on function public.study_profile_confidence(bigint) to authenticated, anon, service_role;

create function public.study_profile(p_window_days integer default 42)
returns jsonb
language plpgsql
security definer
stable
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_tz text;
  v_today date;
  v_from date;
  v_plan_id uuid;
  v_consistency jsonb;
  v_time_patterns jsonb;
  v_momentum jsonb;
  v_week_scores jsonb := '{}'::jsonb;
  v_wp jsonb;
  v_rec record;
  v_min_category_sample constant integer := 3;
  v_min_weeks constant integer := 2;
  v_traits jsonb;
  v_result jsonb;
begin
  if v_uid is null then
    raise exception 'study_profile: no authenticated user' using errcode = '42501';
  end if;

  if p_window_days is null or p_window_days < 1 or p_window_days > 400 then
    raise exception 'study_profile: p_window_days (%) must be between 1 and 400', p_window_days
      using errcode = '22023';
  end if;

  select coalesce(pr.timezone, 'UTC') into v_tz
  from public.profiles pr where pr.id = v_uid;
  v_tz := coalesce(v_tz, 'UTC');

  v_today := (now() at time zone v_tz)::date;
  v_from := v_today - (p_window_days - 1);

  select pl.id into v_plan_id
  from public.plans pl
  where pl.user_id = v_uid and pl.is_active
  limit 1;

  if v_plan_id is null then
    return jsonb_build_object(
      'schema_version', 'mtdo.study_profile.v1',
      'computed_at', now(), 'from', v_from, 'to', v_today, 'window_days', p_window_days,
      'timezone', v_tz, 'status', 'no_active_plan',
      'focus', null, 'execution', null, 'consistency', null, 'planning', null,
      'best_study_window', null, 'best_weekday', null, 'ideal_session_length', null,
      'strongest_subject', null, 'weakest_subject', null, 'most_avoided_subject', null
    );
  end if;

  -- Composition, not re-derivation: each of these is called exactly like a
  -- frontend caller would call it directly.
  v_consistency := public.review_consistency(v_from, v_today);
  v_time_patterns := public.review_time_patterns(v_from, v_today);
  v_momentum := public.review_momentum(p_window_days);

  -- One weekly_performance() call per DISTINCT ISO week the plan touched in
  -- the window -- same bounded-loop pattern as review_consistency() (0026).
  for v_rec in
    select distinct to_char(b.date, 'IYYY-"W"IW') as iso_week
    from public.blocks b
    where b.user_id = v_uid
      and b.plan_id = v_plan_id
      and b.date between v_from and v_today
  loop
    v_wp := public.weekly_performance(v_plan_id, v_rec.iso_week);
    v_week_scores := v_week_scores || jsonb_build_object(v_rec.iso_week, v_wp);
  end loop;

  with
  days as (
    select
      (elem->>'focus_percentage')::numeric as focus_percentage,
      (elem->>'execute_percentage')::numeric as execute_percentage
    from jsonb_array_elements(v_consistency->'days') as elem
  ),
  focus_agg as (
    select count(*) as n, avg(focus_percentage) as avgv
    from days where focus_percentage is not null
  ),
  exec_agg as (
    select count(*) as n, avg(execute_percentage) as avgv
    from days where execute_percentage is not null
  ),
  weeks as (
    select key as iso_week, value from jsonb_each(v_week_scores)
  ),
  week_plan as (
    select
      iso_week,
      (value->'plan'->>'completion_rate')::numeric as completion_rate,
      (value->'plan'->>'pace_ratio')::numeric as pace_ratio
    from weeks
  ),
  planning_agg as (
    select
      count(*) filter (where completion_rate is not null) as n_completion,
      avg(completion_rate) filter (where completion_rate is not null) as avg_completion,
      count(*) filter (where pace_ratio is not null) as n_pace,
      avg(pace_ratio) filter (where pace_ratio is not null) as avg_pace,
      count(*) as n_weeks
    from week_plan
  ),
  cats as (
    select c
    from weeks, jsonb_array_elements(value->'categories') as c
  ),
  cat_agg as (
    select
      c->>'category_id' as category_id,
      max(c->>'name') as name,
      max(c->>'label') as label,
      coalesce(sum((c->>'picked_count')::int), 0) as picked_count,
      coalesce(sum((c->>'done_count')::int), 0) as done_count,
      coalesce(sum((c->>'postponement_count')::int), 0) as postponement_count
    from cats
    group by c->>'category_id'
  ),
  cat_shaped as (
    select
      *,
      case when picked_count > 0 then round(done_count::numeric / picked_count, 4) end as completion_rate,
      case when (picked_count + postponement_count) > 0
        then round(postponement_count::numeric / (picked_count + postponement_count), 4) end as postponement_rate
    from cat_agg
  )
  select jsonb_build_object(
    'focus', jsonb_build_object(
      'metric_version', 'study_profile_v1',
      'avg_percentage', case when fa.n >= 5 then round(fa.avgv, 1) end,
      'sample_size', fa.n, 'window_days', p_window_days,
      'confidence', public.study_profile_confidence(fa.n)
    ),
    'execution', jsonb_build_object(
      'metric_version', 'study_profile_v1',
      'avg_percentage', case when ea.n >= 5 then round(ea.avgv, 1) end,
      'sample_size', ea.n, 'window_days', p_window_days,
      'confidence', public.study_profile_confidence(ea.n)
    ),
    'planning', jsonb_build_object(
      'metric_version', 'study_profile_v1',
      'avg_completion_rate', case when pa.n_weeks >= v_min_weeks then round(pa.avg_completion, 4) end,
      'avg_pace_ratio', case when pa.n_pace >= v_min_weeks then round(pa.avg_pace, 4) end,
      'weeks_sampled', pa.n_weeks,
      'confidence', case when pa.n_weeks < v_min_weeks then 'insufficient_data'
                          when pa.n_weeks < 4 then 'low'
                          when pa.n_weeks < 8 then 'medium'
                          else 'high' end
    ),
    'strongest_subject', (
      select jsonb_build_object(
        'category_id', cs.category_id, 'name', cs.name, 'label', cs.label,
        'completion_rate', cs.completion_rate, 'sample_size', cs.picked_count,
        'confidence', public.study_profile_confidence(cs.picked_count)
      )
      from cat_shaped cs
      where cs.picked_count >= v_min_category_sample and cs.completion_rate is not null
      order by cs.completion_rate desc, cs.picked_count desc
      limit 1
    ),
    'weakest_subject', (
      select jsonb_build_object(
        'category_id', cs.category_id, 'name', cs.name, 'label', cs.label,
        'completion_rate', cs.completion_rate, 'sample_size', cs.picked_count,
        'confidence', public.study_profile_confidence(cs.picked_count)
      )
      from cat_shaped cs
      where cs.picked_count >= v_min_category_sample and cs.completion_rate is not null
      order by cs.completion_rate asc, cs.picked_count desc
      limit 1
    ),
    'most_avoided_subject', (
      select jsonb_build_object(
        'category_id', cs.category_id, 'name', cs.name, 'label', cs.label,
        'postponement_rate', cs.postponement_rate, 'sample_size', cs.picked_count + cs.postponement_count,
        'confidence', public.study_profile_confidence(cs.picked_count + cs.postponement_count)
      )
      from cat_shaped cs
      where (cs.picked_count + cs.postponement_count) >= v_min_category_sample
        and cs.postponement_rate is not null and cs.postponement_rate > 0
      order by cs.postponement_rate desc, cs.picked_count desc
      limit 1
    )
  ) into v_traits
  from focus_agg fa, exec_agg ea, planning_agg pa;

  v_result := jsonb_build_object(
    'schema_version', 'mtdo.study_profile.v1',
    'computed_at', now(), 'from', v_from, 'to', v_today, 'window_days', p_window_days,
    'timezone', v_tz, 'plan_id', v_plan_id, 'status', 'ok',
    'focus', v_traits->'focus',
    'execution', v_traits->'execution',
    'consistency', jsonb_build_object(
      'metric_version', 'momentum_v1',
      'active_days_rate', v_momentum->'active_days_rate',
      'momentum_score', v_momentum->'momentum_score',
      'current_streak', v_momentum->'current_streak',
      'longest_streak', v_momentum->'longest_streak',
      'window_days', p_window_days
    ),
    'planning', v_traits->'planning',
    'best_study_window', v_time_patterns->'best_hour',
    'best_weekday', v_time_patterns->'best_weekday',
    'ideal_session_length', v_time_patterns->'best_duration_bucket',
    'strongest_subject', v_traits->'strongest_subject',
    'weakest_subject', v_traits->'weakest_subject',
    'most_avoided_subject', v_traits->'most_avoided_subject'
  );

  return v_result;
end;
$$;

alter function public.study_profile(integer) owner to postgres;
revoke execute on function public.study_profile(integer) from public, anon;
grant execute on function public.study_profile(integer) to authenticated;

comment on function public.study_profile(integer) is
  'Composed learner profile (schema mtdo.study_profile.v1) over the trailing p_window_days (default 42) -- pure composition over review_consistency()/review_time_patterns()/review_momentum()/weekly_performance(), never a second implementation of any of their formulas. Every field is NULL below its own minimum-sample gate, with a confidence tier (study_profile_confidence()) alongside it -- never inferred from too little evidence. status=no_active_plan with every field null when the caller has no active plan. See docs/architecture/api.md sec3n.';
