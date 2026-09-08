-- Phase 3 of the operating-engine plan: the plan pipeline (manual setup,
-- import/export, curriculum extension). Also closes decisions.md's
-- 2026-09-08 reversal ("Curriculum exhaustion, reversed again: extend in
-- place, not re-onboard") -- read that entry before touching this file; it
-- records the three costs this migration deliberately pays and why.

-- 1. plans.onboarding_answers -------------------------------------------

-- Previously dropped entirely after generation (OnboardingAnswers'
-- experienceLevel/notes never made it past route.ts). Nullable, no
-- default -- a plan created via Manual Setup or Import has no onboarding
-- answers at all, and that must stay a genuine NULL, not a defaulted-away
-- empty object indistinguishable from "answered with nothing." Feeds a
-- future extend-plan AI prompt with the same context original generation
-- had; not read by any RPC in this migration.
alter table public.plans
  add column onboarding_answers jsonb;

comment on column public.plans.onboarding_answers is
  'The OnboardingAnswers (experienceLevel, notes, etc.) that produced this plan via AI generation, or NULL for a plan created through Manual Setup or Import. Client-writable like the rest of plans (schema.md sec2). See docs/architecture/decisions.md 2026-09-08.';

-- 2. curriculum_items: a real unique constraint, not just an index --------

-- curriculum_items_category_idx (migrations/0012) is a plain index -- it
-- speeds up the menu query but does nothing to stop two concurrent appends
-- from both computing the same next (week_index, position) and inserting
-- duplicates. extend_plan() below relies on this constraint, under its own
-- advisory lock, to make that structurally impossible rather than merely
-- unlikely -- the same reasoning as blocks_curriculum_item_once (0012).
alter table public.curriculum_items
  add constraint curriculum_items_category_week_position_key
  unique (category_id, week_index, position);

-- 3. extend_plan() --------------------------------------------------------

-- Appends new curriculum content to existing categories of the caller's
-- active plan, and -- the trap decisions.md's 2026-09-08 entry names
-- explicitly -- advances each extended category's unlock cursor in the
-- SAME transaction, so a user who just asked for more work sees it
-- immediately instead of waiting for the cursor's normal weekly cadence.
--
-- p_extension shape (validated field-by-field below, not trusted blindly):
--   [
--     { "category_id": "<uuid, must belong to the caller's active plan>",
--       "items": [ { "task": "...", "meta": {...} }, ... ] },
--     ...
--   ]
-- `items` is a flat, ordered list -- this function buckets it into weeks of
-- `array_length(plan_categories.days, 1)` items each, continuing from that
-- category's current max week_index/position, exactly mirroring
-- web/lib/plan-generation/persist.ts's original bucketing logic for the
-- append case (persist.ts still owns the initial-generation case; this is
-- deliberately not a shared code path -- one is client-side TypeScript
-- against a fresh plan, this is server-side SQL against an existing one
-- under a lock TypeScript can't take).
create function public.extend_plan(p_extension jsonb)
returns setof public.curriculum_items
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_plan_id uuid;
  v_category jsonb;
  v_items jsonb;
  v_item jsonb;
  v_category_id uuid;
  v_days_per_week integer;
  v_next_week integer;
  v_next_position integer;
  v_item_index integer;
  v_row public.curriculum_items;
  v_iso_week text := to_char((now() at time zone 'UTC')::date, 'IYYY-"W"IW');
begin
  if v_uid is null then
    raise exception 'extend_plan: no authenticated user' using errcode = '42501';
  end if;

  if jsonb_typeof(p_extension) is distinct from 'array' or jsonb_array_length(p_extension) = 0 then
    raise exception 'extend_plan: p_extension must be a non-empty JSON array' using errcode = '22023';
  end if;

  select p.id into v_plan_id
  from public.plans p
  where p.user_id = v_uid and p.is_active
  limit 1;

  if v_plan_id is null then
    raise exception 'extend_plan: no active plan for this user' using errcode = '42501';
  end if;

  -- Same lock key as ensure_curriculum_menu()/pick_curriculum_item()
  -- (migrations/0012): all three touch the same (plan_categories cursor,
  -- curriculum_items position) invariant pair for one user and must never
  -- interleave. This is what makes the unique constraint above a backstop,
  -- not the primary defense.
  perform pg_advisory_xact_lock(hashtext('mtdo.curriculum_menu:' || v_uid::text));

  for v_category in select * from jsonb_array_elements(p_extension)
  loop
    if jsonb_typeof(v_category -> 'category_id') is distinct from 'string' then
      raise exception 'extend_plan: each entry needs a "category_id" string' using errcode = '22023';
    end if;
    -- Explicit cast + catch, not left to leak a raw invalid_text_representation
    -- -- this RPC is callable directly by any authenticated client (jsonb
    -- input has no type-checked boundary the way a plain `uuid` parameter
    -- would), so a malformed id must fail the same clean way every other
    -- validation branch in this function does.
    begin
      v_category_id := (v_category ->> 'category_id')::uuid;
    exception when invalid_text_representation then
      raise exception 'extend_plan: "category_id" is not a valid uuid' using errcode = '22023';
    end;

    v_items := v_category -> 'items';
    if jsonb_typeof(v_items) is distinct from 'array' or jsonb_array_length(v_items) = 0 then
      raise exception 'extend_plan: category % needs a non-empty "items" array', v_category_id
        using errcode = '22023';
    end if;

    -- Ownership re-checked here, not just trusted from the client, same
    -- posture as pick_curriculum_item(): this function owns the row (it is
    -- security definer, exempt from RLS), so this join IS the access
    -- control. Requires the category's plan to be the caller's own active
    -- plan -- extending a retired plan would resurrect a goal the user
    -- deliberately put down, same reasoning as pick_curriculum_item()'s own
    -- ownership check.
    select coalesce(array_length(pc.days, 1), 1) into v_days_per_week
    from public.plan_categories pc
    where pc.id = v_category_id and pc.plan_id = v_plan_id;

    if v_days_per_week is null then
      raise exception 'extend_plan: category % not available for this user', v_category_id
        using errcode = '42501';
    end if;

    select coalesce(max(ci.week_index) + 1, 0), coalesce(max(ci.position) + 1, 0)
      into v_next_week, v_next_position
    from public.curriculum_items ci
    where ci.category_id = v_category_id;

    v_item_index := 0;
    for v_item in select * from jsonb_array_elements(v_items)
    loop
      if jsonb_typeof(v_item -> 'task') is distinct from 'string' or btrim(v_item ->> 'task') = '' then
        raise exception 'extend_plan: category % has an item with a blank or missing "task"', v_category_id
          using errcode = '22023';
      end if;

      insert into public.curriculum_items (category_id, week_index, position, task, meta)
      values (
        v_category_id,
        v_next_week + (v_item_index / v_days_per_week),
        v_next_position + v_item_index,
        v_item ->> 'task',
        coalesce(v_item -> 'meta', '{}'::jsonb)
      )
      returning * into v_row;

      return next v_row;
      v_item_index := v_item_index + 1;
    end loop;

    -- Unlock the newly-appended content immediately -- the exact trap named
    -- above. Stamping v_iso_week here (not just bumping the index) means
    -- ensure_curriculum_menu()'s own "iso_week is distinct from current"
    -- check won't also advance this category again later this same week.
    update public.plan_categories pc
       set menu_unlocked_week_index = v_next_week + ((v_item_index - 1) / v_days_per_week),
           menu_unlocked_iso_week = v_iso_week
     where pc.id = v_category_id;
  end loop;

  return;
end;
$$;

alter function public.extend_plan(jsonb) owner to postgres;
revoke execute on function public.extend_plan(jsonb) from public, anon, authenticated;
grant execute on function public.extend_plan(jsonb) to authenticated;

comment on function public.extend_plan(jsonb) is
  'Appends new curriculum content to existing categories of the caller''s active plan and unlocks it immediately (advances menu_unlocked_week_index/menu_unlocked_iso_week in the same transaction). See docs/architecture/decisions.md 2026-09-08 and api.md sec3b.';
