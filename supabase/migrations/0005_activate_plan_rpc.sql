-- Real fix for gh90 (see web/lib/plan-generation/persist.ts's KNOWN
-- LIMITATION comment, and PR #95/#97's history: a prior ad hoc reordering of
-- two separate .update() calls was reviewed, hand-traced, and found to move
-- the race rather than close it -- two independent PostgREST round trips can
-- never be made atomic against each other from the client side, no matter
-- what order the statements run in).
--
-- What this DOES fix: the deactivate-others + activate-this-one pair now
-- runs inside one transaction, serialized per user via
-- pg_advisory_xact_lock -- two concurrent activate_plan() calls for the same
-- user can no longer interleave their writes. The loser blocks until the
-- winner's transaction commits, then re-evaluates "which plan is currently
-- active" against the winner's already-committed state, so the deactivate
-- step can never race an activate step from another in-flight call. This
-- closes the actual data-integrity gap: previously two truly concurrent
-- requests had genuinely undefined interleaving of two independent
-- statements each.
--
-- What this does NOT fix, and no server-side lock can: if request A's HTTP
-- response has already been sent (client shown "success", referencing plan
-- A) before request B's activate_plan() call runs and correctly deactivates
-- plan A (because "one active plan per user" is the real invariant, and B's
-- plan legitimately supersedes it), there is no way to retroactively tell
-- A's already-completed response that its plan is no longer active. That is
-- a genuine double-submission problem, not a database race -- the fix for
-- it is preventing the second submission from ever firing (a client-side
-- submit-guard disabling the button after first click) or notifying the
-- loser out-of-band (e.g. a realtime subscription on plans), neither of
-- which is in scope here. Filed separately if it turns out to matter --
-- Wave 1 has no concurrent real users yet to trigger even the double-submit
-- precondition.
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

  -- Transaction-scoped advisory lock, released automatically on commit or
  -- rollback -- no explicit unlock needed, and no risk of a leaked lock if
  -- this function raises partway through. hashtext() collapses the uuid
  -- into a bigint lock key; a collision between two different users' uids
  -- would only cost extra (harmless) serialization, never incorrect
  -- behavior, since the ownership check below still scopes every write to
  -- v_uid regardless of who else shares the lock key.
  perform pg_advisory_xact_lock(hashtext(v_uid::text));

  if not exists (
    select 1 from public.plans p where p.id = p_plan_id and p.user_id = v_uid
  ) then
    raise exception 'activate_plan: plan % not found for this user', p_plan_id
      using errcode = '42501';
  end if;

  update public.plans set is_active = false
    where user_id = v_uid and is_active = true and id != p_plan_id;

  update public.plans set is_active = true
    where id = p_plan_id and user_id = v_uid;
end;
$$;

alter function public.activate_plan(uuid) owner to postgres;
revoke execute on function public.activate_plan(uuid) from public, anon, authenticated;
grant execute on function public.activate_plan(uuid) to authenticated;
