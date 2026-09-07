-- Closes a real consistency gap 0013 (per-user time zones) left open:
-- pick_curriculum_item() (migrations/0012) hard-codes
-- `(now() at time zone 'UTC')::date` for a new block's `date` column. Once
-- Today's own "what date is today" read (web/lib/today-date.ts) switches to
-- a user's stored profiles.timezone, a user meaningfully offset from UTC
-- could pick an item and have it land on a `date` Today isn't querying for
-- yet -- the exact "Today and Progress disagree about what today is" bug
-- decisions.md's original timezone entry warned against, just moved from
-- Progress to Today/blocks instead.
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

comment on function public.pick_curriculum_item(uuid) is
  'Pulls one curriculum item onto today''s board as a block, copying its task text and meta. "Today" is computed in the caller''s own profiles.timezone (UTC fallback, see 0013) so a picked block''s date agrees with what the Today screen is querying for. Idempotent per (user, item). See docs/architecture/api.md §3b.';

-- NOT changed here, deliberately: ensure_curriculum_menu()'s ISO-week
-- unlock cursor (migrations/0012) still advances in UTC regardless of the
-- caller's profile timezone. A user meaningfully offset from UTC can unlock
-- their next week's content up to ~12-14 hours earlier or later than their
-- own local ISO-week boundary would suggest. This is a real, known
-- inconsistency, not an oversight -- left alone because it is a coarse,
-- weekly-granularity nicety (worst case: content unlocks a few hours off
-- from a user's own week boundary) rather than the sharp, immediately
-- visible bug daily date mismatches produce (a picked block not showing up
-- on Today at all until the "right" day arrives). Revisit only if it turns
-- out to matter in practice.
