\set ON_ERROR_STOP on
\pset pager off
set client_min_messages = notice;
set timezone = 'UTC';

do $test$
declare
  u1 uuid := (select id from auth.users where email = 'alice@test.local');
  u2 uuid := (select id from auth.users where email = 'bob@test.local');
  u3 uuid;
  d1 date := date '2026-03-10';
  d2 date := date '2026-03-11';
  d3 date := date '2026-03-12';
  n int; n2 int;
  c1 timestamptz; c2 timestamptz;
  before_json jsonb; after_json jsonb;
begin
  -- ===== 12. idempotency: same numbers, fresh computed_at =================
  select jsonb_agg(x order by x->>'date', x->>'user_id') into before_json
    from (select to_jsonb(r) - 'computed_at' - 'id' as x from public.daily_rollups r) s;
  select max(computed_at) into c1 from public.daily_rollups;
  perform pg_sleep(0.05);
  n := public.recompute_daily_rollups(d1, d3, 'UTC');
  select jsonb_agg(x order by x->>'date', x->>'user_id') into after_json
    from (select to_jsonb(r) - 'computed_at' - 'id' as x from public.daily_rollups r) s;
  select min(computed_at) into c2 from public.daily_rollups;
  perform t.eq('12 rerun is byte-identical apart from computed_at', after_json, before_json);
  perform t.eq('12 computed_at is bumped on every row even when unchanged', c2 > c1, true);
  perform t.eq('12 no duplicate rows appeared (NULLS NOT DISTINCT conflict target)',
               (select count(*)::int from public.daily_rollups
                 where (user_id, date, room_id) in
                   (select user_id, date, room_id from public.daily_rollups
                    group by 1,2,3 having count(*) > 1)), 0);

  -- ===== 13. it is a REPLACE, not an increment ============================
  -- A late correction must be able to move a number DOWN. This is the one
  -- behaviour an incrementing trigger could not have.
  perform t.eq('13 precondition: alice/d1 blocks_done', (select blocks_done from t.roll(u1, d1)), 2);
  perform t.ev(u1, 'task_regressed', d1 + time '23:00', 'blk-a');
  perform t.ev(u1, 'task_regressed', d1 + time '23:01', 'blk-b');
  perform public.recompute_daily_rollups(d1, d3, 'UTC');
  perform t.eq('13 a later correction lowers a past count', (select blocks_done from t.roll(u1, d1)), 0);

  -- ===== 14. timezone bucketing ==========================================
  u3 := t.mkuser('carol');
  -- 2026-03-12 02:00 UTC is still 2026-03-11 18:00 in Los Angeles.
  perform t.ev(u3, 'task_completed', timestamptz '2026-03-12 02:00+00', 'blk-tz');
  perform public.recompute_daily_rollups(d1, d3, 'UTC');
  perform t.eq('14 UTC buckets the event on 2026-03-12',
               (select blocks_done from t.roll(u3, d3)), 1);

  -- Same event, LA bucketing. Note this run rewrites EVERY user's rows in the
  -- window under LA dates -- see the mixed-zone assertion below, which is the
  -- point of doing it here rather than in isolation.
  perform public.recompute_daily_rollups(d1, d3, 'America/Los_Angeles');
  perform t.eq('14 America/Los_Angeles buckets the same event on 2026-03-11',
               (select blocks_done from t.roll(u3, d2)), 1);

  -- 14b. THE HAZARD, pinned deliberately: p_timezone is a property of the
  -- whole TABLE, not of one call. Carol has exactly one task_completed event,
  -- and it buckets to 2026-03-12 under UTC and to 2026-03-11 under LA. The
  -- second run does not move the first run's row -- nothing deletes rows
  -- whose source data left the bucket -- so the one event now stands counted
  -- on two different days at once. That is why 0010 pins the zone for the
  -- scheduled job instead of accepting one per invocation, and why changing
  -- the zone later is a delete-then-backfill, not just a parameter change.
  perform t.eq('14b the same event is now counted on two days at once',
               (select count(*)::int from public.daily_rollups where user_id = u3), 2);
  perform t.eq('14b ...the first run''s row is not cleaned up',
               (select blocks_done from t.roll(u3, d3)), 1);

  -- Restore canonical UTC state for the rest of the suite.
  delete from public.daily_rollups;
  delete from public.activity_events where user_id = u3;
  delete from auth.users where id = u3;
  perform public.recompute_daily_rollups(d1, d3, 'UTC');
  perform t.eq('14 restored: a full UTC recompute rebuilds the window exactly',
               (select focus_seconds from t.roll(u2, d2)), 1500);

  -- ===== 15. multi-user isolation ========================================
  perform t.eq('15 alice and bob get separate rows',
               (select count(distinct user_id)::int from public.daily_rollups), 2);
  perform t.eq('15 bob d2 is bob-only', (select focus_seconds from t.roll(u2, d2)), 1500);

  -- ===== 16. window bounds ================================================
  -- Recomputing a narrow window must not touch rows outside it.
  select computed_at into c1 from public.daily_rollups where user_id = u2 and date = d1;
  perform pg_sleep(0.05);
  n := public.recompute_daily_rollups(d3, d3, 'UTC');
  select computed_at into c2 from public.daily_rollups where user_id = u2 and date = d1;
  perform t.eq('16 a row outside the window is left completely alone', c2, c1);
  perform t.eq('16 the narrow run only wrote in-window rows', n,
               (select count(*)::int from public.daily_rollups where date = d3));

  -- ===== 17. default window is the last three days, in the given zone =====
  u3 := t.mkuser('dave');
  perform t.ev(u3, 'task_completed', now() - interval '1 hour', 'blk-today');
  perform t.ev(u3, 'task_completed', now() - interval '2 days',  'blk-2d');
  perform t.ev(u3, 'task_completed', now() - interval '9 days',  'blk-9d');
  perform public.recompute_daily_rollups();   -- all defaults
  perform t.eq('17 default window picks up today',
               (select blocks_done from t.roll(u3, (now() at time zone 'UTC')::date)), 1);
  perform t.eq('17 default window reaches back two days',
               (select blocks_done from t.roll(u3, (now() at time zone 'UTC')::date - 2)), 1);
  perform t.eq('17 default window does not reach nine days back',
               (select count(*)::int from t.roll(u3, (now() at time zone 'UTC')::date - 9)), 0);
  -- ...and an explicit backfill does reach it.
  perform public.recompute_daily_rollups((now() at time zone 'UTC')::date - 30,
                                         (now() at time zone 'UTC')::date, 'UTC');
  perform t.eq('17 an explicit backfill window reaches the old day',
               (select blocks_done from t.roll(u3, (now() at time zone 'UTC')::date - 9)), 1);

  -- ===== 18. return value counts rows written ============================
  n := public.recompute_daily_rollups(d1, d1, 'UTC');
  perform t.eq('18 return value equals rows written for that window', n,
               (select count(*)::int from public.daily_rollups where date = d1));

  -- ===== 19. argument validation ==========================================
  begin
    perform public.recompute_daily_rollups(d3, d1, 'UTC');
    raise exception 'FAIL 19 reversed window was accepted';
  exception when sqlstate '22023' then
    raise notice 'PASS  19 p_from after p_to is rejected (22023)';
  end;
  begin
    perform public.recompute_daily_rollups(d1, d3, 'Mars/Olympus_Mons');
    raise exception 'FAIL 19 unknown time zone was accepted';
  exception when sqlstate '22023' then
    raise notice 'PASS  19 unknown time zone is rejected (22023)';
  end;
  begin
    perform public.recompute_daily_rollups(d1, d3, null);
    raise exception 'FAIL 19 null time zone was accepted';
  exception when sqlstate '22023' then
    raise notice 'PASS  19 null time zone is rejected (22023)';
  end;

  -- ===== 20. table constraints still hold on everything written ==========
  perform t.eq('20 no negative counters were written',
               (select count(*)::int from public.daily_rollups
                where blocks_done < 0 or focus_seconds < 0 or sessions_completed < 0), 0);
  perform t.eq('20 every written row has a room_id of null (fenced until W4a)',
               (select count(*)::int from public.daily_rollups where room_id is not null), 0);

  raise notice '--- part 2 complete ---';
end
$test$;
