-- Phase 6 of the operating-engine plan: Time. Gives a block an optional
-- calendar window, and a safe way to move it between board dates.
--
-- READ decisions.md's 2026-09-11 entry before changing anything here. It
-- narrows -- it does NOT undo -- 2026-09-07's "curriculum is a weekly menu,
-- never scheduled onto calendar dates" decision. The menu mechanism
-- (ensure_curriculum_menu, the unlock cursor, days-as-a-count, week_index as
-- a sequence position) is completely untouched by this migration. What is new
-- is strictly downstream of an explicit pick: once a real blocks row exists
-- because a human put it there, that block may optionally also carry a
-- date/time. Nothing here derives a date from `today - plan_start`, and
-- nothing here ever should.

-- 1. the columns ----------------------------------------------------------
-- Both nullable with no default, deliberately: an unscheduled block is the
-- normal, overwhelmingly common case, and NULL is the honest representation
-- of "genuinely never scheduled" -- the same load-bearing NULL the 2026-09-07
-- timezone entry describes for profiles.timezone, and the same reasoning as
-- blocks.estimated_minutes (0018). A default would make every existing block
-- claim a schedule it does not have.

alter table public.blocks
  add column scheduled_start_at timestamptz,
  add column scheduled_end_at timestamptz,
  -- Both or neither. A half-set window has no meaning, and letting one exist
  -- would push the "is this actually scheduled?" test into every reader.
  add constraint blocks_scheduled_window_paired
    check ((scheduled_start_at is null) = (scheduled_end_at is null)),
  -- Strictly positive duration. A zero-length block is not a calendar event.
  add constraint blocks_scheduled_window_ordered
    check (scheduled_end_at is null or scheduled_end_at > scheduled_start_at);

comment on column public.blocks.scheduled_start_at is
  'Optional calendar start for this block. NULL means genuinely unscheduled (the normal case), not midnight. Set/cleared through schedule_block() (0019) -- see docs/architecture/api.md sec3d. Deliberately NOT constrained to fall on blocks.date: a 23:30-00:30 session is legitimate, and the board date and the calendar window are related concepts, not redundant ones.';
comment on column public.blocks.scheduled_end_at is
  'Optional calendar end. Paired with scheduled_start_at by blocks_scheduled_window_paired (both or neither) and ordered after it by blocks_scheduled_window_ordered.';

-- Partial index: only scheduled blocks are ever queried by window, and that
-- is a small minority of the table. Supports the Time deck's "what is on my
-- calendar this week" read without carrying every unscheduled row.
create index blocks_scheduled_window_idx on public.blocks (user_id, scheduled_start_at)
  where scheduled_start_at is not null;

-- 2. schedule_block() -----------------------------------------------------
-- Why this is an RPC when `blocks` stays an ordinary client-writable table:
-- exactly the same reason pick_curriculum_item() is one, and NOT access
-- control. Moving a block to another date changes
-- (user_id, date, category_id, position), which is blocks_slot_key -- and
-- blocks_slot_key is DEFERRABLE INITIALLY DEFERRED. A client-side move that
-- keeps the old `position` therefore does not collide at UPDATE time: it
-- succeeds, the transaction looks fine, and it fails at COMMIT with a 23505
-- the UI has no way to attribute to anything. Position has to be reallocated
-- server-side, under the same per-user advisory lock the other three
-- curriculum/board writers already share, so none of them can interleave.
--
-- CONTRACT (documented in full in api.md sec3d -- summarised here because the
-- NULL semantics are the part a reader will otherwise guess wrong):
--
--   This REPLACES a block's schedule. It does not patch it.
--
--   p_start_at / p_end_at  Both given  -> that becomes the window.
--                          Both NULL   -> the window is CLEARED. This is the
--                                         un-schedule call; there is no
--                                         separate unschedule_block().
--                          One of each -> 22023. A half-window is rejected at
--                                         the argument boundary, not left to
--                                         the CHECK constraint, so the error
--                                         names the function.
--   p_date                 Given       -> the block moves to that board date,
--                                         and its position is reallocated.
--                          NULL        -> the block KEEPS its current date.
--                                         This is the one asymmetry, and it is
--                                         forced: blocks.date is NOT NULL, so
--                                         there is nothing to clear it to.
--
--   So schedule_block(id) with no other argument = "clear this block's time,
--   leave it on the day it is already on."

create function public.schedule_block(
  p_block_id uuid,
  p_date date default null,
  p_start_at timestamptz default null,
  p_end_at timestamptz default null
)
returns public.blocks
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_row public.blocks;
  v_target_date date;
  v_position integer;
begin
  if v_uid is null then
    raise exception 'schedule_block: no authenticated user' using errcode = '42501';
  end if;

  if (p_start_at is null) <> (p_end_at is null) then
    raise exception 'schedule_block: p_start_at and p_end_at must both be provided or both be null'
      using errcode = '22023';
  end if;

  if p_start_at is not null and p_end_at <= p_start_at then
    raise exception 'schedule_block: p_end_at must be after p_start_at'
      using errcode = '22023';
  end if;

  -- Taken BEFORE the ownership read, not after: this function's whole job is
  -- the position reallocation below, and reading max(position) outside the
  -- lock would reintroduce the exact read-then-write race the lock exists to
  -- close. Same key as ensure_curriculum_menu() / pick_curriculum_item() /
  -- extend_plan() -- all four touch the same per-user invariant pair and must
  -- never interleave.
  perform pg_advisory_xact_lock(hashtext('mtdo.curriculum_menu:' || v_uid::text));

  -- Ownership is re-checked here, not just in RLS: this function is owned by
  -- postgres and is therefore exempt from RLS, so this predicate IS the
  -- access control.
  select b.* into v_row from public.blocks b
  where b.id = p_block_id and b.user_id = v_uid
  for update;

  if v_row.id is null then
    -- Deliberately does not distinguish "not yours" from "no such block" --
    -- a distinguishable error would confirm the existence of another user's
    -- block id. Same posture as pick_curriculum_item().
    raise exception 'schedule_block: block % not available for this user', p_block_id
      using errcode = '42501';
  end if;

  v_target_date := coalesce(p_date, v_row.date);

  if v_target_date = v_row.date then
    -- Same day: the block already holds a valid slot, so leave `position`
    -- exactly where it is. Recomputing max(position) + 1 here would be
    -- actively wrong -- the max includes this very row, so every no-op
    -- re-schedule would push the block to the end of its own lane and open a
    -- gap behind it. A same-day reorder is an ordinary client UPDATE of
    -- `position` (the DEFERRABLE constraint exists precisely so a two-row
    -- swap works inside one transaction); this function is about the
    -- cross-date case that a client cannot do safely.
    v_position := v_row.position;
  else
    -- Cross-date move. The destination lane is (user_id, target_date,
    -- category_id) -- category_id never changes here, a block does not
    -- change which goal category it belongs to by being moved in time.
    -- Appended at the end of that lane; gaps left behind on the source date
    -- are fine, blocks_slot_key requires uniqueness, not density.
    select coalesce(max(b.position) + 1, 0) into v_position
    from public.blocks b
    where b.user_id = v_uid
      and b.date = v_target_date
      and b.category_id = v_row.category_id;
  end if;

  update public.blocks b
  set date = v_target_date,
      position = v_position,
      scheduled_start_at = p_start_at,
      scheduled_end_at = p_end_at
  where b.id = p_block_id and b.user_id = v_uid
  returning * into v_row;

  return v_row;
end;
$$;

alter function public.schedule_block(uuid, date, timestamptz, timestamptz) owner to postgres;
revoke execute on function public.schedule_block(uuid, date, timestamptz, timestamptz)
  from public, anon, authenticated;
grant execute on function public.schedule_block(uuid, date, timestamptz, timestamptz) to authenticated;

comment on function public.schedule_block(uuid, date, timestamptz, timestamptz) is
  'Sets or clears a block''s calendar window, and moves it between board dates safely. REPLACES the schedule rather than patching it: both timestamps null clears the window (this is the un-schedule call), a null p_date keeps the block on its current date (blocks.date is NOT NULL, so there is nothing to clear it to). Reallocates blocks.position under the same per-user advisory lock as pick_curriculum_item(), because blocks_slot_key is DEFERRABLE and a client-side cross-date move fails at COMMIT, not at UPDATE. See docs/architecture/api.md sec3d.';

-- 3. pick_curriculum_item() gains an optional target date -----------------
-- Needed so the Time deck can pick an item straight onto a chosen day rather
-- than picking onto today and immediately calling schedule_block() to move
-- it (two writes, one of them visible to the user as a block briefly landing
-- on the wrong day).
--
-- Note this is a DROP-and-create, not a create-or-replace. Adding a
-- defaulted second parameter would otherwise create an OVERLOAD, and every
-- existing one-argument call site -- of which there are several, all of them
-- the real regression risk in this migration -- would then fail with 42725
-- "function is not unique" rather than resolving. Dropping first is what
-- keeps `pick_curriculum_item(p_item_id)` meaning exactly what it always
-- meant. Grants do not survive a drop, so they are re-issued below.

drop function public.pick_curriculum_item(uuid);

create function public.pick_curriculum_item(
  p_item_id uuid,
  p_target_date date default null
)
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

  -- p_target_date defaults to NULL, and NULL resolves to today in the
  -- caller's own zone -- so every pre-0019 call site (which passes only
  -- p_item_id) behaves exactly as it did before, byte for byte. The
  -- coalesce pattern itself is unchanged from 0014: a user's own stored
  -- preference wins when set, UTC is the fallback for one who never set one.
  -- NULL is deliberately not "UTC" in profiles.timezone either -- see that
  -- column's own comment.
  if p_target_date is not null then
    v_date := p_target_date;
  else
    select (now() at time zone coalesce(p.timezone, 'UTC'))::date into v_date
    from public.profiles p where p.id = v_uid;
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
  --
  -- p_target_date does NOT move an already-picked block, deliberately. This
  -- branch is the same "an idempotent re-pick must not clobber the user's own
  -- edits" rule 0018 established for a manual re-prioritization -- a block the
  -- user has since dragged to another day must not silently jump back because
  -- the menu was re-picked from. Moving a block is schedule_block()'s job.
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
  -- one would fail at COMMIT, after the transaction looked fine.
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

alter function public.pick_curriculum_item(uuid, date) owner to postgres;
revoke execute on function public.pick_curriculum_item(uuid, date) from public, anon, authenticated;
grant execute on function public.pick_curriculum_item(uuid, date) to authenticated;

comment on function public.pick_curriculum_item(uuid, date) is
  'Pulls one curriculum item onto the board as a block, copying its task text, meta, priority, and estimated_minutes. p_target_date is optional and defaults to today in the caller''s own profiles.timezone (UTC fallback, see 0013/0014), so every pre-0019 one-argument call site is unchanged. Idempotent per (user, item) -- a repeat pick returns the existing block and does NOT move it to p_target_date; use schedule_block() for that. See docs/architecture/api.md sec3b.';

-- NOT changed here, deliberately: this does not make curriculum "scheduled".
-- p_target_date is a destination the user chose in the UI, never a date this
-- or any other function derives from the plan's start date and
-- plan_categories.days. See 0012's own header and api.md sec3b for why that
-- derivation is wrong, and decisions.md's 2026-09-11 entry for exactly how
-- narrow this phase's reversal is.
