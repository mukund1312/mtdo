\set ON_ERROR_STOP on
\pset pager off

-- ---------------------------------------------------------------------------
-- Test harness. Fixtures are written with direct INSERTs as `postgres`, not
-- through record_event()/start_session(), because those stamp occurred_at and
-- started_at from now() by design -- which is exactly what makes them
-- trustworthy in production and useless for constructing a multi-day history.
-- What is under test here is the aggregation, not the append path.
-- ---------------------------------------------------------------------------
create schema if not exists t;

create or replace function t.eq(label text, got anyelement, want anyelement)
returns void language plpgsql as $$
begin
  if got is not distinct from want then
    raise notice 'PASS  %  (= %)', label, coalesce(got::text, 'NULL');
  else
    raise exception 'FAIL  %  got=% want=%', label, coalesce(got::text,'NULL'), coalesce(want::text,'NULL');
  end if;
end $$;

create or replace function t.raises(label text, sql text, want_code text)
returns void language plpgsql as $$
begin
  execute sql;
  raise exception 'FAIL  %  expected errcode % but the statement succeeded', label, want_code;
exception
  -- The catchable list, and why it is a list rather than `when others`.
  -- `others` would also swallow the FAIL exception raised just above when a
  -- statement unexpectedly SUCCEEDS, turning a clear "expected an error, got
  -- none" into a confusing errcode mismatch on P0001. So each class a test
  -- may legitimately assert on is named explicitly.
  --
  -- 23505/23514/23503 (unique, check, foreign-key violation) added 2026-09-13
  -- for 16_music_connections.sql. Before that the list was privileges-only,
  -- so a constraint assertion did not fail -- it ESCAPED the handler and
  -- aborted the whole run with a raw ERROR, which is exactly how this was
  -- found. Adding a class here can only turn an aborted run into a real
  -- PASS/FAIL; no existing assertion changes meaning.
  when sqlstate '42501' or sqlstate '22023' or sqlstate '0A000'
    or sqlstate '23505' or sqlstate '23514' or sqlstate '23503' then
    if sqlstate = want_code then
      raise notice 'PASS  %  (errcode %)', label, want_code;
    else
      raise exception 'FAIL  %  got errcode % want %', label, sqlstate, want_code;
    end if;
end $$;

-- Convenience: the rollup row for a user/day, or nulls if absent.
create or replace function t.roll(p_user uuid, p_day date)
returns table (blocks_done int, focus_seconds int, sessions_completed int)
language sql stable as $$
  select r.blocks_done, r.focus_seconds, r.sessions_completed
  from public.daily_rollups r
  where r.user_id = p_user and r.date = p_day and r.room_id is null
$$;

-- Fixture helpers -----------------------------------------------------------
create or replace function t.mkuser(tag text) returns uuid
language plpgsql as $$
declare v uuid;
begin
  -- 0001's on_auth_user_created trigger creates the profiles row.
  insert into auth.users (email, raw_user_meta_data)
  values (tag || '@test.local', jsonb_build_object('display_name', tag))
  returning id into v;
  return v;
end $$;

create or replace function t.ev(p_user uuid, p_kind text, p_at timestamptz, p_block text default null)
returns void language sql as $$
  insert into public.activity_events (user_id, kind, occurred_at, payload)
  values (p_user, p_kind, p_at,
          case when p_block is null then '{}'::jsonb
               else jsonb_build_object('block_id', p_block) end);
$$;

create or replace function t.sess(
  p_user uuid, p_start timestamptz, p_planned int, p_state text, p_end timestamptz
) returns uuid language plpgsql as $$
declare v uuid;
begin
  insert into public.focus_sessions (user_id, started_at, planned_duration_s, state, completed_at)
  values (p_user, p_start, p_planned, p_state, p_end)
  returning id into v;
  return v;
end $$;

-- The assertion helpers get called from inside `set local role` blocks, so
-- every role the suite impersonates needs to reach them. Test-only schema.
grant usage on schema t to anon, authenticated, service_role;
grant execute on all functions in schema t to anon, authenticated, service_role;
