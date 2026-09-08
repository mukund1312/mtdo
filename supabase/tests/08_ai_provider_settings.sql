\set ON_ERROR_STOP on
\pset pager off
set client_min_messages = notice;

-- migrations/0015: ai_provider_settings (ordinary client-writable, same
-- posture as profiles) and ai_generations (append-only audit trail,
-- service-role insert + select-own, same posture as activity_events). Two
-- new tables, so the same live two-user cross-isolation test the
-- 2026-09-07 audit already ran against every other table -- gold standard,
-- not something to skip just because these are settings/audit tables
-- rather than domain data.
do $test$
declare
  v_alice uuid := t.mkuser('ai_alice');
  v_bob uuid := t.mkuser('ai_bob');
  v_gen_id uuid;
begin
  -- ===== ai_provider_settings: alice can manage her own row ===============
  set local role authenticated;
  perform set_config('request.jwt.claim.sub', v_alice::text, true);

  insert into public.ai_provider_settings (user_id, provider) values (v_alice, 'ollama');
  perform t.eq('1 alice can insert her own settings row',
    (select provider from public.ai_provider_settings where user_id = v_alice), 'ollama');

  update public.ai_provider_settings set endpoint = 'http://localhost:11434' where user_id = v_alice;
  perform t.eq('2 alice can update her own row',
    (select endpoint from public.ai_provider_settings where user_id = v_alice), 'http://localhost:11434');

  -- ===== ai_provider_settings: alice cannot touch bob's row ================
  begin
    insert into public.ai_provider_settings (user_id, provider) values (v_bob, 'ollama');
    raise exception 'FAIL 3 alice inserted a settings row for bob';
  exception when insufficient_privilege then
    raise notice 'PASS  3 alice cannot insert a settings row for bob (42501)';
  end;

  set local role service_role;
  insert into public.ai_provider_settings (user_id, provider) values (v_bob, 'anthropic');
  reset role;

  set local role authenticated;
  perform set_config('request.jwt.claim.sub', v_alice::text, true);
  perform t.eq('4 alice cannot see bob''s settings row',
    (select count(*)::int from public.ai_provider_settings where user_id = v_bob), 0);

  -- RLS silently affects zero rows here rather than raising -- alice's
  -- UPDATE's USING clause just never matches bob's row, same shape as
  -- every other owner-scoped table in this suite. Nothing to assert from
  -- inside alice's own session (RLS already hides the row, per test 4) --
  -- test 5 below checks the real effect from the unrestricted connection role.
  update public.ai_provider_settings set provider = 'ollama' where user_id = v_bob;
  reset role;

  -- Confirm from the unrestricted connection role that bob's row really is
  -- untouched -- same "no RLS in the way" check 04_privileges_and_plans.sql
  -- uses right after its own reset role.
  perform t.eq('5 alice''s update to bob''s row affected nothing, seen without RLS in the way',
    (select provider from public.ai_provider_settings where user_id = v_bob), 'anthropic');

  -- ===== ai_generations: append-only, service-role write only =============
  set local role authenticated;
  perform set_config('request.jwt.claim.sub', v_alice::text, true);
  begin
    insert into public.ai_generations (user_id, kind, provider, model, valid)
      values (v_alice, 'goal_plan', 'anthropic', 'claude-sonnet-5', true);
    raise exception 'FAIL 6 authenticated could insert into ai_generations';
  exception when insufficient_privilege then
    raise notice 'PASS  6 authenticated cannot INSERT into ai_generations (42501)';
  end;
  reset role;

  set local role service_role;
  insert into public.ai_generations (user_id, kind, provider, model, valid, input_tokens, output_tokens)
    values (v_alice, 'goal_plan', 'anthropic', 'claude-sonnet-5', true, 120, 900)
    returning id into v_gen_id;
  insert into public.ai_generations (user_id, kind, provider, model, valid, error_code)
    values (v_bob, 'goal_plan', 'anthropic', 'claude-sonnet-5', false, 'rate_limited');
  reset role;

  set local role authenticated;
  perform set_config('request.jwt.claim.sub', v_alice::text, true);
  perform t.eq('7 alice can see her own generation row',
    (select kind from public.ai_generations where id = v_gen_id), 'goal_plan');
  perform t.eq('8 alice cannot see bob''s generation row',
    (select count(*)::int from public.ai_generations where user_id = v_bob), 0);

  begin
    delete from public.ai_generations where id = v_gen_id;
    raise exception 'FAIL 9 authenticated could delete its own audit row';
  exception when insufficient_privilege then
    raise notice 'PASS  9 authenticated cannot DELETE from ai_generations, even its own row (42501)';
  end;
  reset role;

  raise notice '--- ai provider settings/generations: RLS cross-isolation complete ---';
end $test$;
