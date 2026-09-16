\set ON_ERROR_STOP on
\pset pager off
set client_min_messages = notice;
set timezone = 'UTC';

-- migrations/0035: contextual sensors -- activity_events.client_event_id
-- (real idempotency, not just client-side debounce), the post-session
-- check-in (self_difficulty/self_confidence/self_help_level, gated by
-- check_in_state), settle_session()'s periodic-sample eligibility rule and
-- its sampling-provenance payload, and session_visibility_changed (the one
-- new CLIENT-minted kind this migration adds).
--
-- TIMING IS DETERMINISTIC HERE, same discipline as
-- 15_session_pause_breaks_outcomes.sql: `now()` is transaction-start time
-- and is constant for the whole of each `do $test$` block, so backdating
-- started_at by a fixed interval produces an exact, not approximate,
-- session_focus_seconds() result.

-- Local helper: create + settle one session with p_minutes of real elapsed
-- focus time, exercising settle_session()'s check-in eligibility rule
-- exactly as a real client would -- start_session()/complete_session()/
-- abandon_session() all called as `authenticated`, with only the started_at
-- backdating UPDATE done as `postgres` (focus_sessions stays SELECT-only to
-- clients, and this proves the eligibility path needs no client write to
-- reach). planned_duration_s (3600) always exceeds every p_minutes used
-- below, so the session_focus_seconds() cap never interferes with the
-- numbers under test.
create or replace function t.settled_session(p_uid uuid, p_minutes numeric, p_kind text default 'complete')
returns public.focus_sessions language plpgsql as $$
declare
  v_sess public.focus_sessions;
begin
  set local role authenticated;
  perform set_config('request.jwt.claim.sub', p_uid::text, true);
  v_sess := public.start_session(null, 3600);

  reset role;
  update public.focus_sessions set started_at = now() - (p_minutes || ' minutes')::interval
   where id = v_sess.id;

  set local role authenticated;
  perform set_config('request.jwt.claim.sub', p_uid::text, true);
  if p_kind = 'abandon' then
    v_sess := public.abandon_session(v_sess.id);
  else
    v_sess := public.complete_session(v_sess.id);
  end if;

  reset role;
  return v_sess;
end $$;

-- Local helper: three back-to-back 20-minute (well above the 600s floor)
-- sessions for a FRESH user, returning the third -- lands exactly on the
-- periodic-sample cadence (eligible_session_number 3, 3 mod 3 = 0) and so
-- is guaranteed offered_pending. Used by every test below that needs a real
-- offered check-in to answer or decline.
create or replace function t.offered_session(p_uid uuid) returns public.focus_sessions
language plpgsql as $$
declare
  v_sess public.focus_sessions;
  i int;
begin
  for i in 1..3 loop
    v_sess := t.settled_session(p_uid, 20, 'complete');
  end loop;
  return v_sess;
end $$;

-- ===== 1. a client cannot mint any of the three check-in kinds =============
do $test$
declare
  v_uid uuid := t.mkuser('checkin_client_reject');
begin
  set local role authenticated;
  perform set_config('request.jwt.claim.sub', v_uid::text, true);

  perform t.raises('1 record_event() rejects client-minted session_check_in_offered',
    'select public.record_event(''session_check_in_offered'', ''{}''::jsonb)', '22023');
  perform t.raises('1b record_event() rejects client-minted session_check_in_answered',
    'select public.record_event(''session_check_in_answered'', ''{}''::jsonb)', '22023');
  perform t.raises('1c record_event() rejects client-minted session_check_in_declined',
    'select public.record_event(''session_check_in_declined'', ''{}''::jsonb)', '22023');

  reset role;
  raise notice '--- server-minted check-in kinds, client rejection: complete ---';
end $test$;

-- ===== 2. ...but a client CAN mint session_visibility_changed ==============
do $test$
declare
  v_uid uuid := t.mkuser('visibility_client_accept');
  v_row public.activity_events;
begin
  set local role authenticated;
  perform set_config('request.jwt.claim.sub', v_uid::text, true);

  v_row := public.record_event('session_visibility_changed', jsonb_build_object(
    'session_id', gen_random_uuid()::text,
    'visibility_state', 'hidden',
    'client_occurred_at', '2026-09-16T14:03:00.000Z',
    'client_tz', 'America/Los_Angeles'
  ));
  perform t.eq('2 session_visibility_changed is a real, client-mintable kind', v_row.kind, 'session_visibility_changed');
  perform t.eq('2b the payload''s client_occurred_at/client_tz round-trip as ordinary payload fields (claims, not columns)',
    (v_row.payload->>'client_tz'), 'America/Los_Angeles');

  reset role;
  raise notice '--- client-minted session_visibility_changed: complete ---';
end $test$;

-- ===== 3. the widened CHECK genuinely accepts all four new kinds, server-side
do $test$
declare
  v_uid uuid := t.mkuser('checkin_server_accept');
  v_kind text;
  v_kinds text[] := array[
    'session_check_in_offered', 'session_check_in_answered', 'session_check_in_declined',
    'session_visibility_changed'
  ];
  n int;
begin
  foreach v_kind in array v_kinds loop
    perform public.append_event(v_uid, v_kind, '{}'::jsonb);
  end loop;

  select count(*)::int into n from public.activity_events
   where user_id = v_uid and kind = any(v_kinds);
  perform t.eq('3 all four new kinds are real, storable ledger rows', n, 4);

  raise notice '--- server-minted + client-minted kinds, server acceptance: complete ---';
end $test$;

-- ===== 4. client_event_id: real idempotency, not just debounce =============
do $test$
declare
  v_uid uuid := t.mkuser('idempotency_direct');
  v_id uuid := gen_random_uuid();
  v_first public.activity_events;
  v_second public.activity_events;
  n int;
begin
  v_first := public.append_event(v_uid, 'screen_opened', '{}'::jsonb, null, null, v_id);
  v_second := public.append_event(v_uid, 'screen_opened', '{}'::jsonb, null, null, v_id);

  perform t.eq('4 replaying the same client_event_id returns the SAME row id, not a new one',
    v_first.id, v_second.id);

  select count(*)::int into n from public.activity_events where client_event_id = v_id;
  perform t.eq('4b ...and really inserted exactly one row', n, 1);

  -- A DIFFERENT client_event_id is a genuinely different event.
  v_second := public.append_event(v_uid, 'screen_opened', '{}'::jsonb, null, null, gen_random_uuid());
  perform t.eq('4c a different client_event_id is a genuinely new row', v_first.id = v_second.id, false);

  -- No client_event_id at all (the server-minted default) dedupes nothing --
  -- the partial index does not cover NULLs, so two calls really are two rows.
  perform public.append_event(v_uid, 'screen_opened', '{}'::jsonb);
  perform public.append_event(v_uid, 'screen_opened', '{}'::jsonb);
  select count(*)::int into n from public.activity_events
   where user_id = v_uid and kind = 'screen_opened' and client_event_id is null;
  perform t.eq('4d two calls with no client_event_id are two ordinary rows, not deduped', n, 2);

  raise notice '--- client_event_id idempotency (append_event direct): complete ---';
end $test$;

-- ===== 5. client_event_id via record_event(), as a real client would call it
do $test$
declare
  v_uid uuid := t.mkuser('idempotency_client');
  v_id uuid := gen_random_uuid();
  v_first public.activity_events;
  v_second public.activity_events;
  n int;
begin
  set local role authenticated;
  perform set_config('request.jwt.claim.sub', v_uid::text, true);

  v_first := public.record_event('goal_created', '{}'::jsonb, v_id);
  v_second := public.record_event('goal_created', '{}'::jsonb, v_id);
  perform t.eq('5 replaying record_event() with the same client_event_id inserts exactly one row',
    v_first.id, v_second.id);

  select count(*)::int into n from public.activity_events where client_event_id = v_id;
  perform t.eq('5b ...confirmed by a direct count', n, 1);

  reset role;
  raise notice '--- client_event_id idempotency (record_event, client-facing): complete ---';
end $test$;

-- ===== 6. fresh focus_sessions rows default to not_offered, all-null =======
do $test$
declare
  v_uid uuid := t.mkuser('checkin_defaults');
  v_sess public.focus_sessions;
begin
  set local role authenticated;
  perform set_config('request.jwt.claim.sub', v_uid::text, true);
  v_sess := public.start_session(null, 1500);
  reset role;

  perform t.eq('6 a fresh session has never been offered a check-in', v_sess.check_in_state, 'not_offered');
  perform t.eq('6b ...and carries no self-report', v_sess.self_difficulty is null and v_sess.self_confidence is null and v_sess.self_help_level is null, true);

  raise notice '--- focus_sessions check-in defaults: complete ---';
end $test$;

-- ===== 7. CHECK constraints reject out-of-range/vocabulary values ==========
-- Exercised as `postgres` directly against the columns (not through the
-- RPCs, which validate the same ranges themselves with a readable error --
-- see test 9 below) -- this proves the CHECK is real structural protection,
-- not merely something the RPC happens to also enforce.
do $test$
declare
  v_uid uuid := t.mkuser('checkin_check_constraints');
  v_id uuid;
begin
  v_id := t.sess(v_uid, now() - interval '30 minutes', 1500, 'running', null);

  perform t.raises('7 self_difficulty must be between 1 and 5',
    format('update public.focus_sessions set self_difficulty = 0 where id = %L', v_id), '23514');
  perform t.raises('7b ...not above 5 either',
    format('update public.focus_sessions set self_difficulty = 6 where id = %L', v_id), '23514');
  perform t.raises('7c self_confidence must be between 1 and 5',
    format('update public.focus_sessions set self_confidence = 9 where id = %L', v_id), '23514');
  perform t.raises('7d self_help_level must be a recognised value',
    format('update public.focus_sessions set self_help_level = ''bogus'' where id = %L', v_id), '23514');
  perform t.raises('7e check_in_state must be a recognised value',
    format('update public.focus_sessions set check_in_state = ''bogus'' where id = %L', v_id), '23514');

  raise notice '--- focus_sessions CHECK constraints: complete ---';
end $test$;

-- ===== 8. settle_session() check-in eligibility -- the cadence rule ========
do $test$
declare
  v_uid uuid := t.mkuser('checkin_cadence');
  v_sess public.focus_sessions;
  v_payload jsonb;
begin
  -- Below the 600s real-focus-time floor: never offered, and (proven by the
  -- cadence below landing exactly where expected) never even COUNTED toward
  -- eligible_session_number.
  v_sess := t.settled_session(v_uid, 5, 'complete'); -- 300s real focus
  perform t.eq('8 a short session (below the 600s floor) is never offered a check-in',
    v_sess.check_in_state, 'not_offered');

  -- Three sessions clearing the floor: offered on the third, not before.
  v_sess := t.settled_session(v_uid, 20, 'complete'); -- eligible #1
  perform t.eq('8b eligible session #1 (1 mod 3) is not offered', v_sess.check_in_state, 'not_offered');

  v_sess := t.settled_session(v_uid, 20, 'complete'); -- eligible #2
  perform t.eq('8c eligible session #2 (2 mod 3) is not offered', v_sess.check_in_state, 'not_offered');

  -- Settled by ABANDON, not complete -- proves the same rule applies to
  -- both settle paths (settle_session() is the shared body either way).
  v_sess := t.settled_session(v_uid, 20, 'abandon'); -- eligible #3
  perform t.eq('8d eligible session #3 (3 mod 3 = 0) IS offered, even though it was abandoned, not completed',
    v_sess.check_in_state, 'offered_pending');

  select payload into v_payload from public.activity_events
   where session_id = v_sess.id and kind = 'session_check_in_offered';
  perform t.eq('8e session_check_in_offered carries trigger_reason', v_payload->>'trigger_reason', 'periodic_sample');
  perform t.eq('8f ...and sampling_policy', v_payload->>'sampling_policy', 'session_checkin_v1');
  perform t.eq('8g ...and prompt_version', v_payload->>'prompt_version', 'v1');
  perform t.eq('8h ...and the real eligible_session_number', (v_payload->>'eligible_session_number')::int, 3);

  -- Cadence continues correctly past the first cycle.
  v_sess := t.settled_session(v_uid, 20, 'complete'); -- eligible #4
  perform t.eq('8i eligible session #4 (4 mod 3 = 1) is not offered again', v_sess.check_in_state, 'not_offered');

  raise notice '--- settle_session() check-in eligibility cadence: complete ---';
end $test$;

-- ===== 9. answer_session_check_in(): validation + happy path ===============
do $test$
declare
  v_uid uuid := t.mkuser('checkin_answer');
  v_offered public.focus_sessions;
  v_offered2 public.focus_sessions;
  v_sess public.focus_sessions;
  v_sess2 public.focus_sessions;
  v_payload jsonb;
begin
  v_offered := t.offered_session(v_uid);
  perform t.eq('9 the fixture really is offered_pending', v_offered.check_in_state, 'offered_pending');

  set local role authenticated;
  perform set_config('request.jwt.claim.sub', v_uid::text, true);

  perform t.raises('9b answering with all three fields null is rejected -- an answer that answers nothing',
    format('select public.answer_session_check_in(%L)', v_offered.id), '22023');
  perform t.raises('9c self_difficulty below range (0) is rejected',
    format('select public.answer_session_check_in(%L, 0::smallint)', v_offered.id), '22023');
  perform t.raises('9d self_difficulty above range (6) is rejected',
    format('select public.answer_session_check_in(%L, 6::smallint)', v_offered.id), '22023');
  perform t.raises('9e self_confidence out of range is rejected',
    format('select public.answer_session_check_in(%L, null, 9::smallint)', v_offered.id), '22023');
  perform t.raises('9f an unrecognised self_help_level is rejected',
    format('select public.answer_session_check_in(%L, null, null, ''bogus'')', v_offered.id), '22023');

  -- None of the rejected attempts above actually moved the state.
  perform t.eq('9g rejected attempts leave check_in_state untouched',
    (select check_in_state from public.focus_sessions where id = v_offered.id), 'offered_pending');

  v_sess := public.answer_session_check_in(v_offered.id, 4::smallint, 2::smallint, 'hint');
  perform t.eq('9h answering sets check_in_state to answered', v_sess.check_in_state, 'answered');
  perform t.eq('9i ...and self_difficulty', v_sess.self_difficulty, 4::smallint);
  perform t.eq('9j ...and self_confidence', v_sess.self_confidence, 2::smallint);
  perform t.eq('9k ...and self_help_level', v_sess.self_help_level, 'hint');

  select payload into v_payload from public.activity_events
   where session_id = v_sess.id and kind = 'session_check_in_answered';
  perform t.eq('9l session_check_in_answered carries self_difficulty', (v_payload->>'self_difficulty')::int, 4);
  perform t.eq('9m ...and self_confidence', (v_payload->>'self_confidence')::int, 2);
  perform t.eq('9n ...and self_help_level', v_payload->>'self_help_level', 'hint');

  -- THE AUTHORITY GUARD, not a validation rule: an already-answered
  -- check-in cannot be answered again, and cannot be declined after the
  -- fact either -- the offer is spent.
  perform t.raises('9o answering an already-answered check-in is refused',
    format('select public.answer_session_check_in(%L, 3::smallint)', v_offered.id), '55006');
  perform t.raises('9p ...and so is declining it after it was answered',
    format('select public.decline_session_check_in(%L)', v_offered.id), '55006');

  -- A single field is enough to count as a real answer. t.offered_session()
  -- ends by resetting role to postgres internally, so re-establish
  -- `authenticated` before calling the RPC as the real client would.
  v_offered2 := t.offered_session(v_uid);
  set local role authenticated;
  perform set_config('request.jwt.claim.sub', v_uid::text, true);
  v_sess2 := public.answer_session_check_in(v_offered2.id, null, null, 'none');
  perform t.eq('9q a lone self_help_level (no difficulty/confidence) is a valid answer on its own',
    v_sess2.check_in_state, 'answered');

  reset role;
  raise notice '--- answer_session_check_in validation + happy path: complete ---';
end $test$;

-- ===== 10. decline_session_check_in(): happy path + can't re-answer =======
do $test$
declare
  v_uid uuid := t.mkuser('checkin_decline');
  v_offered public.focus_sessions;
  v_sess public.focus_sessions;
  n int;
begin
  v_offered := t.offered_session(v_uid);

  set local role authenticated;
  perform set_config('request.jwt.claim.sub', v_uid::text, true);

  v_sess := public.decline_session_check_in(v_offered.id);
  perform t.eq('10 declining sets check_in_state to declined', v_sess.check_in_state, 'declined');
  perform t.eq('10b ...and leaves the self-report columns untouched (still null)',
    v_sess.self_difficulty is null and v_sess.self_confidence is null and v_sess.self_help_level is null, true);

  select count(*)::int into n from public.activity_events
   where session_id = v_sess.id and kind = 'session_check_in_declined';
  perform t.eq('10c session_check_in_declined was minted exactly once', n, 1);

  -- A decline also spends the offer -- cannot then answer it either.
  perform t.raises('10d cannot answer a check-in that was already declined',
    format('select public.answer_session_check_in(%L, 3::smallint)', v_offered.id), '55006');

  reset role;
  raise notice '--- decline_session_check_in: complete ---';
end $test$;

-- ===== 11. a client cannot manufacture a self-report on a never-offered session
do $test$
declare
  v_uid uuid := t.mkuser('checkin_never_offered');
  v_sess public.focus_sessions;
begin
  -- One ordinary short session -- settled, but never eligible, so
  -- check_in_state stays 'not_offered'.
  v_sess := t.settled_session(v_uid, 2, 'complete');
  perform t.eq('11 fixture is genuinely not_offered', v_sess.check_in_state, 'not_offered');

  set local role authenticated;
  perform set_config('request.jwt.claim.sub', v_uid::text, true);

  perform t.raises('11b a client cannot answer a check-in that was never offered',
    format('select public.answer_session_check_in(%L, 3::smallint)', v_sess.id), '55006');
  perform t.raises('11c ...nor decline one that was never offered',
    format('select public.decline_session_check_in(%L)', v_sess.id), '55006');

  reset role;
  raise notice '--- no self-report without a real offer: complete ---';
end $test$;

-- ===== 12. cross-user isolation =============================================
do $test$
declare
  v_alice uuid := t.mkuser('checkin_alice');
  v_bob uuid := t.mkuser('checkin_bob');
  v_offered public.focus_sessions;
begin
  v_offered := t.offered_session(v_alice);

  set local role authenticated;
  perform set_config('request.jwt.claim.sub', v_bob::text, true);

  perform t.raises(
    '12 bob cannot answer alice''s check-in (and the error does not confirm it exists)',
    format('select public.answer_session_check_in(%L, 3::smallint)', v_offered.id), '42501');
  perform t.raises(
    '12b ...nor decline it',
    format('select public.decline_session_check_in(%L)', v_offered.id), '42501');

  reset role;

  perform t.eq('12c alice''s check-in is genuinely untouched',
    (select check_in_state from public.focus_sessions where id = v_offered.id), 'offered_pending');
  perform t.eq('12d ...and the ledger recorded nothing under bob',
    (select count(*)::int from public.activity_events
      where user_id = v_bob and kind in ('session_check_in_answered', 'session_check_in_declined')), 0);

  raise notice '--- answer/decline cross-user isolation: complete ---';
end $test$;

-- ===== 13. focus_sessions stays SELECT-only -- the new columns are not a
--           back door around the RPCs =======================================
do $test$
declare
  v_uid uuid := t.mkuser('checkin_no_direct_write');
  v_sess public.focus_sessions;
begin
  set local role authenticated;
  perform set_config('request.jwt.claim.sub', v_uid::text, true);
  v_sess := public.start_session(null, 1500);

  perform t.raises('13 a client cannot UPDATE check_in_state directly (focus_sessions stays SELECT-only, 0001)',
    format('update public.focus_sessions set check_in_state = ''answered'' where id = %L', v_sess.id), '42501');
  perform t.raises('13b ...nor self_difficulty',
    format('update public.focus_sessions set self_difficulty = 3 where id = %L', v_sess.id), '42501');

  reset role;
  raise notice '--- focus_sessions SELECT-only holds for the new columns too: complete ---';
end $test$;
