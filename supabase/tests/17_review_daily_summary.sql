\set ON_ERROR_STOP on
\pset pager off
set client_min_messages = notice;
set timezone = 'UTC';

-- migrations/0025: review_daily_summary() -- the Focus/Execute/Progress
-- rings behind the Review page (docs/designs/mtdo-web-review-study-profile-plan.md
-- sec4 Phase A, docs/architecture/api.md sec3j).
--
-- 2026-09-01 is a Tuesday inside ISO week 2026-W36 (Monday 2026-08-31 --
-- Sunday 2026-09-06), the same week 13_weekly_performance.sql's fixtures use,
-- so this file's numbers can be sanity-checked against that one's if needed.

-- ===== the three rings over a normal day ===================================
do $test$
declare
  v_uid uuid := t.mkuser('review_daily');
  v_plan uuid;
  v_focus_cat uuid;
  v_exec_cat uuid;
  v_b1 uuid; -- focus_cat, done, estimated 30m
  v_b2 uuid; -- exec_cat, done, no estimate
  v_b3 uuid; -- exec_cat, not done, estimated 20m
  v_out jsonb;
  v_weekly jsonb;
begin
  insert into public.plans (user_id, app_name, goal_line, is_active)
    values (v_uid, 'test', 'review daily summary', false) returning id into v_plan;
  insert into public.plan_categories (plan_id, name, label, days, sort_order, score_weight, created_at)
    values (v_plan, 'focus_cat', 'Focus Cat', '{0,1,2,3,4}', 0, 2, '2026-01-01'::timestamptz)
    returning id into v_focus_cat;
  insert into public.plan_categories (plan_id, name, label, days, sort_order, score_weight, created_at)
    values (v_plan, 'exec_cat', 'Exec Cat', '{0,1,2,3,4}', 1, 1, '2026-01-01'::timestamptz)
    returning id into v_exec_cat;

  insert into public.blocks (user_id, plan_id, category_id, date, position, text, status, estimated_minutes)
    values (v_uid, v_plan, v_focus_cat, '2026-09-01', 0, 'b1', 'done', 30) returning id into v_b1;
  insert into public.blocks (user_id, plan_id, category_id, date, position, text, status, estimated_minutes)
    values (v_uid, v_plan, v_exec_cat, '2026-09-01', 0, 'b2', 'done', null) returning id into v_b2;
  insert into public.blocks (user_id, plan_id, category_id, date, position, text, status, estimated_minutes)
    values (v_uid, v_plan, v_exec_cat, '2026-09-01', 1, 'b3', 'todo', 20) returning id into v_b3;

  perform t.ev(v_uid, 'task_completed', '2026-09-01 07:00+00', v_b1::text);
  perform t.ev(v_uid, 'task_completed', '2026-09-01 07:30+00', v_b2::text);

  -- 25m completed session + a 30m-planned session abandoned after 10m real.
  perform t.sess(v_uid, '2026-09-01 08:00+00', 1500, 'completed', '2026-09-01 08:25+00');
  perform t.sess(v_uid, '2026-09-01 09:00+00', 1800, 'abandoned', '2026-09-01 09:10+00');

  set local role authenticated;
  perform set_config('request.jwt.claim.sub', v_uid::text, true);
  perform public.activate_plan(v_plan);

  v_out := public.review_daily_summary('2026-09-01'::date);
  v_weekly := public.weekly_performance(v_plan, '2026-W36');

  perform t.eq('1 declares its schema version', v_out->>'schema_version', 'mtdo.review_daily_summary.v1');
  perform t.eq('1b status is ok with an active plan', v_out->>'status', 'ok');
  perform t.eq('1c resolves the active plan without being told which one', v_out->>'plan_id', v_plan::text);
  perform t.eq('1d resolves the containing ISO week', v_out->>'iso_week', '2026-W36');

  -- ----- FOCUS: 25m + 10m = 35m against a 50m (30+20) estimate-derived target
  perform t.eq('2 focus_minutes sums real elapsed, not planned', v_out->'focus'->>'focus_minutes', '35.0');
  perform t.eq('2b target is the sum of TODAY''s real estimates, never invented',
    v_out->'focus'->>'target_minutes', '50.0');
  perform t.eq('2c focus percentage is 35/50', v_out->'focus'->>'percentage', '70.0');
  perform t.eq('2d session_count counts both sessions', v_out->'focus'->>'session_count', '2');
  perform t.eq('2e completed_sessions counts only the completed one', v_out->'focus'->>'completed_sessions', '1');
  perform t.eq('2f longest_session_minutes is the completed 25m one, not the abandoned one',
    v_out->'focus'->>'longest_session_minutes', '25.0');

  -- ----- EXECUTE: 2 of 3 blocks done; score is category-weighted, so it
  -- differs from the raw ratio by design (2 + 1 done-weight of 4 total-weight)
  perform t.eq('3 tasks_done', v_out->'execute'->>'tasks_done', '2');
  perform t.eq('3b tasks_picked', v_out->'execute'->>'tasks_picked', '3');
  perform t.eq('3c raw percentage is 2/3', v_out->'execute'->>'percentage', '66.7');
  perform t.eq('3d score_max_today sums every picked block''s category weight (2+1+1)',
    v_out->'execute'->>'score_max', '4');
  perform t.eq('3e score_today sums only DONE blocks'' weight (2 from b1 + 1 from b2)',
    v_out->'execute'->>'score', '3');

  -- ----- PROGRESS: must equal weekly_performance()'s own number exactly --
  -- the whole point is there is no second formula.
  perform t.eq('4 progress.week_score equals weekly_performance()''s plan.score',
    v_out->'progress'->>'week_score', v_weekly->'plan'->>'score');
  perform t.eq('4b progress.week_score_max equals weekly_performance()''s plan.score_max',
    v_out->'progress'->>'week_score_max', v_weekly->'plan'->>'score_max');
  perform t.eq('4c progress.percentage is week_score / week_score_max',
    v_out->'progress'->>'percentage',
    round((v_weekly->'plan'->>'score')::numeric / (v_weekly->'plan'->>'score_max')::numeric * 100, 1)::text);
end $test$;

-- ===== a day with nothing planned: null, not zero ==========================
do $test$
declare
  v_uid uuid := t.mkuser('review_daily_quiet');
  v_plan uuid;
  v_out jsonb;
begin
  insert into public.plans (user_id, app_name, goal_line, is_active)
    values (v_uid, 'test', 'quiet day', false) returning id into v_plan;
  insert into public.plan_categories (plan_id, name, label, days, sort_order, created_at)
    values (v_plan, 'quiet', 'Quiet', '{0,1,2}', 0, '2026-01-01'::timestamptz);

  set local role authenticated;
  perform set_config('request.jwt.claim.sub', v_uid::text, true);
  perform public.activate_plan(v_plan);
  v_out := public.review_daily_summary('2026-09-01'::date);

  perform t.eq('5 execute.percentage is NULL when nothing was picked today, never 0',
    v_out->'execute'->'percentage', 'null'::jsonb);
  perform t.eq('5b ...but tasks_picked is a real zero', v_out->'execute'->>'tasks_picked', '0');
  perform t.eq('5c focus.target_minutes is NULL with no estimated task today, never 0',
    v_out->'focus'->'target_minutes', 'null'::jsonb);
  perform t.eq('5d focus.percentage is NULL for the same reason', v_out->'focus'->'percentage', 'null'::jsonb);
  perform t.eq('5e focus_minutes is a real zero -- no sessions ran', v_out->'focus'->>'focus_minutes', '0.0');
end $test$;

-- ===== no active plan =======================================================
do $test$
declare
  v_uid uuid := t.mkuser('review_daily_no_plan');
  v_out jsonb;
begin
  -- A retired plan only -- deliberately not active.
  insert into public.plans (user_id, app_name, goal_line, is_active)
    values (v_uid, 'test', 'retired', false);

  set local role authenticated;
  perform set_config('request.jwt.claim.sub', v_uid::text, true);
  v_out := public.review_daily_summary('2026-09-01'::date);

  perform t.eq('6 status is no_active_plan', v_out->>'status', 'no_active_plan');
  perform t.eq('6b rings are null, not a fake zero ring', v_out->'focus', 'null'::jsonb);
  perform t.eq('6c ...for all three', v_out->'execute', 'null'::jsonb);
  perform t.eq('6d ...including progress', v_out->'progress', 'null'::jsonb);
end $test$;

-- ===== a default date resolves to "today" in the caller's own zone =========
do $test$
declare
  v_uid uuid := t.mkuser('review_daily_default_date');
  v_plan uuid;
  v_out jsonb;
begin
  insert into public.plans (user_id, app_name, goal_line, is_active)
    values (v_uid, 'test', 'default date', false) returning id into v_plan;

  set local role authenticated;
  perform set_config('request.jwt.claim.sub', v_uid::text, true);
  perform public.activate_plan(v_plan);
  v_out := public.review_daily_summary();

  perform t.eq('7 a null p_date resolves to today (UTC, no profile timezone set)',
    v_out->>'date', to_char(current_date, 'YYYY-MM-DD'));
end $test$;

-- ===== cross-user isolation: one user never sees another's blocks/sessions =
do $test$
declare
  v_a uuid := t.mkuser('review_daily_a');
  v_b uuid := t.mkuser('review_daily_b');
  v_plan_a uuid;
  v_plan_b uuid;
  v_cat_a uuid;
  v_cat_b uuid;
  v_out jsonb;
begin
  insert into public.plans (user_id, app_name, goal_line, is_active)
    values (v_a, 'test', 'user a', false) returning id into v_plan_a;
  insert into public.plans (user_id, app_name, goal_line, is_active)
    values (v_b, 'test', 'user b', false) returning id into v_plan_b;
  insert into public.plan_categories (plan_id, name, label, days, sort_order, created_at)
    values (v_plan_a, 'cat', 'Cat', '{0,1,2}', 0, '2026-01-01'::timestamptz) returning id into v_cat_a;
  insert into public.plan_categories (plan_id, name, label, days, sort_order, created_at)
    values (v_plan_b, 'cat', 'Cat', '{0,1,2}', 0, '2026-01-01'::timestamptz) returning id into v_cat_b;

  -- User B has a full, done, estimated day. User A has nothing.
  insert into public.blocks (user_id, plan_id, category_id, date, position, text, status, estimated_minutes)
    values (v_b, v_plan_b, v_cat_b, '2026-09-01', 0, 'b only', 'done', 60);
  perform t.sess(v_b, '2026-09-01 08:00+00', 3600, 'completed', '2026-09-01 09:00+00');

  set local role authenticated;
  perform set_config('request.jwt.claim.sub', v_b::text, true);
  perform public.activate_plan(v_plan_b);

  perform set_config('request.jwt.claim.sub', v_a::text, true);
  perform public.activate_plan(v_plan_a);

  v_out := public.review_daily_summary('2026-09-01'::date);

  perform t.eq('8 user A''s summary reflects only user A -- nothing picked, no focus time',
    v_out->'execute'->>'tasks_picked', '0');
  perform t.eq('8b ...and no focus minutes leaked from user B''s session',
    v_out->'focus'->>'focus_minutes', '0.0');
  perform t.eq('8c ...and plan_id is A''s own plan, not B''s', v_out->>'plan_id', v_plan_a::text);
end $test$;

-- ===== 0030 regression: focus time subtracts paused time, via ===============
-- session_focus_seconds() (0023), never a re-spelled cap. t.sess() doesn't
-- expose total_paused_s, so this session is inserted directly.
do $test$
declare
  v_uid uuid := t.mkuser('review_daily_pause_fix');
  v_plan uuid;
  v_cat uuid;
  v_block uuid;
  v_out jsonb;
begin
  insert into public.plans (user_id, app_name, goal_line, is_active)
    values (v_uid, 'test', 'pause fix', false) returning id into v_plan;
  insert into public.plan_categories (plan_id, name, label, days, sort_order, created_at)
    values (v_plan, 'cat', 'Cat', '{0,1,2}', 0, '2026-01-01'::timestamptz) returning id into v_cat;
  insert into public.blocks (user_id, plan_id, category_id, date, position, text, status, estimated_minutes)
    values (v_uid, v_plan, v_cat, '2026-09-01', 0, 'block', 'todo', 30) returning id into v_block;

  -- Planned 30m (1800s), wall clock 30m (08:00-08:30), but 10m (600s) of that
  -- was paused. Real focus time is 20m -- the pre-0030 bug would have
  -- reported the full 30m (elapsed capped at planned, ignoring the pause).
  insert into public.focus_sessions
    (user_id, block_id, started_at, completed_at, planned_duration_s, total_paused_s, state)
  values (v_uid, v_block, '2026-09-01 08:00+00', '2026-09-01 08:30+00', 1800, 600, 'completed');

  set local role authenticated;
  perform set_config('request.jwt.claim.sub', v_uid::text, true);
  perform public.activate_plan(v_plan);

  v_out := public.review_daily_summary('2026-09-01'::date);

  perform t.eq('9 focus_minutes subtracts the paused interval -- 30m wall clock minus 10m paused = 20m',
    v_out->'focus'->>'focus_minutes', '20.0');
  perform t.eq('9b longest_session_minutes agrees',
    v_out->'focus'->>'longest_session_minutes', '20.0');
end $test$;

do $test$
begin
  raise notice '--- review_daily_summary: complete ---';
end $test$;
