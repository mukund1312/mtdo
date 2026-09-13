\set ON_ERROR_STOP on
\pset pager off
set client_min_messages = notice;
set timezone = 'UTC';

-- migrations/0029: review_momentum() (docs/designs/mtdo-web-review-study-profile-plan.md
-- sec4 Phase C, docs/architecture/api.md sec3m).
--
-- review_momentum() resolves "today" from real now(), not a fixture date, so
-- these fixtures are built relative to current_date rather than literal
-- dates. To keep the numbers hand-verifiable regardless of which real ISO
-- week the test happens to run in, the test data lives under a plan that is
-- NEVER activated -- review_consistency()'s progress_percentage only looks
-- at weeks the CURRENT active plan touched (0026), so keeping the data plan
-- inactive guarantees progress_percentage is NULL for every day here,
-- leaving effort_score equal to execute_percentage exactly (the same
-- renormalize-to-the-sole-available-component property Phase B's own day-2
-- test already relies on). A separate, genuinely-active plan with zero
-- blocks supplies a real (non-null) plan_id.

do $test$
declare
  v_uid uuid := t.mkuser('momentum_normal');
  v_plan_active uuid;
  v_plan_data uuid;
  v_cat uuid;
  v_out jsonb;
begin
  insert into public.plans (user_id, app_name, goal_line, is_active)
    values (v_uid, 'test', 'active, no data', false) returning id into v_plan_active;
  insert into public.plans (user_id, app_name, goal_line, is_active)
    values (v_uid, 'test', 'inactive, all the data', false) returning id into v_plan_data;
  insert into public.plan_categories (plan_id, name, label, days, sort_order, created_at)
    values (v_plan_data, 'cat', 'Cat', '{0,1,2}', 0, '2020-01-01'::timestamptz) returning id into v_cat;

  -- Pattern (oldest -> newest, 5-day window): active, active, active,
  -- inactive, active -- current_streak (1, broken yesterday) < longest_streak (3).
  insert into public.blocks (user_id, plan_id, category_id, date, position, text, status)
  values
    (v_uid, v_plan_data, v_cat, current_date - 4, 0, 'day -4 done', 'done'),
    (v_uid, v_plan_data, v_cat, current_date - 3, 0, 'day -3 done', 'done'),
    (v_uid, v_plan_data, v_cat, current_date - 2, 0, 'day -2 done', 'done'),
    (v_uid, v_plan_data, v_cat, current_date - 1, 0, 'day -1 NOT done', 'todo'),
    (v_uid, v_plan_data, v_cat, current_date,     0, 'today done', 'done');

  set local role authenticated;
  perform set_config('request.jwt.claim.sub', v_uid::text, true);
  perform public.activate_plan(v_plan_active);

  v_out := public.review_momentum(5);

  perform t.eq('1 declares its schema version', v_out->>'schema_version', 'mtdo.review_momentum.v1');
  perform t.eq('1b declares its formula version', v_out->>'metric_version', 'momentum_v1');
  perform t.eq('1c status ok with an active plan', v_out->>'status', 'ok');
  perform t.eq('1d window_days echoes the request', v_out->>'window_days', '5');

  -- active = [T, T, T, F, T] oldest to newest.
  perform t.eq('2 longest_streak is 3 -- the run of three active days before the break',
    v_out->>'longest_streak', '3');
  perform t.eq('2b current_streak is 1 -- yesterday broke the longer run; only today counts now',
    v_out->>'current_streak', '1');
  perform t.eq('2c active_days_rate is 4 of 5', v_out->>'active_days_rate', '0.8000');

  -- effort_score per day equals execute_percentage exactly here (progress is
  -- NULL throughout, focus is NULL throughout -- see header). EWMA with
  -- decay 0.9, values [100,100,100,0,100] oldest->newest:
  -- (100*0.6561 + 100*0.729 + 100*0.81 + 0*0.9 + 100*1) / (0.6561+0.729+0.81+0.9+1)
  -- = 319.51 / 4.0951 = 78.0 (rounded to 1 decimal).
  perform t.eq('3 momentum_score is the decayed average, not a simple mean (which would be 80.0)',
    v_out->>'momentum_score', '78.0');
end $test$;

-- ===== no active plan: every field is NULL, not a fake 0 ===================
do $test$
declare
  v_uid uuid := t.mkuser('momentum_no_plan');
  v_plan uuid;
  v_out jsonb;
begin
  insert into public.plans (user_id, app_name, goal_line, is_active)
    values (v_uid, 'test', 'never activated', false) returning id into v_plan;

  set local role authenticated;
  perform set_config('request.jwt.claim.sub', v_uid::text, true);
  v_out := public.review_momentum(5);

  perform t.eq('4 status is no_active_plan', v_out->>'status', 'no_active_plan');
  perform t.eq('4b momentum_score is NULL', v_out->'momentum_score', 'null'::jsonb);
  perform t.eq('4c current_streak is NULL', v_out->'current_streak', 'null'::jsonb);
  perform t.eq('4d longest_streak is NULL', v_out->'longest_streak', 'null'::jsonb);
  perform t.eq('4e active_days_rate is NULL', v_out->'active_days_rate', 'null'::jsonb);
end $test$;

-- ===== validation ============================================================
do $test$
declare
  v_uid uuid := t.mkuser('momentum_validate');
begin
  set local role authenticated;
  perform set_config('request.jwt.claim.sub', v_uid::text, true);

  perform t.raises('5 a zero window is rejected',
    $$select public.review_momentum(0)$$, '22023');
  perform t.raises('5b a window over 400 days is rejected',
    $$select public.review_momentum(401)$$, '22023');
end $test$;

do $test$
begin
  raise notice '--- review_momentum: complete ---';
end $test$;
