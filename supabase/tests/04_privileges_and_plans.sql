\set ON_ERROR_STOP on
\pset pager off
set client_min_messages = notice;
set timezone = 'UTC';

do $test$
declare
  u1 uuid := (select id from auth.users where email = 'alice@test.local');
  u2 uuid := (select id from auth.users where email = 'bob@test.local');
  n int;
begin
  -- ===== 21. EXECUTE is service-role only ================================
  -- The interesting half is anon/authenticated: Supabase's default privileges
  -- grant them EXECUTE on every new public function, so `revoke ... from
  -- public` alone would have left this callable by any client with the anon
  -- key (0001's security-model header, consequence 2).
  set local role authenticated;
  begin
    perform public.recompute_daily_rollups();
    raise exception 'FAIL 21 authenticated could execute the job';
  exception when insufficient_privilege then
    raise notice 'PASS  21 authenticated cannot execute recompute_daily_rollups (42501)';
  end;
  reset role;

  set local role anon;
  begin
    perform public.recompute_daily_rollups();
    raise exception 'FAIL 21 anon could execute the job';
  exception when insufficient_privilege then
    raise notice 'PASS  21 anon cannot execute recompute_daily_rollups (42501)';
  end;
  reset role;

  set local role service_role;
  n := public.recompute_daily_rollups(date '2026-03-10', date '2026-03-12', 'UTC');
  perform t.eq('21 service_role can execute it', n > 0, true);
  reset role;

  -- ===== 22. the table stays read-only to clients ========================
  set local role authenticated;
  perform set_config('request.jwt.claim.sub', u1::text, true);
  begin
    insert into public.daily_rollups (user_id, date, blocks_done) values (u1, date '2026-03-10', 999);
    raise exception 'FAIL 22 authenticated could insert a rollup';
  exception when insufficient_privilege then
    raise notice 'PASS  22 authenticated cannot INSERT into daily_rollups (42501)';
  end;
  begin
    update public.daily_rollups set blocks_done = 999 where user_id = u1;
    raise exception 'FAIL 22 authenticated could update a rollup';
  exception when insufficient_privilege then
    raise notice 'PASS  22 authenticated cannot UPDATE daily_rollups (42501)';
  end;
  begin
    delete from public.daily_rollups where user_id = u1;
    raise exception 'FAIL 22 authenticated could delete a rollup';
  exception when insufficient_privilege then
    raise notice 'PASS  22 authenticated cannot DELETE from daily_rollups (42501)';
  end;

  -- ===== 23. RLS still scopes reads to the caller ========================
  perform t.eq('23 alice reads only her own rollups',
               (select count(distinct user_id)::int from public.daily_rollups), 1);
  perform t.eq('23 ...and that user is alice',
               (select distinct user_id from public.daily_rollups), u1);
  perform t.eq('23 alice cannot see bob''s rows the job just wrote',
               (select count(*)::int from public.daily_rollups where user_id = u2), 0);
  reset role;
  -- Same query, no RLS in the way: the rows alice could not see are there.
  perform t.eq('23 postgres still sees bob''s rows through the same query',
               (select count(*)::int from public.daily_rollups where user_id = u2) > 0, true);

  -- ===== 24. function definition matches the house rules =================
  perform t.eq('24 security definer',
    (select p.prosecdef from pg_proc p join pg_namespace nsp on nsp.oid = p.pronamespace
      where nsp.nspname='public' and p.proname='recompute_daily_rollups'), true);
  perform t.eq('24 owned by postgres',
    (select pg_get_userbyid(p.proowner) from pg_proc p join pg_namespace nsp on nsp.oid = p.pronamespace
      where nsp.nspname='public' and p.proname='recompute_daily_rollups'), 'postgres');
  perform t.eq('24 search_path pinned empty',
    (select p.proconfig from pg_proc p join pg_namespace nsp on nsp.oid = p.pronamespace
      where nsp.nspname='public' and p.proname='recompute_daily_rollups'),
    array['search_path=""']::text[]);

  raise notice '--- part 3 complete ---';
end
$test$;

-- ===== 25/26. plan shape and locking =====================================
do $test$
declare
  plan text;
  held int;
  ln text;
begin
  -- 25. The whole reason 0009 converts the local-date range to timestamptz
  -- bounds instead of writing `(occurred_at at time zone tz)::date between
  -- ...`: a function call wrapped around the indexed column is not sargable,
  -- and the job's entire cost is these two window scans. With seqscan off the
  -- planner must still be ABLE to reach the index; if the predicate were the
  -- non-sargable form it would fall back to a full scan even here.
  set local enable_seqscan = off;

  plan := '';
  for ln in execute $q$
    explain (format text)
    select 1 from public.activity_events
    where kind in ('task_completed','task_regressed')
      and occurred_at >= timestamptz '2026-03-10 00:00+00'
      and occurred_at <  timestamptz '2026-03-13 00:00+00'
  $q$ loop plan := plan || ln || E'\n'; end loop;
  perform t.eq('25 activity_events window becomes an Index Cond on occurred_at',
               plan like '%activity_events_occurred_idx%'
               and plan like '%Index Cond:%occurred_at >=%', true);

  plan := '';
  for ln in execute $q$
    explain (format text)
    select 1 from public.focus_sessions
    where state in ('completed','abandoned')
      and started_at >= timestamptz '2026-03-10 00:00+00'
      and started_at <  timestamptz '2026-03-13 00:00+00'
  $q$ loop plan := plan || ln || E'\n'; end loop;
  perform t.eq('25 focus_sessions window becomes an Index Cond on started_at',
               plan like '%focus_sessions_started_idx%'
               and plan like '%Index Cond:%started_at >=%', true);

  -- Contrast: the non-sargable form 0009 deliberately avoids. It still
  -- *touches* the index -- with seqscan off the planner will happily read the
  -- whole thing -- but the range never becomes an Index Cond, so it degrades
  -- to a full index scan plus a Filter that has to evaluate the timezone cast
  -- on every ledger row ever written. That is the difference this test pins.
  plan := '';
  for ln in execute $q$
    explain (format text)
    select 1 from public.activity_events
    where (occurred_at at time zone 'UTC')::date between date '2026-03-10' and date '2026-03-12'
  $q$ loop plan := plan || ln || E'\n'; end loop;
  perform t.eq('25 ...the date-cast form degrades to a Filter with no Index Cond',
               plan like '%Index Cond:%', false);
  perform t.eq('25 ...and evaluates the timezone cast per row instead',
               plan like '%Filter:%AT TIME ZONE%', true);

  reset enable_seqscan;

  -- 26. A DO block is one transaction, so the xact-scoped advisory lock taken
  -- inside the function is still held here.
  perform public.recompute_daily_rollups(date '2026-03-10', date '2026-03-12', 'UTC');
  select count(*)::int into held from pg_locks
    where locktype = 'advisory' and pid = pg_backend_pid();
  perform t.eq('26 a transaction-scoped advisory lock is held during the run', held, 1);

  raise notice '--- part 4 complete ---';
end
$test$;

-- The DO block above committed, so the xact-scoped lock is gone.
do $$
declare held int;
begin
  select count(*)::int into held from pg_locks
    where locktype = 'advisory' and pid = pg_backend_pid();
  perform t.eq('26 ...and released when that transaction ends', held, 0);
end $$;
