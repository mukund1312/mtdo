-- Phase G of the operating-engine plan: task/opportunity EVIDENCE. This
-- migration adds no metric, touches no `review_*`/`weekly_performance`/
-- `daily_rollups`/`study_profile` function, and does not touch the Review
-- UI. It exists to stop destroying observations that a future metric will
-- eventually want, and that today simply vanish on every edit:
--
--   1. schedule_block() (0019) REPLACES a block's time and mints no event.
--      0032's own header already names the gap: a cross-date move "leaves
--      no trace at all" -- "this schema has NO 'task rescheduled' event at
--      all."
--   2. Kanban lane changes (today-deck.tsx's moveBlock) mint an event only
--      to/from 'done'. Every other transition (todo -> in_progress, a
--      backlog pull, a bounce between todo and in_progress) is silent.
--   3. blocks.started_at EXISTS (0001) and is NEVER WRITTEN BY ANYTHING.
--      A dead column since the table's very first migration.
--   4. blocks has no created_at; estimated_minutes/priority are
--      overwritten in place with no record of what they used to be.
--   5. Nothing distinguishes cancelled from skipped from "not yet due" --
--      a poisoned denominator for any future score that tries to divide by
--      "how many opportunities were there."
--
-- GOVERNING PRINCIPLE (project law, restated here because every choice
-- below turns on it): Observation != derived feature != pattern !=
-- inference != recommendation. This migration adds observations ONLY.
-- Nothing here computes a rate, a score, a trend, or a rule. Every new
-- event is a server-witnessed fact ("this happened"); every new column is
-- either a raw fact (created_at, original_estimated_minutes) or current/
-- terminal state (disposition, cancelled_at, deleted_at). A future
-- consumer builds a metric FROM this evidence; this migration is not that
-- consumer.
--
-- ===========================================================================
-- DISPOSITION IS CURRENT STATE, NOT HISTORY
-- ===========================================================================
-- One block can carry many OPPORTUNITIES over its life -- scheduled Monday,
-- rescheduled to Tuesday, rescheduled again to Wednesday, completed
-- Wednesday -- but `blocks.disposition` is one column and can hold exactly
-- one value at a time: 'completed'. It CANNOT hold "rescheduled off Monday,
-- rescheduled off Tuesday, completed Wednesday" -- there is nowhere to put
-- the first two facts once the third overwrites the column.
--
-- So: `blocks.disposition` is the block's CURRENT/terminal state ONLY, never
-- a historical record. Opportunity-level disposition -- what actually
-- happened to each individual scheduled window -- is derived from the
-- immutable event stream (task_scheduled/task_rescheduled/task_unscheduled,
-- task_status_changed, task_disposition_set), never from this column. That
-- is why 'rescheduled' is DELIBERATELY ABSENT from the CHECK below: a
-- reschedule is not a thing a block's current state can BE, it is a thing
-- that HAPPENED to one of its opportunities, and only the ledger can say how
-- many of those there were.
--
-- ===========================================================================
-- CANCELLATION MUST NOT ERASE PAST FAILURE -- the gaming hole this closes
-- ===========================================================================
-- Without a rule here, a user could improve a future "did you follow
-- through" score by CANCELLING a task *after* having already failed to do
-- it -- the cancellation would remove the failed opportunity from whatever
-- denominator a future metric computes, laundering a miss into "it never
-- counted." The rule that prevents this, for a future consumer to apply
-- (nothing in THIS migration computes it):
--
--   CANCEL BEFORE the opportunity became eligible (e.g. before its
--     scheduled_start_at, or before its board date arrived) -> that FUTURE
--     opportunity simply leaves the denominator. Nothing to hold against
--     the user; they called it off before it was ever live.
--   CANCEL AFTER the opportunity became eligible -> the HISTORICAL
--     opportunity STAYS in the denominator exactly as it already stood.
--     Cancelling only prevents FUTURE opportunities on this block; it does
--     not retroactively un-fail (or un-succeed) anything that already
--     happened.
--   DELETE removes the object from ACTIVE PRODUCT STATE (it stops
--     appearing on any board/calendar) -- it does NOT retroactively erase
--     HISTORICAL EVIDENCE. The ledger's task_deleted event, and every event
--     minted before it, stand exactly as they were.
--   PRIVACY ERASURE is a SEPARATE, permitted process (account deletion /
--     "delete my data") that may physically remove rows. "Append-only"
--     above means immutable under NORMAL PRODUCT OPERATION -- it does not,
--     and must not, override a real privacy erasure. auth.users' ON DELETE
--     CASCADE onto activity_events (0001) already implements this; nothing
--     here weakens or second-guesses it.
--
-- `cancelled_at` (below) is what makes the before/after rule EVALUABLE by a
-- future consumer: compare it against the relevant opportunity's
-- scheduled_start_at/date. Computing that comparison is explicitly not this
-- migration's job.

-- ===========================================================================
-- 1. New server-minted ledger kinds
-- ===========================================================================
-- Exact precedent copied from 0023 (lines ~121-147), which did this same
-- ALTER for session_paused/session_resumed/session_extended: DROP then
-- ADD the CHECK with the full existing vocabulary plus the new members.
--
-- ALL NINE ARE SERVER-MINTED ONLY. None are added to record_event()'s
-- client-appendable whitelist (0001 sec4) -- a client that could self-report
-- "this got rescheduled" or "I started this" could fabricate the exact
-- evidence a future metric would trust, which is the whole reason D17's
-- server-minted rule exists. Test coverage below proves a client call fails
-- with 22023, the same proof settle_block_outcome()'s siblings already
-- established for the session_* family.
--
-- Two of the nine (task_estimate_changed, task_priority_changed) and one
-- more (task_deleted) have NO PRODUCER in this migration -- see the closing
-- note at the bottom of this file. They are added to the vocabulary now,
-- with their payload shape documented, so the schema is ready the moment a
-- real editor/delete UI exists; minting them is that future feature's job,
-- not this one's.
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
    -- 0033, all server-minted only:
    'task_scheduled',
    'task_rescheduled',
    'task_unscheduled',
    'task_started',
    'task_status_changed',
    'task_estimate_changed',
    'task_priority_changed',
    'task_disposition_set',
    'task_deleted'
  ));

-- ===========================================================================
-- 2. Schema additions to `blocks` -- all additive, all nullable, no
--    existing row ever gets a guessed value. See each column's own comment.
-- ===========================================================================
--
-- created_at IS ADDED WITHOUT A DEFAULT, DELIBERATELY, AND THEN GIVEN ONE IN
-- A SEPARATE STATEMENT. `add column created_at timestamptz not null default
-- now()` in one statement would backfill every EXISTING block to this
-- migration's own run timestamp -- a single fabricated value standing in for
-- hundreds of real creation times, and a silent violation of this project's
-- own null-over-guess law (weekly_performance()'s null-vs-0 discipline,
-- study_profile()'s "null below the gate, never inferred from too little
-- evidence"). A future "how far ahead does this user plan?" query grouping
-- blocks by created_at would read that fabricated spike as fact. So: add the
-- column bare (nullable, no default -- every existing row gets a real NULL,
-- meaning "unknown, never captured", not a guess), THEN attach the default
-- with ALTER COLUMN, which only governs INSERTs from this point forward and
-- touches no existing row. Postgres 11+ makes this two-statement split cheap
-- either way (a constant DEFAULT is metadata-only, no table rewrite) -- the
-- reason for two statements here is correctness, not performance.

alter table public.blocks
  add column created_at timestamptz;

alter table public.blocks
  alter column created_at set default now();

alter table public.blocks
  -- Set EXACTLY ONCE, in pick_curriculum_item(), from the curriculum item's
  -- estimate at pick time. Never written again by anything -- including a
  -- re-pick of an already-picked item, which returns the existing row
  -- untouched (0019's own idempotence rule). This is what makes planning
  -- calibration ("did the user finish near what they originally committed
  -- to?") measurable against the ORIGINAL commitment even though
  -- estimated_minutes itself stays freely client-writable and can drift.
  add column original_estimated_minutes integer check (original_estimated_minutes > 0),
  -- CURRENT/terminal task state only -- see this file's header. 'rescheduled'
  -- is deliberately absent; a reschedule is ledger history, not a state this
  -- column can hold. Written only through transition_block_status() below,
  -- though blocks stays an ordinary client-writable table for everything
  -- else (same posture settle_block_outcome() already established for
  -- status/notes) -- see that function's own comment for why this is not an
  -- RLS gap.
  add column disposition text
    check (disposition in ('completed', 'skipped', 'abandoned', 'cancelled', 'not_due_yet')),
  -- Soft-delete marker. Nothing in this migration sets, reads, or filters
  -- on it -- there is no delete-block UI anywhere in the product today (the
  -- only removal path was, and remains, a raw client DELETE via
  -- blocks_owner_all). Added now, alongside task_deleted, so the column and
  -- the event exist together and a future delete flow does not also need a
  -- migration.
  add column deleted_at timestamptz,
  -- Set once, the first time disposition = 'cancelled' is written (never
  -- moved on a repeat cancellation). This is the timestamp a future
  -- consumer compares against an opportunity's scheduled_start_at/date to
  -- apply the before/after cancellation rule in this file's header.
  add column cancelled_at timestamptz;

comment on column public.blocks.created_at is
  'Server-stamped row creation time (0033). NULLABLE, deliberately: a PRE-0033 block''s true creation date was never captured, and this column reads NULL for one rather than inventing a value -- same null-over-guess law as weekly_performance()''s null-vs-0 discipline and study_profile()''s confidence gate. The DEFAULT now() is attached in a separate ALTER COLUMN statement from the ADD COLUMN above specifically so it governs INSERTs only and never backfills an existing row -- every block created from 0033 onward carries a real, non-null creation time; every block from before it honestly does not.';
comment on column public.blocks.original_estimated_minutes is
  'The curriculum item''s estimate at PICK TIME, copied once by pick_curriculum_item() (0033) and never written again -- including by a repeat pick, which returns the existing row untouched. estimated_minutes itself stays freely client-editable; this column is what lets a future metric measure drift against the ORIGINAL commitment rather than whatever estimate is current. NULL for a hand-composed block or a picked item that never had an estimate -- never a guessed value.';
comment on column public.blocks.disposition is
  'CURRENT/terminal task state, not history -- see this migration''s header. completed/skipped/abandoned/cancelled/not_due_yet. Deliberately does NOT include ''rescheduled'': a reschedule is a fact about one past opportunity, derivable only from the ledger (task_scheduled/task_rescheduled/task_status_changed/task_disposition_set), never a state this single column can represent for a block with several opportunities in its history. Written by transition_block_status() (0033); blocks stays otherwise client-writable, same posture as settle_block_outcome() already established for status/notes.';
comment on column public.blocks.deleted_at is
  'Soft-delete marker (0033). Nothing in this codebase sets or reads it yet -- there is no delete-block UI today, only a raw client DELETE via blocks_owner_all. Added alongside the task_deleted ledger kind so a future delete flow needs no further migration. A real DELETE, should the client use its existing full-CRUD grant, does not retroactively erase ledger evidence either way -- see this migration''s header.';
comment on column public.blocks.cancelled_at is
  'Set once, the first time disposition is written as ''cancelled'' (never moved on a repeat cancellation). Exists so a future consumer can apply the before/after cancellation rule in this migration''s header: compare this timestamp against the relevant opportunity''s scheduled_start_at/date to decide whether that opportunity leaves the denominator (cancelled before eligible) or stays in it (cancelled after).';

-- ===========================================================================
-- 3. transition_block_status() -- the one server-authoritative RPC for
--    lifecycle writes to a block's status/disposition.
-- ===========================================================================
-- Same posture as settle_block_outcome() (0023): `blocks` remains an
-- ordinary client-writable table (blocks_owner_all is still `for all`) and
-- this is NOT an RLS workaround. It exists because status/disposition/
-- started_at/cancelled_at are FIVE things that must move together as one
-- fact -- exactly the "one transaction, not two client calls" argument
-- 0023's header already made for settle_block_outcome(). A client that
-- wrote `status = 'in_progress'` directly (today-deck.tsx did, until this
-- migration) would move the board and leave started_at dead and the ledger
-- silent, which is problems #2/#3 in this file's opening list.
--
-- `p_source` is REQUIRED PROVENANCE, not a decoration -- every call names
-- which surface drove it (a Kanban drag is not the same fact as a calendar
-- drag is not the same fact as the session screen marking a task started).
-- Defaults to 'manual' only because a bare RPC call with no other context
-- (e.g. from psql, from a test) has to resolve to *something*, and "someone
-- did this on purpose without a more specific surface" is the honest
-- reading of that default -- every real call site below passes an explicit,
-- more specific source.
--
-- WHY TWO SEPARATE EVENT KINDS FOR ONE UPDATE (task_status_changed AND
-- task_disposition_set). A status change and a disposition change are
-- different questions a future reader might ask ("when did this move
-- lanes" vs "when was this task's fate decided"), and status changes far
-- more often than disposition does -- collapsing them into one kind would
-- force every disposition-history query to filter noise out of the
-- board's ordinary lane traffic. Both are minted from the SAME atomic
-- write and both are GUARDED on a real change (IS DISTINCT FROM the
-- prior value) -- an unchanged re-call, like schedule_block()'s own
-- no-op rule below, mints nothing.
create function public.transition_block_status(
  p_block_id uuid,
  p_to_status text,
  p_source text default 'manual',
  p_disposition text default null
)
returns public.blocks
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_row public.blocks;
  v_from text;
  v_old_disposition text;
  v_mint_started boolean;
begin
  if v_uid is null then
    raise exception 'transition_block_status: no authenticated user' using errcode = '42501';
  end if;

  if p_to_status is null or p_to_status not in ('backlog', 'todo', 'in_progress', 'done') then
    raise exception 'transition_block_status: p_to_status must be one of backlog/todo/in_progress/done'
      using errcode = '22023';
  end if;

  if p_source is null or p_source not in
    ('focus_session', 'kanban_transition', 'calendar', 'manual', 'system') then
    raise exception
      'transition_block_status: p_source must be one of focus_session/kanban_transition/calendar/manual/system'
      using errcode = '22023';
  end if;

  if p_disposition is not null and p_disposition not in
    ('completed', 'skipped', 'abandoned', 'cancelled', 'not_due_yet') then
    raise exception
      'transition_block_status: p_disposition must be one of completed/skipped/abandoned/cancelled/not_due_yet'
      using errcode = '22023';
  end if;

  -- Ownership is re-checked here, not just in RLS: this function is owned by
  -- postgres and is therefore exempt from RLS, so this predicate IS the
  -- access control. Row-locked so a concurrent double-call cannot both read
  -- started_at as null and both decide to mint task_started.
  select b.* into v_row from public.blocks b
  where b.id = p_block_id and b.user_id = v_uid
  for update;

  if v_row.id is null then
    -- Deliberately does not distinguish "not yours" from "no such block" --
    -- a distinguishable error would confirm the existence of another user's
    -- block id. Same posture as schedule_block()/pick_curriculum_item().
    raise exception 'transition_block_status: block % not available for this user', p_block_id
      using errcode = '42501';
  end if;

  v_from := v_row.status;
  v_old_disposition := v_row.disposition;
  -- THE ONE-TIME GUARD. started_at is set if and only if it is currently
  -- NULL and this call is a transition INTO in_progress -- never overwritten
  -- once real. A second in_progress transition (e.g. a regression back into
  -- progress after being bounced to done and back) leaves it exactly where
  -- it was. start_session() (0033) shares this exact same guard on the same
  -- column for the focus-session entry point -- whichever path gets there
  -- first wins, permanently.
  v_mint_started := (v_row.started_at is null and p_to_status = 'in_progress');

  update public.blocks b
     set status = p_to_status,
         disposition = p_disposition,
         -- Folded in for parity with the raw `.update({ claimed, status })`
         -- this RPC replaces in today-deck.tsx -- claimed is a purely
         -- cosmetic "is a live timer on this" marker (the Kanban card's
         -- is-claimed CSS class), not lifecycle evidence, but it must move
         -- atomically with status or a reload would show a claimed=false
         -- card sitting in the in_progress lane. settle_block_outcome()
         -- (0023) already owns this same column at session end for the
         -- same reason.
         claimed = (p_to_status = 'in_progress'),
         started_at = case when v_mint_started then now() else b.started_at end,
         cancelled_at = case
           when p_disposition = 'cancelled' and b.cancelled_at is null then now()
           else b.cancelled_at
         end
   where b.id = p_block_id and b.user_id = v_uid
  returning * into v_row;

  if v_mint_started then
    perform public.append_event(
      v_uid, 'task_started',
      jsonb_build_object('block_id', v_row.id::text, 'source', p_source)
    );
  end if;

  -- Guarded on a REAL change, same "no event for a no-op" rule
  -- schedule_block() applies to an unchanged re-save below.
  if v_from is distinct from p_to_status then
    perform public.append_event(
      v_uid, 'task_status_changed',
      jsonb_build_object(
        'block_id', v_row.id::text, 'from', v_from, 'to', p_to_status,
        'source', p_source, 'disposition', p_disposition
      )
    );
  end if;

  if v_old_disposition is distinct from p_disposition then
    perform public.append_event(
      v_uid, 'task_disposition_set',
      jsonb_build_object(
        'block_id', v_row.id::text, 'from', v_old_disposition, 'to', p_disposition,
        'source', p_source
      )
    );
  end if;

  return v_row;
end;
$$;

alter function public.transition_block_status(uuid, text, text, text) owner to postgres;
revoke execute on function public.transition_block_status(uuid, text, text, text)
  from public, anon, authenticated;
grant execute on function public.transition_block_status(uuid, text, text, text) to authenticated;

comment on function public.transition_block_status(uuid, text, text, text) is
  'The one server-authoritative write path for a block''s lifecycle: status, disposition, claimed (mirrors status = in_progress, same posture settle_block_outcome() already owns it with), started_at (set once, never overwritten), and cancelled_at (set once, on the first cancellation). p_source is required provenance -- one of focus_session/kanban_transition/calendar/manual/system. Mints task_started (only on the first transition into in_progress), task_status_changed and task_disposition_set (each only on a REAL change to that field -- an unchanged re-call mints neither). blocks stays otherwise client-writable, same posture settle_block_outcome() (0023) established. See docs/architecture/api.md sec3p.';

-- ===========================================================================
-- 4. schedule_block() gains scheduling evidence -- same signature, same
--    position-reallocation behaviour, VERBATIM except for the event-minting
--    block appended at the end. calendar-deck.tsx needs NO change: that is
--    the entire point of minting this server-side rather than asking every
--    caller to report its own intent.
-- ===========================================================================
--
-- RESCHEDULE VS. HARMLESS EDIT -- deterministic, evaluated in this exact
-- order, first match wins (this is the header-level statement of the rule;
-- the SQL below is its literal implementation):
--
--   1. IF the update happens BEFORE the block's (old) scheduled_start_at
--      AND the destination stays on the same LOCAL date (the caller's own
--      profiles.timezone, coalesced to UTC -- same pattern as
--      recompute_daily_rollups()/pick_curriculum_item(), 0013/0014)
--        -> harmless_schedule_edit (is_reschedule: false). Nudging a task
--           that has not started yet, same day, changes nothing about
--           whether the opportunity will be kept.
--   2. ELSE IF the destination local date differs from the origin's
--        -> reschedule (is_reschedule: true), REGARDLESS of whether the
--           block had started. Moving a task to a different calendar day is
--           always a real reschedule of the opportunity.
--   3. ELSE IF the block had already started or passed (now() is at or
--      after the OLD scheduled_start_at) AND the new start is LATER than
--      the old one
--        -> reschedule (is_reschedule: true). This is the "avoid a failure
--           by pushing it back" case the whole classification exists to
--           catch.
--   4. Otherwise (a judgment call, not in the brief's three worked
--      examples): default to harmless_schedule_edit. The only way to reach
--      this branch is a same-day edit that does not fall under rule 1 --
--      i.e. the block had already started and the new start is EARLIER or
--      unchanged. That changes nothing about the opportunity's future
--      eligibility (there is no "future" left to protect), so treating it
--      as a real reschedule would misclassify an honest correction (e.g.
--      fixing a typo'd end time on a session already underway) as gaming
--      the record. Flagged in the PR report as a genuine judgment call.
--
-- An EXACT re-save (identical start AND end) mints nothing, matching
-- schedule_block()'s own long-standing "this REPLACES, not patches" rule --
-- replacing a value with itself is not a write worth remembering.
create or replace function public.schedule_block(
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
  v_tz text;
  v_old_start timestamptz;
  v_old_end timestamptz;
  v_old_local_date date;
  v_new_local_date date;
  v_is_reschedule boolean;
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

  -- 0033: captured BEFORE the write below overwrites v_row with the
  -- post-update row -- this is the only place the OLD window is available
  -- for the evidence event minted at the end of this function.
  v_old_start := v_row.scheduled_start_at;
  v_old_end := v_row.scheduled_end_at;

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

  -- 0033: the scheduling evidence this migration exists to add. Skipped
  -- entirely when both the old and new windows are null -- nothing about
  -- the block's schedule changed at all.
  if v_old_start is not null or p_start_at is not null then
    select coalesce(p.timezone, 'UTC') into v_tz from public.profiles p where p.id = v_uid;
    v_tz := coalesce(v_tz, 'UTC');
    v_old_local_date := case when v_old_start is null then null else (v_old_start at time zone v_tz)::date end;
    v_new_local_date := case when p_start_at is null then null else (p_start_at at time zone v_tz)::date end;

    if v_old_start is null then
      -- First time this block has ever carried a calendar window. No "old"
      -- values exist to carry, so the new ones describe what was set.
      perform public.append_event(
        v_uid, 'task_scheduled',
        jsonb_build_object(
          'block_id', v_row.id::text,
          'start_at', p_start_at, 'end_at', p_end_at, 'date', v_new_local_date
        )
      );
    elsif p_start_at is null then
      -- The documented un-schedule call: a real window existed and is now
      -- cleared. Carries the OLD values, since those are the only ones a
      -- reader of this event would want.
      perform public.append_event(
        v_uid, 'task_unscheduled',
        jsonb_build_object(
          'block_id', v_row.id::text,
          'from_start_at', v_old_start, 'from_end_at', v_old_end, 'from_date', v_old_local_date
        )
      );
    elsif v_old_start is distinct from p_start_at or v_old_end is distinct from p_end_at then
      -- A real change to an existing window. Classify per the deterministic
      -- rule stated in this function's header comment above -- evaluated in
      -- this exact order, first match wins.
      if now() < v_old_start and v_new_local_date = v_old_local_date then
        v_is_reschedule := false;
      elsif v_new_local_date is distinct from v_old_local_date then
        v_is_reschedule := true;
      elsif now() >= v_old_start and p_start_at > v_old_start then
        v_is_reschedule := true;
      else
        -- No rule matched -- see this function's header, point 4, for why
        -- the default here is "edit", not "reschedule".
        v_is_reschedule := false;
      end if;

      perform public.append_event(
        v_uid, 'task_rescheduled',
        jsonb_build_object(
          'block_id', v_row.id::text,
          'from_start_at', v_old_start, 'from_end_at', v_old_end, 'from_date', v_old_local_date,
          'to_start_at', p_start_at, 'to_end_at', p_end_at, 'to_date', v_new_local_date,
          'is_reschedule', v_is_reschedule
        )
      );
    end if;
    -- ELSE: old and new windows are identical (start AND end) -- an
    -- unchanged re-save. Mints nothing, per this function's own long-
    -- standing "replaces, not patches" contract: replacing a value with
    -- itself is not a write worth remembering.
  end if;

  return v_row;
end;
$$;

alter function public.schedule_block(uuid, date, timestamptz, timestamptz) owner to postgres;
revoke execute on function public.schedule_block(uuid, date, timestamptz, timestamptz)
  from public, anon, authenticated;
grant execute on function public.schedule_block(uuid, date, timestamptz, timestamptz) to authenticated;

comment on function public.schedule_block(uuid, date, timestamptz, timestamptz) is
  'Sets or clears a block''s calendar window, and moves it between board dates safely. REPLACES the schedule rather than patching it: both timestamps null clears the window (this is the un-schedule call), a null p_date keeps the block on its current date. Reallocates blocks.position under the same per-user advisory lock as pick_curriculum_item(). 0033: mints task_scheduled (first-ever window), task_unscheduled (window cleared), or task_rescheduled (window changed, carrying is_reschedule -- see this function''s own header for the deterministic classification) -- an unchanged re-save mints nothing. See docs/architecture/api.md sec3d/sec3p.';

-- ===========================================================================
-- 5. pick_curriculum_item() sets original_estimated_minutes -- same
--    signature (uuid, date), VERBATIM except for the one new column in the
--    INSERT.
-- ===========================================================================
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
     priority, estimated_minutes, original_estimated_minutes)
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
    v_item.estimated_minutes,
    -- 0033: set ONCE, here, and never again -- see that column's own
    -- comment. Not re-copied on the idempotent re-pick branch above, same
    -- as every other copied field.
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
  'Pulls one curriculum item onto the board as a block, copying its task text, meta, priority, and estimated_minutes. p_target_date is optional and defaults to today in the caller''s own profiles.timezone (UTC fallback, see 0013/0014), so every pre-0019 one-argument call site is unchanged. Idempotent per (user, item) -- a repeat pick returns the existing block and does NOT move it to p_target_date; use schedule_block() for that, and does not re-copy any field including original_estimated_minutes (0033), which is set exactly once at first insert. See docs/architecture/api.md sec3b.';

-- ===========================================================================
-- 6. start_session() marks the linked block started, once -- same
--    signature (uuid, integer, jsonb), VERBATIM except for the block below
--    the session_started mint.
-- ===========================================================================
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
begin
  if v_uid is null then
    raise exception 'start_session: no authenticated user' using errcode = '42501';
  end if;

  if p_planned_duration_s is null or p_planned_duration_s <= 0 or p_planned_duration_s > 86400 then
    raise exception 'start_session: planned_duration_s must be between 1 and 86400'
      using errcode = '22023';
  end if;

  -- Validate the break plan here rather than leaning on the structural CHECK,
  -- for the same reason the block-ownership probe exists below: a readable
  -- error beats an opaque constraint violation. A malformed plan is rejected
  -- at start, when the user can still fix it, rather than surfacing as a
  -- break that silently never fires 20 minutes in.
  if p_break_plan is not null then
    -- IS DISTINCT FROM, not <>. A missing key makes `p_break_plan->'breaks'`
    -- SQL NULL, jsonb_typeof(NULL) is NULL, and `NULL <> 'array'` is NULL --
    -- not true -- so a plain <> silently accepts exactly the malformed plans
    -- this block exists to reject. Caught by test 5g.
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
      -- IS DISTINCT FROM for the same NULL reason as above: a break object
      -- missing at_s or duration_s entirely is the likeliest malformed shape,
      -- and a plain <> would wave it straight through.
      if jsonb_typeof(v_break) is distinct from 'object'
         or jsonb_typeof(v_break->'at_s') is distinct from 'number'
         or jsonb_typeof(v_break->'duration_s') is distinct from 'number' then
        raise exception 'start_session: each break needs numeric at_s and duration_s'
          using errcode = '22023';
      end if;

      -- at_s is focus-seconds from the start, so a break at or past the end of
      -- the planned work would never fire -- almost certainly a units mistake
      -- (minutes passed where seconds were meant), and silently accepting it
      -- would ship a session whose configured breaks simply never happen.
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

      -- Strictly increasing. The client walks this array in order to decide
      -- what is due next; an unsorted or duplicated at_s makes that walk
      -- ambiguous, and the ambiguity would show up as a break that fires twice
      -- or not at all.
      if (v_break->>'at_s')::bigint <= v_prev_at then
        raise exception 'start_session: break at_s values must be strictly increasing'
          using errcode = '22023';
      end if;
      v_prev_at := (v_break->>'at_s')::bigint;

      v_total_break_s := v_total_break_s + (v_break->>'duration_s')::bigint;
    end loop;

    -- Work plus breaks is the session's real wall-clock footprint; keeping it
    -- inside a day matches planned_duration_s's own ceiling.
    if p_planned_duration_s + v_total_break_s > 86400 then
      raise exception 'start_session: planned_duration_s plus total break time must not exceed 86400'
        using errcode = '22023';
    end if;
  end if;

  -- Belt and braces: focus_sessions_block_fk would reject a foreign block too,
  -- but as an opaque FK violation. Fail with something an implementer can read.
  if p_block_id is not null and not exists (
    select 1 from public.blocks b where b.id = p_block_id and b.user_id = v_uid
  ) then
    raise exception 'start_session: block % not found for this user', p_block_id
      using errcode = '42501';
  end if;

  if exists (
    select 1 from public.focus_sessions s
    where s.user_id = v_uid and s.state = 'running'
  ) then
    -- focus_sessions_one_running enforces this under concurrency; this branch
    -- exists only to return a meaningful error in the common case.
    --
    -- RECOVERY CONTRACT for the UI: a user who closes the tab mid-session
    -- leaves a `running` row behind, and this error is what they hit the next
    -- day. Deliberately an error rather than a silent auto-abandon. Note this
    -- now also covers a PAUSED session, which is still state = 'running' --
    -- exactly as intended, since a paused session is one the user may well
    -- still want to finish. errcode 55006 is distinguishable so the UI can
    -- branch on it.
    raise exception 'start_session: a session is already running'
      using errcode = '55006';
  end if;

  insert into public.focus_sessions
    (user_id, room_id, block_id, started_at, planned_duration_s, state, completed_at, break_plan)
  values (v_uid, null, p_block_id, now(), p_planned_duration_s, 'running', null, p_break_plan)
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

  -- 0033: server-authoritative "when did real work first begin" for the
  -- linked block, alongside the session's own started_at. Guarded on
  -- started_at being currently NULL -- the exact same one-time guard
  -- transition_block_status() (0033) applies for its own
  -- kanban_transition/manual/calendar/system entry points. Both paths race
  -- to set the SAME honest fact; whichever gets there first wins,
  -- permanently, and neither ever overwrites the other's write.
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
  'Starts a focus session, server-stamping started_at and validating an optional break plan (0023). 0033: if p_block_id is given and that block has never started (started_at is null), stamps blocks.started_at and mints task_started {source: focus_session} -- guarded so a session on an already-started block never overwrites the original started_at. See docs/architecture/api.md sec3h/sec3p.';

-- ===========================================================================
-- Closing note: what this migration deliberately leaves unwired.
-- ===========================================================================
-- task_estimate_changed, task_priority_changed, and task_deleted are added
-- to the ledger vocabulary above (with their payload shape documented in
-- api.md sec3p) but have NO PRODUCER in this migration. There is no
-- existing UI anywhere in the product that edits a block's priority or
-- estimate after it is picked, and no delete-block UI beyond a raw client
-- DELETE via blocks_owner_all -- confirmed by inspection of today-deck.tsx
-- and calendar-deck.tsx, not assumed. Minting these three is therefore the
-- job of whichever future feature builds that editor/delete flow, not this
-- evidence migration. The schema and vocabulary are ready for it today.
--
-- Every OTHER raw `.from('blocks').update({ status, ... })` write in web/
-- found while auditing this migration was closed, not left unwired:
-- today-deck.tsx's moveBlock, calendar-deck.tsx's updateBlockStatus() (the
-- detail popover's status dropdown, source: 'calendar'), and
-- session/page.tsx's two claimed/status writes on session start and on
-- "focus longer" (source: 'focus_session') all now call
-- transition_block_status(). The only client write to blocks.status/
-- disposition/claimed left un-evidenced anywhere in web/ after this
-- migration is none -- confirmed by grepping every `.from("blocks")` call
-- site in web/ for `.update(`, not assumed. The one remaining raw blocks
-- UPDATE at all (calendar-deck.tsx's saveBlockNotes) writes only `notes`, a
-- non-lifecycle field explicitly out of this migration's scope (see the
-- header note on blocks.disposition's comment: blocks stays client-writable
-- for everything settle_block_outcome() already established as such).
