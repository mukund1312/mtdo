\set ON_ERROR_STOP on
\pset pager off
set client_min_messages = notice;
set timezone = 'UTC';

-- migrations/0021: iso_week_start() and weekly_performance().
--
-- The fixture under test is supabase/seeds/weekly_engine_demo.sql (sourced by
-- run.sh before this file). Its header documents what each category is built
-- to demonstrate; these assertions pin the exact numbers weekly_performance()
-- must produce from it, so a change to either the function or the fixture
-- that silently stops exercising a threshold fails here rather than passing
-- quietly.

-- ===== iso_week_start() ====================================================
do $test$
begin
  perform t.eq('1 iso_week_start returns the Monday of an ordinary week',
    public.iso_week_start('2026-W37'), date '2026-09-07');
  perform t.eq('1b week 01 of a year whose Jan 1 is mid-week starts in the PREVIOUS December',
    public.iso_week_start('2026-W01'), date '2025-12-29');
  -- 2020 is a 53-week ISO year. A naive "Jan 1 + 7*(week-1)" would be days
  -- out here, which is exactly why this is computed from the Jan-4 anchor.
  perform t.eq('1c a 53-week ISO year resolves its last week correctly',
    public.iso_week_start('2020-W53'), date '2020-12-28');
  perform t.eq('1d round trips against to_char, the format the rest of the schema stamps',
    to_char(public.iso_week_start('2026-W37'), 'IYYY-"W"IW'), '2026-W37');
end $test$;

do $test$
begin
  perform t.raises('2 a malformed ISO week is rejected, not silently coerced',
    $$select public.iso_week_start('2026-37')$$, '22023');
  perform t.raises('2b week 00 is rejected',
    $$select public.iso_week_start('2026-W00')$$, '22023');
  perform t.raises('2c week 54 is rejected',
    $$select public.iso_week_start('2026-W54')$$, '22023');
end $test$;

-- ===== weekly_performance() over the demo fixture ==========================
do $test$
declare
  v_uid uuid := t.mkuser('weekly_perf');
  v_seed jsonb;
  v_plan uuid;
  v_w2 text;
  v_w3 text;
  v_cur jsonb;
  v_prev jsonb;
begin
  v_seed := public.seed_weekly_engine_demo(v_uid, '2026-W36');
  v_plan := (v_seed->>'plan_id')::uuid;
  v_w2 := v_seed->'weeks'->>'w2';
  v_w3 := v_seed->'weeks'->>'w3';

  perform t.eq('3 (fixture) the seed built the three weeks it claims',
    v_seed->'weeks'->>'w1' || ',' || v_w2 || ',' || v_w3,
    '2026-W34,2026-W35,2026-W36');

  set local role authenticated;
  perform set_config('request.jwt.claim.sub', v_uid::text, true);

  v_cur := public.weekly_performance(v_plan, v_w3);
  v_prev := public.weekly_performance(v_plan, v_w2);

  perform t.eq('4 the output declares its schema version',
    v_cur->>'schema_version', 'mtdo.weekly_performance.v1');
  perform t.eq('4b week_start is the Monday of the requested week',
    v_cur->>'week_start', '2026-08-31');
  perform t.eq('4c week_end is the Sunday, six days later',
    v_cur->>'week_end', '2026-09-06');
  perform t.eq('4d every category of the plan appears, including quiet ones',
    jsonb_array_length(v_cur->'categories'), 4);
end $test$;

-- The per-category numbers. Split into its own block so a failure names the
-- category rather than the whole fixture.
do $test$
declare
  v_uid uuid := t.mkuser('weekly_perf_cats');
  v_seed jsonb;
  v_plan uuid;
  v_cur jsonb;
  v_prev jsonb;
begin
  v_seed := public.seed_weekly_engine_demo(v_uid, '2026-W36');
  v_plan := (v_seed->>'plan_id')::uuid;
  set local role authenticated;
  perform set_config('request.jwt.claim.sub', v_uid::text, true);
  v_cur := public.weekly_performance(v_plan, '2026-W36');
  v_prev := public.weekly_performance(v_plan, '2026-W35');

  -- ----- STRUGGLING: completion under half, two weeks running -------------
  perform t.eq('5 dsa completion this week is exactly 1/4',
    (select c->>'completion_rate' from jsonb_array_elements(v_cur->'categories') c
      where c->>'name' = 'dsa'), '0.2500');
  perform t.eq('5b dsa completion last week is exactly 2/6',
    (select c->>'completion_rate' from jsonb_array_elements(v_prev->'categories') c
      where c->>'name' = 'dsa'), '0.3333');
  -- 45 actual against a 30 estimate. This is the assertion that proves the
  -- pomodoro-splitting in the fixture works: recorded as ONE 30-minute
  -- session, least(elapsed, planned_duration_s) would cap it back to 30 and
  -- this would read 1.0000.
  perform t.eq('5c dsa pace is 1.5 -- real overrun survives the per-session cap',
    (select c->>'pace_ratio' from jsonb_array_elements(v_cur->'categories') c
      where c->>'name' = 'dsa'), '1.5000');

  -- ----- COASTING: everything done, well under the estimate ---------------
  perform t.eq('6 sql completes everything it picks',
    (select c->>'completion_rate' from jsonb_array_elements(v_cur->'categories') c
      where c->>'name' = 'sql'), '1.0000');
  perform t.eq('6b sql pace is 0.6 -- 18 actual minutes against a 30 estimate',
    (select c->>'pace_ratio' from jsonb_array_elements(v_cur->'categories') c
      where c->>'name' = 'sql'), '0.6000');

  -- ----- AVOIDED: the menu offered, the user did not pick -----------------
  -- The load-bearing part of this one: completion is 1.0 AND pick_rate is
  -- low. Avoided is about engagement, not failure, and a metric that could
  -- not separate the two would make the signal useless.
  perform t.eq('7 system_design pick_rate this week is 1 of 6',
    (select c->>'pick_rate' from jsonb_array_elements(v_cur->'categories') c
      where c->>'name' = 'system_design'), '0.1667');
  perform t.eq('7b system_design pick_rate last week is 1 of 5',
    (select c->>'pick_rate' from jsonb_array_elements(v_prev->'categories') c
      where c->>'name' = 'system_design'), '0.2000');
  perform t.eq('7c ...while completing everything it DOES pick',
    (select c->>'completion_rate' from jsonb_array_elements(v_cur->'categories') c
      where c->>'name' = 'system_design'), '1.0000');

  -- 7d-7g pin the OBSERVABILITY GATE, not the rates. classifyCategory()
  -- (web/lib/planning/classify.ts) refuses to classify a week at all unless
  -- existed_before_week is true AND something was offered or picked -- so if
  -- either of those silently flipped for this category, `avoided` would
  -- become `insufficient_data`, the engine would emit NO weekly_plan_changes
  -- row for it, and every rate assertion above would still pass. That is a
  -- signal disappearing with nothing going red, which is the worst shape a
  -- rules-engine regression can take. Both trailing weeks are checked
  -- because the classifier requires both.
  --
  -- system_design is the category most exposed to this: it is the smallest
  -- (days=2, so the fewest curriculum items per unlocked week_index) and the
  -- only one whose signal depends on the menu-reconstruction estimate rather
  -- than on completion or pace.
  perform t.eq('7d system_design existed before the week under review',
    (select c->>'existed_before_week' from jsonb_array_elements(v_cur->'categories') c
      where c->>'name' = 'system_design'), 'true');
  perform t.eq('7e ...and before the week before it, which the classifier also reads',
    (select c->>'existed_before_week' from jsonb_array_elements(v_prev->'categories') c
      where c->>'name' = 'system_design'), 'true');
  perform t.eq('7f the menu really did offer it this week (a zero here reads as silence, not avoidance)',
    (select c->>'menu_offered_count' from jsonb_array_elements(v_cur->'categories') c
      where c->>'name' = 'system_design'), '6');
  perform t.eq('7g ...and last week too',
    (select c->>'menu_offered_count' from jsonb_array_elements(v_prev->'categories') c
      where c->>'name' = 'system_design'), '5');

  -- ----- ON TRACK ---------------------------------------------------------
  perform t.eq('8 behavioral completion is 3 of 4',
    (select c->>'completion_rate' from jsonb_array_elements(v_cur->'categories') c
      where c->>'name' = 'behavioral'), '0.7500');
  perform t.eq('8b behavioral pace is exactly 1.0',
    (select c->>'pace_ratio' from jsonb_array_elements(v_cur->'categories') c
      where c->>'name' = 'behavioral'), '1.0000');

  -- ----- the plan-level floor the engine checks before any increase -------
  perform t.eq('9 plan completion this week stays above the 40% low-week floor',
    v_cur->'plan'->>'completion_rate', '0.6923');
  perform t.eq('9b plan completion last week too',
    v_prev->'plan'->>'completion_rate', '0.6667');

  -- ----- resolved target, the baseline every proposal moves ---------------
  perform t.eq('10 an unset weekly_target_blocks resolves to days_per_week',
    (select c->>'current_target' from jsonb_array_elements(v_cur->'categories') c
      where c->>'name' = 'dsa'), '4');
  perform t.eq('10b ...and the raw column is still honestly NULL',
    (select c->'weekly_target_blocks' from jsonb_array_elements(v_cur->'categories') c
      where c->>'name' = 'dsa'), 'null'::jsonb);
  perform t.eq('10c system_design resolves to its own smaller days_per_week',
    (select c->>'current_target' from jsonb_array_elements(v_cur->'categories') c
      where c->>'name' = 'system_design'), '2');

  -- ----- study days, postponement -----------------------------------------
  perform t.eq('11 study_days counts distinct days with real activity, not blocks',
    v_cur->'plan'->>'study_days', '4');
  perform t.eq('11b a completed-then-regressed task counts as a regression that week',
    (select c->>'regressed_count' from jsonb_array_elements(v_cur->'categories') c
      where c->>'name' = 'dsa'), '1');
  perform t.eq('11c ...and is NOT counted as done -- last event of the block wins',
    (select c->>'done_count' from jsonb_array_elements(v_cur->'categories') c
      where c->>'name' = 'dsa'), '1');
end $test$;

-- ===== the null-not-zero rule, which the whole engine turns on =============
do $test$
declare
  v_uid uuid := t.mkuser('weekly_nulls');
  v_plan uuid;
  v_cat uuid;
  v_res jsonb;
  v_c jsonb;
begin
  insert into public.plans (user_id, app_name, goal_line, is_active)
    values (v_uid, 'test', 'null semantics', false) returning id into v_plan;
  -- Backdated so existed_before_week is true and the category is not excluded
  -- for the unrelated reason of being brand new.
  insert into public.plan_categories (plan_id, name, label, days, sort_order, created_at)
    values (v_plan, 'quiet', 'Quiet', '{0,1,2}', 0, '2026-01-01'::timestamptz)
    returning id into v_cat;

  set local role authenticated;
  perform set_config('request.jwt.claim.sub', v_uid::text, true);
  v_res := public.weekly_performance(v_plan, '2026-W36');
  v_c := v_res->'categories'->0;

  -- THE distinction the engine exists to make. If any of these came back as
  -- 0 instead of null, "picked nothing" would be indistinguishable from
  -- "picked everything and failed it all", and the rules would propose
  -- cutting the load of a category the user never opened.
  perform t.eq('12 completion_rate is NULL when nothing was picked, never 0',
    v_c->'completion_rate', 'null'::jsonb);
  perform t.eq('12b pace_ratio is NULL when no task had a computable pace',
    v_c->'pace_ratio', 'null'::jsonb);
  perform t.eq('12c pick_rate is NULL when the menu offered nothing',
    v_c->'pick_rate', 'null'::jsonb);
  -- Counts, unlike rates, are genuinely zero.
  perform t.eq('12d ...but the counts behind them are real zeroes',
    v_c->>'picked_count', '0');
  perform t.eq('12e a plan with no activity still reports every category',
    jsonb_array_length(v_res->'categories'), 1);
  perform t.eq('12f and a plan-level completion_rate of NULL, not 0',
    v_res->'plan'->'completion_rate', 'null'::jsonb);
end $test$;

-- ===== a task with an estimate but no session is EXCLUDED from pace ========
-- The single most damaging false positive this engine can produce: someone
-- who finishes their work without ever starting a timer would otherwise
-- compute as ~0 minutes against a real estimate, read as "coasting", and be
-- handed 25% MORE work for not using a Pomodoro.
do $test$
declare
  v_uid uuid := t.mkuser('weekly_pace_guard');
  v_plan uuid;
  v_cat uuid;
  v_block uuid;
  v_c jsonb;
begin
  insert into public.plans (user_id, app_name, goal_line, is_active)
    values (v_uid, 'test', 'pace guard', false) returning id into v_plan;
  insert into public.plan_categories (plan_id, name, label, days, sort_order, created_at)
    values (v_plan, 'dsa', 'DSA', '{0,1,2}', 0, '2026-01-01'::timestamptz)
    returning id into v_cat;
  -- Done, with a real estimate, and NO focus session at all.
  insert into public.blocks
    (user_id, plan_id, category_id, date, position, text, status, estimated_minutes)
  values (v_uid, v_plan, v_cat, '2026-09-01', 0, 'finished without a timer', 'done', 30)
  returning id into v_block;
  insert into public.activity_events (user_id, kind, occurred_at, payload)
  values (v_uid, 'task_completed', '2026-09-01 18:00+00',
          jsonb_build_object('block_id', v_block::text));

  set local role authenticated;
  perform set_config('request.jwt.claim.sub', v_uid::text, true);
  v_c := (public.weekly_performance(v_plan, '2026-W36'))->'categories'->0;

  perform t.eq('13 a done task counts toward completion even with no session',
    v_c->>'completion_rate', '1.0000');
  perform t.eq('13b ...but is excluded from pace entirely',
    v_c->'pace_ratio', 'null'::jsonb);
  perform t.eq('13c paced_task_count proves the exclusion was deliberate',
    v_c->>'paced_task_count', '0');
end $test$;

-- ===== a block the ledger has never seen falls back to blocks.status =======
do $test$
declare
  v_uid uuid := t.mkuser('weekly_ledger_fallback');
  v_plan uuid;
  v_cat uuid;
  v_done uuid;
  v_todo uuid;
  v_c jsonb;
begin
  insert into public.plans (user_id, app_name, goal_line, is_active)
    values (v_uid, 'test', 'ledger fallback', false) returning id into v_plan;
  insert into public.plan_categories (plan_id, name, label, days, sort_order, created_at)
    values (v_plan, 'dsa', 'DSA', '{0,1,2}', 0, '2026-01-01'::timestamptz)
    returning id into v_cat;
  -- Neither block has any ledger event -- the pre-Phase-1 state, when
  -- task_completed had no call site anywhere in the app (api.md sec2c).
  insert into public.blocks (user_id, plan_id, category_id, date, position, text, status)
  values (v_uid, v_plan, v_cat, '2026-09-01', 0, 'old done block', 'done')
  returning id into v_done;
  insert into public.blocks (user_id, plan_id, category_id, date, position, text, status)
  values (v_uid, v_plan, v_cat, '2026-09-01', 1, 'old todo block', 'todo')
  returning id into v_todo;

  set local role authenticated;
  perform set_config('request.jwt.claim.sub', v_uid::text, true);
  v_c := (public.weekly_performance(v_plan, '2026-W36'))->'categories'->0;

  perform t.eq('14 a block with no ledger history is read from blocks.status',
    v_c->>'done_count', '1');
  perform t.eq('14b ...out of both blocks on the board',
    v_c->>'picked_count', '2');
end $test$;

-- ===== a regression AFTER the week does not rewrite the week's history =====
-- Mirrors recompute_daily_rollups()'s own rule (api.md sec3a): a correction
-- on a later day does not retroactively change an earlier day. Here the
-- block's LAST event wins for the week its date sits in, which is how
-- compute_week_progress() reads current done-ness rather than
-- "was it completed inside these seven days".
do $test$
declare
  v_uid uuid := t.mkuser('weekly_late_regress');
  v_plan uuid;
  v_cat uuid;
  v_block uuid;
  v_c jsonb;
begin
  insert into public.plans (user_id, app_name, goal_line, is_active)
    values (v_uid, 'test', 'late regression', false) returning id into v_plan;
  insert into public.plan_categories (plan_id, name, label, days, sort_order, created_at)
    values (v_plan, 'dsa', 'DSA', '{0,1,2}', 0, '2026-01-01'::timestamptz)
    returning id into v_cat;
  insert into public.blocks (user_id, plan_id, category_id, date, position, text, status)
  values (v_uid, v_plan, v_cat, '2026-09-01', 0, 'completed then walked back later', 'done')
  returning id into v_block;
  insert into public.activity_events (user_id, kind, occurred_at, payload)
  values (v_uid, 'task_completed', '2026-09-01 18:00+00',
          jsonb_build_object('block_id', v_block::text)),
         -- two weeks later
         (v_uid, 'task_regressed', '2026-09-15 09:00+00',
          jsonb_build_object('block_id', v_block::text));

  set local role authenticated;
  perform set_config('request.jwt.claim.sub', v_uid::text, true);
  v_c := (public.weekly_performance(v_plan, '2026-W36'))->'categories'->0;

  perform t.eq('15 the block''s last event wins, so it reads as not done now',
    v_c->>'done_count', '0');
  perform t.eq('15b the regression is NOT counted in the reviewed week, which it did not happen in',
    v_c->>'regressed_count', '0');
end $test$;

-- ===== a category created mid-window is flagged, not scored ================
do $test$
declare
  v_uid uuid := t.mkuser('weekly_new_cat');
  v_plan uuid;
  v_old uuid;
  v_new uuid;
  v_res jsonb;
begin
  insert into public.plans (user_id, app_name, goal_line, is_active)
    values (v_uid, 'test', 'new category', false) returning id into v_plan;
  insert into public.plan_categories (plan_id, name, label, days, sort_order, created_at)
    values (v_plan, 'old', 'Old', '{0,1,2}', 0, '2026-01-01'::timestamptz) returning id into v_old;
  -- Created on the Wednesday of 2026-W36 (which starts Monday 2026-08-31).
  insert into public.plan_categories (plan_id, name, label, days, sort_order, created_at)
    values (v_plan, 'fresh', 'Fresh', '{0,1,2}', 1, '2026-09-02'::timestamptz) returning id into v_new;

  set local role authenticated;
  perform set_config('request.jwt.claim.sub', v_uid::text, true);
  v_res := public.weekly_performance(v_plan, '2026-W36');

  perform t.eq('16 a category that predates the week is marked as covering it',
    (select c->>'existed_before_week' from jsonb_array_elements(v_res->'categories') c
      where c->>'name' = 'old'), 'true');
  perform t.eq('16b a category created mid-week is NOT -- three days is not evidence',
    (select c->>'existed_before_week' from jsonb_array_elements(v_res->'categories') c
      where c->>'name' = 'fresh'), 'false');
end $test$;

-- ===== access control ======================================================
do $test$
declare
  v_owner uuid := t.mkuser('weekly_owner');
  v_intruder uuid := t.mkuser('weekly_intruder');
  v_plan uuid;
begin
  insert into public.plans (user_id, app_name, goal_line, is_active)
    values (v_owner, 'test', 'access', false) returning id into v_plan;

  set local role authenticated;
  perform set_config('request.jwt.claim.sub', v_intruder::text, true);
  perform t.raises('17 another user''s plan cannot be reviewed (and the error does not confirm it exists)',
    format($$select public.weekly_performance(%L::uuid, '2026-W36')$$, v_plan), '42501');

  perform set_config('request.jwt.claim.sub', v_owner::text, true);
  perform t.raises('17b a malformed week is rejected before any aggregation runs',
    format($$select public.weekly_performance(%L::uuid, 'not-a-week')$$, v_plan), '22023');
end $test$;

do $test$
begin
  raise notice '--- weekly_performance: complete ---';
end $test$;
