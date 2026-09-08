-- Phase 5 of the operating-engine plan: Kanban + task metadata. Two plain
-- columns on curriculum_items and blocks, and pick_curriculum_item() copies
-- them alongside task/meta -- the same "copied, not referenced" reasoning
-- 0012 already established for text/meta (a block must still read
-- correctly after the curriculum item is edited or deleted).
--
-- Deliberately NOT touched here: the AI-generation prompt (prompt.ts),
-- Manual Setup's task form, or the extension prompt (extend-prompt.ts) --
-- none of them collect a priority/estimate today. priority's own
-- NOT NULL DEFAULT 'medium' is what makes every task, old and new, get a
-- real (if uniform) value regardless -- richer collection is a fast-follow,
-- not required for this migration to be honest. estimated_minutes has no
-- default (genuinely unset is genuinely unset, same reasoning as
-- profiles.timezone/plans.onboarding_answers).

alter table public.curriculum_items
  add column priority text not null default 'medium' check (priority in ('high', 'medium', 'low')),
  add column estimated_minutes integer check (estimated_minutes > 0);

comment on column public.curriculum_items.priority is
  'high/medium/low, defaults to medium -- no authoring surface sets this explicitly yet (prompt.ts, Manual Setup, extend-prompt.ts all still omit it), so every row gets a real, uniform value rather than a fabricated spread. Copied to blocks.priority by pick_curriculum_item(). See docs/architecture/api.md sec3b.';
comment on column public.curriculum_items.estimated_minutes is
  'Optional; NULL means genuinely never set, not zero. Copied to blocks.estimated_minutes by pick_curriculum_item().';

alter table public.blocks
  add column priority text not null default 'medium' check (priority in ('high', 'medium', 'low')),
  add column estimated_minutes integer check (estimated_minutes > 0);

comment on column public.blocks.priority is
  'Copied from curriculum_items.priority at pick time (pick_curriculum_item()) for a picked block; defaults to medium for a hand-composed block (today-deck.tsx''s composer does not set this). Client-updatable like the rest of blocks -- a user re-prioritizing their own board is not a privilege question.';
comment on column public.blocks.estimated_minutes is
  'Copied from curriculum_items.estimated_minutes at pick time; NULL (no estimate) for a hand-composed block or an item that never had one set.';

create or replace function public.pick_curriculum_item(p_item_id uuid)
returns public.blocks
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_item public.curriculum_items;
  v_plan_id uuid;
  v_date date;
  v_row public.blocks;
begin
  if v_uid is null then
    raise exception 'pick_curriculum_item: no authenticated user' using errcode = '42501';
  end if;

  -- Same coalesce pattern as recompute_daily_rollups() (0013): a user's own
  -- stored preference wins when set, UTC is the fallback for one who never
  -- set one. NULL is deliberately not "UTC" here either -- see profiles.timezone's
  -- own comment for why the column stays nullable rather than defaulted.
  select (now() at time zone coalesce(p.timezone, 'UTC'))::date into v_date
  from public.profiles p where p.id = v_uid;

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
    (user_id, plan_id, category_id, curriculum_item_id, date, position, text, status, coaching,
     priority, estimated_minutes)
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
    case when v_item.meta = '{}'::jsonb then null else v_item.meta end,
    v_item.priority,
    v_item.estimated_minutes
  )
  returning * into v_row;

  return v_row;
end;
$$;

alter function public.pick_curriculum_item(uuid) owner to postgres;
revoke execute on function public.pick_curriculum_item(uuid) from public, anon, authenticated;
grant execute on function public.pick_curriculum_item(uuid) to authenticated;

comment on function public.pick_curriculum_item(uuid) is
  'Pulls one curriculum item onto today''s board as a block, copying its task text, meta, priority, and estimated_minutes. "Today" is computed in the caller''s own profiles.timezone (UTC fallback, see 0013) so a picked block''s date agrees with what the Today screen is querying for. Idempotent per (user, item). See docs/architecture/api.md sec3b.';
