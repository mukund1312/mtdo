\set ON_ERROR_STOP on
\pset pager off
set client_min_messages = notice;
set timezone = 'UTC';

-- migrations/0012: the curriculum -> blocks bridge. The model under test is
-- an unlocking, carry-forward menu -- NOT a calendar schedule. See 0012's
-- header for why the scheduler reading of plan_categories.days is wrong.
do $test$
declare
  v_u1 uuid := t.mkuser('menu_owner');
  v_u2 uuid := t.mkuser('menu_other');
  v_plan uuid;
  v_cat_a uuid;
  v_cat_b uuid;
  v_w0_1 uuid; v_w0_2 uuid; v_w1_1 uuid;
  v_b_item uuid;
  v_block public.blocks;
  v_block2 public.blocks;
  v_id uuid;
  n int;
  v_today date := (now() at time zone 'UTC')::date;
begin
  -- ===== 0. no active plan is an empty menu, not an error ================
  set local role authenticated;
  perform set_config('request.jwt.claim.sub', v_u1::text, true);
  perform t.eq('0 no active plan yields an empty menu',
               (select count(*)::int from public.ensure_curriculum_menu()), 0);
  reset role;

  -- Fixture. is_active false on insert (plans_guard_activation, 0006-0008);
  -- activated below through the sanctioned RPC.
  insert into public.plans (user_id, app_name, goal_line, is_active)
    values (v_u1, 'test', 'curriculum bridge', false) returning id into v_plan;
  insert into public.plan_categories (plan_id, name, label, days, sort_order)
    values (v_plan, 'dsa', 'DSA', '{0,2,4}', 0) returning id into v_cat_a;
  insert into public.plan_categories (plan_id, name, label, days, sort_order)
    values (v_plan, 'sql', 'SQL', '{0,2,4}', 1) returning id into v_cat_b;

  -- Two weeks of content, which is exactly what prompt.ts rule 2 generates.
  insert into public.curriculum_items (category_id, week_index, position, task, meta)
    values (v_cat_a, 0, 0, 'Arrays: two pointers',
            '{"focus_points":["invariants"]}'::jsonb) returning id into v_w0_1;
  insert into public.curriculum_items (category_id, week_index, position, task)
    values (v_cat_a, 0, 1, 'Arrays: sliding window') returning id into v_w0_2;
  insert into public.curriculum_items (category_id, week_index, position, task)
    values (v_cat_a, 1, 2, 'Hash maps: frequency counting') returning id into v_w1_1;
  insert into public.curriculum_items (category_id, week_index, position, task)
    values (v_cat_b, 0, 0, 'SELECT and WHERE') returning id into v_b_item;

  set local role authenticated;
  perform set_config('request.jwt.claim.sub', v_u1::text, true);
  perform public.activate_plan(v_plan);

  -- ===== 1. first draw unlocks week 0 ONLY ===============================
  -- The bug this pins: a null iso_week taking the "advance" branch would
  -- start a brand new user on week 1 and dump both weeks on them at once.
  n := (select count(*)::int from public.ensure_curriculum_menu());
  perform t.eq('1 first draw returns only week 0 across both categories', n, 3);
  perform t.eq('1 cursor sits at week 0',
               (select max(menu_unlocked_week_index) from public.plan_categories
                 where plan_id = v_plan), 0);
  perform t.eq('1 week 1 item is not on the menu yet',
               (select count(*)::int from public.ensure_curriculum_menu() m
                 where m.curriculum_item_id = v_w1_1), 0);

  -- ===== 2. a second draw in the same ISO week does not advance ==========
  perform public.ensure_curriculum_menu();
  perform public.ensure_curriculum_menu();
  perform t.eq('2 repeated draws in one ISO week leave the cursor alone',
               (select max(menu_unlocked_week_index) from public.plan_categories
                 where plan_id = v_plan), 0);

  -- ===== 3. a new ISO week advances exactly one step =====================
  reset role;
  update public.plan_categories set menu_unlocked_iso_week = '2020-W01' where plan_id = v_plan;
  set local role authenticated;
  perform set_config('request.jwt.claim.sub', v_u1::text, true);
  n := (select count(*)::int from public.ensure_curriculum_menu());
  perform t.eq('3 cursor advanced one week',
               (select max(menu_unlocked_week_index) from public.plan_categories
                 where plan_id = v_plan), 1);
  perform t.eq('3 CARRY-FORWARD: week 0 items are still on the menu alongside week 1', n, 4);

  -- ===== 4. the cursor caps at the content that exists ===================
  -- Category b only has week 0. Advancing repeatedly must not walk its
  -- cursor off into weeks that will never exist.
  reset role;
  update public.plan_categories set menu_unlocked_iso_week = '2020-W02' where plan_id = v_plan;
  set local role authenticated;
  perform set_config('request.jwt.claim.sub', v_u1::text, true);
  perform public.ensure_curriculum_menu();
  perform t.eq('4 category with only week 0 stays capped at 0',
               (select menu_unlocked_week_index from public.plan_categories where id = v_cat_b), 0);
  perform t.eq('4 category with two weeks stays capped at 1',
               (select menu_unlocked_week_index from public.plan_categories where id = v_cat_a), 1);

  -- ===== 5. picking places a real block on today's board =================
  v_block := public.pick_curriculum_item(v_w0_1);
  perform t.eq('5 block carries the item text', v_block.text, 'Arrays: two pointers');
  perform t.eq('5 block is dated today (UTC)', v_block.date, v_today);
  perform t.eq('5 block starts as todo', v_block.status, 'todo');
  perform t.eq('5 block records its provenance', v_block.curriculum_item_id, v_w0_1);
  perform t.eq('5 coaching is copied from the item meta',
               v_block.coaching, '{"focus_points":["invariants"]}'::jsonb);
  perform t.eq('5 block belongs to the item''s category', v_block.category_id, v_cat_a);

  -- ===== 6. a picked item leaves the menu ================================
  perform t.eq('6 picked item is gone from the menu',
               (select count(*)::int from public.ensure_curriculum_menu() m
                 where m.curriculum_item_id = v_w0_1), 0);

  -- ===== 7. deleting the block puts the item back =======================
  -- "Picked" is derived, not stored, so this follows for free -- and it is
  -- the behaviour a user would predict after removing a card by mistake.
  delete from public.blocks where id = v_block.id;
  perform t.eq('7 removing the block returns the item to the menu',
               (select count(*)::int from public.ensure_curriculum_menu() m
                 where m.curriculum_item_id = v_w0_1), 1);

  -- ===== 8. picking is idempotent =======================================
  v_block := public.pick_curriculum_item(v_w0_1);
  v_block2 := public.pick_curriculum_item(v_w0_1);
  perform t.eq('8 a second pick returns the same block', v_block2.id, v_block.id);
  perform t.eq('8 and does not create a duplicate',
               (select count(*)::int from public.blocks
                 where user_id = v_u1 and curriculum_item_id = v_w0_1), 1);

  -- ===== 9. position allocation is sequential per category/day ==========
  v_block2 := public.pick_curriculum_item(v_w0_2);
  perform t.eq('9 second pick in the category takes the next position',
               v_block2.position, v_block.position + 1);
  perform t.eq('9 a pick in a different category starts its own sequence',
               (public.pick_curriculum_item(v_b_item)).position, 0);

  -- ===== 10. empty meta becomes NULL coaching, not '{}' =================
  perform t.eq('10 item with no meta leaves coaching null', v_block2.coaching, null::jsonb);

  raise notice '--- curriculum bridge: behaviour complete ---';
end
$test$;

-- ===== 11. constraints, ownership and privileges =========================
do $test$
declare
  v_u1 uuid := (select id from auth.users where email = 'menu_owner@test.local');
  v_u2 uuid := (select id from auth.users where email = 'menu_other@test.local');
  v_w0_1 uuid := (select id from public.curriculum_items where task = 'Arrays: two pointers');
  v_b_item uuid := (select id from public.curriculum_items where task = 'SELECT and WHERE');
  v_cat_a uuid := (select category_id from public.curriculum_items where task = 'Arrays: two pointers');
  v_block_id uuid;
  v_plan uuid;
begin
  -- 11a. another user cannot pick an item they do not own, and the error
  -- does not distinguish "not yours" from "does not exist".
  set local role authenticated;
  perform set_config('request.jwt.claim.sub', v_u2::text, true);
  begin
    perform public.pick_curriculum_item(v_w0_1);
    raise exception 'FAIL 11a another user picked an item they do not own';
  exception when insufficient_privilege then
    raise notice 'PASS  11a another user cannot pick an item they do not own (42501)';
  end;
  perform t.eq('11a ...and no block was created for them',
               (select count(*)::int from public.blocks where user_id = v_u2), 0);
  reset role;

  -- 11b. the one-block-per-item index is structural, not just RPC logic.
  select id into v_block_id from public.blocks where curriculum_item_id = v_w0_1;
  select plan_id into v_plan from public.plan_categories where id = v_cat_a;
  set local role authenticated;
  perform set_config('request.jwt.claim.sub', v_u1::text, true);
  begin
    insert into public.blocks (user_id, plan_id, category_id, curriculum_item_id, date, position, text)
      values (v_u1, v_plan, v_cat_a, v_w0_1, (now() at time zone 'UTC')::date, 99, 'hand-forged duplicate');
    raise exception 'FAIL 11b a duplicate curriculum block was accepted';
  exception when unique_violation then
    raise notice 'PASS  11b blocks_curriculum_item_once rejects a second block for one item (23505)';
  end;

  -- 11c. the composite FK proves the item belongs to the block's category.
  -- v_b_item is currently picked, and blocks_curriculum_item_once would fire
  -- first and mask the constraint actually under test here -- so free it.
  delete from public.blocks where user_id = v_u1 and curriculum_item_id = v_b_item;
  begin
    update public.blocks set curriculum_item_id = v_b_item where id = v_block_id;
    raise exception 'FAIL 11c an item from another category was accepted';
  exception when foreign_key_violation then
    raise notice 'PASS  11c blocks_curriculum_item_fk rejects an item from another category (23503)';
  end;
  reset role;

  -- 11d. ON DELETE SET NULL keeps the block and its copied text.
  delete from public.curriculum_items where id = v_w0_1;
  perform t.eq('11d deleting the curriculum item keeps the block',
               (select count(*)::int from public.blocks where id = v_block_id), 1);
  perform t.eq('11d ...with its copied text intact',
               (select text from public.blocks where id = v_block_id), 'Arrays: two pointers');
  perform t.eq('11d ...and only the backlink nulled',
               (select curriculum_item_id from public.blocks where id = v_block_id), null::uuid);

  -- 11e. execute privileges: authenticated yes, anon no.
  set local role anon;
  begin
    perform public.ensure_curriculum_menu();
    raise exception 'FAIL 11e anon could call ensure_curriculum_menu';
  exception when insufficient_privilege then
    raise notice 'PASS  11e anon cannot call ensure_curriculum_menu (42501)';
  end;
  begin
    perform public.pick_curriculum_item(v_b_item);
    raise exception 'FAIL 11e anon could call pick_curriculum_item';
  exception when insufficient_privilege then
    raise notice 'PASS  11e anon cannot call pick_curriculum_item (42501)';
  end;
  reset role;

  -- 11f. a retired plan is not pickable -- picking from a goal the user put
  -- down would resurrect it onto today's board.
  update public.plans set is_active = false where id = v_plan;
  set local role authenticated;
  perform set_config('request.jwt.claim.sub', v_u1::text, true);
  begin
    perform public.pick_curriculum_item(v_b_item);
    raise exception 'FAIL 11f picked from a retired plan';
  exception when insufficient_privilege then
    raise notice 'PASS  11f a retired plan''s items cannot be picked (42501)';
  end;
  perform t.eq('11f ...and a retired plan yields an empty menu',
               (select count(*)::int from public.ensure_curriculum_menu()), 0);
  reset role;

  raise notice '--- curriculum bridge: constraints complete ---';
end
$test$;
