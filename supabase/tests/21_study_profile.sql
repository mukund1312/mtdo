\set ON_ERROR_STOP on
\pset pager off
set client_min_messages = notice;
set timezone = 'UTC';

-- migrations/0031: study_profile() (docs/designs/mtdo-web-review-study-profile-plan.md
-- sec4 Phase D, docs/architecture/api.md sec3n).
--
-- study_profile() resolves "today" from real now() (like review_momentum),
-- so fixtures are built relative to current_date, not literal dates. The
-- two block dates (current_date-20 and current_date-3) are 17 days apart --
-- guaranteed to land in two different ISO weeks regardless of which real
-- day this suite happens to run on.

do $test$
declare
  v_uid uuid := t.mkuser('study_profile_normal');
  v_plan uuid;
  v_strong uuid;
  v_weak uuid;
  v_avoided uuid;
  v_avoided_block2 uuid;
  v_out jsonb;
  i int;
begin
  insert into public.plans (user_id, app_name, goal_line, is_active)
    values (v_uid, 'test', 'study profile', false) returning id into v_plan;
  insert into public.plan_categories (plan_id, name, label, days, sort_order, created_at)
    values (v_plan, 'strong_cat', 'Strong Cat', '{0,1,2}', 0, '2020-01-01'::timestamptz) returning id into v_strong;
  insert into public.plan_categories (plan_id, name, label, days, sort_order, created_at)
    values (v_plan, 'weak_cat', 'Weak Cat', '{0,1,2}', 1, '2020-01-01'::timestamptz) returning id into v_weak;
  insert into public.plan_categories (plan_id, name, label, days, sort_order, created_at)
    values (v_plan, 'avoided_cat', 'Avoided Cat', '{0,1,2}', 2, '2020-01-01'::timestamptz) returning id into v_avoided;

  -- strong_cat: 3 of 3 done (fallback to blocks.status -- ledger never saw them).
  insert into public.blocks (user_id, plan_id, category_id, date, position, text, status)
  select v_uid, v_plan, v_strong, current_date - 3, gs.n, 'strong ' || gs.n, 'done'
  from generate_series(0, 2) as gs(n);

  -- weak_cat: 0 of 3 done.
  insert into public.blocks (user_id, plan_id, category_id, date, position, text, status)
  select v_uid, v_plan, v_weak, current_date - 3, gs.n, 'weak ' || gs.n, 'todo'
  from generate_series(0, 2) as gs(n);

  -- avoided_cat: one done block in an OLDER week (current_date-20, so that
  -- week enters the sampled set at all), plus one regressed + one untouched
  -- block in the current_date-3 week -- picked=3, done=1, postponed=1.
  insert into public.blocks (user_id, plan_id, category_id, date, position, text, status)
    values (v_uid, v_plan, v_avoided, current_date - 20, 0, 'avoided old done', 'done');
  insert into public.blocks (user_id, plan_id, category_id, date, position, text, status)
    values (v_uid, v_plan, v_avoided, current_date - 3, 0, 'avoided regressed', 'done') returning id into v_avoided_block2;
  perform t.ev(v_uid, 'task_completed', (current_date - 3)::timestamptz + interval '9 hours', v_avoided_block2::text);
  perform t.ev(v_uid, 'task_regressed', (current_date - 3)::timestamptz + interval '10 hours', v_avoided_block2::text);
  insert into public.blocks (user_id, plan_id, category_id, date, position, text, status)
    values (v_uid, v_plan, v_avoided, current_date - 3, 1, 'avoided untouched', 'todo');

  -- 6 completed ~20-minute sessions at hour 8 on current_date-1, comfortably
  -- clearing review_time_patterns()'s min_sample_size=5.
  for i in 0..5 loop
    insert into public.focus_sessions (user_id, started_at, completed_at, planned_duration_s, state)
    values (v_uid, (current_date - 1)::timestamptz + (8*3600 + i*60) * interval '1 second',
            (current_date - 1)::timestamptz + (8*3600 + i*60 + 1200) * interval '1 second', 1200, 'completed');
  end loop;

  set local role authenticated;
  perform set_config('request.jwt.claim.sub', v_uid::text, true);
  perform public.activate_plan(v_plan);

  v_out := public.study_profile(42);

  perform t.eq('1 declares its schema version', v_out->>'schema_version', 'mtdo.study_profile.v1');
  perform t.eq('1b status ok with an active plan', v_out->>'status', 'ok');
  perform t.eq('1c window_days echoes the request', v_out->>'window_days', '42');

  -- ----- subjects --------------------------------------------------------
  perform t.eq('2 strongest_subject is strong_cat (completion 1.0)',
    v_out->'strongest_subject'->>'category_id', v_strong::text);
  perform t.eq('2b ...with the real sample size', v_out->'strongest_subject'->>'sample_size', '3');
  perform t.eq('3 weakest_subject is weak_cat (completion 0.0)',
    v_out->'weakest_subject'->>'category_id', v_weak::text);
  perform t.eq('4 most_avoided_subject is avoided_cat (the only one with a real postponement)',
    v_out->'most_avoided_subject'->>'category_id', v_avoided::text);
  perform t.eq('4b avoided_cat postponement_rate is 1 of 4 (3 picked + 1 postponed)',
    v_out->'most_avoided_subject'->>'postponement_rate', '0.2500');

  -- ----- planning: 2 weeks, avg completion (1.0 + 0.375) / 2 = 0.6875 ------
  perform t.eq('5 planning.weeks_sampled is 2', v_out->'planning'->>'weeks_sampled', '2');
  perform t.eq('5b planning.avg_completion_rate averages the two weeks'' plan-level rates',
    v_out->'planning'->>'avg_completion_rate', '0.6875');
  perform t.eq('5c planning.avg_pace_ratio is NULL -- no block here has both an estimate and a session',
    v_out->'planning'->'avg_pace_ratio', 'null'::jsonb);
  perform t.eq('5d planning confidence is low at exactly 2 weeks',
    v_out->'planning'->>'confidence', 'low');

  -- ----- focus/execution: below the 5-sample threshold, so NULL, but real
  -- sample sizes and 'insufficient_data' confidence, never a fake average --
  perform t.eq('6 focus.avg_percentage is NULL -- no block here has an estimate at all',
    v_out->'focus'->'avg_percentage', 'null'::jsonb);
  perform t.eq('6b focus.sample_size is a real zero', v_out->'focus'->>'sample_size', '0');
  perform t.eq('6c focus confidence is insufficient_data', v_out->'focus'->>'confidence', 'insufficient_data');
  perform t.eq('7 execution.sample_size is 2 -- the two days with any picked block',
    v_out->'execution'->>'sample_size', '2');
  perform t.eq('7b execution.avg_percentage is NULL below the 5-sample threshold, even though it IS computable',
    v_out->'execution'->'avg_percentage', 'null'::jsonb);
  perform t.eq('7c execution confidence is insufficient_data at n=2', v_out->'execution'->>'confidence', 'insufficient_data');

  -- ----- time-of-day / session-length pass through review_time_patterns ---
  perform t.eq('8 best_study_window is hour 8', v_out->'best_study_window'->>'hour', '8');
  perform t.eq('8b ...with the real sample size', v_out->'best_study_window'->>'sample_size', '6');
  perform t.eq('9 ideal_session_length is the 15-30m bucket', v_out->'ideal_session_length'->>'bucket', '15-30m');

  -- ----- consistency passes through review_momentum, structurally --------
  perform t.eq('10 consistency.momentum_score is present (not null) with an active plan',
    (v_out->'consistency'->'momentum_score') is not null, true);
  perform t.eq('10b current_streak is a non-negative integer',
    (v_out->'consistency'->>'current_streak')::int >= 0, true);
end $test$;

-- ===== no active plan: every field NULL, not a fake value ==================
do $test$
declare
  v_uid uuid := t.mkuser('study_profile_no_plan');
  v_plan uuid;
  v_out jsonb;
begin
  insert into public.plans (user_id, app_name, goal_line, is_active)
    values (v_uid, 'test', 'never activated', false) returning id into v_plan;

  set local role authenticated;
  perform set_config('request.jwt.claim.sub', v_uid::text, true);
  v_out := public.study_profile(42);

  perform t.eq('11 status is no_active_plan', v_out->>'status', 'no_active_plan');
  perform t.eq('11b focus is NULL', v_out->'focus', 'null'::jsonb);
  perform t.eq('11c strongest_subject is NULL', v_out->'strongest_subject', 'null'::jsonb);
  perform t.eq('11d consistency is NULL', v_out->'consistency', 'null'::jsonb);
end $test$;

-- ===== validation and isolation =============================================
do $test$
declare
  v_a uuid := t.mkuser('study_profile_iso_a');
  v_b uuid := t.mkuser('study_profile_iso_b');
  v_plan_a uuid;
  v_plan_b uuid;
  v_cat_b uuid;
  v_out jsonb;
begin
  insert into public.plans (user_id, app_name, goal_line, is_active)
    values (v_a, 'test', 'a', false) returning id into v_plan_a;
  insert into public.plans (user_id, app_name, goal_line, is_active)
    values (v_b, 'test', 'b', false) returning id into v_plan_b;
  insert into public.plan_categories (plan_id, name, label, days, sort_order, created_at)
    values (v_plan_b, 'cat', 'Cat', '{0,1,2}', 0, '2020-01-01'::timestamptz) returning id into v_cat_b;
  insert into public.blocks (user_id, plan_id, category_id, date, position, text, status)
  select v_b, v_plan_b, v_cat_b, current_date - 3, gs.n, 'b block ' || gs.n, 'done'
  from generate_series(0, 2) as gs(n);

  set local role authenticated;
  perform set_config('request.jwt.claim.sub', v_b::text, true);
  perform public.activate_plan(v_plan_b);
  perform set_config('request.jwt.claim.sub', v_a::text, true);
  perform public.activate_plan(v_plan_a);

  v_out := public.study_profile(42);
  perform t.eq('12 user A sees none of user B''s subjects',
    v_out->'strongest_subject', 'null'::jsonb);

  perform t.raises('13 a zero window is rejected',
    $$select public.study_profile(0)$$, '22023');
  perform t.raises('13b a window over 400 days is rejected',
    $$select public.study_profile(401)$$, '22023');
end $test$;

do $test$
begin
  raise notice '--- study_profile: complete ---';
end $test$;
