\set ON_ERROR_STOP on
\pset pager off
set client_min_messages = notice;

-- migrations/0011: blocks.status gains a fourth persisted value, 'backlog',
-- for J's Today board Backlog lane. Scope is exactly the CHECK constraint --
-- this file confirms that and nothing else moved (RLS ownership, other
-- status values, invalid values still rejected).
do $test$
declare
  v_owner uuid := t.mkuser('backlog_owner');
  v_other uuid := t.mkuser('backlog_other');
  v_plan_id uuid;
  v_category_id uuid;
  v_block_id uuid;
  v_default_block_id uuid;
begin
  -- Fixture setup as postgres (bypasses RLS -- what's under test is the
  -- CHECK constraint and RLS on blocks, not the insert path for plans).
  -- is_active: false -- plans_guard_activation (0006-0008) rejects a direct
  -- insert with is_active: true outside activate_plan(). This fixture only
  -- needs a valid FK target for blocks/plan_categories; activation status
  -- is irrelevant to what this file tests.
  insert into public.plans (user_id, app_name, goal_line, is_active)
    values (v_owner, 'test', 'backlog status test', false)
    returning id into v_plan_id;
  insert into public.plan_categories (plan_id, name, label)
    values (v_plan_id, 'core', 'Core')
    returning id into v_category_id;

  -- ===== 1. inserting a user-owned block as 'backlog' succeeds ===========
  set local role authenticated;
  perform set_config('request.jwt.claim.sub', v_owner::text, true);

  insert into public.blocks (user_id, plan_id, category_id, date, position, text, status)
    values (v_owner, v_plan_id, v_category_id, current_date, 1, 'triage this', 'backlog')
    returning id into v_block_id;
  perform t.eq('1 insert with status=backlog succeeds', (select status from public.blocks where id = v_block_id), 'backlog');

  -- ===== 1b. updating an existing block to 'backlog' succeeds ============
  update public.blocks set status = 'todo' where id = v_block_id;
  update public.blocks set status = 'backlog' where id = v_block_id;
  perform t.eq('1b update to status=backlog succeeds', (select status from public.blocks where id = v_block_id), 'backlog');

  -- ===== 2. an invalid status is rejected =================================
  begin
    update public.blocks set status = 'someday_maybe' where id = v_block_id;
    raise exception 'FAIL 2 invalid status was accepted';
  exception when check_violation then
    raise notice 'PASS  2 invalid status rejected (23514)';
  end;

  begin
    insert into public.blocks (user_id, plan_id, category_id, date, position, text, status)
      values (v_owner, v_plan_id, v_category_id, current_date, 2, 'bad status insert', 'archived');
    raise exception 'FAIL 2b invalid status was accepted on insert';
  exception when check_violation then
    raise notice 'PASS  2b invalid status rejected on insert (23514)';
  end;

  -- ===== 3. the three pre-existing statuses still work ====================
  update public.blocks set status = 'todo' where id = v_block_id;
  perform t.eq('3 status=todo still accepted', (select status from public.blocks where id = v_block_id), 'todo');
  update public.blocks set status = 'in_progress' where id = v_block_id;
  perform t.eq('3 status=in_progress still accepted', (select status from public.blocks where id = v_block_id), 'in_progress');
  update public.blocks set status = 'done' where id = v_block_id;
  perform t.eq('3 status=done still accepted', (select status from public.blocks where id = v_block_id), 'done');

  -- default still 'todo' when omitted entirely
  insert into public.blocks (user_id, plan_id, category_id, date, position, text)
    values (v_owner, v_plan_id, v_category_id, current_date, 3, 'default status check')
    returning id into v_default_block_id;
  perform t.eq('3b omitted status still defaults to todo', (select status from public.blocks where id = v_default_block_id), 'todo');

  reset role;

  -- ===== 4. RLS ownership is unchanged by this migration =================
  set local role authenticated;
  perform set_config('request.jwt.claim.sub', v_other::text, true);

  perform t.eq('4 a different user cannot see the backlog-capable block', (select count(*) from public.blocks where id = v_block_id), 0::bigint);

  -- RLS silently affects zero rows rather than raising; the real assertion
  -- is that the row is unchanged, checked below as postgres.
  update public.blocks set status = 'backlog' where id = v_block_id;

  reset role;

  perform t.eq('4b the other user update affected nothing (still done)', (select status from public.blocks where id = v_block_id), 'done');

  -- cleanup
  delete from public.blocks where plan_id = v_plan_id;
  delete from public.plan_categories where id = v_category_id;
  delete from public.plans where id = v_plan_id;
end $test$;
