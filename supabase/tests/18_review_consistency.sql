\set ON_ERROR_STOP on
\pset pager off
set client_min_messages = notice;
set timezone = 'UTC';

-- migrations/0026: review_consistency() -- the Effort Score behind the
-- Consistency heatmap (docs/designs/mtdo-web-review-study-profile-plan.md
-- sec4 Phase B, docs/architecture/api.md sec3k).

-- ===== a normal week: two days, one with real activity, one quiet =========
do $test$
declare
  v_uid uuid := t.mkuser('consist_normal');
  v_plan uuid;
  v_focus_cat uuid;
  v_exec_cat uuid;
  v_a uuid; -- focus_cat, done, estimated 30m
  v_b uuid; -- exec_cat, not done, no estimate
  v_out jsonb;
  v_day1 jsonb;
  v_day2 jsonb;
begin
  insert into public.plans (user_id, app_name, goal_line, is_active)
    values (v_uid, 'test', 'consistency normal', false) returning id into v_plan;
  insert into public.plan_categories (plan_id, name, label, days, sort_order, created_at)
    values (v_plan, 'focus_cat', 'Focus Cat', '{0,1,2,3,4}', 0, '2026-01-01'::timestamptz)
    returning id into v_focus_cat;
  insert into public.plan_categories (plan_id, name, label, days, sort_order, created_at)
    values (v_plan, 'exec_cat', 'Exec Cat', '{0,1,2,3,4}', 1, '2026-01-01'::timestamptz)
    returning id into v_exec_cat;

  -- Day 1 (2026-09-01, ISO week 2026-W36): one done, one not.
  insert into public.blocks (user_id, plan_id, category_id, date, position, text, status, estimated_minutes)
    values (v_uid, v_plan, v_focus_cat, '2026-09-01', 0, 'a', 'done', 30) returning id into v_a;
  insert into public.blocks (user_id, plan_id, category_id, date, position, text, status, estimated_minutes)
    values (v_uid, v_plan, v_exec_cat, '2026-09-01', 0, 'b', 'todo', null) returning id into v_b;
  perform t.ev(v_uid, 'task_completed', '2026-09-01 07:00+00', v_a::text);
  -- 20 real minutes against a 30-planned session.
  perform t.sess(v_uid, '2026-09-01 08:00+00', 1800, 'completed', '2026-09-01 08:20+00');
  -- Day 2 (2026-09-02, same ISO week): nothing at all.

  set local role authenticated;
  perform set_config('request.jwt.claim.sub', v_uid::text, true);
  perform public.activate_plan(v_plan);

  v_out := public.review_consistency('2026-09-01'::date, '2026-09-02'::date);

  perform t.eq('1 declares its schema version', v_out->>'schema_version', 'mtdo.review_consistency.v1');
  perform t.eq('1b declares its formula version', v_out->>'metric_version', 'effort_v1');
  perform t.eq('1c covers both requested days, in order', jsonb_array_length(v_out->'days'), 2);

  v_day1 := v_out->'days'->0;
  v_day2 := v_out->'days'->1;
  perform t.eq('2 day 1 date', v_day1->>'date', '2026-09-01');
  perform t.eq('2b day 1 focus_percentage: 20 real minutes of a 30m target', v_day1->>'focus_percentage', '66.7');
  perform t.eq('2c day 1 execute_percentage: 1 of 2 done', v_day1->>'execute_percentage', '50.0');
  -- weekly_performance over this fixture: focus_cat completion 1.0, exec_cat
  -- completion 0.0, both score_weight 1 (the default) -> score 1, score_max 2.
  perform t.eq('2d day 1 progress_percentage: week score 1 of 2', v_day1->>'progress_percentage', '50.0');
  -- effort = 66.7*.35 + 50.0*.45 + 50.0*.20 = 55.845 -> 55.8; level = floor(55.8/20) = 2
  perform t.eq('2e day 1 effort_score combines all three available components', v_day1->>'effort_score', '55.8');
  perform t.eq('2f day 1 level buckets the score', v_day1->>'level', '2');

  perform t.eq('3 day 2 has no picked/estimated task -- both percentages NULL, not 0',
    v_day2->'focus_percentage', 'null'::jsonb);
  perform t.eq('3b ...execute too', v_day2->'execute_percentage', 'null'::jsonb);
  -- Progress is a WEEKLY number and this is the same ISO week as day 1, so
  -- it applies to day 2 as well -- a real, deliberate property, not a bug.
  perform t.eq('3c ...but progress_percentage still applies -- same ISO week as day 1',
    v_day2->>'progress_percentage', '50.0');
  -- effort renormalizes to the ONE available component: 50.0*.20 / .20 = 50.0 exactly.
  perform t.eq('3d day 2 effort_score renormalizes to the sole available component',
    v_day2->>'effort_score', '50.0');
  perform t.eq('3e day 2 level', v_day2->>'level', '2');
end $test$;

-- ===== a genuinely empty day inside an active plan's life: real 0, not null =
do $test$
declare
  v_uid uuid := t.mkuser('consist_empty');
  v_plan uuid;
  v_out jsonb;
  v_day jsonb;
begin
  insert into public.plans (user_id, app_name, goal_line, is_active)
    values (v_uid, 'test', 'consistency empty', false) returning id into v_plan;
  -- No categories, no blocks, no sessions at all -- and this date's week has
  -- nothing under this plan either, so progress_percentage is also NULL.
  set local role authenticated;
  perform set_config('request.jwt.claim.sub', v_uid::text, true);
  perform public.activate_plan(v_plan);

  v_out := public.review_consistency('2026-01-05'::date, '2026-01-05'::date);
  v_day := v_out->'days'->0;

  perform t.eq('4 focus_percentage is NULL (no basis)', v_day->'focus_percentage', 'null'::jsonb);
  perform t.eq('4b execute_percentage is NULL (nothing picked)', v_day->'execute_percentage', 'null'::jsonb);
  perform t.eq('4c progress_percentage is NULL (this week has no activity under the active plan)',
    v_day->'progress_percentage', 'null'::jsonb);
  perform t.eq('4d effort_score is a REAL ZERO -- a plan exists, nothing happened -- never NULL',
    v_day->>'effort_score', '0');
  perform t.eq('4e level 0', v_day->>'level', '0');
end $test$;

-- ===== no active plan at all: every effort_score/level is NULL, even though
-- focus/execute (user-scoped) can still be non-null =========================
do $test$
declare
  v_uid uuid := t.mkuser('consist_no_plan');
  v_plan uuid;
  v_cat uuid;
  v_block uuid;
  v_out jsonb;
  v_day jsonb;
begin
  insert into public.plans (user_id, app_name, goal_line, is_active)
    values (v_uid, 'test', 'retired, never reactivated', false) returning id into v_plan;
  insert into public.plan_categories (plan_id, name, label, days, sort_order, created_at)
    values (v_plan, 'cat', 'Cat', '{0,1,2}', 0, '2026-01-01'::timestamptz) returning id into v_cat;
  insert into public.blocks (user_id, plan_id, category_id, date, position, text, status, estimated_minutes)
    values (v_uid, v_plan, v_cat, '2026-09-01', 0, 'orphaned work', 'done', 30) returning id into v_block;
  insert into public.activity_events (user_id, kind, occurred_at, payload)
    values (v_uid, 'task_completed', '2026-09-01 07:00+00', jsonb_build_object('block_id', v_block::text));
  perform t.sess(v_uid, '2026-09-01 08:00+00', 1800, 'completed', '2026-09-01 08:30+00');

  set local role authenticated;
  perform set_config('request.jwt.claim.sub', v_uid::text, true);
  -- Deliberately never call activate_plan().

  v_out := public.review_consistency('2026-09-01'::date, '2026-09-01'::date);
  v_day := v_out->'days'->0;

  perform t.eq('5 plan_id is NULL at the top level', v_out->'plan_id', 'null'::jsonb);
  perform t.eq('5b focus_percentage is still computed -- it is user-scoped, not plan-gated',
    v_day->>'focus_percentage', '100.0');
  perform t.eq('5c execute_percentage too', v_day->>'execute_percentage', '100.0');
  perform t.eq('5d ...but effort_score is NULL -- there is no goal to measure this day against',
    v_day->'effort_score', 'null'::jsonb);
  perform t.eq('5e ...and so is level', v_day->'level', 'null'::jsonb);
end $test$;

-- ===== switching goals: old plan's real work is not erased, but PROGRESS ===
-- does not misattribute it to the new plan's categories -- the property
-- this whole function exists to get right (see the migration's own header).
do $test$
declare
  v_uid uuid := t.mkuser('consist_switch');
  v_plan_old uuid;
  v_cat_old uuid;
  v_block_old uuid;
  v_plan_new uuid;
  v_cat_new uuid;
  v_block_new uuid;
  v_out jsonb;
  v_week1 jsonb; -- 2026-08-03, old plan's week (2026-W32)
  v_week2 jsonb; -- 2026-09-01, new plan's week (2026-W36)
begin
  insert into public.plans (user_id, app_name, goal_line, is_active)
    values (v_uid, 'test', 'old goal', false) returning id into v_plan_old;
  insert into public.plan_categories (plan_id, name, label, days, sort_order, created_at)
    values (v_plan_old, 'old_cat', 'Old Cat', '{0,1,2}', 0, '2026-01-01'::timestamptz)
    returning id into v_cat_old;
  insert into public.blocks (user_id, plan_id, category_id, date, position, text, status, estimated_minutes)
    values (v_uid, v_plan_old, v_cat_old, '2026-08-03', 0, 'old work, really done', 'done', 20)
    returning id into v_block_old;
  insert into public.activity_events (user_id, kind, occurred_at, payload)
    values (v_uid, 'task_completed', '2026-08-03 07:00+00', jsonb_build_object('block_id', v_block_old::text));

  insert into public.plans (user_id, app_name, goal_line, is_active)
    values (v_uid, 'test', 'new goal', false) returning id into v_plan_new;
  insert into public.plan_categories (plan_id, name, label, days, sort_order, created_at)
    values (v_plan_new, 'new_cat', 'New Cat', '{0,1,2}', 0, '2026-01-01'::timestamptz)
    returning id into v_cat_new;
  insert into public.blocks (user_id, plan_id, category_id, date, position, text, status, estimated_minutes)
    values (v_uid, v_plan_new, v_cat_new, '2026-09-01', 0, 'new work, done', 'done', 20)
    returning id into v_block_new;
  insert into public.activity_events (user_id, kind, occurred_at, payload)
    values (v_uid, 'task_completed', '2026-09-01 07:00+00', jsonb_build_object('block_id', v_block_new::text));

  set local role authenticated;
  perform set_config('request.jwt.claim.sub', v_uid::text, true);
  perform public.activate_plan(v_plan_old);
  perform public.activate_plan(v_plan_new); -- retires v_plan_old, activates v_plan_new

  v_out := public.review_consistency('2026-08-03'::date, '2026-09-01'::date);
  v_week1 := (select d from jsonb_array_elements(v_out->'days') d where d->>'date' = '2026-08-03');
  v_week2 := (select d from jsonb_array_elements(v_out->'days') d where d->>'date' = '2026-09-01');

  perform t.eq('6 the old plan''s real work is still visible in execute_percentage',
    v_week1->>'execute_percentage', '100.0');
  perform t.eq('6b ...but progress_percentage is NULL -- that week belongs to a plan that is not current',
    v_week1->'progress_percentage', 'null'::jsonb);
  perform t.eq('6c the new plan''s week gets a real progress_percentage',
    v_week2->>'progress_percentage', '100.0');
  perform t.eq('6d ...and its own execute_percentage', v_week2->>'execute_percentage', '100.0');
end $test$;

-- ===== validation ============================================================
do $test$
declare
  v_uid uuid := t.mkuser('consist_validate');
begin
  set local role authenticated;
  perform set_config('request.jwt.claim.sub', v_uid::text, true);

  perform t.raises('7 p_start after p_end is rejected',
    $$select public.review_consistency('2026-09-05'::date, '2026-09-01'::date)$$, '22023');
  perform t.raises('7b a range over 400 days is rejected',
    $$select public.review_consistency('2025-01-01'::date, '2026-06-01'::date)$$, '22023');
end $test$;

-- ===== cross-user isolation ==================================================
do $test$
declare
  v_a uuid := t.mkuser('consist_iso_a');
  v_b uuid := t.mkuser('consist_iso_b');
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
    values (v_plan_b, 'cat', 'Cat', '{0,1,2}', 0, '2026-01-01'::timestamptz) returning id into v_cat_b;
  insert into public.blocks (user_id, plan_id, category_id, date, position, text, status, estimated_minutes)
    values (v_b, v_plan_b, v_cat_b, '2026-09-01', 0, 'b only', 'done', 30);
  perform t.sess(v_b, '2026-09-01 08:00+00', 1800, 'completed', '2026-09-01 08:30+00');

  set local role authenticated;
  perform set_config('request.jwt.claim.sub', v_b::text, true);
  perform public.activate_plan(v_plan_b);

  perform set_config('request.jwt.claim.sub', v_a::text, true);
  perform public.activate_plan(v_plan_a);

  v_out := public.review_consistency('2026-09-01'::date, '2026-09-01'::date);

  perform t.eq('8 user A sees none of user B''s activity',
    (v_out->'days'->0)->>'execute_percentage', null::text);
  perform t.eq('8b ...a real empty day, not user B''s', (v_out->'days'->0)->>'effort_score', '0');
end $test$;

-- ===== 0027 regression: same session_focus_seconds() fix, range grain ======
do $test$
declare
  v_uid uuid := t.mkuser('consist_pause_fix');
  v_plan uuid;
  v_cat uuid;
  v_block uuid;
  v_out jsonb;
  v_day jsonb;
begin
  insert into public.plans (user_id, app_name, goal_line, is_active)
    values (v_uid, 'test', 'pause fix range', false) returning id into v_plan;
  insert into public.plan_categories (plan_id, name, label, days, sort_order, created_at)
    values (v_plan, 'cat', 'Cat', '{0,1,2}', 0, '2026-01-01'::timestamptz) returning id into v_cat;
  insert into public.blocks (user_id, plan_id, category_id, date, position, text, status, estimated_minutes)
    values (v_uid, v_plan, v_cat, '2026-09-01', 0, 'block', 'todo', 30) returning id into v_block;

  -- Same fixture as 17's 9/9b: 30m wall clock, 10m paused, 20m real focus.
  insert into public.focus_sessions
    (user_id, block_id, started_at, completed_at, planned_duration_s, total_paused_s, state)
  values (v_uid, v_block, '2026-09-01 08:00+00', '2026-09-01 08:30+00', 1800, 600, 'completed');

  set local role authenticated;
  perform set_config('request.jwt.claim.sub', v_uid::text, true);
  perform public.activate_plan(v_plan);

  v_out := public.review_consistency('2026-09-01'::date, '2026-09-01'::date);
  v_day := v_out->'days'->0;

  perform t.eq('9 focus_percentage subtracts the paused interval -- 20m of a 30m target, not 30m',
    v_day->>'focus_percentage', '66.7');
end $test$;

do $test$
begin
  raise notice '--- review_consistency: complete ---';
end $test$;
