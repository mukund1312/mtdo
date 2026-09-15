\set ON_ERROR_STOP on
\pset pager off
set client_min_messages = notice;
set timezone = 'UTC';

-- migrations/0033: task/opportunity evidence -- the nine new server-minted
-- ledger kinds, transition_block_status(), schedule_block()'s scheduling
-- evidence, pick_curriculum_item()'s original_estimated_minutes, and
-- start_session()'s block-started_at stamp.
--
-- TIMING: schedule_block()'s reschedule-vs-edit classification compares the
-- OLD scheduled_start_at against now() (real transaction-start time, per
-- 15_session_pause_breaks_outcomes.sql's own note -- constant for the whole
-- of one `do $test$` block). Rather than relative offsets from the real
-- clock (which risk crossing a day boundary depending on when the suite
-- happens to run), the "not yet started" fixtures below anchor to a fixed
-- date far in the future (2030) and the "already started/passed" fixtures
-- to one far in the past (2020) -- both unambiguous relative to any
-- realistic real-world test run, so these assertions are exact, not
-- approximate.

-- ===== 1. a client cannot mint any of the nine new kinds ===================
do $test$
declare
  v_uid uuid := t.mkuser('evidence_client_reject');
  v_kind text;
  v_kinds text[] := array[
    'task_scheduled', 'task_rescheduled', 'task_unscheduled', 'task_started',
    'task_status_changed', 'task_estimate_changed', 'task_priority_changed',
    'task_disposition_set', 'task_deleted'
  ];
begin
  set local role authenticated;
  perform set_config('request.jwt.claim.sub', v_uid::text, true);

  foreach v_kind in array v_kinds loop
    perform t.raises(
      format('1 record_event() rejects client-minted %s', v_kind),
      format('select public.record_event(%L, ''{}''::jsonb)', v_kind),
      '22023');
  end loop;

  reset role;
  raise notice '--- server-minted kinds, client rejection: complete ---';
end $test$;

-- ===== 2. the widened CHECK genuinely accepts all nine, server-side ========
do $test$
declare
  v_uid uuid := t.mkuser('evidence_server_accept');
  v_kind text;
  v_kinds text[] := array[
    'task_scheduled', 'task_rescheduled', 'task_unscheduled', 'task_started',
    'task_status_changed', 'task_estimate_changed', 'task_priority_changed',
    'task_disposition_set', 'task_deleted'
  ];
  n int;
begin
  foreach v_kind in array v_kinds loop
    perform public.append_event(v_uid, v_kind, '{}'::jsonb);
  end loop;

  select count(*)::int into n from public.activity_events
   where user_id = v_uid and kind = any(v_kinds);
  perform t.eq('2 all nine new kinds are real, storable ledger rows', n, 9);

  raise notice '--- server-minted kinds, server acceptance: complete ---';
end $test$;

-- ===== 3. transition_block_status(): argument validation ===================
do $test$
declare
  v_uid uuid := t.mkuser('tbs_validation');
  v_plan uuid;
  v_cat uuid;
  v_block uuid;
begin
  insert into public.plans (user_id, app_name, goal_line, is_active)
    values (v_uid, 'test', 'transition validation', false) returning id into v_plan;
  insert into public.plan_categories (plan_id, name, label, days, sort_order)
    values (v_plan, 'dsa', 'DSA', '{0,1,2}', 0) returning id into v_cat;

  set local role authenticated;
  perform set_config('request.jwt.claim.sub', v_uid::text, true);

  insert into public.blocks (user_id, plan_id, category_id, date, position, text)
    values (v_uid, v_plan, v_cat, '2026-09-01', 0, 'two pointers') returning id into v_block;

  perform t.raises('3 an invalid p_to_status is rejected',
    format('select public.transition_block_status(%L, ''bogus'')', v_block), '22023');
  perform t.raises('3b an invalid p_source is rejected',
    format('select public.transition_block_status(%L, ''todo'', ''bogus'')', v_block), '22023');
  perform t.raises('3c an invalid p_disposition is rejected',
    format('select public.transition_block_status(%L, ''todo'', ''manual'', ''bogus'')', v_block), '22023');
  perform t.raises(
    '3d ''rescheduled'' is specifically rejected as a disposition -- current state, not history (this migration''s header)',
    format('select public.transition_block_status(%L, ''todo'', ''manual'', ''rescheduled'')', v_block), '22023');
  perform t.raises('3e a block that is not yours cannot be transitioned (and the error does not confirm it exists)',
    format('select public.transition_block_status(gen_random_uuid(), ''todo'')'), '42501');

  reset role;
  raise notice '--- transition_block_status validation: complete ---';
end $test$;

-- ===== 4. transition_block_status(): behavior -- started_at once, the two
--          guarded event kinds, cancellation stamped once =================
do $test$
declare
  v_uid uuid := t.mkuser('tbs_behavior');
  v_plan uuid;
  v_cat uuid;
  v_block uuid;
  v_row public.blocks;
  v_started_first timestamptz;
  v_cancelled_first timestamptz;
  v_payload jsonb;
  n int;
begin
  insert into public.plans (user_id, app_name, goal_line, is_active)
    values (v_uid, 'test', 'transition behavior', false) returning id into v_plan;
  insert into public.plan_categories (plan_id, name, label, days, sort_order)
    values (v_plan, 'dsa', 'DSA', '{0,1,2}', 0) returning id into v_cat;

  set local role authenticated;
  perform set_config('request.jwt.claim.sub', v_uid::text, true);

  insert into public.blocks (user_id, plan_id, category_id, date, position, text)
    values (v_uid, v_plan, v_cat, '2026-09-01', 0, 'two pointers') returning id into v_block;

  perform t.eq('4 a fresh block has no started_at -- the dead column, now honest',
    (select started_at from public.blocks where id = v_block), null::timestamptz);
  perform t.eq('4b ...or a disposition',
    (select disposition from public.blocks where id = v_block), null::text);

  -- todo -> in_progress: the FIRST transition into in_progress.
  v_row := public.transition_block_status(v_block, 'in_progress', 'kanban_transition');
  perform t.eq('4c status moved to in_progress', v_row.status, 'in_progress');
  perform t.eq('4c2 claimed mirrors status = in_progress, same as settle_block_outcome() owns it', v_row.claimed, true);
  perform t.eq('4d started_at is now set', v_row.started_at is not null, true);
  v_started_first := v_row.started_at;

  select payload into v_payload from public.activity_events
   where user_id = v_uid and kind = 'task_started' and payload->>'block_id' = v_block::text
   order by occurred_at desc, id desc limit 1;
  perform t.eq('4e task_started minted with the right source', v_payload->>'source', 'kanban_transition');

  select payload into v_payload from public.activity_events
   where user_id = v_uid and kind = 'task_status_changed' and payload->>'block_id' = v_block::text
   order by occurred_at desc, id desc limit 1;
  perform t.eq('4f task_status_changed carries from', v_payload->>'from', 'todo');
  perform t.eq('4g ...and to', v_payload->>'to', 'in_progress');
  perform t.eq('4h ...and source', v_payload->>'source', 'kanban_transition');
  perform t.eq('4i no disposition change (still null -> null) means no task_disposition_set event',
    (select count(*)::int from public.activity_events
      where user_id = v_uid and kind = 'task_disposition_set' and payload->>'block_id' = v_block::text),
    0);

  -- in_progress -> done, with disposition 'completed'.
  v_row := public.transition_block_status(v_block, 'done', 'kanban_transition', 'completed');
  perform t.eq('4j disposition is now completed', v_row.disposition, 'completed');
  perform t.eq('4j2 claimed goes back to false -- no live timer on a done task', v_row.claimed, false);

  select payload into v_payload from public.activity_events
   where user_id = v_uid and kind = 'task_disposition_set' and payload->>'block_id' = v_block::text
   order by occurred_at desc, id desc limit 1;
  perform t.eq('4k task_disposition_set carries from (null)', v_payload->'from', 'null'::jsonb);
  perform t.eq('4l ...and to', v_payload->>'to', 'completed');

  -- Bounce: done -> in_progress again (a regression). started_at must NOT
  -- move and task_started must NOT mint a second time.
  v_row := public.transition_block_status(v_block, 'in_progress', 'kanban_transition');
  perform t.eq('4m a second transition into in_progress does not move started_at',
    v_row.started_at, v_started_first);
  perform t.eq('4n disposition is not sticky -- reverts to whatever this call passed (null, the default)',
    v_row.disposition, null::text);

  n := (select count(*)::int from public.activity_events
    where user_id = v_uid and kind = 'task_started' and payload->>'block_id' = v_block::text);
  perform t.eq('4o task_started is minted exactly once, ever, for this block', n, 1);

  -- An unchanged re-call (same status, same disposition -- both currently
  -- null/in_progress) mints nothing at all.
  n := (select count(*)::int from public.activity_events where user_id = v_uid);
  perform public.transition_block_status(v_block, 'in_progress', 'kanban_transition');
  perform t.eq('4p an unchanged re-call mints no event',
    (select count(*)::int from public.activity_events where user_id = v_uid), n);

  -- cancelled_at is stamped once and never moves on a repeat cancellation.
  v_row := public.transition_block_status(v_block, 'todo', 'manual', 'cancelled');
  perform t.eq('4q cancelled_at is stamped on first cancellation', v_row.cancelled_at is not null, true);
  v_cancelled_first := v_row.cancelled_at;

  v_row := public.transition_block_status(v_block, 'todo', 'manual', 'cancelled');
  perform t.eq('4r a second cancellation does not move cancelled_at', v_row.cancelled_at, v_cancelled_first);

  reset role;
  raise notice '--- transition_block_status behavior: complete ---';
end $test$;

-- ===== 5. transition_block_status(): cross-user isolation ==================
do $test$
declare
  v_alice uuid := t.mkuser('tbs_alice');
  v_bob uuid := t.mkuser('tbs_bob');
  v_plan uuid;
  v_cat uuid;
  v_alice_block uuid;
begin
  insert into public.plans (user_id, app_name, goal_line, is_active)
    values (v_alice, 'test', 'alice', false) returning id into v_plan;
  insert into public.plan_categories (plan_id, name, label, days, sort_order)
    values (v_plan, 'dsa', 'DSA', '{0,1,2}', 0) returning id into v_cat;

  set local role authenticated;
  perform set_config('request.jwt.claim.sub', v_alice::text, true);
  insert into public.blocks (user_id, plan_id, category_id, date, position, text)
    values (v_alice, v_plan, v_cat, '2026-09-01', 0, 'alice block') returning id into v_alice_block;
  reset role;

  set local role authenticated;
  perform set_config('request.jwt.claim.sub', v_bob::text, true);
  perform t.raises(
    '5 bob cannot transition alice''s block (and the error does not confirm it exists)',
    format('select public.transition_block_status(%L, ''in_progress'')', v_alice_block), '42501');
  reset role;

  perform t.eq('5b alice''s block is genuinely untouched',
    (select status from public.blocks where id = v_alice_block), 'todo');
  perform t.eq('5c ...and the ledger recorded nothing for it',
    (select count(*)::int from public.activity_events
      where payload->>'block_id' = v_alice_block::text and user_id = v_bob),
    0);

  raise notice '--- transition_block_status cross-user isolation: complete ---';
end $test$;

-- ===== 6. schedule_block(): scheduling evidence =============================
do $test$
declare
  v_uid uuid := t.mkuser('sched_evidence');
  v_plan uuid;
  v_cat uuid;
  v_block uuid;
  v_row public.blocks;
  v_payload jsonb;
begin
  insert into public.plans (user_id, app_name, goal_line, is_active)
    values (v_uid, 'test', 'schedule evidence', false) returning id into v_plan;
  insert into public.plan_categories (plan_id, name, label, days, sort_order)
    values (v_plan, 'dsa', 'DSA', '{0,1,2}', 0) returning id into v_cat;

  set local role authenticated;
  perform set_config('request.jwt.claim.sub', v_uid::text, true);

  insert into public.blocks (user_id, plan_id, category_id, date, position, text)
    values (v_uid, v_plan, v_cat, '2026-09-01', 0, 'evidence block') returning id into v_block;

  -- ----- unscheduled -> unscheduled: no event at all ---------------------
  perform public.schedule_block(v_block);
  perform t.eq('6 clearing an already-unscheduled block mints nothing',
    (select count(*)::int from public.activity_events
      where user_id = v_uid and kind in ('task_scheduled', 'task_rescheduled', 'task_unscheduled')),
    0);

  -- ----- first-ever schedule: task_scheduled ------------------------------
  v_row := public.schedule_block(v_block, null, '2030-01-01 09:00+00', '2030-01-01 10:00+00');
  select payload into v_payload from public.activity_events
   where user_id = v_uid and kind = 'task_scheduled' and payload->>'block_id' = v_block::text
   order by occurred_at desc, id desc limit 1;
  perform t.eq('6b first schedule mints task_scheduled with the new start',
    (v_payload->>'start_at')::timestamptz, '2030-01-01 09:00+00'::timestamptz);
  perform t.eq('6c ...and the new local date',
    (v_payload->>'date')::date, date '2030-01-01');

  -- ----- exact re-save (identical window): no event -----------------------
  perform public.schedule_block(v_block, null, '2030-01-01 09:00+00', '2030-01-01 10:00+00');
  perform t.eq('6d an exact re-save (unchanged window) mints nothing new',
    (select count(*)::int from public.activity_events
      where user_id = v_uid and kind in ('task_scheduled', 'task_rescheduled')),
    1);

  -- ----- WORKED EXAMPLE 1: before start, same day = harmless edit --------
  -- Anchored far in the future (2030) so "not yet started" (now() real <<
  -- 2030) is unambiguous regardless of when this suite actually runs.
  v_row := public.schedule_block(v_block, null, '2030-06-01 09:00+00', '2030-06-01 10:00+00');
  v_row := public.schedule_block(v_block, null, '2030-06-01 11:00+00', '2030-06-01 12:00+00');
  select payload into v_payload from public.activity_events
   where user_id = v_uid and kind = 'task_rescheduled' and payload->>'block_id' = v_block::text
   order by occurred_at desc, id desc limit 1;
  perform t.eq('6e before start, same local day -> is_reschedule is false (a harmless edit)',
    (v_payload->>'is_reschedule')::boolean, false);

  -- ----- WORKED EXAMPLE 2: already started, moves later = reschedule -----
  -- Anchored far in the past (2020) so "already started/passed" (now() real
  -- >> 2020) is unambiguous.
  v_row := public.schedule_block(v_block, null, '2020-01-01 09:00+00', '2020-01-01 10:00+00');
  v_row := public.schedule_block(v_block, null, '2020-01-01 14:00+00', '2020-01-01 15:00+00');
  select payload into v_payload from public.activity_events
   where user_id = v_uid and kind = 'task_rescheduled' and payload->>'block_id' = v_block::text
   order by occurred_at desc, id desc limit 1;
  perform t.eq('6f already started, same day, moves LATER -> is_reschedule is true',
    (v_payload->>'is_reschedule')::boolean, true);

  -- ----- WORKED EXAMPLE 3: date changes = reschedule, regardless ---------
  v_row := public.schedule_block(v_block, null, '2020-03-01 22:00+00', '2020-03-01 23:00+00');
  v_row := public.schedule_block(v_block, null, '2020-03-02 06:00+00', '2020-03-02 07:00+00');
  select payload into v_payload from public.activity_events
   where user_id = v_uid and kind = 'task_rescheduled' and payload->>'block_id' = v_block::text
   order by occurred_at desc, id desc limit 1;
  perform t.eq('6g the destination local date changes -> is_reschedule is true',
    (v_payload->>'is_reschedule')::boolean, true);
  perform t.eq('6h ...and from_date is the real old local date',
    (v_payload->>'from_date')::date, date '2020-03-01');
  perform t.eq('6i ...and to_date is the real new local date',
    (v_payload->>'to_date')::date, date '2020-03-02');

  -- ----- the documented default (point 4): already started, moves EARLIER,
  --       same day -> harmless edit, not a reschedule ---------------------
  v_row := public.schedule_block(v_block, null, '2020-05-01 14:00+00', '2020-05-01 15:00+00');
  v_row := public.schedule_block(v_block, null, '2020-05-01 09:00+00', '2020-05-01 10:00+00');
  select payload into v_payload from public.activity_events
   where user_id = v_uid and kind = 'task_rescheduled' and payload->>'block_id' = v_block::text
   order by occurred_at desc, id desc limit 1;
  perform t.eq('6j already started, same day, moves EARLIER -> the documented default is "edit", not "reschedule"',
    (v_payload->>'is_reschedule')::boolean, false);

  -- ----- unschedule: task_unscheduled carries the OLD values --------------
  v_row := public.schedule_block(v_block);
  select payload into v_payload from public.activity_events
   where user_id = v_uid and kind = 'task_unscheduled' and payload->>'block_id' = v_block::text
   order by occurred_at desc, id desc limit 1;
  perform t.eq('6k unschedule carries the old start', (v_payload->>'from_start_at')::timestamptz,
    '2020-05-01 09:00+00'::timestamptz);
  perform t.eq('6l the block''s window is genuinely cleared', v_row.scheduled_start_at, null::timestamptz);

  raise notice '--- schedule_block scheduling evidence: complete ---';
end $test$;

-- ===== 7. pick_curriculum_item(): original_estimated_minutes ===============
do $test$
declare
  v_uid uuid := t.mkuser('pick_original_estimate');
  v_plan uuid;
  v_cat uuid;
  v_item uuid;
  v_row public.blocks;
begin
  insert into public.plans (user_id, app_name, goal_line, is_active)
    values (v_uid, 'test', 'original estimate', false) returning id into v_plan;
  insert into public.plan_categories (plan_id, name, label, days, sort_order)
    values (v_plan, 'dsa', 'DSA', '{0,1,2}', 0) returning id into v_cat;
  insert into public.curriculum_items (category_id, week_index, position, task, estimated_minutes)
    values (v_cat, 0, 0, 'Arrays: two pointers', 45) returning id into v_item;

  set local role authenticated;
  perform set_config('request.jwt.claim.sub', v_uid::text, true);
  perform public.activate_plan(v_plan);

  v_row := public.pick_curriculum_item(v_item);
  perform t.eq('7 original_estimated_minutes is copied at pick time', v_row.original_estimated_minutes, 45);
  perform t.eq('7b ...matching estimated_minutes at pick time', v_row.estimated_minutes, 45);
  perform t.eq('7c the block has a real created_at', v_row.created_at is not null, true);

  -- The client freely edits estimated_minutes going forward (blocks stays
  -- client-writable, same posture as every other non-lifecycle field) --
  -- original_estimated_minutes must NOT follow it.
  reset role;
  update public.blocks set estimated_minutes = 90 where id = v_row.id;
  set local role authenticated;
  perform set_config('request.jwt.claim.sub', v_uid::text, true);

  perform t.eq('7d original_estimated_minutes is untouched by a later estimate edit',
    (select original_estimated_minutes from public.blocks where id = v_row.id), 45);
  perform t.eq('7e ...even though estimated_minutes itself really did change',
    (select estimated_minutes from public.blocks where id = v_row.id), 90);

  -- A repeat pick is idempotent and does not re-copy anything, including the
  -- new column -- same rule 0018/0019 already established for every other
  -- copied field.
  v_row := public.pick_curriculum_item(v_item);
  perform t.eq('7f a repeat pick does not re-copy original_estimated_minutes',
    v_row.original_estimated_minutes, 45);

  reset role;
  raise notice '--- pick_curriculum_item original_estimated_minutes: complete ---';
end $test$;

-- ===== 8. start_session(): block started_at, once, shared with
--          transition_block_status()'s guard on the same column ============
do $test$
declare
  v_uid uuid := t.mkuser('start_session_evidence');
  v_plan uuid;
  v_cat uuid;
  v_block_a uuid; -- never touched before start_session
  v_block_b uuid; -- already started via transition_block_status
  v_sess public.focus_sessions;
  v_row public.blocks;
  v_started_via_transition timestamptz;
  v_payload jsonb;
  n int;
begin
  insert into public.plans (user_id, app_name, goal_line, is_active)
    values (v_uid, 'test', 'start_session evidence', false) returning id into v_plan;
  insert into public.plan_categories (plan_id, name, label, days, sort_order)
    values (v_plan, 'dsa', 'DSA', '{0,1,2}', 0) returning id into v_cat;

  set local role authenticated;
  perform set_config('request.jwt.claim.sub', v_uid::text, true);

  insert into public.blocks (user_id, plan_id, category_id, date, position, text)
    values (v_uid, v_plan, v_cat, '2026-09-01', 0, 'block a') returning id into v_block_a;
  insert into public.blocks (user_id, plan_id, category_id, date, position, text)
    values (v_uid, v_plan, v_cat, '2026-09-01', 1, 'block b') returning id into v_block_b;

  -- start_session() on a never-touched block: sets started_at, mints
  -- task_started with source focus_session.
  v_sess := public.start_session(v_block_a, 1500);
  perform t.eq('8 start_session() sets the linked block''s started_at',
    (select started_at from public.blocks where id = v_block_a) is not null, true);

  select payload into v_payload from public.activity_events
   where user_id = v_uid and kind = 'task_started' and payload->>'block_id' = v_block_a::text
   order by occurred_at desc, id desc limit 1;
  perform t.eq('8b ...with source focus_session', v_payload->>'source', 'focus_session');

  n := (select count(*)::int from public.activity_events
    where user_id = v_uid and kind = 'task_started' and payload->>'block_id' = v_block_a::text);
  perform t.eq('8c task_started minted exactly once for block a', n, 1);

  -- Free up the one-running-session slot before starting a second one.
  perform public.abandon_session(v_sess.id);

  -- block_b already has started_at via transition_block_status() (a Kanban
  -- move) BEFORE any session ever touches it -- start_session() must not
  -- overwrite that, and must not mint a second task_started.
  v_row := public.transition_block_status(v_block_b, 'in_progress', 'kanban_transition');
  v_started_via_transition := v_row.started_at;

  v_sess := public.start_session(v_block_b, 900);
  perform public.abandon_session(v_sess.id);
  perform t.eq('8d start_session() never overwrites a started_at set by transition_block_status()',
    (select started_at from public.blocks where id = v_block_b), v_started_via_transition);

  n := (select count(*)::int from public.activity_events
    where user_id = v_uid and kind = 'task_started' and payload->>'block_id' = v_block_b::text);
  perform t.eq('8e ...and task_started still minted only once, by the transition that got there first', n, 1);

  reset role;
  raise notice '--- start_session block-evidence: complete ---';
end $test$;

-- ===== 9. end to end: a block rescheduled twice, then completed, leaves
--          THREE opportunities in the ledger while blocks.disposition
--          reads a single, current 'completed' ============================
do $test$
declare
  v_uid uuid := t.mkuser('lifecycle_three_opportunities');
  v_plan uuid;
  v_cat uuid;
  v_block uuid;
  v_row public.blocks;
  n_opportunities int;
begin
  insert into public.plans (user_id, app_name, goal_line, is_active)
    values (v_uid, 'test', 'three opportunities', false) returning id into v_plan;
  insert into public.plan_categories (plan_id, name, label, days, sort_order)
    values (v_plan, 'dsa', 'DSA', '{0,1,2}', 0) returning id into v_cat;

  set local role authenticated;
  perform set_config('request.jwt.claim.sub', v_uid::text, true);

  insert into public.blocks (user_id, plan_id, category_id, date, position, text)
    values (v_uid, v_plan, v_cat, '2026-09-01', 0, 'three opportunities') returning id into v_block;

  -- Opportunity 1: scheduled Monday.
  perform public.schedule_block(v_block, null, '2030-11-04 09:00+00', '2030-11-04 10:00+00');
  -- Opportunity 2: rescheduled to Tuesday (a genuine date change -> reschedule).
  perform public.schedule_block(v_block, null, '2030-11-05 09:00+00', '2030-11-05 10:00+00');
  -- Opportunity 3: rescheduled to Wednesday.
  perform public.schedule_block(v_block, null, '2030-11-06 09:00+00', '2030-11-06 10:00+00');
  -- Wednesday's opportunity is the one actually worked and completed.
  v_row := public.transition_block_status(v_block, 'in_progress', 'kanban_transition');
  v_row := public.transition_block_status(v_block, 'done', 'kanban_transition', 'completed');

  select count(*)::int into n_opportunities
  from public.activity_events
  where user_id = v_uid
    and payload->>'block_id' = v_block::text
    and (
      kind = 'task_scheduled'
      or (kind = 'task_rescheduled' and (payload->>'is_reschedule')::boolean)
    );
  perform t.eq('9 three distinct opportunities are derivable from the ledger alone', n_opportunities, 3);

  perform t.eq('9b ...while blocks.disposition holds only the single CURRENT terminal state',
    (select disposition from public.blocks where id = v_block), 'completed');
  perform t.eq('9c ...and blocks.status agrees', (select status from public.blocks where id = v_block), 'done');

  reset role;
  raise notice '--- end-to-end: three opportunities, one current disposition: complete ---';
end $test$;

-- ===== 10. the disposition CHECK itself rejects a bare, non-RPC write of
--           an invalid value -- including 'rescheduled', belt and braces
--           behind transition_block_status()'s own 22023 validation =======
do $test$
declare
  v_uid uuid := t.mkuser('disposition_check_raw');
  v_plan uuid;
  v_cat uuid;
  v_block uuid;
begin
  insert into public.plans (user_id, app_name, goal_line, is_active)
    values (v_uid, 'test', 'raw disposition check', false) returning id into v_plan;
  insert into public.plan_categories (plan_id, name, label, days, sort_order)
    values (v_plan, 'dsa', 'DSA', '{0,1,2}', 0) returning id into v_cat;

  set local role authenticated;
  perform set_config('request.jwt.claim.sub', v_uid::text, true);
  insert into public.blocks (user_id, plan_id, category_id, date, position, text)
    values (v_uid, v_plan, v_cat, '2026-09-01', 0, 'raw check') returning id into v_block;

  perform t.raises('10 the CHECK constraint itself rejects an arbitrary disposition value',
    format('update public.blocks set disposition = ''bogus'' where id = %L', v_block), '23514');
  perform t.raises('10b ...and specifically rejects ''rescheduled'' -- it is not a current-state value',
    format('update public.blocks set disposition = ''rescheduled'' where id = %L', v_block), '23514');

  reset role;
  raise notice '--- raw disposition CHECK: complete ---';
end $test$;

-- ===== 11. created_at is NULLABLE, not backfilled -- a pre-0033 block reads
--           NULL honestly; only a genuinely new block gets the real default.
--           (The whole test suite runs its fixtures AFTER 0033 has already
--           applied, so "pre-existing" is simulated by explicitly setting
--           created_at = NULL on insert -- exactly the shape a real
--           pre-migration row has, and exactly what `add column created_at
--           timestamptz` with NO default, followed by a SEPARATE `alter
--           column ... set default now()`, is supposed to produce: the
--           default only ever applies when an INSERT omits the column.) ====
do $test$
declare
  v_uid uuid := t.mkuser('created_at_nullable');
  v_plan uuid;
  v_cat uuid;
  v_legacy_block uuid;
  v_new_block uuid;
begin
  insert into public.plans (user_id, app_name, goal_line, is_active)
    values (v_uid, 'test', 'created_at nullability', false) returning id into v_plan;
  insert into public.plan_categories (plan_id, name, label, days, sort_order)
    values (v_plan, 'dsa', 'DSA', '{0,1,2}', 0) returning id into v_cat;

  set local role authenticated;
  perform set_config('request.jwt.claim.sub', v_uid::text, true);

  -- Stands in for a real pre-0033 row: created_at explicitly NULL, exactly
  -- what that column honestly holds for a block whose true creation time
  -- was never captured -- never a guessed migration-run timestamp.
  insert into public.blocks (user_id, plan_id, category_id, date, position, text, created_at)
    values (v_uid, v_plan, v_cat, '2026-09-01', 0, 'legacy block', null) returning id into v_legacy_block;
  perform t.eq('11 a pre-existing block honestly reads created_at is null, never a guessed value',
    (select created_at from public.blocks where id = v_legacy_block), null::timestamptz);

  -- A genuinely new block (created_at omitted from the INSERT) picks up the
  -- real DEFAULT now() -- proving the ALTER COLUMN ... SET DEFAULT applies
  -- to future inserts without having touched the legacy row above at all.
  insert into public.blocks (user_id, plan_id, category_id, date, position, text)
    values (v_uid, v_plan, v_cat, '2026-09-01', 1, 'new block') returning id into v_new_block;
  perform t.eq('11b a genuinely new block gets a real, non-null created_at',
    (select created_at from public.blocks where id = v_new_block) is not null, true);

  reset role;
  raise notice '--- created_at nullability: complete ---';
end $test$;
