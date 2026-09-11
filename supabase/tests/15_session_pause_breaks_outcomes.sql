\set ON_ERROR_STOP on
\pset pager off
set client_min_messages = notice;
set timezone = 'UTC';

-- migrations/0023: pause/resume, scheduled breaks, extend_session, and the
-- block-status outcome of settling a session.
--
-- TIMING IS DETERMINISTIC HERE, not approximate. now() is transaction start
-- time and is constant for the whole of each `do $test$` block, so a session
-- whose started_at is set to `now() - interval '30 minutes'` really does
-- measure exactly 1800 wall-clock seconds when settled in the same block.
-- That is why these assertions can use t.eq on exact integers rather than a
-- tolerance: the only clock involved is one frozen value.
--
-- The RPCs are called as `authenticated` (that is the contract under test);
-- the backdating UPDATEs between them are done as `postgres`, because
-- focus_sessions is SELECT-only to clients and must stay that way -- test 6
-- below asserts exactly that.

-- ===== 1. the shared focus-time formula ====================================
-- session_focus_seconds() is the one definition three consumers share. Pin it
-- directly before testing anything that calls it, so a failure downstream is
-- attributable to the caller rather than the arithmetic.
do $test$
begin
  perform t.eq('1 an unpaused session is plain wall clock',
    public.session_focus_seconds(
      '2026-09-01 10:00+00', '2026-09-01 10:25+00', 0, 1500), 1500);

  perform t.eq('1b paused time is subtracted, not counted as focus',
    public.session_focus_seconds(
      '2026-09-01 10:00+00', '2026-09-01 10:30+00', 600, 1500), 1200);

  -- The rule 0009 established and 0023 must not lose: a tab left open for
  -- nine hours after a 25-minute block is 25 minutes.
  perform t.eq('1c the result is still capped at planned_duration_s',
    public.session_focus_seconds(
      '2026-09-01 10:00+00', '2026-09-01 19:00+00', 0, 1500), 1500);

  -- Cap applies to the POST-subtraction number. A long pause inside a long
  -- overrun must not be able to sneak the total back above planned.
  perform t.eq('1d ...and the cap is applied after the pause subtraction',
    public.session_focus_seconds(
      '2026-09-01 10:00+00', '2026-09-01 19:00+00', 30000, 1500), 1500);

  perform t.eq('1e a pause longer than the session floors at 0, never negative',
    public.session_focus_seconds(
      '2026-09-01 10:00+00', '2026-09-01 10:25+00', 9999, 1500), 0);

  -- A pre-0023 row has total_paused_s = 0 by column default, so every session
  -- that existed before this migration keeps computing exactly as it did.
  perform t.eq('1f a NULL total_paused_s behaves as zero, not as NULL',
    public.session_focus_seconds(
      '2026-09-01 10:00+00', '2026-09-01 10:25+00', null, 1500), 1500);

  raise notice '--- session_focus_seconds: complete ---';
end $test$;

-- ===== 2. pause / resume accounting end to end =============================
do $test$
declare
  v_uid uuid := t.mkuser('pause_accounting');
  v_plan uuid;
  v_cat uuid;
  v_block uuid;
  v_sess public.focus_sessions;
  v_id uuid;
begin
  insert into public.plans (user_id, app_name, goal_line, is_active)
    values (v_uid, 'test', 'pause accounting', false) returning id into v_plan;
  insert into public.plan_categories (plan_id, name, label, days, sort_order)
    values (v_plan, 'dsa', 'DSA', '{0,1,2}', 0) returning id into v_cat;
  insert into public.blocks (user_id, plan_id, category_id, date, position, text)
    values (v_uid, v_plan, v_cat, '2026-09-01', 0, 'two pointers')
    returning id into v_block;

  set local role authenticated;
  perform set_config('request.jwt.claim.sub', v_uid::text, true);

  -- A 25-minute session.
  v_sess := public.start_session(v_block, 1500);
  v_id := v_sess.id;

  perform t.eq('2 a fresh session starts unpaused with nothing accumulated',
    (v_sess.paused_at is null and v_sess.total_paused_s = 0), true);

  -- Make it look like the session began 30 wall-clock minutes ago.
  reset role;
  update public.focus_sessions set started_at = now() - interval '30 minutes'
   where id = v_id;
  set local role authenticated;

  v_sess := public.pause_session(v_id, 'manual');
  perform t.eq('2b pausing stamps paused_at', v_sess.paused_at is not null, true);
  -- THE POINT OF THE WHOLE MIGRATION: a paused session is still `running`,
  -- so it keeps the one-running slot, stays findable by the client's existing
  -- recovery query, and settle_session()'s guard does not have to change.
  perform t.eq('2c ...and the session is STILL state = running, not a fourth state',
    v_sess.state, 'running');

  -- Make the pause look like it began 10 minutes ago.
  reset role;
  update public.focus_sessions set paused_at = now() - interval '10 minutes'
   where id = v_id;
  set local role authenticated;

  v_sess := public.resume_session(v_id);
  perform t.eq('2d resuming banks the closed interval exactly',
    v_sess.total_paused_s, 600);
  perform t.eq('2e ...and clears paused_at', v_sess.paused_at is null, true);

  v_sess := public.complete_session(v_id);

  -- 1800 wall-clock seconds, 600 of them paused -> 1200 focus, under the
  -- 1500 cap. The number this migration exists to get right.
  perform t.eq('2f focus_seconds subtracts the paused interval',
    public.session_focus_seconds(
      v_sess.started_at, v_sess.completed_at, v_sess.total_paused_s, v_sess.planned_duration_s),
    1200);

  -- Without pause tracking this session would have reported the full 1500
  -- (1800 wall clock, capped) -- 25 minutes of credit for 20 minutes of work.
  perform t.eq('2g ...which is genuinely less than the pre-0023 formula gave',
    public.session_focus_seconds(
      v_sess.started_at, v_sess.completed_at, 0, v_sess.planned_duration_s),
    1500);

  -- The ledger carries both numbers under distinct names so a reader is never
  -- silently comparing wall clock against focus time.
  perform t.eq('2h the session_completed event carries the pause-aware focus_s',
    (select e.payload->>'focus_s' from public.activity_events e
      where e.session_id = v_id and e.kind = 'session_completed'), '1200');
  perform t.eq('2i ...alongside the unchanged wall-clock elapsed_s',
    (select e.payload->>'elapsed_s' from public.activity_events e
      where e.session_id = v_id and e.kind = 'session_completed'), '1800');
  perform t.eq('2j ...and the paused total, so the two can be reconciled',
    (select e.payload->>'total_paused_s' from public.activity_events e
      where e.session_id = v_id and e.kind = 'session_completed'), '600');

  reset role;
  raise notice '--- pause/resume accounting: complete ---';
end $test$;

-- ===== 3. settling FROM paused closes the open interval ====================
-- The path a real user hits constantly: pause, walk away, come back and press
-- End. If the open paused interval were not folded in at settle time it would
-- be counted as focus, which is the exact inflation this migration prevents.
do $test$
declare
  v_uid uuid := t.mkuser('settle_from_paused');
  v_sess public.focus_sessions;
  v_id uuid;
begin
  set local role authenticated;
  perform set_config('request.jwt.claim.sub', v_uid::text, true);

  v_sess := public.start_session(null, 1500);
  v_id := v_sess.id;

  reset role;
  update public.focus_sessions set started_at = now() - interval '30 minutes'
   where id = v_id;
  set local role authenticated;

  perform public.pause_session(v_id, 'manual');

  reset role;
  update public.focus_sessions set paused_at = now() - interval '20 minutes'
   where id = v_id;
  set local role authenticated;

  -- Ending directly from paused must be allowed -- no resume-first dance.
  v_sess := public.complete_session(v_id);

  perform t.eq('3 a session can be completed directly from paused',
    v_sess.state, 'completed');
  perform t.eq('3b the open paused interval is folded into total_paused_s',
    v_sess.total_paused_s, 1200);
  perform t.eq('3c ...and paused_at is cleared, never left set on a settled row',
    v_sess.paused_at is null, true);
  -- 1800 wall clock - 1200 paused = 600 focus. Ten minutes of real work.
  perform t.eq('3d so the focus time is the 10 minutes actually worked',
    public.session_focus_seconds(
      v_sess.started_at, v_sess.completed_at, v_sess.total_paused_s, v_sess.planned_duration_s),
    600);

  reset role;
  raise notice '--- settle from paused: complete ---';
end $test$;

-- ===== 4. pause/resume guards ==============================================
do $test$
declare
  v_uid uuid := t.mkuser('pause_guards');
  v_other uuid := t.mkuser('pause_guards_other');
  v_sess public.focus_sessions;
  v_id uuid;
begin
  set local role authenticated;
  perform set_config('request.jwt.claim.sub', v_uid::text, true);
  v_sess := public.start_session(null, 1500);
  v_id := v_sess.id;

  -- A double pause must not silently restamp paused_at -- that would erase
  -- however long the user had already been away and hand back free focus
  -- time. A scheduled break firing while the user has manually paused is a
  -- real race, not a hypothetical one.
  perform public.pause_session(v_id, 'manual');
  perform t.raises('4 a second pause on an already-paused session is refused',
    format($$select public.pause_session(%L::uuid)$$, v_id), '42501');

  perform public.resume_session(v_id);
  perform t.raises('4b resuming a session that is not paused is refused',
    format($$select public.resume_session(%L::uuid)$$, v_id), '42501');

  perform t.raises('4c an unknown pause reason is rejected',
    format($$select public.pause_session(%L::uuid, 'snack')$$, v_id), '22023');

  -- Cross-user. The error deliberately does not distinguish "not yours" from
  -- "not running" -- distinguishing them confirms another user's id exists.
  perform set_config('request.jwt.claim.sub', v_other::text, true);
  perform t.raises('4d another user cannot pause your session',
    format($$select public.pause_session(%L::uuid)$$, v_id), '42501');
  perform t.raises('4e ...nor resume it',
    format($$select public.resume_session(%L::uuid)$$, v_id), '42501');

  perform set_config('request.jwt.claim.sub', v_uid::text, true);
  perform public.complete_session(v_id);
  perform t.raises('4f a settled session cannot be paused',
    format($$select public.pause_session(%L::uuid)$$, v_id), '42501');

  reset role;
  raise notice '--- pause/resume guards: complete ---';
end $test$;

-- ===== 5. breaks are scheduled pauses, and the plan survives a reload ======
do $test$
declare
  v_uid uuid := t.mkuser('break_plan');
  v_sess public.focus_sessions;
  v_id uuid;
  v_plan jsonb := jsonb_build_object('breaks', jsonb_build_array(
    jsonb_build_object('at_s', 900,  'duration_s', 300),
    jsonb_build_object('at_s', 1800, 'duration_s', 300)
  ));
begin
  set local role authenticated;
  perform set_config('request.jwt.claim.sub', v_uid::text, true);

  -- The founder's example: 45 minutes of work with 2 x 5 minute breaks.
  v_sess := public.start_session(null, 2700, v_plan);
  v_id := v_sess.id;

  -- PERSISTED, which is the whole argument for the column: a client that
  -- reloads at minute 30 can still rebuild the schedule instead of silently
  -- losing the user's remaining breaks while the timer keeps looking right.
  perform t.eq('5 the break plan is stored on the session, not held in the tab',
    v_sess.break_plan, v_plan);
  perform t.eq('5b a reader re-fetching the row gets it back intact',
    (select break_plan from public.focus_sessions where id = v_id), v_plan);
  perform t.eq('5c the session_started event records the break count',
    (select e.payload->>'break_count' from public.activity_events e
      where e.session_id = v_id and e.kind = 'session_started'), '2');

  -- A break uses the SAME mechanism as a manual pause -- one state, one pair
  -- of RPCs. Only the ledger's reason tag differs.
  perform public.pause_session(v_id, 'break');
  perform t.eq('5d a break pauses the same way a manual pause does',
    (select paused_at is not null from public.focus_sessions where id = v_id), true);
  perform t.eq('5e ...and is distinguishable only by the ledger reason tag',
    (select e.payload->>'reason' from public.activity_events e
      where e.session_id = v_id and e.kind = 'session_paused'), 'break');
  perform public.resume_session(v_id);
  perform public.abandon_session(v_id);

  reset role;
  raise notice '--- break plan: complete ---';
end $test$;

-- ===== 5g. break plan validation ===========================================
-- Every one of these would otherwise ship a session whose breaks silently
-- never fire, twenty minutes after the user could still have fixed it.
do $test$
declare
  v_uid uuid := t.mkuser('break_plan_validation');
begin
  set local role authenticated;
  perform set_config('request.jwt.claim.sub', v_uid::text, true);

  perform t.raises('5g a break plan that is not an object with breaks[] is rejected',
    $$select public.start_session(null, 1500, '{"count":2}'::jsonb)$$, '22023');
  perform t.raises('5h a break missing duration_s is rejected',
    $$select public.start_session(null, 1500, '{"breaks":[{"at_s":600}]}'::jsonb)$$, '22023');
  -- The units mistake this catches: minutes passed where seconds were meant.
  perform t.raises('5i a break at or past the end of the work would never fire',
    $$select public.start_session(null, 1500, '{"breaks":[{"at_s":1500,"duration_s":300}]}'::jsonb)$$,
    '22023');
  perform t.raises('5j out-of-order break points are rejected, not silently sorted',
    $$select public.start_session(null, 1500,
        '{"breaks":[{"at_s":900,"duration_s":300},{"at_s":600,"duration_s":300}]}'::jsonb)$$,
    '22023');
  perform t.raises('5k work plus breaks must still fit inside a day',
    $$select public.start_session(null, 86000, '{"breaks":[{"at_s":600,"duration_s":900}]}'::jsonb)$$,
    '22023');

  -- And the happy path still works with no break plan at all, which is what
  -- every existing call site passes.
  perform t.eq('5l a session with no break plan is unaffected',
    (public.start_session(null, 1500)).break_plan, null::jsonb);

  reset role;
  raise notice '--- break plan validation: complete ---';
end $test$;

-- ===== 6. focus_sessions is still SELECT-only to clients ===================
-- The new columns are exactly the kind of thing a client would love to write
-- directly (a bigger total_paused_s is free focus time back; a bigger
-- planned_duration_s raises the cap). D12 says no.
do $test$
declare
  v_uid uuid := t.mkuser('session_privs');
  v_id uuid;
begin
  set local role authenticated;
  perform set_config('request.jwt.claim.sub', v_uid::text, true);
  v_id := (public.start_session(null, 1500)).id;

  perform t.raises('6 a client cannot UPDATE total_paused_s to fabricate focus time',
    format($$update public.focus_sessions set total_paused_s = 0 where id = %L$$, v_id), '42501');
  perform t.raises('6b ...nor raise planned_duration_s to lift the cap',
    format($$update public.focus_sessions set planned_duration_s = 86400 where id = %L$$, v_id),
    '42501');
  perform t.raises('6c ...nor clear paused_at to un-pause without the RPC',
    format($$update public.focus_sessions set paused_at = null where id = %L$$, v_id), '42501');
  perform t.raises('6d ...nor rewrite the break plan mid-session',
    format($$update public.focus_sessions set break_plan = null where id = %L$$, v_id), '42501');

  -- settle_session's free p_state parameter stays unreachable, as before.
  perform t.raises('6e settle_session is internal and reachable by nobody',
    format($$select public.settle_session(%L::uuid, 'completed', null, null)$$, v_id), '42501');

  perform public.abandon_session(v_id);
  reset role;
  raise notice '--- session privileges: complete ---';
end $test$;

-- ===== 7. extend_session ===================================================
do $test$
declare
  v_uid uuid := t.mkuser('extend_session_owner');
  v_other uuid := t.mkuser('extend_session_other');
  v_sess public.focus_sessions;
  v_id uuid;
begin
  set local role authenticated;
  perform set_config('request.jwt.claim.sub', v_uid::text, true);

  v_sess := public.start_session(null, 1500);
  v_id := v_sess.id;
  perform t.eq('7 a new session has extended nothing', v_sess.extended_s, 0);

  -- "Do you need more time?" -- yes, ten minutes.
  v_sess := public.extend_session(v_id, 600);
  perform t.eq('7b extending raises planned_duration_s', v_sess.planned_duration_s, 2100);
  -- Tracked separately so reporting can still tell "planned 25, then asked
  -- for 10 more" from "planned 35" -- a real signal about estimation that
  -- bumping planned_duration_s alone would destroy.
  perform t.eq('7c ...and records how much of it was an extension', v_sess.extended_s, 600);

  v_sess := public.extend_session(v_id, 300);
  perform t.eq('7d extensions accumulate', v_sess.planned_duration_s, 2400);
  perform t.eq('7e ...on both columns', v_sess.extended_s, 900);

  perform t.eq('7f the ledger records each extension',
    (select count(*) from public.activity_events e
      where e.session_id = v_id and e.kind = 'session_extended'), 2::bigint);

  perform t.raises('7g a non-positive extension is rejected',
    format($$select public.extend_session(%L::uuid, 0)$$, v_id), '22023');
  -- A readable 22023 rather than the table CHECK surfacing as an opaque 23514
  -- the UI would have to pattern-match on.
  perform t.raises('7h an extension past the 86400 ceiling is refused readably',
    format($$select public.extend_session(%L::uuid, 86400)$$, v_id), '22023');

  perform set_config('request.jwt.claim.sub', v_other::text, true);
  perform t.raises('7i another user cannot extend your session',
    format($$select public.extend_session(%L::uuid, 600)$$, v_id), '42501');

  perform set_config('request.jwt.claim.sub', v_uid::text, true);
  perform public.complete_session(v_id);
  perform t.raises('7j a settled session cannot be extended',
    format($$select public.extend_session(%L::uuid, 600)$$, v_id), '42501');

  -- Extending while paused is allowed on purpose: someone who paused to think
  -- and then realises they need longer is completely ordinary, and refusing
  -- would be an arbitrary rule the UI would have to explain.
  v_id := (public.start_session(null, 1500)).id;
  perform public.pause_session(v_id, 'manual');
  perform t.eq('7k a paused session can still be extended',
    (public.extend_session(v_id, 600)).planned_duration_s, 2100);
  perform public.abandon_session(v_id);

  reset role;
  raise notice '--- extend_session: complete ---';
end $test$;

-- ===== 8. the three block outcomes =========================================
-- The part that did not exist at all before 0023: settling a session had no
-- effect on the linked block's status, ever.
do $test$
declare
  v_uid uuid := t.mkuser('block_outcomes');
  v_plan uuid;
  v_cat uuid;
  v_end uuid;      -- explicit "End session"
  v_early uuid;    -- "Leave early"
  v_left uuid;     -- natural expiry, something left
  v_fin uuid;      -- natural expiry, finished
  v_sid uuid;
  v_blk public.blocks;
begin
  insert into public.plans (user_id, app_name, goal_line, is_active)
    values (v_uid, 'test', 'block outcomes', false) returning id into v_plan;
  insert into public.plan_categories (plan_id, name, label, days, sort_order)
    values (v_plan, 'dsa', 'DSA', '{0,1,2}', 0) returning id into v_cat;
  insert into public.blocks (user_id, plan_id, category_id, date, position, text, status)
    values (v_uid, v_plan, v_cat, '2026-09-01', 0, 'explicit end', 'in_progress')
    returning id into v_end;
  insert into public.blocks (user_id, plan_id, category_id, date, position, text, status)
    values (v_uid, v_plan, v_cat, '2026-09-01', 1, 'leave early', 'todo')
    returning id into v_early;
  insert into public.blocks (user_id, plan_id, category_id, date, position, text, status)
    values (v_uid, v_plan, v_cat, '2026-09-01', 2, 'something left', 'in_progress')
    returning id into v_left;
  insert into public.blocks (user_id, plan_id, category_id, date, position, text, status)
    values (v_uid, v_plan, v_cat, '2026-09-01', 3, 'finished it', 'in_progress')
    returning id into v_fin;

  set local role authenticated;
  perform set_config('request.jwt.claim.sub', v_uid::text, true);

  -- ---- PATH 1: explicit "End session" -> done, atomically, no prompt ------
  v_sid := (public.start_session(v_end, 1500)).id;
  perform public.complete_session(v_sid, 'done');
  perform t.eq('8 explicit End Session moves the linked block to done',
    (select status from public.blocks where id = v_end), 'done');
  -- The ledger event is what actually makes this visible to Phase 7. A bare
  -- status write would show on the board and be invisible to the engine.
  perform t.eq('8b ...and mints task_completed so weekly_performance can see it',
    (select count(*) from public.activity_events e
      where e.kind = 'task_completed' and e.payload->>'block_id' = v_end::text), 1::bigint);
  perform t.eq('8c ...and releases the block''s claim',
    (select claimed from public.blocks where id = v_end), false);

  -- ---- PATH 2: "Leave early" -> in_progress, no note, no regression ------
  v_sid := (public.start_session(v_early, 1500)).id;
  perform public.abandon_session(v_sid, 'in_progress');
  perform t.eq('9 Leave Early puts the block in in_progress',
    (select status from public.blocks where id = v_early), 'in_progress');
  -- THE BUG THIS NEARLY SHIPPED. weekly_performance() computes
  -- postponement_count as regressed_count + stale_open_count. Minting
  -- task_regressed on every ordinary unfinished session would read a person
  -- who works steadily on hard tasks as someone who keeps putting things off.
  perform t.eq('9b a task that was never done is NOT a regression',
    (select count(*) from public.activity_events e
      where e.kind = 'task_regressed' and e.payload->>'block_id' = v_early::text), 0::bigint);

  -- ---- PATH 3a: natural expiry, "something's left" -> in_progress + note --
  -- The session settles FIRST (time ran out), and the question is answered
  -- afterwards -- which is why this is a separate call, not a parameter.
  v_sid := (public.start_session(v_left, 1500)).id;
  perform public.complete_session(v_sid);
  perform t.eq('10 the session itself completes -- the time was really spent',
    (select state from public.focus_sessions where id = v_sid), 'completed');
  perform t.eq('10b ...and settling alone changes nothing about the block yet',
    (select status from public.blocks where id = v_left), 'in_progress');

  v_blk := public.settle_block_outcome(v_sid, 'in_progress', 'still need the left-join case');
  perform t.eq('10c answering "something''s left" keeps the block in_progress',
    v_blk.status, 'in_progress');
  perform t.eq('10d ...and persists the note the user typed',
    v_blk.notes like '%still need the left-join case%', true);
  perform t.eq('10e ...dated, so it reads as history rather than current state',
    v_blk.notes like to_char((now() at time zone 'UTC')::date, 'YYYY-MM-DD') || '%', true);

  -- APPEND, never overwrite: blocks.notes is an ordinary user-editable field
  -- that the session screen already renders as the task's description.
  -- Clobbering it would destroy text written somewhere else, with no undo.
  v_sid := (public.start_session(v_left, 1500)).id;
  perform public.complete_session(v_sid);
  v_blk := public.settle_block_outcome(v_sid, 'in_progress', 'and the null side');
  perform t.eq('10f a second leftover note is appended, not overwritten',
    (v_blk.notes like '%still need the left-join case%'
     and v_blk.notes like '%and the null side%'), true);

  -- ---- PATH 3b: natural expiry, "I finished" -> done ---------------------
  v_sid := (public.start_session(v_fin, 1500)).id;
  perform public.complete_session(v_sid);
  v_blk := public.settle_block_outcome(v_sid, 'done');
  perform t.eq('11 answering "I finished" moves the block to done',
    v_blk.status, 'done');
  perform t.eq('11b ...and mints task_completed, same as the explicit path',
    (select count(*) from public.activity_events e
      where e.kind = 'task_completed' and e.payload->>'block_id' = v_fin::text), 1::bigint);

  -- ---- a genuine walk-back IS a regression -------------------------------
  -- v_fin is done per the ledger. Saying "actually, something's left" on a
  -- later session is a real regression and must be recorded, or Phase 7 would
  -- go on counting it as done forever.
  v_sid := (public.start_session(v_fin, 1500)).id;
  perform public.complete_session(v_sid);
  v_blk := public.settle_block_outcome(v_sid, 'in_progress', 'reopened it');
  perform t.eq('11c walking back a genuinely-done task DOES mint task_regressed',
    (select count(*) from public.activity_events e
      where e.kind = 'task_regressed' and e.payload->>'block_id' = v_fin::text), 1::bigint);

  reset role;
  raise notice '--- block outcomes: complete ---';
end $test$;

-- ===== 12. settle_block_outcome guards =====================================
do $test$
declare
  v_uid uuid := t.mkuser('outcome_guards');
  v_other uuid := t.mkuser('outcome_guards_other');
  v_plan uuid;
  v_cat uuid;
  v_block uuid;
  v_sid uuid;
begin
  insert into public.plans (user_id, app_name, goal_line, is_active)
    values (v_uid, 'test', 'outcome guards', false) returning id into v_plan;
  insert into public.plan_categories (plan_id, name, label, days, sort_order)
    values (v_plan, 'dsa', 'DSA', '{0,1,2}', 0) returning id into v_cat;
  insert into public.blocks (user_id, plan_id, category_id, date, position, text)
    values (v_uid, v_plan, v_cat, '2026-09-01', 0, 'guarded') returning id into v_block;

  set local role authenticated;
  perform set_config('request.jwt.claim.sub', v_uid::text, true);
  v_sid := (public.start_session(v_block, 1500)).id;

  -- "What happened to the task" is not a question about a live session.
  perform t.raises('12 a running session has no block outcome to settle yet',
    format($$select public.settle_block_outcome(%L::uuid, 'done')$$, v_sid), '42501');

  perform public.complete_session(v_sid);

  perform t.raises('12b an outcome outside done/in_progress is rejected',
    format($$select public.settle_block_outcome(%L::uuid, 'backlog')$$, v_sid), '22023');
  -- A note only makes sense on the path where something is left. Silently
  -- dropping it would lose the user's typing.
  perform t.raises('12c a leftover note on the done path is refused, not dropped',
    format($$select public.settle_block_outcome(%L::uuid, 'done', 'but actually...')$$, v_sid),
    '22023');

  perform set_config('request.jwt.claim.sub', v_other::text, true);
  perform t.raises('12d another user cannot settle your block outcome',
    format($$select public.settle_block_outcome(%L::uuid, 'done')$$, v_sid), '42501');

  -- An unlinked session (Home's generic "Start focus") has no task whose
  -- status could change. NULL rather than an error, so the client can run the
  -- same outcome flow for every session without branching first.
  perform set_config('request.jwt.claim.sub', v_uid::text, true);
  v_sid := (public.start_session(null, 1500)).id;
  perform public.complete_session(v_sid);
  perform t.eq('12e an unlinked session returns NULL rather than erroring',
    (public.settle_block_outcome(v_sid, 'done')).id, null::uuid);

  reset role;
  raise notice '--- block outcome guards: complete ---';
end $test$;

-- ===== 13. weekly_performance() under a REAL pause =========================
-- The Phase 7 regression risk named in the brief, tested directly rather than
-- assumed from "the formula is shared". A paused session must reduce
-- actual_minutes, which is the numerator of pace_ratio -- the signal the
-- engine uses to decide someone is coasting and hand them MORE work.
do $test$
declare
  v_uid uuid := t.mkuser('weekly_pause_aware');
  v_plan uuid;
  v_cat uuid;
  v_block uuid;
  v_c jsonb;
begin
  insert into public.plans (user_id, app_name, goal_line, is_active)
    values (v_uid, 'test', 'pause-aware pace', false) returning id into v_plan;
  insert into public.plan_categories (plan_id, name, label, days, sort_order, created_at)
    values (v_plan, 'dsa', 'DSA', '{0,1,2}', 0, '2026-01-01'::timestamptz)
    returning id into v_cat;
  -- Estimated 60 minutes. Done, with a real settled session.
  insert into public.blocks
    (user_id, plan_id, category_id, date, position, text, status, estimated_minutes)
  values (v_uid, v_plan, v_cat, '2026-09-01', 0, 'paused halfway', 'done', 60)
  returning id into v_block;
  insert into public.activity_events (user_id, kind, occurred_at, payload)
  values (v_uid, 'task_completed', '2026-09-01 18:00+00',
          jsonb_build_object('block_id', v_block::text));

  -- 90 wall-clock minutes, 30 of them paused, planned 90 so the cap does not
  -- interfere: 60 real focus minutes against a 60-minute estimate.
  insert into public.focus_sessions
    (user_id, block_id, started_at, completed_at, planned_duration_s, state, total_paused_s)
  values (v_uid, v_block, '2026-09-01 10:00+00', '2026-09-01 11:30+00', 5400, 'completed', 1800);

  set local role authenticated;
  perform set_config('request.jwt.claim.sub', v_uid::text, true);
  v_c := (public.weekly_performance(v_plan, '2026-W36'))->'categories'->0;

  perform t.eq('13 weekly_performance subtracts paused time from actual minutes',
    v_c->>'actual_minutes', '60.0');
  -- The number that matters: 60 actual against 60 estimated is pace 1.0, a
  -- person working exactly to estimate. Counting the paused half hour would
  -- make it 1.5 and classify them as struggling -- the engine would ease a
  -- target that was never the problem.
  perform t.eq('13b ...so pace_ratio reads 1.0, not the 1.5 the old formula gave',
    v_c->>'pace_ratio', '1.0000');
  perform t.eq('13c the session still counts as a paced task',
    v_c->>'paced_task_count', '1');
  perform t.eq('13d ...and completion is unaffected by pausing',
    v_c->>'completion_rate', '1.0000');

  reset role;
  raise notice '--- weekly_performance under pause: complete ---';
end $test$;

-- ===== 14. daily_rollups under a REAL pause ================================
-- The other consumer of the shared formula. Same risk, same explicit test.
do $test$
declare
  v_uid uuid := t.mkuser('rollup_pause_aware');
begin
  -- 60 wall-clock minutes, 20 paused, planned 60 -> 40 minutes of focus.
  insert into public.focus_sessions
    (user_id, started_at, completed_at, planned_duration_s, state, total_paused_s)
  values (v_uid, '2026-09-01 10:00+00', '2026-09-01 11:00+00', 3600, 'completed', 1200);

  perform public.recompute_daily_rollups('2026-09-01', '2026-09-01', 'UTC');

  perform t.eq('14 recompute_daily_rollups subtracts paused time too',
    (select focus_seconds from t.roll(v_uid, '2026-09-01')), 2400);
  perform t.eq('14b ...and still counts the session as completed',
    (select sessions_completed from t.roll(v_uid, '2026-09-01')), 1);

  raise notice '--- daily_rollups under pause: complete ---';
end $test$;

-- ===== 15. the pre-0023 world is unchanged =================================
-- Every session that existed before this migration has total_paused_s = 0 by
-- column default, so its focus time must compute exactly as it always did.
-- Without this, a silent shift in historical numbers would be invisible.
do $test$
declare
  v_uid uuid := t.mkuser('rollup_unpaused_regression');
begin
  perform t.sess(v_uid, '2026-09-02 10:00+00', 1500, 'completed', '2026-09-02 10:25+00');
  -- The nine-hour tab, the case 0009's CAP AT PLANNED note exists for.
  perform t.sess(v_uid, '2026-09-03 10:00+00', 1500, 'completed', '2026-09-03 19:00+00');

  perform public.recompute_daily_rollups('2026-09-02', '2026-09-03', 'UTC');

  perform t.eq('15 an unpaused session is unchanged by 0023',
    (select focus_seconds from t.roll(v_uid, '2026-09-02')), 1500);
  perform t.eq('15b ...and the planned-duration cap still applies as before',
    (select focus_seconds from t.roll(v_uid, '2026-09-03')), 1500);

  raise notice '--- pre-0023 sessions unchanged: complete ---';
end $test$;
