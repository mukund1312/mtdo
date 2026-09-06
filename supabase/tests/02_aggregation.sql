\set ON_ERROR_STOP on
\pset pager off
set client_min_messages = notice;
set timezone = 'UTC';

do $test$
declare
  u1 uuid; u2 uuid;
  d1 date := date '2026-03-10';
  d2 date := date '2026-03-11';
  d3 date := date '2026-03-12';
  n int; n2 int;
  c1 timestamptz; c2 timestamptz;
  r record;
begin
  u1 := t.mkuser('alice');
  u2 := t.mkuser('bob');

  -- ===== 1. empty database =================================================
  n := public.recompute_daily_rollups(d1, d3, 'UTC');
  perform t.eq('01 empty window writes no rows', n, 0);
  perform t.eq('01 no rollups exist', (select count(*)::int from public.daily_rollups), 0);

  -- ===== 2. basic day: two blocks + one completed session ==================
  perform t.ev(u1, 'task_completed', d1 + time '09:00', 'blk-a');
  perform t.ev(u1, 'task_completed', d1 + time '11:00', 'blk-b');
  perform t.sess(u1, d1 + time '10:00', 1500, 'completed', d1 + time '10:25');
  n := public.recompute_daily_rollups(d1, d3, 'UTC');
  perform t.eq('02 wrote one rollup row', n, 1);
  select * into r from t.roll(u1, d1);
  perform t.eq('02 blocks_done', r.blocks_done, 2);
  perform t.eq('02 focus_seconds', r.focus_seconds, 1500);
  perform t.eq('02 sessions_completed', r.sessions_completed, 1);

  -- ===== 3. same block completed repeatedly counts once ====================
  perform t.ev(u1, 'task_completed', d1 + time '11:05', 'blk-b');
  perform t.ev(u1, 'task_completed', d1 + time '11:06', 'blk-b');
  perform public.recompute_daily_rollups(d1, d3, 'UTC');
  perform t.eq('03 duplicate completions of one block count once',
               (select blocks_done from t.roll(u1, d1)), 2);

  -- ===== 4. complete then regress the same block, same day => 0 ============
  perform t.ev(u1, 'task_regressed', d1 + time '12:00', 'blk-b');
  perform public.recompute_daily_rollups(d1, d3, 'UTC');
  perform t.eq('04 same-day regression cancels that block',
               (select blocks_done from t.roll(u1, d1)), 1);

  -- ...and re-completing after the regression brings it back (last wins)
  perform t.ev(u1, 'task_completed', d1 + time '13:00', 'blk-b');
  perform public.recompute_daily_rollups(d1, d3, 'UTC');
  perform t.eq('04 last event of the day wins',
               (select blocks_done from t.roll(u1, d1)), 2);

  -- ===== 5. a regression the NEXT day leaves the earlier day alone =========
  perform t.ev(u1, 'task_regressed', d2 + time '09:00', 'blk-a');
  perform public.recompute_daily_rollups(d1, d3, 'UTC');
  perform t.eq('05 earlier day unchanged by later regression',
               (select blocks_done from t.roll(u1, d1)), 2);
  perform t.eq('05 the regression day itself is zero',
               (select blocks_done from t.roll(u1, d2)), 0);

  -- ===== 6. events with no block_id are each their own unit ================
  perform t.ev(u2, 'task_completed', d1 + time '09:00', null);
  perform t.ev(u2, 'task_completed', d1 + time '09:01', null);
  perform public.recompute_daily_rollups(d1, d3, 'UTC');
  perform t.eq('06 block_id-less completions do not collapse together',
               (select blocks_done from t.roll(u2, d1)), 2);

  -- 6b. ...and an empty-string block_id takes the same path as a missing one.
  perform t.ev(u2, 'task_completed', d1 + time '09:02', '');
  perform t.ev(u2, 'task_completed', d1 + time '09:03', '');
  perform public.recompute_daily_rollups(d1, d3, 'UTC');
  perform t.eq('06b empty-string block_id does not collapse events together',
               (select blocks_done from t.roll(u2, d1)), 4);

  -- ===== 7. elapsed capped at planned =====================================
  -- 9 hours of wall clock on a 25-minute block: the tab stayed open.
  perform t.sess(u2, d2 + time '10:00', 1500, 'completed', d2 + time '19:00');
  perform public.recompute_daily_rollups(d1, d3, 'UTC');
  perform t.eq('07 overlong session capped at planned_duration_s',
               (select focus_seconds from t.roll(u2, d2)), 1500);

  -- ===== 8. abandoned counts focus time, not a completion =================
  perform t.sess(u2, d3 + time '08:00', 1500, 'abandoned', d3 + time '08:10');
  perform public.recompute_daily_rollups(d1, d3, 'UTC');
  perform t.eq('08 abandoned session contributes its real elapsed time',
               (select focus_seconds from t.roll(u2, d3)), 600);
  perform t.eq('08 abandoned session is not a completed session',
               (select sessions_completed from t.roll(u2, d3)), 0);

  -- ===== 9. a still-running session contributes nothing ===================
  perform t.sess(u1, d3 + time '07:00', 1500, 'running', null);
  perform public.recompute_daily_rollups(d1, d3, 'UTC');
  perform t.eq('09 running session produces no rollup row for that day',
               (select count(*)::int from t.roll(u1, d3)), 0);

  -- ===== 10. midnight-spanning session lands on the START day =============
  perform t.sess(u1, d2 + time '23:50', 3600, 'completed', d3 + time '00:20');
  perform public.recompute_daily_rollups(d1, d3, 'UTC');
  perform t.eq('10 cross-midnight session attributed to the start day',
               (select focus_seconds from t.roll(u1, d2)), 1800);
  perform t.eq('10 ...and not to the settle day',
               (select count(*)::int from t.roll(u1, d3)), 0);

  -- ===== 11. overnight ghost session settled the next day =================
  -- start_session()'s 55006 recovery contract: user closes the tab, comes
  -- back tomorrow, UI abandons the stale session before starting a new one.
  perform t.sess(u2, d1 + time '22:00', 1500, 'abandoned', d2 + time '09:30');
  perform public.recompute_daily_rollups(d1, d3, 'UTC');
  perform t.eq('11 ghost session credited to the day it was started',
               (select focus_seconds from t.roll(u2, d1)), 1500);

  raise notice '--- part 1 complete ---';
end
$test$;
