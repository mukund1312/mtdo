\set ON_ERROR_STOP on
\pset pager off
set client_min_messages = notice;
set timezone = 'UTC';

-- migrations/0016: extend_plan(). See docs/architecture/decisions.md
-- 2026-09-08 ("Curriculum exhaustion, reversed again: extend in place") for
-- why this RPC exists at all. Two things must hold, or the reversal's own
-- stated reason for existing is broken: (1) appended items continue each
-- category's own week_index/position numbering, bucketed by that
-- category's real days-per-week, not restarted at 0; (2) the unlock cursor
-- advances in the SAME transaction as the insert, so a user who just asked
-- for more work sees it immediately.
do $test$
declare
  v_owner uuid := t.mkuser('extend_owner');
  v_other uuid := t.mkuser('extend_other');
  v_plan uuid;
  v_cat_a uuid; -- 3 days/week, has weeks 0-1 already (6 items)
  v_cat_b uuid; -- 2 days/week, has week 0 only (1 item)
  v_retired_plan uuid;
  v_retired_cat uuid;
  n int;
begin
  insert into public.plans (user_id, app_name, goal_line, is_active)
    values (v_owner, 'test', 'extend plan', false) returning id into v_plan;
  insert into public.plan_categories (plan_id, name, label, days, sort_order)
    values (v_plan, 'dsa', 'DSA', '{0,2,4}', 0) returning id into v_cat_a;
  insert into public.plan_categories (plan_id, name, label, days, sort_order)
    values (v_plan, 'sql', 'SQL', '{0,2}', 1) returning id into v_cat_b;

  insert into public.curriculum_items (category_id, week_index, position, task)
    select v_cat_a, w, p, 'dsa item ' || p
    from generate_series(0, 5) p, lateral (select p / 3 as w) x; -- weeks 0,0,0,1,1,1
  insert into public.curriculum_items (category_id, week_index, position, task)
    values (v_cat_b, 0, 0, 'sql item 0');

  set local role authenticated;
  perform set_config('request.jwt.claim.sub', v_owner::text, true);
  perform public.activate_plan(v_plan);

  -- ===== 1. anon cannot call it at all ====================================
  reset role;
  set local role anon;
  begin
    perform public.extend_plan('[]'::jsonb);
    raise exception 'FAIL 1 anon could call extend_plan';
  exception when insufficient_privilege then
    raise notice 'PASS  1 anon cannot call extend_plan (42501)';
  end;
  reset role;

  set local role authenticated;
  perform set_config('request.jwt.claim.sub', v_owner::text, true);

  -- ===== 2. a different user cannot extend this category ==================
  perform set_config('request.jwt.claim.sub', v_other::text, true);
  begin
    perform public.extend_plan(jsonb_build_array(jsonb_build_object(
      'category_id', v_cat_a::text,
      'items', jsonb_build_array(jsonb_build_object('task', 'stolen item'))
    )));
    raise exception 'FAIL 2 a different user extended someone else''s category';
  exception when insufficient_privilege then
    raise notice 'PASS  2 a different user cannot extend this category (42501)';
  end;
  perform t.eq('2b no stolen item was inserted',
    (select count(*)::int from public.curriculum_items where task = 'stolen item'), 0);

  perform set_config('request.jwt.claim.sub', v_owner::text, true);

  -- ===== 3. malformed input is rejected cleanly, not a raw cast error ====
  begin
    perform public.extend_plan(jsonb_build_array(jsonb_build_object(
      'category_id', 'not-a-uuid', 'items', jsonb_build_array(jsonb_build_object('task', 'x'))
    )));
    raise exception 'FAIL 3 a non-uuid category_id was accepted';
  exception when invalid_parameter_value then
    raise notice 'PASS  3 a non-uuid category_id is rejected (22023)';
  end;

  begin
    perform public.extend_plan(jsonb_build_array(jsonb_build_object(
      'category_id', v_cat_a::text, 'items', jsonb_build_array(jsonb_build_object('task', '  '))
    )));
    raise exception 'FAIL 4 a blank task was accepted';
  exception when invalid_parameter_value then
    raise notice 'PASS  4 a blank task is rejected (22023)';
  end;
  -- The whole call is one transaction -- a later validation failure must not
  -- leave an earlier item in this same call partially inserted.
  perform t.eq('4b a rejected call inserts nothing at all',
    (select count(*)::int from public.curriculum_items where category_id = v_cat_a), 6);

  -- ===== 5. extending a retired plan's category is refused ===============
  insert into public.plans (user_id, app_name, goal_line, is_active)
    values (v_owner, 'test', 'retired plan', false) returning id into v_retired_plan;
  insert into public.plan_categories (plan_id, name, label, days, sort_order)
    values (v_retired_plan, 'old', 'Old', '{0}', 0) returning id into v_retired_cat;
  insert into public.curriculum_items (category_id, week_index, position, task)
    values (v_retired_cat, 0, 0, 'old item');
  -- Never activated -- v_plan (activated above) is still the one active plan,
  -- which is itself the mechanism under test here (plans_one_active).
  begin
    perform public.extend_plan(jsonb_build_array(jsonb_build_object(
      'category_id', v_retired_cat::text, 'items', jsonb_build_array(jsonb_build_object('task', 'x'))
    )));
    raise exception 'FAIL 5 a retired plan''s category was extended';
  exception when insufficient_privilege then
    raise notice 'PASS  5 a retired plan''s category cannot be extended (42501)';
  end;

  -- ===== 6. the real append: continues numbering, buckets by days/week ===
  n := (select count(*)::int from public.extend_plan(jsonb_build_array(
    jsonb_build_object('category_id', v_cat_a::text, 'items', jsonb_build_array(
      jsonb_build_object('task', 'dsa new 0', 'meta', jsonb_build_object('focus_points', jsonb_build_array('x'))),
      jsonb_build_object('task', 'dsa new 1'),
      jsonb_build_object('task', 'dsa new 2'),
      jsonb_build_object('task', 'dsa new 3')
    )),
    jsonb_build_object('category_id', v_cat_b::text, 'items', jsonb_build_array(
      jsonb_build_object('task', 'sql new 0'),
      jsonb_build_object('task', 'sql new 1')
    ))
  )));
  perform t.eq('6 returns one row per inserted item', n, 6);

  -- cat_a: existing max week_index=1, max position=5. 3 days/week. 4 new
  -- items -> positions 6,7,8,9; weeks 2,2,2,3 (0,1,2 in week 2; 3 in week 3).
  perform t.eq('6a dsa new 0 continues at week 2 (not restarted at 0)',
    (select week_index from public.curriculum_items where task = 'dsa new 0'), 2);
  perform t.eq('6b dsa new 3 rolls into week 3 (3 items/week)',
    (select week_index from public.curriculum_items where task = 'dsa new 3'), 3);
  perform t.eq('6c positions continue from the existing max, not from 0',
    (select position from public.curriculum_items where task = 'dsa new 0'), 6);
  perform t.eq('6d meta is preserved on items that have it',
    (select meta from public.curriculum_items where task = 'dsa new 0'),
    '{"focus_points":["x"]}'::jsonb);
  perform t.eq('6e meta defaults to {} when omitted',
    (select meta from public.curriculum_items where task = 'dsa new 1'), '{}'::jsonb);

  -- cat_b: existing max week_index=0, max position=0. 2 days/week. 2 new
  -- items -> positions 1,2; both land in week 1.
  perform t.eq('6f sql category buckets independently by its own days-per-week',
    (select week_index from public.curriculum_items where task = 'sql new 1'), 1);

  -- ===== 7. the unlock cursor advances immediately, in the same call =====
  perform t.eq('7 dsa category unlocked through the newly-appended week 3',
    (select menu_unlocked_week_index from public.plan_categories where id = v_cat_a), 3);
  perform t.eq('7b sql category unlocked through its newly-appended week 1',
    (select menu_unlocked_week_index from public.plan_categories where id = v_cat_b), 1);
  perform t.eq('7c the new content is on the menu right now, no wait',
    (select count(*)::int from public.ensure_curriculum_menu() m where m.task like '%new%') >= 6, true);

  -- ===== 8. the unique constraint is a real backstop, not just an index ==
  begin
    insert into public.curriculum_items (category_id, week_index, position, task)
      values (v_cat_a, 2, 6, 'duplicate slot');
    raise exception 'FAIL 8 a duplicate (category_id, week_index, position) was accepted';
  exception when unique_violation then
    raise notice 'PASS  8 curriculum_items_category_week_position_key rejects a duplicate slot (23505)';
  end;

  reset role;
  raise notice '--- extend_plan: complete ---';
end $test$;
