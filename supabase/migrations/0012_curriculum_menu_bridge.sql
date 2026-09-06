-- The curriculum -> blocks bridge.
--
-- curriculum_items has been written by onboarding since W1 and read by
-- absolutely nothing. This is the missing half: the path from generated
-- curriculum to a card on the Today board.
--
-- WHAT THIS IS NOT, AND WHY THAT IS THE WHOLE POINT
-- The obvious bridge is a scheduler: week_index = floor((today -
-- plan_start) / 7), then place a block on every date whose weekday appears
-- in plan_categories.days. Every part of that is wrong here, and three
-- independent places in this repo already say so:
--   * the prompt that generates every plan (web/lib/plan-generation/
--     prompt.ts, rule 2): "`curriculum` is a WEEKLY MENU, not a day-by-day
--     schedule. The user picks items from the current week's menu whenever
--     they get to them -- it is not locked to a specific calendar day."
--   * src/mtdo/core.py's categories_for_day(): "curriculum content is no
--     longer tied to specific calendar days at all ... 'days' for those only
--     sets how many items make up one week's menu, not which days they're
--     visible."
--   * web/lib/plan-generation/types.ts on GeneratedCurriculumDay: "the app
--     does NOT lock these to specific calendar days."
-- So for a curriculum category, `days` is a COUNT -- days.length is how many
-- day-lists make up one week of content, which is also exactly how
-- week_index was assigned at import time (api.md §2a). It is NOT a set of
-- weekdays to schedule on. A bridge that read it as a calendar filter would
-- look correct, pass review, and quietly rebuild the day-by-day schedule the
-- product deliberately moved away from.
--
-- THE MODEL: an unlocking, carry-forward menu.
--   * A category unlocks one more week of curriculum per ISO week, and only
--     when the user actually shows up -- ensure_curriculum_menu() is called
--     from the board's load path. Weeks the user is away cost nothing,
--     because nothing advances while nobody calls it. Same laziness as the
--     terminal app's _ensure_weekly_menu().
--   * Unpicked items CARRY FORWARD. The menu is every unlocked item that
--     hasn't been pulled onto a board yet, not just this week's slice. This
--     is a deliberate divergence from the terminal app, which drops
--     unpicked items when the cursor advances: a generated plan holds
--     exactly two weeks of content (prompt.ts rule 2 writes
--     `days.length * 2` inner lists), so use-it-or-lose-it would mean one
--     missed week costs half the plan. On a terminal you open daily that is
--     a nudge; on the web it is data loss.
--   * "Picked" is not stored. It is `a block exists for this curriculum
--     item` -- one derived fact instead of a second mutable source of truth
--     that could disagree with the board. Deleting the block puts the item
--     back on the menu, which is the behaviour a user would predict.
--   * Nothing is ever auto-placed. Picking is an explicit user action, per
--     prompt.ts rule 2. The board does not fill itself.

-- 1. block provenance ------------------------------------------------------

-- Needed as the target of blocks' composite FK below, in the same style as
-- plans_id_user_key / plan_categories_id_plan_key / blocks_id_user_key.
alter table curriculum_items
  add constraint curriculum_items_id_category_key unique (id, category_id);

alter table blocks
  add column curriculum_item_id uuid;

-- OWNERSHIP CHAIN, same reasoning as the composite FKs already on this table
-- (0001 §3): the pair proves the curriculum item this block claims belongs to
-- the block's own category, not merely that some row with that id exists. The
-- RPC below also checks ownership explicitly, but that check is code and this
-- one is the database.
--
-- ON DELETE SET NULL (curriculum_item_id) -- the column list is required
-- because the FK spans two columns and category_id is NOT NULL; a bare SET
-- NULL would try to null both and fail at delete time. Identical situation to
-- focus_sessions_block_fk in 0001, and the same resolution.
--
-- SET NULL rather than RESTRICT is what preserves 0001's deliberate decision
-- to leave curriculum_items fully deletable ("replaceable plan *content*, and
-- nothing references them ... so deleting one loses no history"). A block
-- copies the item's text and coaching at pick time, so it survives the item's
-- deletion intact and merely loses the backlink.
alter table blocks
  add constraint blocks_curriculum_item_fk
  foreign key (curriculum_item_id, category_id)
  references curriculum_items (id, category_id)
  on delete set null (curriculum_item_id);

-- One block per curriculum item per user. This is what makes "picked" a
-- derived fact safe to rely on: without it a double-clicked pick would put
-- the same item on the board twice and take it off the menu once, and the
-- menu would be quietly wrong from then on. Partial, because ordinary
-- hand-composed blocks (curriculum_item_id is null) must stay unconstrained.
create unique index blocks_curriculum_item_once
  on blocks (user_id, curriculum_item_id)
  where curriculum_item_id is not null;

-- Backs the "is this item already picked" anti-join in the menu query, which
-- runs on every board load.
create index blocks_curriculum_item_idx
  on blocks (curriculum_item_id)
  where curriculum_item_id is not null;

-- 2. the unlock cursor -----------------------------------------------------

-- Lives on plan_categories rather than in a new table because a category
-- already belongs to exactly one plan, which belongs to exactly one user --
-- there is no (user, category) pair to model, the category IS the pair.
--
-- Client-writable, like the rest of plan_categories. Deliberate: a user
-- unlocking their own curriculum faster is a self-service action on their own
-- plan, not a privilege escalation, and nothing downstream is derived from it
-- (daily_rollups reads the ledger and focus_sessions, never this). The RPC
-- exists for correctness under concurrency, not to fence the column off.
alter table plan_categories
  -- Highest curriculum week_index unlocked so far. 0 = only week 0.
  add column menu_unlocked_week_index integer not null default 0,
  -- The ISO week during which the cursor last advanced ('2026-W37'). NULL
  -- means "never drawn" -- the first call unlocks week 0 and stamps this,
  -- rather than immediately advancing to week 1 and dumping two weeks of
  -- content on the user's first day.
  add column menu_unlocked_iso_week text,
  add constraint plan_categories_menu_week_nonneg
    check (menu_unlocked_week_index >= 0);

-- 3. ensure + read the menu ------------------------------------------------

create function public.ensure_curriculum_menu()
returns table (
  category_id uuid,
  category_name text,
  category_label text,
  category_sort_order integer,
  curriculum_item_id uuid,
  week_index integer,
  -- `item_position`, not `position`: POSITION is a reserved word in Postgres
  -- (the position(x in y) function), so a RETURNS TABLE column of that name
  -- is a syntax error. Renamed rather than quoted so no caller has to
  -- remember to quote it either.
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
  v_iso_week text := to_char((now() at time zone 'UTC')::date, 'IYYY-"W"IW');
begin
  if v_uid is null then
    raise exception 'ensure_curriculum_menu: no authenticated user' using errcode = '42501';
  end if;

  select p.id into v_plan_id
  from public.plans p
  where p.user_id = v_uid and p.is_active
  limit 1;

  -- No active plan is an ordinary state (onboarding not finished), not an
  -- error. Return an empty menu and let the screen show its empty state.
  if v_plan_id is null then
    return;
  end if;

  -- Serialize the advance per user. Two tabs loading the board at the same
  -- moment would otherwise both observe "iso_week <> current" and each
  -- advance the cursor, unlocking two weeks in one week. Carry-forward means
  -- that costs no content, but it does silently break the pacing the whole
  -- model exists to provide. Same pattern as activate_plan() (0005).
  perform pg_advisory_xact_lock(hashtext('mtdo.curriculum_menu:' || v_uid::text));

  update public.plan_categories pc
     set menu_unlocked_week_index = case
           -- First time this category's menu has ever been drawn: unlock
           -- week 0 only. Without this branch a null iso_week would take the
           -- advance branch below and start the user on week 1.
           when pc.menu_unlocked_iso_week is null then 0
           -- One step per ISO week in which the user actually showed up,
           -- capped at the content that exists. least() against the real max
           -- keeps the cursor from drifting past the end of a short plan and
           -- then needing weeks to walk back after a plan is extended.
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
    and ci.week_index <= pc.menu_unlocked_week_index
    -- CARRY-FORWARD: the menu is everything unlocked and not yet pulled onto
    -- a board, not this week's slice. An item picked and then deleted from
    -- the board reappears here, which is what a user would expect.
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

-- 4. pick one item onto today's board --------------------------------------

create function public.pick_curriculum_item(p_item_id uuid)
returns public.blocks
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_item public.curriculum_items;
  v_plan_id uuid;
  v_date date := (now() at time zone 'UTC')::date;
  v_row public.blocks;
begin
  if v_uid is null then
    raise exception 'pick_curriculum_item: no authenticated user' using errcode = '42501';
  end if;

  -- Ownership is re-checked here, not just in RLS: this function is owned by
  -- postgres and is therefore exempt from RLS, so this join IS the access
  -- control. Walks item -> category -> plan and requires the plan to be the
  -- caller's own AND active; picking from a retired plan onto today's board
  -- would resurrect a goal the user deliberately put down.
  select ci.* into v_item
  from public.curriculum_items ci
  join public.plan_categories pc on pc.id = ci.category_id
  join public.plans p on p.id = pc.plan_id
  where ci.id = p_item_id and p.user_id = v_uid and p.is_active;

  if v_item.id is null then
    -- Deliberately does not distinguish "not yours" from "no such item" from
    -- "plan is retired" -- a distinguishable error would confirm the
    -- existence of another user's curriculum item id.
    raise exception 'pick_curriculum_item: item % not available for this user', p_item_id
      using errcode = '42501';
  end if;

  select pc.plan_id into v_plan_id
  from public.plan_categories pc where pc.id = v_item.category_id;

  -- Idempotent. blocks_curriculum_item_once enforces this under concurrency;
  -- this branch exists so a double-clicked pick returns the block the user
  -- already has instead of a unique-violation the UI would have to decode.
  select b.* into v_row
  from public.blocks b
  where b.user_id = v_uid and b.curriculum_item_id = p_item_id;
  if v_row.id is not null then
    return v_row;
  end if;

  -- Same lock as ensure_curriculum_menu(), for the position allocation
  -- below: `max(position) + 1` read-then-insert is a genuine race, and
  -- blocks_slot_key is DEFERRABLE, so two concurrent picks into the same
  -- category would not collide on INSERT -- they would both succeed and then
  -- one would fail at COMMIT, after the transaction looked fine. (This is
  -- the same latent race in today-deck.tsx's hand-composer, which allocates
  -- its position the same way from the client.)
  perform pg_advisory_xact_lock(hashtext('mtdo.curriculum_menu:' || v_uid::text));

  insert into public.blocks
    (user_id, plan_id, category_id, curriculum_item_id, date, position, text, status, coaching)
  values (
    v_uid,
    v_plan_id,
    v_item.category_id,
    v_item.id,
    v_date,
    coalesce((
      select max(b.position) + 1 from public.blocks b
      where b.user_id = v_uid and b.date = v_date and b.category_id = v_item.category_id
    ), 0),
    v_item.task,
    'todo',
    -- Copied, not referenced. The block must still read correctly after the
    -- curriculum item is edited or deleted (blocks_curriculum_item_fk nulls
    -- the backlink); this copy is what makes that true, and is the same
    -- thing the terminal app does in _task_text_and_coaching().
    case when v_item.meta = '{}'::jsonb then null else v_item.meta end
  )
  returning * into v_row;

  return v_row;
end;
$$;

alter function public.pick_curriculum_item(uuid) owner to postgres;
revoke execute on function public.pick_curriculum_item(uuid) from public, anon, authenticated;
grant execute on function public.pick_curriculum_item(uuid) to authenticated;

comment on function public.ensure_curriculum_menu() is
  'Advances each active-plan category''s curriculum unlock cursor at most once per ISO week (lazily, only when called), then returns every unlocked curriculum item not yet pulled onto a board. Carry-forward: unpicked items persist across weeks. See docs/architecture/api.md §3b.';
comment on function public.pick_curriculum_item(uuid) is
  'Pulls one curriculum item onto today''s (UTC) board as a block, copying its task text and meta. Idempotent per (user, item). See docs/architecture/api.md §3b.';
