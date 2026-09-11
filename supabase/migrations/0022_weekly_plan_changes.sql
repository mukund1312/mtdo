-- Phase 7 of the operating-engine plan: the weekly change set.
--
-- 0021 computes what happened. This stores what the rule engine PROPOSES to
-- do about it, and applies a change only once a human has said yes.
--
-- Nothing here is AI-generated. weekly_plans.generated_by is 'rules_v1', a
-- versioned non-AI-implying string, because that is the truth AND because it
-- leaves room for a real 'ai_v1' generator later without a schema change --
-- see decisions.md 2026-09-11 ("The weekly engine is deterministic by
-- design").

-- 1. weekly_plans ----------------------------------------------------------
-- One review per (plan, reviewed week). The changes it proposes apply to
-- effective_iso_week, which is the week AFTER the one under review -- keeping
-- those two as separate columns rather than inferring one from the other is
-- what stops "which week is this about" from being ambiguous at every read
-- site.

create table public.weekly_plans (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  plan_id uuid not null,
  -- The week whose performance was reviewed, 'IYYY-"W"IW' (0021's
  -- iso_week_start() parses it; same vocabulary as
  -- plan_categories.menu_unlocked_iso_week).
  iso_week text not null,
  -- The week the proposed changes take effect in.
  effective_iso_week text not null,
  status text not null default 'proposed'
    check (status in ('proposed', 'accepted', 'rejected', 'partial')),
  -- The FULL weekly_performance() output for both trailing weeks, exactly as
  -- the engine saw it: {schema_version, current, previous}. `previous` is
  -- null for a plan's first-ever review. This is an audit snapshot, frozen on
  -- purpose -- never read it back INSTEAD of calling weekly_performance()
  -- for a live number, or the Review deck starts showing history as if it
  -- were today.
  metrics jsonb not null,
  -- Versioned, and deliberately not 'ai'. See this file's header.
  generated_by text not null default 'rules_v1',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint weekly_plans_iso_week_format check (iso_week ~ '^[0-9]{4}-W[0-9]{2}$'),
  constraint weekly_plans_effective_week_format
    check (effective_iso_week ~ '^[0-9]{4}-W[0-9]{2}$'),
  -- One review per plan per reviewed week. Re-running generation for the same
  -- week updates that review rather than stacking a second one beside it.
  constraint weekly_plans_plan_week_key unique (plan_id, iso_week),
  -- Target of weekly_plan_changes' composite FK.
  constraint weekly_plans_id_user_key unique (id, user_id),
  -- OWNERSHIP CHAIN (schema.md sec2): the review's plan must belong to the
  -- review's user. RESTRICT for the same reason blocks uses it -- a plan is
  -- retired, never deleted, and a user's review history is part of the record
  -- the free tier promises to keep.
  constraint weekly_plans_plan_fk foreign key (plan_id, user_id)
    references public.plans (id, user_id) on delete restrict
);

create index weekly_plans_user_week_idx on public.weekly_plans (user_id, iso_week desc);
create index weekly_plans_plan_idx on public.weekly_plans (plan_id);

-- 2. weekly_plan_changes ---------------------------------------------------

create table public.weekly_plan_changes (
  id uuid primary key default gen_random_uuid(),
  weekly_plan_id uuid not null,
  user_id uuid not null references auth.users (id) on delete cascade,
  -- Carried so the composite FK to plan_categories can exist at all
  -- (plan_categories is keyed (id, plan_id), it has no user_id of its own).
  -- Same denormalisation-for-an-ownership-chain trade blocks already makes.
  plan_id uuid not null,

  -- The MECHANISM, not the direction -- direction is already readable from
  -- old_value vs new_value, and `signal` already says why. A new lever later
  -- adds a value here without needing a new signal vocabulary.
  --   'weekly_target_blocks' -- adjust plan_categories.weekly_target_blocks
  --   'flag_question'        -- ask the user something; applies NOTHING, ever
  change_type text not null check (change_type in ('weekly_target_blocks', 'flag_question')),

  -- Which plan_categories row this is about. Always set today (every rule is
  -- per-category); nullable so a future plan-wide proposal does not need a
  -- migration.
  target_category_id uuid,

  old_value numeric,
  new_value numeric,

  -- Plain, specific, built from the actual computed numbers. No model wrote
  -- this string and none ever should -- see decisions.md 2026-09-11.
  reason text not null,
  constraint weekly_plan_changes_reason_not_blank check (btrim(reason) <> ''),

  -- Which classification produced it.
  signal text not null check (signal in ('struggling', 'coasting', 'avoided')),

  status text not null default 'pending'
    check (status in ('pending', 'accepted', 'rejected', 'edited')),
  decided_at timestamptz,
  created_at timestamptz not null default now(),

  -- A decided change must carry when it was decided, and a pending one must
  -- not -- the same state/timestamp agreement focus_sessions enforces between
  -- state and completed_at.
  constraint weekly_plan_changes_decided_pairing
    check ((status = 'pending') = (decided_at is null)),
  -- A numeric change must carry both numbers; a flagged question must carry
  -- neither. Without this, "accept" has no defined meaning for a half-filled
  -- row.
  constraint weekly_plan_changes_values_match_type check (
    (change_type = 'flag_question' and old_value is null and new_value is null)
    or (change_type <> 'flag_question' and old_value is not null and new_value is not null)
  ),

  constraint weekly_plan_changes_id_user_key unique (id, user_id),
  constraint weekly_plan_changes_plan_fk foreign key (weekly_plan_id, user_id)
    references public.weekly_plans (id, user_id) on delete cascade,
  constraint weekly_plan_changes_category_fk foreign key (target_category_id, plan_id)
    references public.plan_categories (id, plan_id) on delete cascade
);

create index weekly_plan_changes_plan_idx
  on public.weekly_plan_changes (weekly_plan_id, status);
create index weekly_plan_changes_user_idx on public.weekly_plan_changes (user_id);
create index weekly_plan_changes_category_plan_idx
  on public.weekly_plan_changes (target_category_id, plan_id);

create trigger weekly_plans_set_updated_at
  before update on public.weekly_plans
  for each row execute function public.set_updated_at();

-- 3. RLS and grants --------------------------------------------------------
-- Posture: SELECT-own to the client; every write goes through one of the
-- three `security definer` RPCs below. Closest existing shape:
-- calendar_event_links (0020) and ai_generations (0015).
--
-- Why not ordinary client-writable, given plan_categories itself is? Because
-- the RPCs are where the hard constraints live (the cap, the "flagged
-- questions never auto-apply" rule, the parent-status recompute). If a client
-- could write these rows directly, "accepted" would stop meaning "was applied
-- under the constraints" and start meaning "some tab said so" -- and
-- weekly_plans.metrics, which is an audit record of what the engine saw,
-- would be rewritable after the fact. Same reasoning that makes
-- activity_events append-only.
--
-- WHY THE WRITE PATH IS AN AUTHENTICATED RPC AND NOT THE SERVICE-ROLE CLIENT.
-- The calendar routes (0020) needed service-role because they write a table
-- no client role may touch at all. Nothing here is like that: a review is
-- entirely the caller's own data, derived from their own plan. Routing
-- generation through save_weekly_plan() instead means (a) the review and all
-- of its changes land in ONE transaction rather than an insert followed by a
-- batch that can half-fail, (b) ownership is proved by auth.uid() rather than
-- by a Route Handler remembering to scope every query itself (rule 2 of
-- service.ts's own header), and (c) the weekly engine does not stop working
-- in a deployment that has no SUPABASE_SERVICE_ROLE_KEY -- which this one
-- currently does not.

alter table public.weekly_plans enable row level security;
alter table public.weekly_plan_changes enable row level security;

create policy "weekly_plans_select_own" on public.weekly_plans
  for select to authenticated
  using ((select auth.uid()) = user_id);

create policy "weekly_plan_changes_select_own" on public.weekly_plan_changes
  for select to authenticated
  using ((select auth.uid()) = user_id);

-- Explicit REVOKEs, not merely absent policies. schema.md sec6's opening
-- paragraph is why: Supabase's default privileges grant ALL on new tables to
-- anon/authenticated, so "no policy for that command" is an incidental denial
-- a future `for all` policy would silently undo. This is also the
-- "every future migration that creates a table in public must re-run that
-- revoke" rule from sec6 -- TRUNCATE is not subject to RLS at all.
revoke all on public.weekly_plans from anon, authenticated;
revoke all on public.weekly_plan_changes from anon, authenticated;
grant select on public.weekly_plans to authenticated;
grant select on public.weekly_plan_changes to authenticated;

-- 4. save_weekly_plan() ----------------------------------------------------
-- Stores one generated review and its whole change set, atomically.
--
-- The rules engine itself lives in TypeScript (web/lib/planning/**) -- see
-- decisions.md 2026-09-11 for the split and why. This function is the write
-- half, and it deliberately RE-VALIDATES every incoming change against the
-- same rails apply_weekly_plan_change() enforces, rather than trusting that
-- the caller was the real engine. A stored proposal that violates the cap
-- would be a proposal that fails the instant a user clicks accept, which is
-- the worst place to discover it.
--
-- p_changes is a jsonb array of objects:
--   {change_type, target_category_id, old_value, new_value, reason, signal}

create function public.save_weekly_plan(
  p_plan_id uuid,
  p_iso_week text,
  p_effective_iso_week text,
  p_metrics jsonb,
  p_changes jsonb
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_weekly_plan_id uuid;
  v_decided integer;
  v_change jsonb;
  v_old numeric;
  v_new numeric;
  v_type text;
  v_category uuid;
begin
  if v_uid is null then
    raise exception 'save_weekly_plan: no authenticated user' using errcode = '42501';
  end if;

  if p_metrics is null or jsonb_typeof(p_metrics) <> 'object' then
    raise exception 'save_weekly_plan: p_metrics must be a jsonb object' using errcode = '22023';
  end if;
  if p_changes is null or jsonb_typeof(p_changes) <> 'array' then
    raise exception 'save_weekly_plan: p_changes must be a jsonb array' using errcode = '22023';
  end if;

  -- Validates the format too: iso_week_start() raises 22023 on anything that
  -- is not 'YYYY-Www', so a malformed week cannot reach the table's CHECK.
  perform public.iso_week_start(p_iso_week);
  perform public.iso_week_start(p_effective_iso_week);

  perform pg_advisory_xact_lock(hashtext('mtdo.curriculum_menu:' || v_uid::text));

  if not exists (
    select 1 from public.plans p where p.id = p_plan_id and p.user_id = v_uid
  ) then
    raise exception 'save_weekly_plan: plan % not available for this user', p_plan_id
      using errcode = '42501';
  end if;

  select w.id into v_weekly_plan_id
  from public.weekly_plans w
  where w.plan_id = p_plan_id and w.iso_week = p_iso_week;

  if v_weekly_plan_id is not null then
    -- Regenerating a review the user has already acted on would silently
    -- destroy their decisions -- and, because accepting already wrote the new
    -- target to plan_categories, would then re-propose a change relative to
    -- the value they just accepted. Refused outright; the caller checks first
    -- and reports an honest no-op.
    select count(*) into v_decided
    from public.weekly_plan_changes c
    where c.weekly_plan_id = v_weekly_plan_id and c.status <> 'pending';

    if v_decided > 0 then
      raise exception 'save_weekly_plan: review for % has % decided change(s) already',
        p_iso_week, v_decided using errcode = '22023';
    end if;

    delete from public.weekly_plan_changes where weekly_plan_id = v_weekly_plan_id;
    update public.weekly_plans
    set metrics = p_metrics,
        effective_iso_week = p_effective_iso_week,
        status = 'proposed',
        generated_by = 'rules_v1'
    where id = v_weekly_plan_id;
  else
    insert into public.weekly_plans
      (user_id, plan_id, iso_week, effective_iso_week, metrics, generated_by, status)
    values (v_uid, p_plan_id, p_iso_week, p_effective_iso_week, p_metrics, 'rules_v1', 'proposed')
    returning id into v_weekly_plan_id;
  end if;

  for v_change in select * from jsonb_array_elements(p_changes)
  loop
    v_type := v_change->>'change_type';
    v_category := (v_change->>'target_category_id')::uuid;
    v_old := (v_change->>'old_value')::numeric;
    v_new := (v_change->>'new_value')::numeric;

    if v_category is null or not exists (
      select 1 from public.plan_categories pc
      where pc.id = v_category and pc.plan_id = p_plan_id
    ) then
      raise exception 'save_weekly_plan: category % is not part of plan %', v_category, p_plan_id
        using errcode = '22023';
    end if;

    if v_type = 'weekly_target_blocks' then
      if v_old is null or v_new is null then
        raise exception 'save_weekly_plan: a weekly_target_blocks change needs both values'
          using errcode = '22023';
      end if;
      if v_new < 1 then
        raise exception 'save_weekly_plan: a weekly target must be at least 1, got %', v_new
          using errcode = '22023';
      end if;
      if v_old <= 0 then
        raise exception 'save_weekly_plan: change has no usable baseline' using errcode = '22023';
      end if;
      -- The same rail apply_weekly_plan_change() applies: +/-30%, or one
      -- whole block, whichever is larger. Checked here so an out-of-rail
      -- proposal can never be STORED, not merely never applied.
      if abs(v_new - v_old) > 1 and (v_new / v_old < 0.7 or v_new / v_old > 1.3) then
        raise exception
          'save_weekly_plan: % is more than one block and more than 30%% away from %', v_new, v_old
          using errcode = '22023';
      end if;
    elsif v_type = 'flag_question' then
      if v_old is not null or v_new is not null then
        raise exception 'save_weekly_plan: a flag_question change carries no values'
          using errcode = '22023';
      end if;
    else
      raise exception 'save_weekly_plan: unknown change_type %', v_type using errcode = '22023';
    end if;

    insert into public.weekly_plan_changes
      (weekly_plan_id, user_id, plan_id, change_type, target_category_id,
       old_value, new_value, reason, signal, status)
    values (
      v_weekly_plan_id, v_uid, p_plan_id, v_type, v_category,
      v_old, v_new, v_change->>'reason', v_change->>'signal', 'pending'
    );
  end loop;

  -- A review that proposed nothing has nothing outstanding, so this settles
  -- it to 'accepted' immediately rather than leaving it forever 'proposed'
  -- and looking like it is waiting on the user.
  perform public.refresh_weekly_plan_status(v_weekly_plan_id);

  return v_weekly_plan_id;
end;
$$;

alter function public.save_weekly_plan(uuid, text, text, jsonb, jsonb) owner to postgres;
revoke execute on function public.save_weekly_plan(uuid, text, text, jsonb, jsonb)
  from public, anon;
grant execute on function public.save_weekly_plan(uuid, text, text, jsonb, jsonb) to authenticated;

comment on function public.save_weekly_plan(uuid, text, text, jsonb, jsonb) is
  'Stores one generated weekly review and its full change set in one transaction. Re-validates every change against the same rails apply_weekly_plan_change() enforces, so an out-of-rail proposal can never be stored. Refuses (22023) to regenerate a review that already has decided changes. See docs/architecture/api.md sec3g.';

-- 5. apply_weekly_plan_change() -------------------------------------------
-- Accept, reject, or accept-with-an-edited-value, for ONE proposed change.
--
-- THE HARD CONSTRAINTS ARE ENFORCED HERE, not only in the TypeScript that
-- generates proposals. Three of the four are structural -- there is simply no
-- code path in this function that writes plans.goal_line or
-- plan_categories.days, so "never modifies the goal line" and "never
-- increases days" are true by construction rather than by discipline. The
-- +/-30% cap is the one that needs an actual check, and it is checked against
-- the value being applied, so a user's hand-edited value is bounded by the
-- same rail as a generated one.
--
-- The fourth constraint -- never propose an increase in a week whose overall
-- completion was below the floor -- is deliberately NOT re-checked here. It
-- is a property of the moment a proposal was GENERATED (it needs that week's
-- metrics, which is what weekly_plans.metrics froze), and re-deriving it at
-- apply time would mean recomputing a past week on every click and could flip
-- a proposal the user is looking at. It lives in web/lib/planning/classify.ts
-- and is recorded in decisions.md.

create function public.apply_weekly_plan_change(
  p_change_id uuid,
  p_decision text,
  p_new_value numeric default null
)
returns public.weekly_plan_changes
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_change public.weekly_plan_changes;
  v_applied numeric;
  v_status text;
  v_ratio numeric;
begin
  if v_uid is null then
    raise exception 'apply_weekly_plan_change: no authenticated user' using errcode = '42501';
  end if;

  if p_decision is null or p_decision not in ('accepted', 'rejected') then
    raise exception 'apply_weekly_plan_change: p_decision must be accepted or rejected, got %', p_decision
      using errcode = '22023';
  end if;

  -- Same per-user advisory lock key as ensure_curriculum_menu(),
  -- pick_curriculum_item(), extend_plan() and schedule_block(). An accepted
  -- change writes plan_categories, which is half of the (cursor, position)
  -- invariant pair those four serialize on, so this must serialize with them
  -- too -- all five now share the key.
  perform pg_advisory_xact_lock(hashtext('mtdo.curriculum_menu:' || v_uid::text));

  -- Ownership re-checked here, not just in RLS: security definer is exempt
  -- from RLS, so this predicate IS the access control.
  select c.* into v_change
  from public.weekly_plan_changes c
  where c.id = p_change_id and c.user_id = v_uid
  for update;

  if v_change.id is null then
    -- Does not distinguish "not yours" from "no such change", same posture as
    -- the other RPCs here.
    raise exception 'apply_weekly_plan_change: change % not available for this user', p_change_id
      using errcode = '42501';
  end if;

  if v_change.status <> 'pending' then
    -- A decision is made once. Re-deciding would silently re-apply an
    -- adjustment on top of itself -- accept the same +25% twice and the
    -- category has quietly gained 56%.
    raise exception 'apply_weekly_plan_change: change % is already %', p_change_id, v_change.status
      using errcode = '22023';
  end if;

  if p_decision = 'rejected' then
    v_status := 'rejected';

  elsif v_change.change_type = 'flag_question' then
    -- A flagged question NEVER applies a numeric change, by construction --
    -- there is no branch below that could. Accepting one records that the
    -- user answered it and nothing else. This is what makes "must not
    -- auto-apply even on accept-all" structural rather than a UI promise;
    -- accept_all_weekly_plan_changes() additionally refuses to touch these
    -- rows at all.
    if p_new_value is not null then
      raise exception 'apply_weekly_plan_change: a flag_question change takes no value'
        using errcode = '22023';
    end if;
    v_status := 'accepted';

  else
    v_applied := coalesce(p_new_value, v_change.new_value);
    v_status := case when p_new_value is null then 'accepted' else 'edited' end;

    -- A weekly target of zero means "stop doing this category", which is a
    -- deliberate choice a user makes by answering a flagged question -- never
    -- something a pace nudge arrives at by arithmetic.
    if v_applied < 1 then
      raise exception 'apply_weekly_plan_change: a weekly target must be at least 1, got %', v_applied
        using errcode = '22023';
    end if;

    -- THE CAP: +/-30% OF old_value, OR one whole block, WHICHEVER IS LARGER.
    -- Bounded against old_value -- the pace in force when the proposal was
    -- made -- so no single week can swing a category's load wildly no matter
    -- how extreme the raw signal was, or how large a number a client passes
    -- in p_new_value.
    --
    -- The "or one whole block" half is not a loophole, it is what makes the
    -- rail implementable at all. Targets are integers and real ones are
    -- small: at a target of 3, one extra block is a 33% move, so a flat 30%
    -- rail would round every proposal straight back to 3 and the engine would
    -- silently never adjust a 3-block category in either direction -- a dead
    -- zone that looks exactly like "the rules never fire". One block is the
    -- smallest change that can be expressed; the proportional rail is what
    -- binds once targets are large enough for it to mean something (at a
    -- target of 10 it allows 7..13, not 9..11).
    --
    -- web/lib/planning/thresholds.ts computes proposals against this same
    -- rule. The two MUST agree: if the generator could propose a value this
    -- function rejects, every such proposal would fail at the moment a user
    -- clicked accept.
    if v_change.old_value is null or v_change.old_value <= 0 then
      raise exception 'apply_weekly_plan_change: change % has no usable baseline', p_change_id
        using errcode = '22023';
    end if;
    v_ratio := v_applied / v_change.old_value;
    if abs(v_applied - v_change.old_value) > 1 and (v_ratio < 0.7 or v_ratio > 1.3) then
      raise exception
        'apply_weekly_plan_change: % is more than one block and more than 30%% away from the current pace of %',
        v_applied, v_change.old_value
        using errcode = '22023';
    end if;

    -- The only write to user plan state this whole subsystem performs.
    -- Scoped by plan_id as well as id: the composite FK guarantees the
    -- category belongs to this change's plan, and this keeps that true at the
    -- write rather than trusting it.
    update public.plan_categories pc
    set weekly_target_blocks = v_applied::integer
    where pc.id = v_change.target_category_id
      and pc.plan_id = v_change.plan_id;

    if not found then
      raise exception 'apply_weekly_plan_change: target category for change % no longer exists', p_change_id
        using errcode = '22023';
    end if;

    -- new_value records what was ACTUALLY applied, not what was proposed --
    -- an edited row whose new_value still read as the engine's suggestion
    -- would make the history lie about what happened to the plan.
    v_change.new_value := v_applied;
  end if;

  update public.weekly_plan_changes c
  set status = v_status,
      new_value = v_change.new_value,
      decided_at = now()
  where c.id = p_change_id and c.user_id = v_uid
  returning * into v_change;

  perform public.refresh_weekly_plan_status(v_change.weekly_plan_id);

  return v_change;
end;
$$;

alter function public.apply_weekly_plan_change(uuid, text, numeric) owner to postgres;
revoke execute on function public.apply_weekly_plan_change(uuid, text, numeric)
  from public, anon;
grant execute on function public.apply_weekly_plan_change(uuid, text, numeric) to authenticated;

comment on function public.apply_weekly_plan_change(uuid, text, numeric) is
  'Accepts, rejects, or accepts-with-an-edited-value one proposed weekly plan change, applying an accepted one to plan_categories.weekly_target_blocks under the shared per-user advisory lock. Enforces the +/-30% cap against old_value (including on a client-supplied p_new_value) and a minimum target of 1; a flag_question change applies nothing, ever. Decisions are final -- re-deciding raises 22023 so an adjustment cannot compound on itself. See docs/architecture/api.md sec3g.';

-- 6. refresh_weekly_plan_status() -----------------------------------------
-- The parent status is RECOMPUTED from its children after every decision
-- rather than being written alongside them, so it cannot drift out of
-- agreement with the rows it summarises.

create function public.refresh_weekly_plan_status(p_weekly_plan_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_pending integer;
  v_accepted integer;
  v_rejected integer;
  v_status text;
begin
  select count(*) filter (where status = 'pending'),
         count(*) filter (where status in ('accepted', 'edited')),
         count(*) filter (where status = 'rejected')
    into v_pending, v_accepted, v_rejected
  from public.weekly_plan_changes
  where weekly_plan_id = p_weekly_plan_id;

  v_status := case
    -- Anything still undecided keeps the whole review open, including a
    -- flagged question the user skipped past on accept-all. That is the
    -- point: the review is not finished until the question is answered.
    when v_pending > 0 then 'proposed'
    when v_accepted > 0 and v_rejected > 0 then 'partial'
    when v_accepted > 0 then 'accepted'
    when v_rejected > 0 then 'rejected'
    -- A review that proposed nothing at all (every category on track) is
    -- 'accepted': there was nothing to decide and nothing is outstanding.
    else 'accepted'
  end;

  update public.weekly_plans set status = v_status where id = p_weekly_plan_id;
end;
$$;

alter function public.refresh_weekly_plan_status(uuid) owner to postgres;
-- Internal. Callable by nobody but the owner and the functions it is called
-- from -- same posture as append_event()/settle_session() (0001).
revoke execute on function public.refresh_weekly_plan_status(uuid)
  from public, anon, authenticated, service_role;

comment on function public.refresh_weekly_plan_status(uuid) is
  'Internal. Recomputes weekly_plans.status from its weekly_plan_changes rows so the summary cannot drift from the rows it summarises. Not callable by any client role.';

-- 7. accept_all_weekly_plan_changes() -------------------------------------
-- The "Accept all" button's single round trip.
--
-- IT SKIPS flag_question ROWS, DELIBERATELY AND STRUCTURALLY. An avoided
-- category's proposal is a question to the user ("is this still a priority?"),
-- and a question cannot be answered by a bulk gesture that means "yes to
-- everything you suggested" -- the honest answer might be no. Those rows stay
-- pending, which (see refresh_weekly_plan_status) also keeps the whole review
-- open until they are answered individually.

create function public.accept_all_weekly_plan_changes(p_weekly_plan_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_owner uuid;
  v_change public.weekly_plan_changes;
  v_applied integer := 0;
  v_skipped integer := 0;
begin
  if v_uid is null then
    raise exception 'accept_all_weekly_plan_changes: no authenticated user' using errcode = '42501';
  end if;

  select w.user_id into v_owner
  from public.weekly_plans w
  where w.id = p_weekly_plan_id and w.user_id = v_uid;

  if v_owner is null then
    raise exception 'accept_all_weekly_plan_changes: review % not available for this user', p_weekly_plan_id
      using errcode = '42501';
  end if;

  for v_change in
    select c.* from public.weekly_plan_changes c
    where c.weekly_plan_id = p_weekly_plan_id
      and c.user_id = v_uid
      and c.status = 'pending'
    order by c.created_at, c.id
  loop
    if v_change.change_type = 'flag_question' then
      v_skipped := v_skipped + 1;
    else
      -- Goes through the single-change RPC rather than reimplementing the
      -- write, so the cap, the minimum, and the status recompute cannot
      -- diverge between the two entry points.
      perform public.apply_weekly_plan_change(v_change.id, 'accepted');
      v_applied := v_applied + 1;
    end if;
  end loop;

  perform public.refresh_weekly_plan_status(p_weekly_plan_id);

  return jsonb_build_object('applied', v_applied, 'skipped_questions', v_skipped);
end;
$$;

alter function public.accept_all_weekly_plan_changes(uuid) owner to postgres;
revoke execute on function public.accept_all_weekly_plan_changes(uuid) from public, anon;
grant execute on function public.accept_all_weekly_plan_changes(uuid) to authenticated;

comment on function public.accept_all_weekly_plan_changes(uuid) is
  'Accepts every pending numeric change on one review in a single round trip, and DELIBERATELY SKIPS flag_question rows -- a question cannot be answered by a bulk "yes to everything". Returns {applied, skipped_questions}. See docs/architecture/api.md sec3g.';
