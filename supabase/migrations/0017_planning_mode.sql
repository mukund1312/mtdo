-- Phase 4 of the operating-engine plan: planning mode. A plan runs in one
-- of two modes -- dynamic_weekly (today's behavior: the menu unlocks one
-- more week per category per ISO week the user shows up) or overall (the
-- whole plan's curriculum is visible on the menu at once, no drip-feed).
-- Small, deliberate change to one function, not a second engine -- see
-- ensure_curriculum_menu()'s own comment below for exactly what branches.

-- 1. plans.planning_mode -------------------------------------------------

-- Ordinary client-writable column, like the rest of plans -- a user's own
-- choice of how their own plan behaves, not an access-control surface.
-- NOT NULL DEFAULT 'dynamic_weekly': unlike profiles.timezone (0013), there
-- is no meaningful "unset" state to preserve here -- every plan, including
-- ones already in the database before this migration, needs a real mode to
-- behave under, and dynamic_weekly is the one that already matches their
-- actual behavior today. A NULL would just mean "which branch does
-- ensure_curriculum_menu() take for this plan," an ambiguity 0013's
-- reasoning doesn't apply to.
alter table public.plans
  add column planning_mode text not null default 'dynamic_weekly'
    check (planning_mode in ('dynamic_weekly', 'overall'));

comment on column public.plans.planning_mode is
  'dynamic_weekly (default): ensure_curriculum_menu() unlocks one more week per category per ISO week. overall: the whole plan is visible on the menu at once, cursor ignored. Client-writable like the rest of plans. See docs/architecture/api.md sec3b.';

-- 2. ensure_curriculum_menu(): branch on it -------------------------------

create or replace function public.ensure_curriculum_menu()
returns table (
  category_id uuid,
  category_name text,
  category_label text,
  category_sort_order integer,
  curriculum_item_id uuid,
  week_index integer,
  item_position integer,
  task text,
  meta jsonb
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_plan_id uuid;
  v_planning_mode text;
  v_iso_week text := to_char((now() at time zone 'UTC')::date, 'IYYY-"W"IW');
begin
  if v_uid is null then
    raise exception 'ensure_curriculum_menu: no authenticated user' using errcode = '42501';
  end if;

  select p.id, p.planning_mode into v_plan_id, v_planning_mode
  from public.plans p
  where p.user_id = v_uid and p.is_active
  limit 1;

  -- No active plan is an ordinary state (onboarding not finished), not an
  -- error. Return an empty menu and let the screen show its empty state.
  if v_plan_id is null then
    return;
  end if;

  -- Serialize the advance per user, same reasoning as 0012's original
  -- comment: two tabs loading the board at the same moment must not each
  -- advance the cursor and unlock two weeks in one week.
  perform pg_advisory_xact_lock(hashtext('mtdo.curriculum_menu:' || v_uid::text));

  -- Only dynamic_weekly advances the cursor at all. An 'overall' plan
  -- ignores menu_unlocked_week_index entirely for menu purposes (the SELECT
  -- below), so advancing it here would be pure waste at best -- and a real
  -- correctness bug at worst: it would silently "pre-unlock" weeks for
  -- free while nobody's looking, which would then be wrongly available
  -- immediately if the user later switches the plan back to
  -- dynamic_weekly. Leaving the cursor untouched in 'overall' mode is what
  -- makes a later switch back to dynamic_weekly resume from exactly where
  -- it would have been had the plan never left that mode.
  if v_planning_mode = 'dynamic_weekly' then
    update public.plan_categories pc
       set menu_unlocked_week_index = case
             when pc.menu_unlocked_iso_week is null then 0
             else least(
               pc.menu_unlocked_week_index + 1,
               coalesce((
                 select max(ci.week_index) from public.curriculum_items ci
                 where ci.category_id = pc.id
               ), 0)
             )
           end,
           menu_unlocked_iso_week = v_iso_week
     where pc.plan_id = v_plan_id
       and pc.menu_unlocked_iso_week is distinct from v_iso_week;
  end if;

  return query
  select
    pc.id,
    pc.name,
    pc.label,
    pc.sort_order,
    ci.id,
    ci.week_index,
    ci.position,
    ci.task,
    ci.meta
  from public.plan_categories pc
  join public.curriculum_items ci on ci.category_id = pc.id
  where pc.plan_id = v_plan_id
    -- 'overall': every item, cursor ignored entirely. 'dynamic_weekly':
    -- unchanged from 0012 -- only what the cursor has unlocked so far.
    and (v_planning_mode = 'overall' or ci.week_index <= pc.menu_unlocked_week_index)
    -- CARRY-FORWARD (0012, unchanged): the menu is everything eligible and
    -- not yet pulled onto a board, not this week's slice.
    and not exists (
      select 1 from public.blocks b
      where b.curriculum_item_id = ci.id and b.user_id = v_uid
    )
  order by pc.sort_order, pc.id, ci.week_index, ci.position;
end;
$$;

alter function public.ensure_curriculum_menu() owner to postgres;
revoke execute on function public.ensure_curriculum_menu() from public, anon, authenticated;
grant execute on function public.ensure_curriculum_menu() to authenticated;

comment on function public.ensure_curriculum_menu() is
  'Advances each active-plan category''s curriculum unlock cursor at most once per ISO week (dynamic_weekly mode only; overall mode ignores the cursor entirely), then returns every eligible curriculum item not yet pulled onto a board. Carry-forward: unpicked items persist across weeks. See docs/architecture/api.md sec3b.';
