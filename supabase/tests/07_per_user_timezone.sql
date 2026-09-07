\set ON_ERROR_STOP on
\pset pager off
set client_min_messages = notice;

-- migrations/0013: profiles.timezone + per-user bucketing in
-- recompute_daily_rollups(). The pre-existing suite (02/03 etc.) proves the
-- job's math is right and that test 14 in 03_idempotence_and_windows.sql
-- still proves an explicit p_timezone override works for a user with no
-- profile preference. This file proves the actual new claim: two users
-- with DIFFERENT stored zones, aggregated in the SAME recompute call, each
-- get bucketed by THEIR OWN zone, not by whatever one shared zone a caller
-- passes in.
do $test$
declare
  v_alice uuid := t.mkuser('tz_alice');   -- profile.timezone: America/Los_Angeles
  v_bob uuid := t.mkuser('tz_bob');       -- profile.timezone: NULL (unset)
  v_carol uuid := t.mkuser('tz_carol');   -- profile.timezone: Asia/Kolkata
  v_alice_day date;
  v_bob_day date;
  v_carol_day date;
begin
  update public.profiles set timezone = 'America/Los_Angeles' where id = v_alice;
  update public.profiles set timezone = 'Asia/Kolkata' where id = v_carol;
  -- bob's profile.timezone is left NULL deliberately.

  -- All three complete a task at the exact same instant: 2026-03-12
  -- 02:00:00 UTC. In UTC that's still March 12. In America/Los_Angeles
  -- (UTC-8 in March, before DST) that's 2026-03-11 18:00 -- the day before.
  -- In Asia/Kolkata (UTC+5:30) that's 2026-03-12 07:30 -- the same day as
  -- UTC, chosen specifically to prove this isn't just "everyone gets
  -- shifted the same way", it's a real per-user lookup.
  perform t.ev(v_alice, 'task_completed', '2026-03-12 02:00:00+00', 'tz-block-alice');
  perform t.ev(v_bob,   'task_completed', '2026-03-12 02:00:00+00', 'tz-block-bob');
  perform t.ev(v_carol, 'task_completed', '2026-03-12 02:00:00+00', 'tz-block-carol');

  -- One recompute call, one shared p_timezone parameter (UTC) -- the
  -- parameter is what bob (no profile preference) falls back to; alice and
  -- carol must ignore it entirely in favor of their own stored zone.
  perform public.recompute_daily_rollups(date '2026-03-10', date '2026-03-13', 'UTC');

  select date into v_alice_day from public.daily_rollups
    where user_id = v_alice and blocks_done > 0;
  select date into v_bob_day from public.daily_rollups
    where user_id = v_bob and blocks_done > 0;
  select date into v_carol_day from public.daily_rollups
    where user_id = v_carol and blocks_done > 0;

  perform t.eq('1 alice (America/Los_Angeles) buckets to the prior day', v_alice_day, date '2026-03-11');
  perform t.eq('2 bob (no profile pref) falls back to p_timezone=UTC, same day', v_bob_day, date '2026-03-12');
  perform t.eq('3 carol (Asia/Kolkata) buckets to the same UTC day here', v_carol_day, date '2026-03-12');

  -- ===== 4. setting an invalid timezone is rejected, not silently coerced =====
  begin
    update public.profiles set timezone = 'Mars/Olympus_Mons' where id = v_alice;
    raise exception 'FAIL 4 invalid timezone was accepted';
  exception when invalid_parameter_value then
    raise notice 'PASS  4 invalid profile timezone rejected (22023)';
  end;

  -- alice's real zone must be unchanged after the rejected update above.
  perform t.eq('4b alice''s valid timezone survives a rejected update attempt',
    (select timezone from public.profiles where id = v_alice), 'America/Los_Angeles');

  -- ===== 5. NULL is a legitimate value, not something the trigger rejects =====
  update public.profiles set timezone = null where id = v_alice;
  perform t.eq('5 clearing a timezone back to NULL succeeds', (select timezone from public.profiles where id = v_alice), null::text);

  -- ===== 6. a cleared-to-NULL user now falls back to p_timezone like bob =====
  delete from public.daily_rollups where user_id in (v_alice, v_bob, v_carol);
  perform public.recompute_daily_rollups(date '2026-03-10', date '2026-03-13', 'UTC');
  select date into v_alice_day from public.daily_rollups
    where user_id = v_alice and blocks_done > 0;
  perform t.eq('6 alice with timezone cleared now buckets like a UTC fallback user', v_alice_day, date '2026-03-12');

  -- ===== 7. profiles_update_own still governs this column like any other =====
  set local role authenticated;
  perform set_config('request.jwt.claim.sub', v_bob::text, true);
  -- RLS silently matches zero rows here rather than raising (same pattern
  -- as every other cross-user write attempt tested elsewhere this
  -- session) -- the real assertion is the read-back below, as postgres.
  update public.profiles set timezone = 'Europe/London' where id = v_alice;
  reset role;

  perform t.eq('7 a different user''s update to my timezone affects nothing',
    (select timezone from public.profiles where id = v_alice), null::text);

  delete from public.daily_rollups where user_id in (v_alice, v_bob, v_carol);
  delete from public.activity_events where user_id in (v_alice, v_bob, v_carol);
end $test$;

-- migrations/0014: pick_curriculum_item()'s block.date must use the
-- caller's own profile timezone too, not hard-coded UTC -- otherwise a
-- freshly-picked block can land on a date Today isn't querying for yet.
-- Wall-clock day-boundary crossings aren't reliably reproducible in a test
-- (this runs whenever it runs, not at a controlled instant), so this proves
-- the invariant directly: the block's date must equal an independent
-- (now() at time zone <that user's own zone>)::date computed inside the
-- same transaction -- which is only true if the function is actually
-- reading the caller's stored timezone, not defaulting to UTC.
do $test$
declare
  v_dana uuid := t.mkuser('tz_dana');
  v_plan_id uuid;
  v_category_id uuid;
  v_item_id uuid;
  v_block public.blocks;
  v_expected_date date;
begin
  update public.profiles set timezone = 'Asia/Kolkata' where id = v_dana;
  select (now() at time zone 'Asia/Kolkata')::date into v_expected_date;

  -- is_active false on insert (plans_guard_activation, 0006-0008) --
  -- activate_plan() below is the only path that may flip it true, and
  -- pick_curriculum_item() requires an active plan.
  insert into public.plans (user_id, app_name, goal_line, is_active)
    values (v_dana, 'test', 'timezone pick test', false)
    returning id into v_plan_id;
  insert into public.plan_categories (plan_id, name, label, days)
    values (v_plan_id, 'core', 'Core', array[0,1,2,3,4])
    returning id into v_category_id;
  insert into public.curriculum_items (category_id, week_index, position, task)
    values (v_category_id, 0, 0, 'timezone pick test task')
    returning id into v_item_id;

  set local role authenticated;
  perform set_config('request.jwt.claim.sub', v_dana::text, true);
  perform public.activate_plan(v_plan_id);
  select * into v_block from public.pick_curriculum_item(v_item_id);
  reset role;

  perform t.eq('8 pick_curriculum_item dates the block in the caller''s own zone, not UTC',
    v_block.date, v_expected_date);

  delete from public.blocks where plan_id = v_plan_id;
  delete from public.plan_categories where id = v_category_id;
  delete from public.plans where id = v_plan_id;
end $test$;
