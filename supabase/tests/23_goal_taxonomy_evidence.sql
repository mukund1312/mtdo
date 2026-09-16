\set ON_ERROR_STOP on
\pset pager off
set client_min_messages = notice;
set timezone = 'UTC';

-- migrations/0034: goal/taxonomy evidence -- plan_target_changed/
-- category_target_changed and their RPCs, the recursive `topics` table and
-- create_topic()'s depth/cycle guard, curriculum_items.topic_id/
-- blocks.topic_id (copied at pick time), and focus_sessions' plan_id/
-- category_id/topic_id attribution snapshots (captured at start_session()
-- time).

-- ===== 1. a client cannot mint either new kind ==============================
do $test$
declare
  v_uid uuid := t.mkuser('goalev_client_reject');
begin
  set local role authenticated;
  perform set_config('request.jwt.claim.sub', v_uid::text, true);

  perform t.raises('1 record_event() rejects client-minted plan_target_changed',
    'select public.record_event(''plan_target_changed'', ''{}''::jsonb)', '22023');
  perform t.raises('1b record_event() rejects client-minted category_target_changed',
    'select public.record_event(''category_target_changed'', ''{}''::jsonb)', '22023');

  reset role;
  raise notice '--- server-minted kinds, client rejection: complete ---';
end $test$;

-- ===== 2. the widened CHECK genuinely accepts both, server-side ============
do $test$
declare
  v_uid uuid := t.mkuser('goalev_server_accept');
  n int;
begin
  perform public.append_event(v_uid, 'plan_target_changed', '{}'::jsonb);
  perform public.append_event(v_uid, 'category_target_changed', '{}'::jsonb);

  select count(*)::int into n from public.activity_events
   where user_id = v_uid and kind in ('plan_target_changed', 'category_target_changed');
  perform t.eq('2 both new kinds are real, storable ledger rows', n, 2);

  raise notice '--- server-minted kinds, server acceptance: complete ---';
end $test$;

-- ===== 3. set_plan_target_date(): behavior ==================================
do $test$
declare
  v_uid uuid := t.mkuser('target_date_behavior');
  v_plan uuid;
  v_row public.plans;
  v_payload jsonb;
  n int;
begin
  insert into public.plans (user_id, app_name, goal_line, is_active)
    values (v_uid, 'test', 'target date behavior', false) returning id into v_plan;

  set local role authenticated;
  perform set_config('request.jwt.claim.sub', v_uid::text, true);

  perform t.eq('3 a fresh plan has no target_date',
    (select target_date from public.plans where id = v_plan), null::date);

  -- First set: no "from" to speak of (null -> a real date).
  v_row := public.set_plan_target_date(v_plan, '2026-12-01');
  perform t.eq('3b target_date is now set', v_row.target_date, date '2026-12-01');

  select payload into v_payload from public.activity_events
   where user_id = v_uid and kind = 'plan_target_changed' order by occurred_at desc, id desc limit 1;
  perform t.eq('3c plan_target_changed carries from (null)', v_payload->'from_date', 'null'::jsonb);
  perform t.eq('3d ...and to_date', (v_payload->>'to_date')::date, date '2026-12-01');

  -- The brief's own worked example: aiming for December, later moved to March.
  v_row := public.set_plan_target_date(v_plan, '2027-03-01');
  select payload into v_payload from public.activity_events
   where user_id = v_uid and kind = 'plan_target_changed' order by occurred_at desc, id desc limit 1;
  perform t.eq('3e moving the target carries the real old date',
    (v_payload->>'from_date')::date, date '2026-12-01');
  perform t.eq('3f ...and the real new date', (v_payload->>'to_date')::date, date '2027-03-01');

  -- An unchanged re-call mints nothing.
  n := (select count(*)::int from public.activity_events where user_id = v_uid);
  v_row := public.set_plan_target_date(v_plan, '2027-03-01');
  perform t.eq('3g an unchanged re-call mints no event',
    (select count(*)::int from public.activity_events where user_id = v_uid), n);

  -- Clearing back to null is a real change and mints an event.
  v_row := public.set_plan_target_date(v_plan, null);
  perform t.eq('3h clearing the target really nulls the column', v_row.target_date, null::date);
  select payload into v_payload from public.activity_events
   where user_id = v_uid and kind = 'plan_target_changed' order by occurred_at desc, id desc limit 1;
  perform t.eq('3i clearing carries the real old date as from_date',
    (v_payload->>'from_date')::date, date '2027-03-01');
  perform t.eq('3j ...and to_date null', v_payload->'to_date', 'null'::jsonb);

  reset role;
  raise notice '--- set_plan_target_date behavior: complete ---';
end $test$;

-- ===== 4. set_plan_target_date(): cross-user isolation ======================
do $test$
declare
  v_alice uuid := t.mkuser('target_alice');
  v_bob uuid := t.mkuser('target_bob');
  v_plan uuid;
begin
  insert into public.plans (user_id, app_name, goal_line, is_active)
    values (v_alice, 'test', 'alice plan', false) returning id into v_plan;

  set local role authenticated;
  perform set_config('request.jwt.claim.sub', v_bob::text, true);
  perform t.raises(
    '4 bob cannot set alice''s plan''s target_date (and the error does not confirm it exists)',
    format('select public.set_plan_target_date(%L, ''2026-12-01'')', v_plan), '42501');
  reset role;

  perform t.eq('4b alice''s plan is genuinely untouched',
    (select target_date from public.plans where id = v_plan), null::date);
  perform t.eq('4c ...and the ledger recorded nothing for it under bob',
    (select count(*)::int from public.activity_events
      where user_id = v_bob and kind = 'plan_target_changed'), 0);

  raise notice '--- set_plan_target_date cross-user isolation: complete ---';
end $test$;

-- ===== 5. set_category_target(): validation and behavior on both fields ====
do $test$
declare
  v_uid uuid := t.mkuser('category_target_behavior');
  v_plan uuid;
  v_cat uuid;
  v_row public.plan_categories;
  v_payload jsonb;
begin
  insert into public.plans (user_id, app_name, goal_line, is_active)
    values (v_uid, 'test', 'category target behavior', false) returning id into v_plan;
  insert into public.plan_categories (plan_id, name, label, days, sort_order, score_weight)
    values (v_plan, 'dsa', 'DSA', '{0,1,2}', 0, 40) returning id into v_cat;

  set local role authenticated;
  perform set_config('request.jwt.claim.sub', v_uid::text, true);

  perform t.raises('5 an invalid p_field is rejected',
    format('select public.set_category_target(%L, ''bogus'', 5)', v_cat), '22023');
  perform t.raises('5b score_weight cannot be set to null',
    format('select public.set_category_target(%L, ''score_weight'', null)', v_cat), '22023');
  perform t.raises('5c score_weight cannot be negative',
    format('select public.set_category_target(%L, ''score_weight'', -1)', v_cat), '22023');
  perform t.raises('5d weekly_target_blocks must be a whole number',
    format('select public.set_category_target(%L, ''weekly_target_blocks'', 2.5)', v_cat), '22023');
  perform t.raises('5e weekly_target_blocks cannot be negative',
    format('select public.set_category_target(%L, ''weekly_target_blocks'', -1)', v_cat), '22023');
  perform t.raises('5f a category that is not yours cannot be targeted (and the error does not confirm it exists)',
    format('select public.set_category_target(gen_random_uuid(), ''score_weight'', 10)'), '42501');

  -- score_weight: real change.
  v_row := public.set_category_target(v_cat, 'score_weight', 55);
  perform t.eq('5g score_weight really moved', v_row.score_weight, 55::numeric);
  select payload into v_payload from public.activity_events
   where user_id = v_uid and kind = 'category_target_changed' order by occurred_at desc, id desc limit 1;
  perform t.eq('5h category_target_changed carries field', v_payload->>'field', 'score_weight');
  perform t.eq('5i ...and the real from', (v_payload->>'from')::numeric, 40::numeric);
  perform t.eq('5j ...and the real to', (v_payload->>'to')::numeric, 55::numeric);

  -- weekly_target_blocks: null -> a real value.
  perform t.eq('5k weekly_target_blocks starts unset', v_row.weekly_target_blocks, null::integer);
  v_row := public.set_category_target(v_cat, 'weekly_target_blocks', 4);
  perform t.eq('5l weekly_target_blocks really moved', v_row.weekly_target_blocks, 4);
  select payload into v_payload from public.activity_events
   where user_id = v_uid and kind = 'category_target_changed' and payload->>'field' = 'weekly_target_blocks'
   order by occurred_at desc, id desc limit 1;
  perform t.eq('5m carries from (null)', v_payload->'from', 'null'::jsonb);
  perform t.eq('5n ...and to', (v_payload->>'to')::numeric, 4::numeric);

  -- Clearing weekly_target_blocks back to null is legal and mints an event.
  v_row := public.set_category_target(v_cat, 'weekly_target_blocks', null);
  perform t.eq('5o weekly_target_blocks is cleared back to null', v_row.weekly_target_blocks, null::integer);

  -- An unchanged re-call mints nothing.
  declare n int;
  begin
    n := (select count(*)::int from public.activity_events where user_id = v_uid);
    perform public.set_category_target(v_cat, 'score_weight', 55);
    perform t.eq('5p an unchanged re-call mints no event',
      (select count(*)::int from public.activity_events where user_id = v_uid), n);
  end;

  reset role;
  raise notice '--- set_category_target behavior: complete ---';
end $test$;

-- ===== 6. set_category_target(): cross-user isolation =======================
do $test$
declare
  v_alice uuid := t.mkuser('cattarget_alice');
  v_bob uuid := t.mkuser('cattarget_bob');
  v_plan uuid;
  v_cat uuid;
begin
  insert into public.plans (user_id, app_name, goal_line, is_active)
    values (v_alice, 'test', 'alice', false) returning id into v_plan;
  insert into public.plan_categories (plan_id, name, label, days, sort_order)
    values (v_plan, 'dsa', 'DSA', '{0,1,2}', 0) returning id into v_cat;

  set local role authenticated;
  perform set_config('request.jwt.claim.sub', v_bob::text, true);
  perform t.raises(
    '6 bob cannot target alice''s category (and the error does not confirm it exists)',
    format('select public.set_category_target(%L, ''score_weight'', 99)', v_cat), '42501');
  reset role;

  perform t.eq('6b alice''s category is genuinely untouched',
    (select score_weight from public.plan_categories where id = v_cat), 1::numeric);
  perform t.eq('6c ...and the ledger recorded nothing under bob',
    (select count(*)::int from public.activity_events
      where user_id = v_bob and kind = 'category_target_changed'), 0);

  raise notice '--- set_category_target cross-user isolation: complete ---';
end $test$;

-- ===== 7. create_topic(): ownership, root creation, and a real parent chain
do $test$
declare
  v_uid uuid := t.mkuser('topic_basic');
  v_plan uuid;
  v_cat uuid;
  v_root public.topics;
  v_child public.topics;
begin
  insert into public.plans (user_id, app_name, goal_line, is_active)
    values (v_uid, 'test', 'topic basic', false) returning id into v_plan;
  insert into public.plan_categories (plan_id, name, label, days, sort_order)
    values (v_plan, 'dsa', 'DSA', '{0,1,2}', 0) returning id into v_cat;

  set local role authenticated;
  perform set_config('request.jwt.claim.sub', v_uid::text, true);

  perform t.raises('7 a category that is not yours is rejected (and the error does not confirm it exists)',
    format('select public.create_topic(gen_random_uuid(), ''Graphs'', ''Graphs'')'), '42501');
  perform t.raises('7b a blank name is rejected',
    format('select public.create_topic(%L, '''', ''Graphs'')', v_cat), '22023');
  perform t.raises('7c a blank label is rejected',
    format('select public.create_topic(%L, ''graphs'', ''  '')', v_cat), '22023');

  v_root := public.create_topic(v_cat, 'graphs', 'Graphs');
  perform t.eq('7d root topic has no parent', v_root.parent_topic_id, null::uuid);
  perform t.eq('7e root topic belongs to this category', v_root.category_id, v_cat);

  v_child := public.create_topic(v_cat, 'bfs', 'BFS', v_root.id);
  perform t.eq('7f child topic''s parent is the root', v_child.parent_topic_id, v_root.id);

  perform t.raises('7g a parent from a different category is rejected',
    format('select public.create_topic(gen_random_uuid(), ''x'', ''X'', %L)', v_root.id), '42501');

  reset role;
  raise notice '--- create_topic basic + parent chain: complete ---';
end $test$;

-- ===== 8. create_topic(): a genuinely deep chain is rejected at the limit ===
do $test$
declare
  v_uid uuid := t.mkuser('topic_depth');
  v_plan uuid;
  v_cat uuid;
  v_cursor uuid;
  v_topic public.topics;
  i int;
begin
  insert into public.plans (user_id, app_name, goal_line, is_active)
    values (v_uid, 'test', 'topic depth', false) returning id into v_plan;
  insert into public.plan_categories (plan_id, name, label, days, sort_order)
    values (v_plan, 'dsa', 'DSA', '{0,1,2}', 0) returning id into v_cat;

  set local role authenticated;
  perform set_config('request.jwt.claim.sub', v_uid::text, true);

  -- Build a chain to exactly the max depth (5): 4 creates succeed (depths
  -- 1-4), building on top of each new leaf.
  v_cursor := null;
  for i in 1..4 loop
    v_topic := public.create_topic(v_cat, 'level' || i, 'Level ' || i, v_cursor);
    perform t.eq(format('8 level %s topic created at the expected parent', i),
      v_topic.parent_topic_id, v_cursor);
    v_cursor := v_topic.id;
  end loop;

  -- A 5th level (depth 5) still fits the max.
  v_topic := public.create_topic(v_cat, 'level5', 'Level 5', v_cursor);
  v_cursor := v_topic.id;

  -- A 6th level (depth 6) exceeds the max of 5 -- rejected.
  perform t.raises('8b a topic past the max depth is rejected',
    format('select public.create_topic(%L, ''level6'', ''Level 6'', %L)', v_cat, v_cursor), '22023');

  reset role;
  raise notice '--- create_topic depth limit: complete ---';
end $test$;

-- ===== 9. the parent_topic_id cycle hole is closed AT ITS SOURCE: an owner
--          cannot UPDATE parent_topic_id/category_id/name at all (column-
--          level grant, revoked table-level UPDATE re-granted only for
--          label/sort_order) -- create_topic() is the ONLY way to set a
--          parent, so a cycle can no longer be hand-built by any client
--          write path. The bounded ancestor walk in create_topic() is kept
--          as defense-in-depth (exercised below via a postgres-level write,
--          the one remaining path that bypasses grants) rather than relied
--          on as the only guard. ================================
do $test$
declare
  v_uid uuid := t.mkuser('topic_cycle');
  v_plan uuid;
  v_cat uuid;
  v_a public.topics;
  v_b public.topics;
begin
  insert into public.plans (user_id, app_name, goal_line, is_active)
    values (v_uid, 'test', 'topic cycle', false) returning id into v_plan;
  insert into public.plan_categories (plan_id, name, label, days, sort_order)
    values (v_plan, 'dsa', 'DSA', '{0,1,2}', 0) returning id into v_cat;

  set local role authenticated;
  perform set_config('request.jwt.claim.sub', v_uid::text, true);

  v_a := public.create_topic(v_cat, 'a', 'A');
  v_b := public.create_topic(v_cat, 'b', 'B', v_a.id);

  -- THE FIX: an owner's direct UPDATE of parent_topic_id now fails on
  -- PRIVILEGES (42501), before RLS is even evaluated -- topics_owner_all's
  -- ownership-chain USING/WITH CHECK would have ALLOWED this (the row
  -- really is theirs), so this specifically proves the column-level grant
  -- is doing the work, not RLS.
  perform t.raises(
    '9 an owner cannot UPDATE parent_topic_id directly -- only create_topic() may ever set it',
    format('update public.topics set parent_topic_id = %L where id = %L', v_b.id, v_a.id),
    '42501');
  perform t.raises(
    '9b ...nor category_id',
    format('update public.topics set category_id = %L where id = %L', v_cat, v_a.id),
    '42501');
  perform t.raises(
    '9c ...nor name',
    format('update public.topics set name = ''renamed'' where id = %L', v_a.id),
    '42501');

  -- The column grant is a deliberate narrow ALLOWLIST, not a blanket
  -- lockout -- label/sort_order (cosmetic, structurally inert) stay
  -- directly client-writable, proving 9/9b/9c are a real, intentional
  -- restriction rather than topics having quietly become fully read-only.
  update public.topics set label = 'A (renamed)', sort_order = 5 where id = v_a.id;
  perform t.eq('9d label stays directly client-writable',
    (select label from public.topics where id = v_a.id), 'A (renamed)');
  perform t.eq('9e ...and sort_order',
    (select sort_order from public.topics where id = v_a.id), 5);

  reset role;

  -- DEFENSE IN DEPTH, not a live client-side hole: even though no client
  -- write path can build a cycle any more, create_topic()'s bounded
  -- ancestor walk must still reject attaching beneath one, in case a FUTURE
  -- non-client path (a migration, a service-role job -- both bypass grants
  -- the way only postgres/service_role can) ever introduced one. Simulated
  -- here as postgres (table owner, exempt from RLS and grants both) rather
  -- than as the authenticated owner, since that client-side path is now
  -- closed by 9/9b/9c above.
  update public.topics set parent_topic_id = v_b.id where id = v_a.id;

  set local role authenticated;
  perform set_config('request.jwt.claim.sub', v_uid::text, true);
  perform t.raises(
    '9f defense in depth: create_topic() still rejects attaching beneath a cycle introduced by a non-client write path, rather than hanging',
    format('select public.create_topic(%L, ''c'', ''C'', %L)', v_cat, v_a.id), '22023');

  reset role;
  raise notice '--- create_topic cycle guard (closed at the source): complete ---';
end $test$;

-- ===== 10. create_topic(): cross-user isolation ==============================
do $test$
declare
  v_alice uuid := t.mkuser('topic_alice');
  v_bob uuid := t.mkuser('topic_bob');
  v_plan uuid;
  v_cat uuid;
begin
  insert into public.plans (user_id, app_name, goal_line, is_active)
    values (v_alice, 'test', 'alice', false) returning id into v_plan;
  insert into public.plan_categories (plan_id, name, label, days, sort_order)
    values (v_plan, 'dsa', 'DSA', '{0,1,2}', 0) returning id into v_cat;

  set local role authenticated;
  perform set_config('request.jwt.claim.sub', v_bob::text, true);
  perform t.raises(
    '10 bob cannot create a topic in alice''s category (and the error does not confirm it exists)',
    format('select public.create_topic(%L, ''x'', ''X'')', v_cat), '42501');
  reset role;

  perform t.eq('10b alice''s category has no topics from bob',
    (select count(*)::int from public.topics where category_id = v_cat), 0);

  raise notice '--- create_topic cross-user isolation: complete ---';
end $test$;

-- ===== 11. curriculum_items.topic_id / blocks.topic_id: copied at pick
--           time, mirroring original_estimated_minutes (0033) ==============
do $test$
declare
  v_uid uuid := t.mkuser('topic_pick_copy');
  v_plan uuid;
  v_cat uuid;
  v_topic public.topics;
  v_item uuid;
  v_item_no_topic uuid;
  v_row public.blocks;
begin
  insert into public.plans (user_id, app_name, goal_line, is_active)
    values (v_uid, 'test', 'topic pick copy', false) returning id into v_plan;
  insert into public.plan_categories (plan_id, name, label, days, sort_order)
    values (v_plan, 'dsa', 'DSA', '{0,1,2}', 0) returning id into v_cat;

  set local role authenticated;
  perform set_config('request.jwt.claim.sub', v_uid::text, true);
  perform public.activate_plan(v_plan);

  v_topic := public.create_topic(v_cat, 'graphs', 'Graphs');

  reset role;
  insert into public.curriculum_items (category_id, week_index, position, task, topic_id)
    values (v_cat, 0, 0, 'BFS traversal', v_topic.id) returning id into v_item;
  insert into public.curriculum_items (category_id, week_index, position, task)
    values (v_cat, 0, 1, 'no-topic task') returning id into v_item_no_topic;

  set local role authenticated;
  perform set_config('request.jwt.claim.sub', v_uid::text, true);

  v_row := public.pick_curriculum_item(v_item);
  perform t.eq('11 topic_id is copied at pick time', v_row.topic_id, v_topic.id);

  v_row := public.pick_curriculum_item(v_item_no_topic);
  perform t.eq('11b a curriculum item with no topic picks a block with null topic_id',
    v_row.topic_id, null::uuid);

  -- Idempotent re-pick does not re-copy (same rule 0033 established for
  -- original_estimated_minutes).
  v_row := public.pick_curriculum_item(v_item);
  perform t.eq('11c a repeat pick does not disturb topic_id', v_row.topic_id, v_topic.id);

  reset role;
  raise notice '--- curriculum_items/blocks topic_id copy: complete ---';
end $test$;

-- ===== 12. topics: a category-spanning FK is rejected (topic and its block
--           must share one category, same rule 0012 enforces for
--           curriculum_item_id) ============================================
do $test$
declare
  v_uid uuid := t.mkuser('topic_category_mismatch');
  v_plan uuid;
  v_cat_a uuid;
  v_cat_b uuid;
  v_topic_a public.topics;
begin
  insert into public.plans (user_id, app_name, goal_line, is_active)
    values (v_uid, 'test', 'category mismatch', false) returning id into v_plan;
  insert into public.plan_categories (plan_id, name, label, days, sort_order)
    values (v_plan, 'dsa', 'DSA', '{0,1,2}', 0) returning id into v_cat_a;
  insert into public.plan_categories (plan_id, name, label, days, sort_order)
    values (v_plan, 'sql', 'SQL', '{0,1,2}', 1) returning id into v_cat_b;

  set local role authenticated;
  perform set_config('request.jwt.claim.sub', v_uid::text, true);
  v_topic_a := public.create_topic(v_cat_a, 'graphs', 'Graphs');
  reset role;

  perform t.raises(
    '12 a block cannot carry a topic_id from a different category than its own category_id',
    format(
      'insert into public.blocks (user_id, plan_id, category_id, topic_id, date, position, text) values (%L, %L, %L, %L, ''2026-09-01'', 0, ''mismatched'')',
      v_uid, v_plan, v_cat_b, v_topic_a.id
    ), '23503');

  raise notice '--- topics category-spanning FK rejection: complete ---';
end $test$;

-- ===== 13. focus_sessions attribution snapshot: captured at start_session()
--           time, survives the category being renamed afterward ===========
do $test$
declare
  v_uid uuid := t.mkuser('session_attribution');
  v_plan uuid;
  v_cat uuid;
  v_topic public.topics;
  v_block uuid;
  v_sess public.focus_sessions;
  v_no_block_sess public.focus_sessions;
begin
  insert into public.plans (user_id, app_name, goal_line, is_active)
    values (v_uid, 'test', 'session attribution', false) returning id into v_plan;
  insert into public.plan_categories (plan_id, name, label, days, sort_order)
    values (v_plan, 'dsa', 'DSA', '{0,1,2}', 0) returning id into v_cat;

  set local role authenticated;
  perform set_config('request.jwt.claim.sub', v_uid::text, true);

  v_topic := public.create_topic(v_cat, 'graphs', 'Graphs');
  insert into public.blocks (user_id, plan_id, category_id, topic_id, date, position, text)
    values (v_uid, v_plan, v_cat, v_topic.id, '2026-09-01', 0, 'attribution block')
    returning id into v_block;

  v_sess := public.start_session(v_block, 1500);
  perform t.eq('13 focus_sessions.plan_id is snapshotted', v_sess.plan_id, v_plan);
  perform t.eq('13b focus_sessions.category_id is snapshotted', v_sess.category_id, v_cat);
  perform t.eq('13c focus_sessions.topic_id is snapshotted', v_sess.topic_id, v_topic.id);
  perform public.abandon_session(v_sess.id);

  -- A session with no linked block gets no attribution at all.
  v_no_block_sess := public.start_session(null, 900);
  perform t.eq('13d a blockless session has no plan_id', v_no_block_sess.plan_id, null::uuid);
  perform t.eq('13e ...or category_id', v_no_block_sess.category_id, null::uuid);
  perform t.eq('13f ...or topic_id', v_no_block_sess.topic_id, null::uuid);
  perform public.abandon_session(v_no_block_sess.id);

  -- THE ATTRIBUTION-SNAPSHOT TEST: rename the category AFTER the session was
  -- captured. The snapshot must not move -- it is not a live join.
  update public.plan_categories set label = 'Renamed Category', name = 'renamed_cat' where id = v_cat;

  perform t.eq('13g the session''s category_id (the id) is unaffected by the rename',
    (select category_id from public.focus_sessions where id = v_sess.id), v_cat);
  perform t.eq('13h the session''s topic_id survives the category rename untouched',
    (select topic_id from public.focus_sessions where id = v_sess.id), v_topic.id);
  -- Prove the rename really happened, so 13g/13h are a meaningful assertion
  -- and not a false pass from the rename silently failing.
  perform t.eq('13i the category really was renamed',
    (select label from public.plan_categories where id = v_cat), 'Renamed Category');

  reset role;
  raise notice '--- focus_sessions attribution snapshot: complete ---';
end $test$;

-- ===== 14. focus_sessions.topic_id is SET NULL if the topic is later
--           deleted, but category_id is untouched by that (column-list
--           requirement on the composite FK) ================================
do $test$
declare
  v_uid uuid := t.mkuser('session_topic_deleted');
  v_plan uuid;
  v_cat uuid;
  v_topic public.topics;
  v_block uuid;
  v_sess public.focus_sessions;
begin
  insert into public.plans (user_id, app_name, goal_line, is_active)
    values (v_uid, 'test', 'topic deleted', false) returning id into v_plan;
  insert into public.plan_categories (plan_id, name, label, days, sort_order)
    values (v_plan, 'dsa', 'DSA', '{0,1,2}', 0) returning id into v_cat;

  set local role authenticated;
  perform set_config('request.jwt.claim.sub', v_uid::text, true);

  v_topic := public.create_topic(v_cat, 'graphs', 'Graphs');
  insert into public.blocks (user_id, plan_id, category_id, topic_id, date, position, text)
    values (v_uid, v_plan, v_cat, v_topic.id, '2026-09-01', 0, 'topic deletion block')
    returning id into v_block;

  v_sess := public.start_session(v_block, 1200);
  perform public.abandon_session(v_sess.id);

  delete from public.topics where id = v_topic.id;

  perform t.eq('14 the session''s topic_id is nulled when the topic is deleted',
    (select topic_id from public.focus_sessions where id = v_sess.id), null::uuid);
  perform t.eq('14b ...but category_id survives the topic''s deletion untouched',
    (select category_id from public.focus_sessions where id = v_sess.id), v_cat);

  reset role;
  raise notice '--- focus_sessions topic deletion SET NULL: complete ---';
end $test$;
