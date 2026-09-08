\set ON_ERROR_STOP on
\pset pager off
set client_min_messages = notice;
set timezone = 'UTC';

-- migrations/0018: curriculum_items/blocks.priority + estimated_minutes,
-- copied by pick_curriculum_item() alongside task/meta -- same "copied,
-- not referenced" reasoning 0012 established for text/meta.
do $test$
declare
  v_uid uuid := t.mkuser('priority_owner');
  v_plan uuid;
  v_cat uuid;
  v_item_default uuid;   -- no priority/estimate given -- must default sensibly
  v_item_explicit uuid;  -- both given explicitly -- must copy through exactly
  v_block public.blocks;
begin
  insert into public.plans (user_id, app_name, goal_line, is_active)
    values (v_uid, 'test', 'priority test', false) returning id into v_plan;
  insert into public.plan_categories (plan_id, name, label, days, sort_order)
    values (v_plan, 'dsa', 'DSA', '{0,2,4}', 0) returning id into v_cat;

  insert into public.curriculum_items (category_id, week_index, position, task)
    values (v_cat, 0, 0, 'Arrays: two pointers') returning id into v_item_default;
  insert into public.curriculum_items (category_id, week_index, position, task, priority, estimated_minutes)
    values (v_cat, 0, 1, 'Arrays: sliding window', 'high', 30) returning id into v_item_explicit;

  set local role authenticated;
  perform set_config('request.jwt.claim.sub', v_uid::text, true);
  perform public.activate_plan(v_plan);

  -- ===== 1. an unset priority defaults to medium, a real value ===========
  perform t.eq('1 curriculum_items.priority defaults to medium',
    (select priority from public.curriculum_items where id = v_item_default), 'medium');
  perform t.eq('1b curriculum_items.estimated_minutes defaults to NULL, not zero',
    (select estimated_minutes from public.curriculum_items where id = v_item_default), null::int);

  -- ===== 2. an invalid priority is rejected ===============================
  begin
    update public.curriculum_items set priority = 'urgent' where id = v_item_default;
    raise exception 'FAIL 2 an invalid priority was accepted';
  exception when check_violation then
    raise notice 'PASS  2 an invalid priority is rejected (23514)';
  end;

  begin
    update public.curriculum_items set estimated_minutes = 0 where id = v_item_default;
    raise exception 'FAIL 2b a zero estimated_minutes was accepted';
  exception when check_violation then
    raise notice 'PASS  2b a zero (non-positive) estimated_minutes is rejected (23514)';
  end;

  -- ===== 3. pick_curriculum_item() copies both, defaulted or explicit ====
  v_block := public.pick_curriculum_item(v_item_default);
  perform t.eq('3 a picked block copies the default priority', v_block.priority, 'medium');
  perform t.eq('3b a picked block copies a NULL estimate as NULL', v_block.estimated_minutes, null::int);

  v_block := public.pick_curriculum_item(v_item_explicit);
  perform t.eq('3c a picked block copies an explicit priority exactly', v_block.priority, 'high');
  perform t.eq('3d a picked block copies an explicit estimate exactly', v_block.estimated_minutes, 30);

  -- ===== 4. blocks.priority/estimated_minutes are independently client-writable =====
  update public.blocks set priority = 'low', estimated_minutes = 90 where id = v_block.id;
  perform t.eq('4 a user can re-prioritize their own picked block',
    (select priority from public.blocks where id = v_block.id), 'low');
  perform t.eq('4b ...and re-estimate it too',
    (select estimated_minutes from public.blocks where id = v_block.id), 90);
  -- Re-picking the same item (idempotent branch) must not clobber a manual
  -- re-prioritization back to the curriculum item's own stored value.
  v_block := public.pick_curriculum_item(v_item_explicit);
  perform t.eq('4c a repeat pick returns the existing block, priority edit survives',
    v_block.priority, 'low');

  reset role;
  raise notice '--- task priority/estimate: complete ---';
end $test$;
