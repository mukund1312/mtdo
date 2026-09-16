-- Phase H of the operating-engine plan: goal / taxonomy EVIDENCE. Like 0033
-- (Phase G), this migration adds no metric, touches no `review_*`/
-- `weekly_performance`/`daily_rollups`/`study_profile` function, and does not
-- touch the Review UI. It preserves two more kinds of intention data that
-- today are either overwritten in place with no trace, or don't exist at
-- all:
--
--   1. `plans` has NO target/deadline column at all. A user who planned to
--      pass an exam by December and later moves it to March is producing
--      real planning evidence today; there is nowhere to even write it, let
--      alone a record of the move.
--   2. `plan_categories.weekly_target_blocks` (0021) and `score_weight`
--      (0001) are both freely client-mutable and both currently overwritten
--      in place -- the same "current-state column, no history" gap 0033
--      closed for `blocks.status`/`disposition`.
--   3. There is no way to say a curriculum item or a block is about a
--      specific SUBTOPIC within its category -- only the category itself.
--      "DSA -> Graphs -> BFS" cannot be expressed; every Graphs task and
--      every DSA task looks identical to any future per-subtopic query.
--   4. `focus_sessions` has no record of which plan/category/topic a session
--      was actually working, beyond a `block_id` that can go stale --
--      `blocks.category_id` can change conceptually if a category is later
--      restructured, and even a topic rename would be invisible history if
--      the session only ever stored a live join, not a snapshot.
--
-- GOVERNING PRINCIPLE (project law, restated because every choice below
-- turns on it, same as 0033): Observation != derived feature != inference !=
-- recommendation. Nothing here computes a rate, a score, or a rule. Every
-- new event is a server-witnessed fact; every new column is either a raw
-- fact (target_date, the topics taxonomy) or an immutable snapshot
-- (focus_sessions' plan_id/category_id/topic_id, captured once at
-- start_session() time and never re-derived from a later join).
--
-- ===========================================================================
-- !! NAMING HAZARD !! `topic_type` (existing, 0001) vs `topics`/`topic_id`
-- (new, this migration) -- READ THIS BEFORE TOUCHING EITHER
-- ===========================================================================
-- `plan_categories.topic_type` ALREADY EXISTS and means something completely
-- different from everything added below:
--
--   topic_type (existing, UNTOUCHED by this migration) -- a coarse,
--     cross-category CS TAG: 'dsa' / 'backend' / 'database' /
--     'system_design' / null. Exactly one per CATEGORY. Selects a built-in
--     coaching framework bucket (web/lib/coaching/build-coaching-content.ts's
--     TOPIC_FRAMEWORKS) and a soundtrack mapping
--     (soundtrack_preferences, migrations/0026, keyed ON topic_type). It is
--     shipped in the mtdo.plan.v1 import/export schema (types.ts/parse.ts/
--     persist.ts), in prompt.ts, in blank-template.ts, AND in the terminal
--     app's goals_template.json/config.py -- including files real users have
--     already authored. IT IS NOT BEING RENAMED, EXTENDED, OR READ BY
--     ANYTHING BELOW.
--
--   topics / *.topic_id (NEW, this migration) -- a fine-grained, RECURSIVE
--     TAXONOMY tier a category can have arbitrarily many of, nested
--     arbitrarily deep (bounded, see part 3 below): DSA (a category, via
--     topic_type "dsa") -> Graphs (a topics row, parent_topic_id null) ->
--     BFS (a topics row, parent_topic_id = Graphs' id). Curriculum items and
--     blocks point at the LEAF topic only (see part 3). Selects nothing,
--     drives no coaching bucket, drives no soundtrack -- it is pure
--     taxonomy/evidence, for a future per-subtopic query to read.
--
-- These two are NEVER joined, conflated, or derived from one another
-- anywhere in this migration, in schema.md, or in api.md. A category can
-- have a topic_type AND a topics tree at the same time, entirely
-- independently -- "DSA" (topic_type: dsa) can have a "Graphs" topic, and
-- "SQL" (topic_type: database) can too; neither installation of "Graphs"
-- knows the other exists, because topics are scoped to one category_id.

-- ===========================================================================
-- 1. New server-minted ledger kinds -- same DROP+ADD pattern as 0023/0033.
-- ===========================================================================
-- Both are SERVER-MINTED ONLY: neither is added to record_event()'s
-- client-appendable whitelist (0001 sec4) below. A client that could
-- self-report "the user moved their deadline" or "the user raised this
-- category's weight" could fabricate the exact planning-intention evidence
-- this migration exists to preserve honestly.
alter table public.activity_events
  drop constraint activity_events_kind_check,
  add constraint activity_events_kind_check check (kind in (
    'signup',
    'goal_created',
    'plan_generated',
    'task_completed',
    'task_regressed',
    'proof_submitted',
    'note_created',
    'screen_opened',
    'focus_mode_toggled',
    'paywall_viewed',
    'session_started',
    'session_completed',
    'session_abandoned',
    'session_paused',
    'session_resumed',
    'session_extended',
    'tutor_message_sent',
    -- 0033:
    'task_scheduled',
    'task_rescheduled',
    'task_unscheduled',
    'task_started',
    'task_status_changed',
    'task_estimate_changed',
    'task_priority_changed',
    'task_disposition_set',
    'task_deleted',
    -- 0034, both server-minted only:
    'plan_target_changed',
    'category_target_changed'
  ));

-- ===========================================================================
-- 2. plans.target_date + set_plan_target_date()
-- ===========================================================================
-- Nullable, no default: existing plans genuinely have no target date, and
-- this column must read that honestly rather than guess one -- same
-- null-over-guess law as blocks.created_at (0033) and profiles.timezone.
-- Unlike blocks.created_at there is no DEFAULT to attach later either: a
-- target date is never "now", there is no sane default value for it at all,
-- so this is a single ordinary ADD COLUMN, not 0033's two-statement split.
alter table public.plans
  add column target_date date;

comment on column public.plans.target_date is
  'Optional user-set goal deadline (0034). NULL means "no target ever set", never a guessed date. Written only through set_plan_target_date(), which mints plan_target_changed on a real change -- plans stays otherwise client-writable (same posture 0033 established for blocks''/transition_block_status()''s relationship), so this is a correctness/evidence RPC, not an access-control one. See docs/architecture/api.md sec3q.';

-- A user moving their target date is real planning evidence (the brief
-- example: aiming for December, later moving to March) -- overwriting the
-- column in place without a record would destroy exactly that. No advisory
-- lock needed: unlike position-allocation RPCs (schedule_block(),
-- pick_curriculum_item()), there is no multi-row invariant here to
-- serialize against, just one row's one column moving under its own
-- `for update` lock.
create function public.set_plan_target_date(
  p_plan_id uuid,
  p_target_date date
)
returns public.plans
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_row public.plans;
  v_from date;
begin
  if v_uid is null then
    raise exception 'set_plan_target_date: no authenticated user' using errcode = '42501';
  end if;

  -- Ownership is re-checked here, not just in RLS: this function is owned by
  -- postgres and is therefore exempt from RLS, so this predicate IS the
  -- access control. Row-locked so a concurrent double-call can't both read
  -- the same "from" value and each mint a divergent event.
  select p.* into v_row from public.plans p
  where p.id = p_plan_id and p.user_id = v_uid
  for update;

  if v_row.id is null then
    -- Deliberately does not distinguish "not yours" from "no such plan" --
    -- a distinguishable error would confirm the existence of another user's
    -- plan id. Same posture as every other ownership-checked RPC in 0012/
    -- 0019/0033.
    raise exception 'set_plan_target_date: plan % not available for this user', p_plan_id
      using errcode = '42501';
  end if;

  v_from := v_row.target_date;

  -- No event for a no-op -- same rule schedule_block() (0033) and
  -- transition_block_status() (0033) already apply to an unchanged re-call.
  -- IS NOT DISTINCT FROM so re-passing an existing null (never set -> still
  -- never set) also mints nothing.
  if v_from is not distinct from p_target_date then
    return v_row;
  end if;

  update public.plans p
     set target_date = p_target_date
   where p.id = p_plan_id and p.user_id = v_uid
  returning * into v_row;

  perform public.append_event(
    v_uid, 'plan_target_changed',
    jsonb_build_object('plan_id', p_plan_id::text, 'from_date', v_from, 'to_date', p_target_date)
  );

  return v_row;
end;
$$;

alter function public.set_plan_target_date(uuid, date) owner to postgres;
revoke execute on function public.set_plan_target_date(uuid, date) from public, anon, authenticated;
grant execute on function public.set_plan_target_date(uuid, date) to authenticated;

comment on function public.set_plan_target_date(uuid, date) is
  'Sets or clears (p_target_date null) a plan''s target_date (0034). Mints plan_target_changed {plan_id, from_date, to_date} only on a real change (IS DISTINCT FROM the prior value) -- an unchanged re-call mints nothing. plans stays otherwise client-writable; this is a correctness/evidence RPC, not an access-control one, same posture as schedule_block() (0033). See docs/architecture/api.md sec3q.';

-- ===========================================================================
-- 3. category_target_changed + set_category_target()
-- ===========================================================================
-- plan_categories.weekly_target_blocks (0021) and .score_weight (0001) are
-- both already-mutable intention data with no record of what they used to
-- be -- weekly_target_blocks can move via apply_weekly_plan_change() (0022,
-- which already writes its own before/after audit row into
-- weekly_plan_changes -- untouched by this migration, see the note on that
-- below) but ALSO via any future direct settings editor; score_weight has no
-- write path of any kind today besides plan creation (persist.ts) and a raw
-- client UPDATE (plan_categories stays ordinary client-writable, 0001).
-- set_category_target() is the one evidence-producing path for a DIRECT
-- user-driven change to either field, ready for whichever settings surface
-- builds that editor -- same "vocabulary + RPC ready, UI to follow" posture
-- 0033 established for task_estimate_changed/task_priority_changed/
-- task_deleted.
create function public.set_category_target(
  p_category_id uuid,
  p_field text,
  p_value numeric
)
returns public.plan_categories
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_row public.plan_categories;
  v_from numeric;
begin
  if v_uid is null then
    raise exception 'set_category_target: no authenticated user' using errcode = '42501';
  end if;

  if p_field is null or p_field not in ('weekly_target_blocks', 'score_weight') then
    raise exception 'set_category_target: p_field must be one of weekly_target_blocks/score_weight'
      using errcode = '22023';
  end if;

  -- score_weight is `not null default 1` (0001) -- a null write would hit
  -- that NOT NULL constraint as an opaque error; reject it here with
  -- something readable instead, same reasoning start_session() (0023) gives
  -- for its own belt-and-braces validation.
  if p_field = 'score_weight' and (p_value is null or p_value < 0) then
    raise exception 'set_category_target: score_weight must be a non-negative number'
      using errcode = '22023';
  end if;

  -- weekly_target_blocks stays genuinely nullable (0021: "never explicitly
  -- set" is a real, distinct state) -- null is a legitimate value here,
  -- meaning "clear the target back to unset". A non-null value must still be
  -- a non-negative WHOLE number: the column is integer, and silently
  -- truncating a fractional p_value would make the "from"/"to" the ledger
  -- records disagree with what the column actually ends up holding.
  if p_field = 'weekly_target_blocks' and p_value is not null
     and (p_value < 0 or p_value <> trunc(p_value)) then
    raise exception 'set_category_target: weekly_target_blocks must be a non-negative whole number, or null'
      using errcode = '22023';
  end if;

  -- Ownership is re-checked here, not just in RLS: this function is owned by
  -- postgres and is therefore exempt from RLS, so this join IS the access
  -- control.
  select pc.* into v_row
  from public.plan_categories pc
  join public.plans p on p.id = pc.plan_id
  where pc.id = p_category_id and p.user_id = v_uid
  for update of pc;

  if v_row.id is null then
    raise exception 'set_category_target: category % not available for this user', p_category_id
      using errcode = '42501';
  end if;

  if p_field = 'weekly_target_blocks' then
    v_from := v_row.weekly_target_blocks;
  else
    v_from := v_row.score_weight;
  end if;

  -- No event for a no-op, same rule as set_plan_target_date() above.
  if v_from is not distinct from p_value then
    return v_row;
  end if;

  if p_field = 'weekly_target_blocks' then
    update public.plan_categories set weekly_target_blocks = p_value::integer
      where id = p_category_id returning * into v_row;
  else
    update public.plan_categories set score_weight = p_value
      where id = p_category_id returning * into v_row;
  end if;

  perform public.append_event(
    v_uid, 'category_target_changed',
    jsonb_build_object('category_id', p_category_id::text, 'field', p_field, 'from', v_from, 'to', p_value)
  );

  return v_row;
end;
$$;

alter function public.set_category_target(uuid, text, numeric) owner to postgres;
revoke execute on function public.set_category_target(uuid, text, numeric)
  from public, anon, authenticated;
grant execute on function public.set_category_target(uuid, text, numeric) to authenticated;

comment on function public.set_category_target(uuid, text, numeric) is
  'Sets plan_categories.weekly_target_blocks or .score_weight (p_field, one of those two names) and mints category_target_changed {category_id, field, from, to} on a real change only. Does NOT replace apply_weekly_plan_change() (0022), which keeps its own weekly_plan_changes audit trail for the rules-engine path -- this is the evidence-producing path for a DIRECT user-driven change (no settings UI calls it yet; vocabulary + RPC ready, same posture 0033 established for task_estimate_changed). plan_categories stays otherwise client-writable. See docs/architecture/api.md sec3q.';

-- ===========================================================================
-- 4. Recursive topics -- owner-only RLS, depth-limited/cycle-guarded RPC
-- ===========================================================================
create table public.topics (
  id uuid primary key default gen_random_uuid(),
  category_id uuid not null references public.plan_categories (id) on delete cascade,
  -- Self-referencing. Nullable = a root topic (e.g. "Graphs" under DSA).
  -- Included NOW, deliberately, even though nothing recursive is required by
  -- any UI yet: it is free today (one column) and avoids a real taxonomy
  -- migration battle later (moving a flat topics list to a tree after real
  -- user data exists is a much harder migration than shipping the tree
  -- shape up front and simply never populating it deeply until something
  -- needs to).
  parent_topic_id uuid references public.topics (id) on delete cascade,
  name text not null,
  label text not null,
  sort_order integer not null default 0,
  created_at timestamptz not null default now(),

  -- Target of curriculum_items' and blocks' composite FKs below -- same
  -- purpose as curriculum_items_id_category_key (0012): proves a
  -- curriculum_item/block's topic actually belongs to that same row's
  -- category, not merely that some topic with that id exists somewhere.
  constraint topics_id_category_key unique (id, category_id)
);

-- Backs the RLS ownership-chain join (every SELECT/write walks category_id
-- -> plan_categories -> plans) and the create_topic() ancestor-depth walk's
-- per-category listing.
create index topics_category_idx on public.topics (category_id, sort_order);
-- Backs create_topic()'s ancestor-chain walk (select parent_topic_id from
-- topics where id = <cursor>) and any future "children of this topic" read.
create index topics_parent_idx on public.topics (parent_topic_id) where parent_topic_id is not null;

alter table public.topics enable row level security;

-- Owner-only, full CRUD, via the ownership-chain `exists` join -- the exact
-- pattern curriculum_items_owner_all (0001_seam.sql) already uses: topics
-- are replaceable plan CONTENT/taxonomy, same category as curriculum_items,
-- and nothing outside this table references a topic in a way that a delete
-- would corrupt (curriculum_items.topic_id/blocks.topic_id both SET NULL on
-- delete, part 5 below).
--
-- NOTE on the depth-limit/cycle-guard below: a CHECK constraint cannot
-- express "no cycle in an arbitrary self-referencing chain" or "this row's
-- ancestor count stays under N" -- both require walking the tree, which
-- CHECK cannot do. create_topic() is therefore the SANCTIONED path for
-- creating a topic with a parent, and is the only thing that validates
-- depth/cycles.
--
-- UNLIKE transition_block_status() (0033), this genuinely IS partly an RLS/
-- grant workaround, and deliberately so: a cycle is not ordinary
-- "corrupt your own data" corruption (the class 0033 accepts for
-- blocks.disposition, where a raw client write can only ever produce a
-- value the CHECK constraint later rejects outright). A cycle in
-- parent_topic_id can never be caught by a CHECK at all, and any FUTURE
-- consumer that walks the parent chain (a mastery rollup, a breadcrumb UI,
-- an export) would have to independently remember to bound its own walk or
-- risk hanging -- a standing tax on every future reader, not a one-time
-- risk borne by the user who caused it. So `parent_topic_id`/`category_id`/
-- `name` are NOT reachable by a client UPDATE at all (see the column-level
-- grant below) -- create_topic() is the ONLY way to set or move a parent.
-- `label`/`sort_order` (cosmetic, structurally inert) stay ordinary
-- client-writable, same posture curriculum_items has for its own content
-- fields.
create policy "topics_owner_all" on public.topics
  for all to authenticated using (
    exists (
      select 1 from public.plan_categories pc
      join public.plans p on p.id = pc.plan_id
      where pc.id = topics.category_id and p.user_id = (select auth.uid())
    )
  ) with check (
    exists (
      select 1 from public.plan_categories pc
      join public.plans p on p.id = pc.plan_id
      where pc.id = topics.category_id and p.user_id = (select auth.uid())
    )
  );

-- Column-level privileges are ADDITIVE with table-level ones in Postgres --
-- a bare `revoke update (parent_topic_id) on topics from authenticated`
-- would do NOTHING while the table-level UPDATE grant (Supabase's default
-- `alter default privileges ... grant all on tables to ... authenticated`,
-- 0001's own security-model header) is still in force. The table-level
-- grant has to be revoked FIRST, then re-granted for exactly the columns a
-- client should be able to touch directly. RLS (topics_owner_all above) is
-- unaffected either way -- grants and policies are checked independently,
-- and a grant this narrow makes `topics_owner_all`'s own USING/WITH CHECK
-- irrelevant for parent_topic_id specifically: there is no row for which an
-- UPDATE touching that column can succeed at all now, regardless of
-- ownership. `anon` gets nothing, same posture activity_events already
-- established (0001) -- this product's real users are always
-- `authenticated`, anonymous-auth included.
revoke update on public.topics from anon, authenticated;
grant update (label, sort_order) on public.topics to authenticated;

comment on table public.topics is
  'Recursive taxonomy tier WITHIN one plan_categories row -- e.g. DSA (category) -> Graphs (topics row, parent null) -> BFS (topics row, parent = Graphs). NOT the same thing as plan_categories.topic_type (a coarse, fixed, cross-category CS tag: dsa/backend/database/system_design) -- see this migration''s header for the full distinction. curriculum_items.topic_id/blocks.topic_id (0034) point at the LEAF topic only. Owner-only for SELECT/INSERT/DELETE and for UPDATE of label/sort_order (topics_owner_all + the column-level UPDATE grant just above) -- but parent_topic_id/category_id/name are reachable ONLY through create_topic() (0034), which owns the depth limit and cycle guard a CHECK constraint cannot express: a client UPDATE touching any of those three columns fails on privileges (42501) before RLS is even evaluated. See docs/architecture/api.md sec3q.';

-- Depth is counted from 1 (a root topic, parent_topic_id null). 5 is chosen
-- to comfortably clear the brief's own worked example (DSA[category] ->
-- Graphs[depth 1] -> BFS[depth 2] -- only 2 topic levels) with three more
-- tiers of headroom (e.g. Graphs -> Traversal -> BFS -> "Iterative BFS" ->
-- "...with an explicit visited set", depth 5) for a future user who wants a
-- genuinely deep taxonomy, while still bounding the ancestor-walk below to a
-- handful of row reads and keeping any future breadcrumb UI from having to
-- render an unbounded chain. A future feature that genuinely needs deeper
-- nesting can raise this constant; nothing about the schema itself caps it
-- lower.
create function public.create_topic(
  p_category_id uuid,
  p_name text,
  p_label text,
  p_parent_topic_id uuid default null,
  p_sort_order integer default 0
)
returns public.topics
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_max_depth constant integer := 5;
  v_row public.topics;
  v_depth integer := 1; -- depth of p_parent_topic_id itself, once resolved
  v_cursor uuid;
  v_hops integer := 0;
begin
  if v_uid is null then
    raise exception 'create_topic: no authenticated user' using errcode = '42501';
  end if;

  if p_name is null or btrim(p_name) = '' then
    raise exception 'create_topic: p_name must not be blank' using errcode = '22023';
  end if;
  if p_label is null or btrim(p_label) = '' then
    raise exception 'create_topic: p_label must not be blank' using errcode = '22023';
  end if;

  -- Ownership is re-checked here, not just in RLS: this function is owned by
  -- postgres and is therefore exempt from RLS, so this join IS the access
  -- control.
  if not exists (
    select 1 from public.plan_categories pc
    join public.plans p on p.id = pc.plan_id
    where pc.id = p_category_id and p.user_id = v_uid
  ) then
    raise exception 'create_topic: category % not available for this user', p_category_id
      using errcode = '42501';
  end if;

  if p_parent_topic_id is not null then
    -- The parent must be a real topic IN THIS SAME CATEGORY -- topics never
    -- span categories, same rule 0012's curriculum_item_fk enforces for a
    -- block and its picked curriculum item (a topic and its parent must
    -- share one category_id, same as a block and its curriculum item do).
    -- Ownership of the parent follows from ownership of p_category_id above
    -- (topics.category_id -> plan_categories -> plans is the same chain),
    -- so no separate ownership check is needed for the parent row itself.
    if not exists (
      select 1 from public.topics t where t.id = p_parent_topic_id and t.category_id = p_category_id
    ) then
      raise exception 'create_topic: parent topic % not found in this category', p_parent_topic_id
        using errcode = '42501';
    end if;

    -- Bounded ancestor walk -- this is BOTH the depth limit and the cycle
    -- guard (see this migration's own header note above topics_owner_all
    -- for why one mechanism covers both, and for why parent_topic_id is no
    -- longer reachable by a client UPDATE at all): walk from the parent up
    -- through its own ancestors, counting hops. A clean chain terminates
    -- when it reaches a root (parent_topic_id is null) within v_max_depth
    -- hops. A chain that is genuinely too deep fails to terminate within
    -- the bound and comes back 22023. A CYCLE is now structurally
    -- impossible via any client-reachable write path -- create_topic() is
    -- insert-only (a freshly inserted row can never already be its own
    -- ancestor) and the column-level grant above means no client UPDATE can
    -- ever move parent_topic_id post-creation -- so this bound is
    -- defense-in-depth against a cycle, not a live mitigation for one: if a
    -- future migration or a service-role path ever DID introduce a cycle
    -- (bypassing grants, which service_role always can), this walk still
    -- fails loudly instead of hanging, rather than assuming the invariant
    -- holds forever just because today's write paths preserve it.
    v_cursor := p_parent_topic_id;
    loop
      select t.parent_topic_id into v_cursor from public.topics t where t.id = v_cursor;
      exit when v_cursor is null;
      v_depth := v_depth + 1;
      v_hops := v_hops + 1;
      if v_hops >= v_max_depth then
        raise exception
          'create_topic: parent chain exceeds the maximum topic depth of % (or, in principle, contains a cycle -- structurally prevented for any client write today, see topics_owner_all''s own comment)',
          v_max_depth
          using errcode = '22023';
      end if;
    end loop;
  end if;

  if v_depth + 1 > v_max_depth then
    raise exception 'create_topic: this topic would sit at depth %, past the maximum of %',
      v_depth + 1, v_max_depth
      using errcode = '22023';
  end if;

  insert into public.topics (category_id, parent_topic_id, name, label, sort_order)
  values (p_category_id, p_parent_topic_id, p_name, p_label, p_sort_order)
  returning * into v_row;

  return v_row;
end;
$$;

alter function public.create_topic(uuid, text, text, uuid, integer) owner to postgres;
revoke execute on function public.create_topic(uuid, text, text, uuid, integer)
  from public, anon, authenticated;
grant execute on function public.create_topic(uuid, text, text, uuid, integer) to authenticated;

comment on function public.create_topic(uuid, text, text, uuid, integer) is
  'The ONLY path for setting a topic''s parent_topic_id/category_id/name -- a table-level UPDATE revoke plus a column-level grant of just (label, sort_order) (0034, right above topics_owner_all) makes those three columns unreachable by any client write, so this function''s bounded ancestor-chain walk is the sole place the depth limit and cycle guard (max depth 5, counted from 1) are enforced or ever need to be. Insert-only: there is no reparent/rename RPC (no topic-editor UI exists yet) -- label/sort_order/deletes stay ordinary client-writable, same posture curriculum_items already has. p_parent_topic_id must belong to the same p_category_id. See docs/architecture/api.md sec3q.';

-- ===========================================================================
-- 5. curriculum_items.topic_id / blocks.topic_id -- mirrors 0012's composite
--    FK shape exactly (curriculum_item_id, category_id) -> curriculum_items
--    (id, category_id) on delete set null -- read that migration's own
--    comment for the full "ownership chain" reasoning, restated briefly
--    here. WORK POINTS AT THE LEAF TOPIC ONLY: a block/curriculum item never
--    references an intermediate node in the topic tree, same way a block
--    only ever references one concrete curriculum_items row, not a whole
--    category's worth of content.
-- ===========================================================================
alter table public.curriculum_items
  add column topic_id uuid;

alter table public.curriculum_items
  add constraint curriculum_items_topic_fk
  foreign key (topic_id, category_id)
  references public.topics (id, category_id)
  -- Column list required: category_id is NOT NULL on curriculum_items, so a
  -- bare `on delete set null` would try to null both columns and fail at
  -- delete time -- identical situation to 0012's blocks_curriculum_item_fk.
  on delete set null (topic_id);

create index curriculum_items_topic_idx on public.curriculum_items (topic_id) where topic_id is not null;

comment on column public.curriculum_items.topic_id is
  'Optional leaf-topic reference (0034) -- fine-grained taxonomy WITHIN this item''s category, e.g. "BFS" under a "Graphs" topic under a "DSA" category. NOT the same thing as plan_categories.topic_type -- see this migration''s header. NULL for every existing item (no inference, no backfill) and for any item that simply has no subtopic. Copied to blocks.topic_id by pick_curriculum_item() at pick time, same as curriculum_item_id itself.';

alter table public.blocks
  add column topic_id uuid;

alter table public.blocks
  add constraint blocks_topic_fk
  foreign key (topic_id, category_id)
  references public.topics (id, category_id)
  -- Same column-list requirement as above: blocks.category_id is NOT NULL.
  on delete set null (topic_id);

create index blocks_topic_idx on public.blocks (topic_id) where topic_id is not null;

comment on column public.blocks.topic_id is
  'Copied from curriculum_items.topic_id at pick time by pick_curriculum_item() (0034), exactly as curriculum_item_id/estimated_minutes/original_estimated_minutes already are -- NOT re-copied on an idempotent re-pick. NULL for a hand-composed block, a picked item with no topic, or any pre-0034 block. focus_sessions.topic_id (part 6 below) is a SEPARATE, independently-captured snapshot of this value at session-start time -- it does not read this column live, so a block''s topic_id changing later never rewrites a past session''s attribution.';

-- pick_curriculum_item() gains topic_id -- same signature (uuid, date),
-- VERBATIM except for the one new column, same treatment 0033 gave this
-- function for original_estimated_minutes.
create or replace function public.pick_curriculum_item(
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

  if p_target_date is not null then
    v_date := p_target_date;
  else
    select (now() at time zone coalesce(p.timezone, 'UTC'))::date into v_date
    from public.profiles p where p.id = v_uid;
  end if;

  select ci.* into v_item
  from public.curriculum_items ci
  join public.plan_categories pc on pc.id = ci.category_id
  join public.plans p on p.id = pc.plan_id
  where ci.id = p_item_id and p.user_id = v_uid and p.is_active;

  if v_item.id is null then
    raise exception 'pick_curriculum_item: item % not available for this user', p_item_id
      using errcode = '42501';
  end if;

  select pc.plan_id into v_plan_id
  from public.plan_categories pc where pc.id = v_item.category_id;

  select b.* into v_row
  from public.blocks b
  where b.user_id = v_uid and b.curriculum_item_id = p_item_id;
  if v_row.id is not null then
    return v_row;
  end if;

  perform pg_advisory_xact_lock(hashtext('mtdo.curriculum_menu:' || v_uid::text));

  insert into public.blocks
    (user_id, plan_id, category_id, curriculum_item_id, topic_id, date, position, text, status,
     coaching, priority, estimated_minutes, original_estimated_minutes)
  values (
    v_uid,
    v_plan_id,
    v_item.category_id,
    v_item.id,
    -- 0034: copied once, here, exactly like curriculum_item_id itself. Not
    -- re-copied on the idempotent re-pick branch above.
    v_item.topic_id,
    v_date,
    coalesce((
      select max(b.position) + 1 from public.blocks b
      where b.user_id = v_uid and b.date = v_date and b.category_id = v_item.category_id
    ), 0),
    v_item.task,
    'todo',
    case when v_item.meta = '{}'::jsonb then null else v_item.meta end,
    v_item.priority,
    v_item.estimated_minutes,
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
  'Pulls one curriculum item onto the board as a block, copying its task text, meta, priority, estimated_minutes, and (0034) topic_id. p_target_date is optional and defaults to today in the caller''s own profiles.timezone (UTC fallback). Idempotent per (user, item) -- a repeat pick returns the existing block and does not move it or re-copy any field, including topic_id. See docs/architecture/api.md sec3b/sec3p/sec3q.';

-- ===========================================================================
-- 6. focus_sessions attribution snapshots -- plan_id/category_id/topic_id,
--    captured ONCE at start_session() time.
-- ===========================================================================
-- Deliberately NOT derived from a later join through block_id: block_id
-- itself is already nullable and already SET NULL on the block's own
-- deletion (0001's focus_sessions_block_fk), and even when block_id
-- survives, blocks.category_id/topic_id are both freely mutable going
-- forward -- a category or topic RENAME never touches these snapshot
-- columns (rename doesn't change the row's id, so an id-based FK is
-- unaffected either way), but the point of capturing plan_id/category_id/
-- topic_id AS THEIR OWN COLUMNS, not read live off blocks at query time, is
-- that even a future RE-POINT of a block onto a different category (nothing
-- does this today, but nothing rules it out either) would never rewrite
-- what a past session actually attributed to. Existing sessions get NULL --
-- no inference, no backfill, same null-over-guess law as every other column
-- in this pair of migrations.
alter table public.focus_sessions
  add column plan_id uuid,
  add column category_id uuid,
  add column topic_id uuid;

-- Ownership-chain FKs, same shape as blocks_plan_fk/blocks_category_fk
-- (0001) -- RESTRICT because plans/plan_categories have no DELETE policy and
-- are never actually deleted in normal product operation (retiring a goal is
-- is_active = false), so this never fires; it exists to make "this session's
-- plan/category really is this user's own" a database-enforced invariant,
-- not a hope. All three columns are nullable (a session with no block has
-- nothing to attribute), and Postgres' default MATCH SIMPLE means a NULL in
-- either column of a composite FK skips the check entirely -- exactly the
-- "no attribution" case this table must allow.
alter table public.focus_sessions
  add constraint focus_sessions_plan_fk foreign key (plan_id, user_id)
    references public.plans (id, user_id) on delete restrict,
  add constraint focus_sessions_category_fk foreign key (category_id, plan_id)
    references public.plan_categories (id, plan_id) on delete restrict,
  -- topic_id DOES have a real delete path (topics stays owner-writable, part
  -- 4), so unlike the two above this one really can fire -- SET NULL
  -- (topic_id only, category_id must survive a topic's own deletion
  -- untouched, same column-list requirement as every other composite FK in
  -- this migration).
  add constraint focus_sessions_topic_fk foreign key (topic_id, category_id)
    references public.topics (id, category_id) on delete set null (topic_id);

create index focus_sessions_plan_idx on public.focus_sessions (plan_id) where plan_id is not null;
create index focus_sessions_category_idx on public.focus_sessions (category_id) where category_id is not null;

comment on column public.focus_sessions.plan_id is
  'Attribution SNAPSHOT (0034), captured once by start_session() from the linked block''s plan_id at session-start time -- never re-derived from a later join. NULL for a session with no linked block, and for every pre-0034 session.';
comment on column public.focus_sessions.category_id is
  'Attribution SNAPSHOT (0034), captured once by start_session() from the linked block''s category_id at session-start time. Surviving a later category RENAME is automatic (an id-based FK is unaffected by a rename); this column exists so a future RE-POINT would not silently rewrite history either. NULL for a session with no linked block, and for every pre-0034 session.';
comment on column public.focus_sessions.topic_id is
  'Attribution SNAPSHOT (0034), captured once by start_session() from the linked block''s topic_id at session-start time. NULL for a session with no linked block, a block with no topic, or any pre-0034 session. SET NULL if the referenced topic is later deleted (topics stays owner-deletable) -- category_id above is untouched by that.';

-- start_session() gains the attribution snapshot -- same signature (uuid,
-- integer, jsonb), same block-started_at behavior from 0033, VERBATIM
-- except for resolving the block's plan_id/category_id/topic_id into local
-- variables (replacing the old bare existence check, which this select
-- subsumes -- `if not found` after the select IS the ownership check) and
-- passing them into the INSERT.
create or replace function public.start_session(
  p_block_id uuid default null,
  p_planned_duration_s integer default null,
  p_break_plan jsonb default null
)
returns public.focus_sessions
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_row public.focus_sessions;
  v_break jsonb;
  v_total_break_s bigint := 0;
  v_prev_at bigint := -1;
  v_block_plan_id uuid;
  v_block_category_id uuid;
  v_block_topic_id uuid;
begin
  if v_uid is null then
    raise exception 'start_session: no authenticated user' using errcode = '42501';
  end if;

  if p_planned_duration_s is null or p_planned_duration_s <= 0 or p_planned_duration_s > 86400 then
    raise exception 'start_session: planned_duration_s must be between 1 and 86400'
      using errcode = '22023';
  end if;

  if p_break_plan is not null then
    if jsonb_typeof(p_break_plan) is distinct from 'object'
       or jsonb_typeof(p_break_plan->'breaks') is distinct from 'array' then
      raise exception 'start_session: break_plan must be an object with a "breaks" array'
        using errcode = '22023';
    end if;

    if jsonb_array_length(p_break_plan->'breaks') > 24 then
      raise exception 'start_session: break_plan may define at most 24 breaks'
        using errcode = '22023';
    end if;

    for v_break in select * from jsonb_array_elements(p_break_plan->'breaks') loop
      if jsonb_typeof(v_break) is distinct from 'object'
         or jsonb_typeof(v_break->'at_s') is distinct from 'number'
         or jsonb_typeof(v_break->'duration_s') is distinct from 'number' then
        raise exception 'start_session: each break needs numeric at_s and duration_s'
          using errcode = '22023';
      end if;

      if (v_break->>'at_s')::bigint <= 0
         or (v_break->>'at_s')::bigint >= p_planned_duration_s then
        raise exception 'start_session: break at_s must be between 1 and planned_duration_s - 1'
          using errcode = '22023';
      end if;

      if (v_break->>'duration_s')::bigint <= 0
         or (v_break->>'duration_s')::bigint > 86400 then
        raise exception 'start_session: break duration_s must be between 1 and 86400'
          using errcode = '22023';
      end if;

      if (v_break->>'at_s')::bigint <= v_prev_at then
        raise exception 'start_session: break at_s values must be strictly increasing'
          using errcode = '22023';
      end if;
      v_prev_at := (v_break->>'at_s')::bigint;

      v_total_break_s := v_total_break_s + (v_break->>'duration_s')::bigint;
    end loop;

    if p_planned_duration_s + v_total_break_s > 86400 then
      raise exception 'start_session: planned_duration_s plus total break time must not exceed 86400'
        using errcode = '22023';
    end if;
  end if;

  -- 0034: resolves the block's current attribution AND proves ownership in
  -- one query -- `if not found` below replaces 0033's separate `not
  -- exists(...)` probe entirely, since this select already fails to find a
  -- row under the exact same predicate.
  if p_block_id is not null then
    select b.plan_id, b.category_id, b.topic_id
      into v_block_plan_id, v_block_category_id, v_block_topic_id
    from public.blocks b
    where b.id = p_block_id and b.user_id = v_uid;

    if not found then
      raise exception 'start_session: block % not found for this user', p_block_id
        using errcode = '42501';
    end if;
  end if;

  if exists (
    select 1 from public.focus_sessions s
    where s.user_id = v_uid and s.state = 'running'
  ) then
    raise exception 'start_session: a session is already running'
      using errcode = '55006';
  end if;

  insert into public.focus_sessions
    (user_id, room_id, block_id, plan_id, category_id, topic_id, started_at, planned_duration_s,
     state, completed_at, break_plan)
  values (
    v_uid, null, p_block_id, v_block_plan_id, v_block_category_id, v_block_topic_id,
    now(), p_planned_duration_s, 'running', null, p_break_plan
  )
  returning * into v_row;

  perform public.append_event(
    v_uid,
    'session_started',
    jsonb_build_object(
      'block_id', p_block_id,
      'planned_duration_s', p_planned_duration_s,
      'break_count', case
        when p_break_plan is null then 0
        else jsonb_array_length(p_break_plan->'breaks')
      end
    ),
    v_row.id
  );

  if p_block_id is not null then
    update public.blocks b
       set started_at = now()
     where b.id = p_block_id
       and b.user_id = v_uid
       and b.started_at is null;

    if found then
      perform public.append_event(
        v_uid, 'task_started',
        jsonb_build_object('block_id', p_block_id::text, 'source', 'focus_session'),
        v_row.id
      );
    end if;
  end if;

  return v_row;
end;
$$;

alter function public.start_session(uuid, integer, jsonb) owner to postgres;
revoke execute on function public.start_session(uuid, integer, jsonb) from public, anon, authenticated;
grant execute on function public.start_session(uuid, integer, jsonb) to authenticated;

comment on function public.start_session(uuid, integer, jsonb) is
  'Starts a focus session, server-stamping started_at and validating an optional break plan (0023). 0034: when p_block_id is given, snapshots that block''s plan_id/category_id/topic_id onto the new focus_sessions row (never re-derived from a later join -- see those columns'' own comments) -- the same select also proves block ownership, replacing 0033''s separate existence probe. 0033: also stamps blocks.started_at once, if unset, and mints task_started {source: focus_session}. See docs/architecture/api.md sec3h/sec3p/sec3q.';
