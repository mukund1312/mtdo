\set ON_ERROR_STOP on
\pset pager off
set client_min_messages = notice;
set timezone = 'UTC';

-- migrations/0017: plans.planning_mode + ensure_curriculum_menu()'s branch
-- on it. The existing 06_curriculum_menu_bridge.sql suite already proves
-- dynamic_weekly's behavior is byte-for-byte unchanged (every plan there
-- gets the new column's default). This file proves the actual new claims:
-- overall mode shows everything with the cursor untouched, and switching
-- back to dynamic_weekly resumes from exactly where it was left, not reset
-- and not advanced for free while in overall mode.
do $test$
declare
  v_uid uuid := t.mkuser('mode_owner');
  v_plan uuid;
  v_cat_a uuid;
  v_cat_b uuid;
  n int;
begin
  insert into public.plans (user_id, app_name, goal_line, is_active)
    values (v_uid, 'test', 'planning mode', false) returning id into v_plan;
  insert into public.plan_categories (plan_id, name, label, days, sort_order)
    values (v_plan, 'dsa', 'DSA', '{0,2,4}', 0) returning id into v_cat_a;
  insert into public.plan_categories (plan_id, name, label, days, sort_order)
    values (v_plan, 'sql', 'SQL', '{0,2}', 1) returning id into v_cat_b;

  -- cat_a: weeks 0-2, 3 items/week (9 items). cat_b: weeks 0-1, 2 items/week
  -- (4 items). cat_a deliberately has THREE weeks, not two -- a single
  -- dynamic_weekly advance (0 -> 1) must stay distinguishable from an
  -- already-at-1 plan advancing a second time (1 -> 2) below, which a
  -- 2-week category can't tell apart (least(cursor+1, max) hits the same
  -- ceiling either way once max_week is only 1).
  insert into public.curriculum_items (category_id, week_index, position, task)
    select v_cat_a, p / 3, p, 'dsa item ' || p from generate_series(0, 8) p;
  insert into public.curriculum_items (category_id, week_index, position, task)
    select v_cat_b, p / 2, p, 'sql item ' || p from generate_series(0, 3) p;

  set local role authenticated;
  perform set_config('request.jwt.claim.sub', v_uid::text, true);
  perform public.activate_plan(v_plan);

  -- ===== 1. default is dynamic_weekly, unchanged behavior =================
  perform t.eq('1 planning_mode defaults to dynamic_weekly',
    (select planning_mode from public.plans where id = v_plan), 'dynamic_weekly');
  n := (select count(*)::int from public.ensure_curriculum_menu());
  perform t.eq('1b first draw in dynamic_weekly unlocks week 0 only (5 of 13 items)', n, 5);

  -- ===== 2. an invalid mode is rejected ====================================
  begin
    update public.plans set planning_mode = 'weekly_ish' where id = v_plan;
    raise exception 'FAIL 2 an invalid planning_mode was accepted';
  exception when check_violation then
    raise notice 'PASS  2 an invalid planning_mode is rejected (23514)';
  end;

  -- ===== 3. switching to overall shows everything, cursor untouched =======
  update public.plans set planning_mode = 'overall' where id = v_plan;
  n := (select count(*)::int from public.ensure_curriculum_menu());
  perform t.eq('3 overall mode returns every item regardless of the cursor (13 total)', n, 13);
  perform t.eq('3b dsa cursor is still at week 0, not advanced by the overall draw',
    (select menu_unlocked_week_index from public.plan_categories where id = v_cat_a), 0);

  -- Calling it again (a second "week" worth of real time would normally
  -- advance dynamic_weekly's cursor) must not move the cursor either, since
  -- overall mode never takes the advance branch at all.
  reset role;
  update public.plan_categories set menu_unlocked_iso_week = '2020-W01' where plan_id = v_plan;
  set local role authenticated;
  perform set_config('request.jwt.claim.sub', v_uid::text, true);
  perform public.ensure_curriculum_menu();
  perform t.eq('3c a later draw in overall mode still does not advance the cursor',
    (select menu_unlocked_week_index from public.plan_categories where id = v_cat_a), 0);

  -- ===== 4. switching back to dynamic_weekly resumes, doesn't reset =======
  update public.plans set planning_mode = 'dynamic_weekly' where id = v_plan;
  -- iso week was rewound to 2020-W01 above (a "new" week relative to that),
  -- so this draw is expected to genuinely advance the cursor by one step
  -- from wherever it was left -- 0, per 3b/3c above -- not from some
  -- inflated value overall mode might have introduced.
  perform public.ensure_curriculum_menu();
  perform t.eq('4 back in dynamic_weekly, the cursor resumes from where it was left (0 -> 1, not 1 -> 2)',
    (select menu_unlocked_week_index from public.plan_categories where id = v_cat_a), 1);
  -- cat_a weeks 0-1 (6 of its 9 items) + cat_b weeks 0-1 (all 4, its max) =
  -- 10 -- not 13 (which is what a wrongly-pre-advanced cursor would show,
  -- since cat_a's max_week is 2 and a second advance would reach it).
  n := (select count(*)::int from public.ensure_curriculum_menu());
  perform t.eq('4b menu is cursor-gated again, proving no free advance happened in overall mode', n, 10);

  reset role;
  raise notice '--- planning mode: complete ---';
end $test$;
