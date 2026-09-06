-- Closes /code-review's finding on PR #102 (0005_activate_plan_rpc.sql): the
-- advisory-lock RPC serializes concurrent activate_plan() calls against each
-- other, but does nothing to stop a *different* write path from bypassing it
-- entirely. plans_update_own (0001_seam.sql) grants any authenticated user
-- UPDATE on their own rows -- required, since "retire a goal" is a direct
-- client write of is_active = false (see that migration's comment) -- but the
-- same grant also permits a raw client
--   supabase.from("plans").update({ is_active: true }).eq("id", planId)
-- which sets is_active = true without ever calling activate_plan(), without
-- taking the advisory lock, and without deactivating the user's other plan
-- first (silently violating plans_one_active's "one active plan" invariant
-- until the unique index catches it, or racing another such call the same
-- way 0005 exists to prevent). RLS alone was never meant to be the access
-- control boundary here -- schema.md's established rule (see decisions.md's
-- prior audit) is grants/structural checks, RLS is incidental -- and this is
-- exactly that gap.
--
-- Fix: a BEFORE UPDATE trigger rejects any UPDATE that flips is_active from
-- false to true unless a transaction-local flag is set -- and the only place
-- that ever sets it is activate_plan() itself, immediately before its own
-- writes. A direct client update can set is_active = false freely (the
-- documented retire-a-goal path keeps working, untouched), but can never set
-- it to true; only the lock-holding RPC can. set_config(..., true) is
-- transaction-scoped (the third arg is is_local), so it can never leak across
-- requests or connections -- it doesn't outlive the transaction that set it.
create or replace function public.plans_guard_activation()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.is_active and not old.is_active then
    if coalesce(current_setting('mtdo.activating_plan', true), '') <> 'true' then
      raise exception
        'plans: is_active may only be set true via activate_plan()'
        using errcode = '42501';
    end if;
  end if;
  return new;
end;
$$;

alter function public.plans_guard_activation() owner to postgres;

drop trigger if exists plans_guard_activation on public.plans;
create trigger plans_guard_activation
  before update on public.plans
  for each row execute function public.plans_guard_activation();

-- Re-create activate_plan() to set the guard's flag before its own writes.
-- Everything else (lock, ownership check, deactivate-then-activate pair) is
-- unchanged from 0005.
create or replace function public.activate_plan(p_plan_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
begin
  if v_uid is null then
    raise exception 'activate_plan: no authenticated user' using errcode = '42501';
  end if;

  perform pg_advisory_xact_lock(hashtext(v_uid::text));

  if not exists (
    select 1 from public.plans p where p.id = p_plan_id and p.user_id = v_uid
  ) then
    raise exception 'activate_plan: plan % not found for this user', p_plan_id
      using errcode = '42501';
  end if;

  -- Transaction-local only (third arg true) -- resets automatically at
  -- commit/rollback, never persists past this call. Must be set before both
  -- writes below, since the trigger fires per-row on each of them.
  perform set_config('mtdo.activating_plan', 'true', true);

  update public.plans set is_active = false
    where user_id = v_uid and is_active = true and id != p_plan_id;

  update public.plans set is_active = true
    where id = p_plan_id and user_id = v_uid;
end;
$$;

alter function public.activate_plan(uuid) owner to postgres;
revoke execute on function public.activate_plan(uuid) from public, anon, authenticated;
grant execute on function public.activate_plan(uuid) to authenticated;
