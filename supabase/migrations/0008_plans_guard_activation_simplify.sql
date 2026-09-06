-- Code-quality finding from /code-review 102 (4th pass): 0007's
-- plans_guard_activation() duplicated the identical raise-exception block
-- once for the INSERT branch and once for the UPDATE branch. A future edit
-- to the message text or the flag-check condition applied to only one
-- branch (e.g. renaming `mtdo.activating_plan`) could silently reintroduce
-- the exact access-control bypass this trigger exists to close, for
-- whichever operation was missed. Collapsed to a single exception site.
-- Behavior is unchanged from 0007 -- same two conditions, same message,
-- same errcode -- verified live below, not just by inspection.
create or replace function public.plans_guard_activation()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if (tg_op = 'INSERT' and new.is_active)
     or (tg_op = 'UPDATE' and new.is_active and not old.is_active)
  then
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
-- Trigger definition itself (before insert or update, from 0007) is
-- untouched -- CREATE OR REPLACE FUNCTION keeps the existing trigger
-- attached, same name, same OID relationship.
