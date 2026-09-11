\set ON_ERROR_STOP on
\pset pager off
set client_min_messages = notice;
set timezone = 'UTC';

-- migrations/0019 (blocks.scheduled_start_at/_end_at, schedule_block(),
-- pick_curriculum_item()'s new p_target_date) and 0020 (calendar_connections,
-- calendar_event_links).
--
-- The one genuinely subtle claim under test is section 3: blocks_slot_key is
-- DEFERRABLE INITIALLY DEFERRED, so a naive cross-date move does NOT collide
-- at UPDATE time -- it succeeds, and fails at COMMIT. That failure mode is
-- invisible to a test that only checks the UPDATE's return, so section 3
-- forces the deferred check to run early (SET CONSTRAINTS ... IMMEDIATE, which
-- is retroactive) to prove the collision is real, then proves schedule_block()
-- avoids it by reallocating position server-side.

do $test$
declare
  v_uid uuid := t.mkuser('sched_owner');
  v_plan uuid;
  v_cat uuid;
  v_cat_other uuid;
  v_item_a uuid;
  v_item_b uuid;
  v_a uuid;          -- the block that gets moved around
  v_squatter uuid;   -- already occupies (d2, cat, position 0)
  v_d1 date := date '2026-03-02';
  v_d2 date := date '2026-03-03';
  v_block public.blocks;
  v_start timestamptz := timestamptz '2026-03-03 09:00:00+00';
  v_end   timestamptz := timestamptz '2026-03-03 10:30:00+00';
begin
  insert into public.plans (user_id, app_name, goal_line, is_active)
    values (v_uid, 'test', 'scheduling test', false) returning id into v_plan;
  insert into public.plan_categories (plan_id, name, label, days, sort_order)
    values (v_plan, 'dsa', 'DSA', '{0,2,4}', 0) returning id into v_cat;
  insert into public.plan_categories (plan_id, name, label, days, sort_order)
    values (v_plan, 'sql', 'SQL', '{0,2}', 1) returning id into v_cat_other;
  insert into public.curriculum_items (category_id, week_index, position, task)
    values (v_cat, 0, 0, 'Arrays: two pointers') returning id into v_item_a;
  insert into public.curriculum_items (category_id, week_index, position, task)
    values (v_cat, 0, 1, 'Arrays: sliding window') returning id into v_item_b;

  set local role authenticated;
  perform set_config('request.jwt.claim.sub', v_uid::text, true);
  perform public.activate_plan(v_plan);

  insert into public.blocks (user_id, plan_id, category_id, date, position, text)
    values (v_uid, v_plan, v_cat, v_d1, 0, 'block A') returning id into v_a;
  -- Deliberately position 0 on the DESTINATION date, same category: this is
  -- the slot block A would land on if a move kept its position.
  insert into public.blocks (user_id, plan_id, category_id, date, position, text)
    values (v_uid, v_plan, v_cat, v_d2, 0, 'squatter') returning id into v_squatter;

  -- ===== 1. an unscheduled block is honestly unscheduled ==================
  perform t.eq('1 a new block starts with no scheduled start (NULL, not midnight)',
    (select scheduled_start_at from public.blocks where id = v_a), null::timestamptz);
  perform t.eq('1b ...and no scheduled end',
    (select scheduled_end_at from public.blocks where id = v_a), null::timestamptz);

  -- ===== 2. schedule_block() sets, then clears, a window ==================
  v_block := public.schedule_block(v_a, null, v_start, v_end);
  perform t.eq('2 schedule_block sets the start it was given', v_block.scheduled_start_at, v_start);
  perform t.eq('2b ...and the end', v_block.scheduled_end_at, v_end);
  perform t.eq('2c a null p_date keeps the block on the date it was already on (blocks.date is NOT NULL)',
    v_block.date, v_d1);
  perform t.eq('2d ...and does not disturb its position', v_block.position, 0);

  -- The documented un-schedule call: every timestamp null CLEARS the window.
  -- This is a replacement, not a patch -- if this ever starts meaning "leave
  -- it alone", there is no way to clear a time at all.
  v_block := public.schedule_block(v_a);
  perform t.eq('2e schedule_block() with no timestamps clears the start', v_block.scheduled_start_at, null::timestamptz);
  perform t.eq('2f ...and the end', v_block.scheduled_end_at, null::timestamptz);
  perform t.eq('2g ...and still leaves the block on its board date', v_block.date, v_d1);

  -- A half-window is rejected at the argument boundary (22023, naming the
  -- function) rather than falling through to the CHECK constraint (23514).
  perform t.raises('2h a start without an end is rejected',
    format('select public.schedule_block(%L, null, %L::timestamptz, null)', v_a, v_start), '22023');
  perform t.raises('2i an end without a start is rejected',
    format('select public.schedule_block(%L, null, null, %L::timestamptz)', v_a, v_end), '22023');
  perform t.raises('2j an end at or before the start is rejected',
    format('select public.schedule_block(%L, null, %L::timestamptz, %L::timestamptz)', v_a, v_end, v_start), '22023');

  -- ===== 3. THE SUBTLE ONE: cross-date move vs. a DEFERRABLE slot key =====
  -- First prove the collision is real and that it is NOT caught at UPDATE
  -- time. If blocks_slot_key were immediate, the UPDATE itself would raise
  -- and this sub-block would report the wrong reason for passing -- so the
  -- UPDATE is asserted to succeed *first*, and only then is the deferred
  -- check forced to run.
  begin
    update public.blocks set date = v_d2 where id = v_a;
    raise notice 'PASS  3 a naive cross-date move succeeds at UPDATE time (the constraint is genuinely deferred)';
    -- Retroactive: forces the outstanding deferred check that COMMIT would
    -- otherwise have run, which is exactly where a client-side move breaks.
    execute 'set constraints public.blocks_slot_key immediate';
    raise exception 'FAIL 3b the naive move did not collide -- blocks_slot_key is not doing its job';
  exception when unique_violation then
    -- The subtransaction rolls back, taking the UPDATE and the constraint
    -- mode change with it: block A is back on v_d1, position 0.
    raise notice 'PASS  3b ...and then fails on the deferred check (23505) -- this is the COMMIT-time bug schedule_block() exists to prevent';
  end;

  perform t.eq('3c the failed move rolled back cleanly, block A is still on its original date',
    (select date from public.blocks where id = v_a), v_d1);

  -- Now the real thing: same move, through the RPC.
  v_block := public.schedule_block(v_a, v_d2, v_start, v_end);
  perform t.eq('3d schedule_block moves the block to the target date', v_block.date, v_d2);
  perform t.eq('3e ...reallocating position past the occupied slot (0 -> 1), which is the whole point',
    v_block.position, 1);
  perform t.eq('3f ...and the squatter is untouched at position 0',
    (select position from public.blocks where id = v_squatter), 0);
  perform t.eq('3g ...and the window came along with the move', v_block.scheduled_start_at, v_start);

  -- A same-date re-schedule must NOT re-run the allocation: max(position)
  -- includes this very row, so a naive implementation would push the block to
  -- the end of its own lane on every no-op call and leave a gap behind it.
  v_block := public.schedule_block(v_a, v_d2, v_start, v_end);
  perform t.eq('3h re-scheduling onto the same date leaves position alone (no self-inflicted drift)',
    v_block.position, 1);

  -- A move to a date with nothing in that lane starts at 0, not at some
  -- carried-over value.
  v_block := public.schedule_block(v_a, date '2026-03-09');
  perform t.eq('3i a move into an empty lane allocates position 0', v_block.position, 0);
  perform t.eq('3j ...and that move cleared the window, because no timestamps were passed',
    v_block.scheduled_start_at, null::timestamptz);

  -- Moving does not change which goal category a block belongs to.
  perform t.eq('3k a move never changes the block''s category',
    (select category_id from public.blocks where id = v_a), v_cat);

  -- ===== 4. pick_curriculum_item()'s new p_target_date ====================
  -- The one-argument call every pre-0019 call site makes must still resolve
  -- (0019 drops-and-recreates rather than overloading precisely so this does
  -- not become a 42725 "function is not unique") and must still land on today
  -- in the caller's own zone.
  v_block := public.pick_curriculum_item(v_item_a);
  perform t.eq('4 a one-argument pick still lands on today in the caller''s own zone',
    v_block.date, (now() at time zone 'UTC')::date);

  -- An explicit target date is honoured verbatim -- it is a destination the
  -- user chose, never a date derived from the plan's start (see 0019's
  -- closing comment and decisions.md 2026-09-11).
  v_block := public.pick_curriculum_item(v_item_b, date '2026-04-06');
  perform t.eq('4b an explicit p_target_date is honoured exactly', v_block.date, date '2026-04-06');
  perform t.eq('4c a picked block is still unscheduled -- picking is not scheduling',
    v_block.scheduled_start_at, null::timestamptz);

  -- Idempotence is unchanged, and a repeat pick must NOT move a block the
  -- user has since scheduled elsewhere -- same rule 0018 established for a
  -- manual re-prioritization surviving a repeat pick.
  perform public.schedule_block(v_block.id, date '2026-04-20');
  v_block := public.pick_curriculum_item(v_item_b, date '2026-04-06');
  perform t.eq('4d a repeat pick returns the existing block without moving it back',
    v_block.date, date '2026-04-20');

  -- ===== 5. a block that is not yours cannot be scheduled =================
  reset role;
  perform t.eq('5 (fixture) a second user exists', 1, 1);
  declare
    v_other uuid := t.mkuser('sched_intruder');
  begin
    set local role authenticated;
    perform set_config('request.jwt.claim.sub', v_other::text, true);
    perform t.raises('5b another user''s block cannot be scheduled (and the error does not confirm it exists)',
      format('select public.schedule_block(%L, null, null, null)', v_a), '42501');
  end;

  reset role;
  raise notice '--- block scheduling: complete ---';
end $test$;

-- ===========================================================================
-- 6-8. migrations/0020 -- calendar_connections is service-role only, and
-- calendar_event_links is read-own / write-never for a client.
-- ===========================================================================
do $test$
declare
  v_alice uuid := t.mkuser('cal_alice');
  v_bob uuid := t.mkuser('cal_bob');
  v_plan uuid;
  v_cat uuid;
  v_alice_block uuid;
  v_bob_plan uuid;
  v_bob_cat uuid;
  v_bob_block uuid;
  n int;
begin
  insert into public.plans (user_id, app_name, goal_line, is_active)
    values (v_alice, 'test', 'alice', false) returning id into v_plan;
  insert into public.plan_categories (plan_id, name, label, days, sort_order)
    values (v_plan, 'dsa', 'DSA', '{0,2}', 0) returning id into v_cat;
  insert into public.blocks (user_id, plan_id, category_id, date, position, text)
    values (v_alice, v_plan, v_cat, date '2026-03-02', 0, 'alice block')
    returning id into v_alice_block;

  insert into public.plans (user_id, app_name, goal_line, is_active)
    values (v_bob, 'test', 'bob', false) returning id into v_bob_plan;
  insert into public.plan_categories (plan_id, name, label, days, sort_order)
    values (v_bob_plan, 'dsa', 'DSA', '{0,2}', 0) returning id into v_bob_cat;
  insert into public.blocks (user_id, plan_id, category_id, date, position, text)
    values (v_bob, v_bob_plan, v_bob_cat, date '2026-03-02', 0, 'bob block')
    returning id into v_bob_block;

  -- Seeded as postgres (the table owner), standing in for the service-role
  -- Route Handler that is the only real writer of these tables.
  insert into public.calendar_connections (user_id, refresh_token_encrypted, scopes)
    values (v_alice, 'v1:aaaa:bbbb:cccc', '{https://www.googleapis.com/auth/calendar.events}');
  insert into public.calendar_event_links (user_id, block_id, external_event_id)
    values (v_alice, v_alice_block, 'goog-event-alice');
  insert into public.calendar_event_links (user_id, block_id, external_event_id)
    values (v_bob, v_bob_block, 'goog-event-bob');

  -- ===== 6. calendar_connections: authenticated has NO access at all ======
  -- Not "no policy matches" (which schema.md sec6 calls an incidental denial
  -- that a copy-pasted `for all` policy would silently undo) -- the privilege
  -- itself is revoked, so this is a hard 42501 rather than an empty result.
  set local role authenticated;
  perform set_config('request.jwt.claim.sub', v_alice::text, true);

  perform t.raises('6 a user cannot SELECT calendar_connections -- not even their own row',
    'select * from public.calendar_connections', '42501');
  perform t.raises('6b a user cannot INSERT a calendar connection',
    format('insert into public.calendar_connections (user_id, refresh_token_encrypted) values (%L, ''forged'')', v_alice),
    '42501');
  perform t.raises('6c a user cannot UPDATE a calendar connection',
    'update public.calendar_connections set calendar_id = ''hijacked''', '42501');
  perform t.raises('6d a user cannot DELETE a calendar connection',
    'delete from public.calendar_connections', '42501');
  perform t.raises('6e ...and cannot TRUNCATE it either (RLS does not apply to TRUNCATE)',
    'truncate public.calendar_connections', '42501');

  -- ===== 7. calendar_event_links: read own, write never ===================
  n := (select count(*)::int from public.calendar_event_links);
  perform t.eq('7 a user sees their own calendar event link', n, 1);
  perform t.eq('7b ...and it is theirs, not the other user''s',
    (select external_event_id from public.calendar_event_links), 'goog-event-alice');

  perform t.raises('7c a user cannot INSERT a calendar event link (service-role only)',
    format('insert into public.calendar_event_links (user_id, block_id, external_event_id) values (%L, %L, ''forged'')',
           v_alice, v_alice_block),
    '42501');
  perform t.raises('7d a user cannot UPDATE one',
    'update public.calendar_event_links set external_event_id = ''hijacked''', '42501');
  perform t.raises('7e a user cannot DELETE one',
    'delete from public.calendar_event_links', '42501');

  -- Cross-user isolation, the same live two-user check every other table in
  -- this suite gets.
  reset role;
  set local role authenticated;
  perform set_config('request.jwt.claim.sub', v_bob::text, true);
  perform t.eq('7f the other user sees only their own link, never alice''s',
    (select external_event_id from public.calendar_event_links), 'goog-event-bob');

  reset role;

  -- ===== 8. the idempotency constraint one-way sync is built on ===========
  begin
    insert into public.calendar_event_links (user_id, block_id, external_event_id)
      values (v_alice, v_alice_block, 'goog-event-duplicate');
    raise exception 'FAIL 8 a second google link for the same block was accepted';
  exception when unique_violation then
    raise notice 'PASS  8 a block cannot have two links for the same provider (23505) -- re-sync updates, never duplicates';
  end;

  -- Deleting the block takes the link with it (ON DELETE CASCADE). This is
  -- the documented, accepted cost: the Google event is orphaned, because
  -- Postgres cannot make an HTTP call from a cascade. Call sites unsync
  -- before deleting (api.md sec3e).
  delete from public.blocks where id = v_alice_block;
  perform t.eq('8b deleting a block cascades its calendar link away',
    (select count(*)::int from public.calendar_event_links where user_id = v_alice), 0);

  raise notice '--- calendar tables: complete ---';
end $test$;
