-- 0006's plans_guard_activation trigger was BEFORE UPDATE only. /code-review
-- 102 (second pass, after 0006 was already pushed) correctly found this left
-- a complete bypass: plans.is_active defaults to true (0001_seam.sql:125)
-- and plans_insert_own only checks user_id = auth.uid() (0001_seam.sql's
-- insert policy), with no is_active restriction. A raw client
--   supabase.from("plans").insert({ user_id, app_name, goal_line })
-- creates an already-active plan via INSERT, which never fires a BEFORE
-- UPDATE trigger -- silently reintroducing the exact unguarded write path
-- 0006 exists to close, and making schema.md's "structural access-control
-- boundary" claim false for the insert path specifically.
--
-- Fix: the trigger now also fires BEFORE INSERT. On insert there is no OLD
-- row, so the false->true transition check doesn't apply -- instead, any
-- INSERT with is_active = true is rejected outright unless the same
-- transaction-local flag is set. This is safe with zero behavior change for
-- every real caller: `persist.ts` always inserts plans with is_active: false
-- (persist.ts:67) and activates them afterward via activate_plan(); nothing
-- in this codebase has ever inserted a plan pre-activated. activate_plan()
-- itself only UPDATEs an existing row by id -- it never inserts -- so it has
-- no need to set the flag for an insert path, but the flag check is kept
-- symmetric with the update case rather than an unconditional insert ban, in
-- case a future legitimate insert-and-activate RPC is added later.
create or replace function public.plans_guard_activation()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    if new.is_active and coalesce(current_setting('mtdo.activating_plan', true), '') <> 'true' then
      raise exception
        'plans: is_active may only be set true via activate_plan()'
        using errcode = '42501';
    end if;
    return new;
  end if;

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
  before insert or update on public.plans
  for each row execute function public.plans_guard_activation();
