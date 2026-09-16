-- Phase I of the operating-engine plan: CONTEXTUAL SENSORS. Like 0033 (Phase
-- G) and 0034 (Phase H), this migration adds no metric, touches no
-- `review_*`/`weekly_performance`/`daily_rollups`/`study_profile` function,
-- and does not touch the Review UI. It adds three unrelated but
-- complementary kinds of raw context that today either cannot be captured at
-- all, or would be trusted from the client in a way that would corrupt the
-- ledger:
--
--   1. A client replaying a ledger append (offline queue, flaky connection,
--      a double-fired button) has no way to say "this is the SAME event I
--      already sent" -- every retry becomes a second row. `client_event_id`
--      plus a real unique index closes that.
--   2. There is no structured self-report after a focus session at all --
--      "how hard was that" and "how confident do you feel" are real signal a
--      user could volunteer, but nothing today can distinguish "we never
--      asked" from "we asked and they declined" from "we asked and they
--      answered" -- three different facts a single nullable column cannot
--      hold.
--   3. `web/app/session/page.tsx` has zero `visibilitychange` instrumentation
--      (confirmed by grep, not assumed) -- a tab that goes hidden mid-session
--      leaves no trace at all.
--
-- GOVERNING PRINCIPLE (project law, restated because every choice below
-- turns on it, same as 0033/0034): Observation != derived feature != pattern
-- != inference != recommendation. This migration adds observations ONLY.
-- Nothing here computes a rate, a score, a trend, or a rule -- including the
-- eligibility rule in part 3 below, which decides WHETHER to ask a question,
-- never what the answer means.
--
-- ===========================================================================
-- WHY NO NEW COLUMN-LEVEL GRANT, EVEN THOUGH 0034 SET THAT PRECEDENT
-- ===========================================================================
-- 0034's `topics` table needed a column-level REVOKE/GRANT split because
-- `topics` is otherwise client-writable for INSERT/DELETE/some UPDATEs, and
-- only `parent_topic_id`/`category_id`/`name` specifically needed to be
-- RPC-only. `focus_sessions` (part 2 below) and `activity_events` (part 1)
-- need no equivalent split here: both tables are ALREADY locked to `SELECT`
-- only for `authenticated` (0001 sec4/sec5, `revoke all ... grant select
-- only`), and every new column added below lands on one of those two tables.
-- The protective effect 0034 achieved with a column-level grant is already
-- achieved here, for free, by the table-level revoke that predates this
-- migration -- adding a redundant column-level grant on top would do
-- nothing except restate what the table grant already guarantees.

-- ===========================================================================
-- 1. `activity_events.client_event_id` -- real idempotency for client
--    appends, not just client-side debounce.
-- ===========================================================================
-- A partial UNIQUE index, not a plain column constraint: the overwhelming
-- majority of events (every server-minted kind, and any client kind a caller
-- chooses not to tag) carry no client id at all, and a bare UNIQUE column
-- would make every one of those NULLs collide under Postgres' historical
-- "NULLs are distinct" behavior only by accident of it being permissive --
-- explicit `where client_event_id is not null` states the real rule: dedupe
-- IS enforced, but only among events that actually claim an id.
alter table public.activity_events
  add column client_event_id uuid;

create unique index activity_events_client_event_id_key
  on public.activity_events (client_event_id)
  where client_event_id is not null;

comment on column public.activity_events.client_event_id is
  'Client-supplied idempotency key (0035), set only when the caller passes one through record_event()/append_event(). A UNIQUE index WHERE NOT NULL means replaying the same id inserts exactly one row -- append_event() below returns the ORIGINAL row on a replay, not an error. NULL for every event that does not opt in (every server-minted kind today, and any client kind a caller chooses not to tag). This is real idempotency for an offline/retry queue, not mere client-side debounce -- the guarantee holds even if two requests carrying the same id race each other, because the index is the arbiter, not application logic.';

-- `append_event()` and `record_event()` both gain a trailing optional
-- parameter. Postgres cannot add a parameter via CREATE OR REPLACE (0023's
-- own note on `settle_session()`), so both are DROP + CREATE. Every existing
-- call site in this codebase calls positionally with strictly fewer
-- arguments than each function already had (e.g. `append_event(v_uid, kind,
-- payload)` or `append_event(v_uid, kind, payload, v_session_id)`) --
-- appending one more DEFAULT-valued parameter at the very end changes
-- nothing about how any of those calls resolve.
drop function public.record_event(text, jsonb);
drop function public.append_event(uuid, text, jsonb, uuid, uuid);

create function public.append_event(
  p_user_id uuid,
  p_kind text,
  p_payload jsonb,
  p_session_id uuid default null,
  p_room_id uuid default null,
  p_client_event_id uuid default null
)
returns public.activity_events
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_row public.activity_events;
begin
  -- ON CONFLICT DO NOTHING targets the partial unique index above by
  -- predicate match (same `where client_event_id is not null` clause) --
  -- when p_client_event_id is null, no row can conflict (the index does not
  -- cover null values at all), so this is a plain insert for every
  -- server-minted call site that never passes one.
  insert into public.activity_events (user_id, room_id, session_id, kind, occurred_at, payload, client_event_id)
  values (
    p_user_id,
    p_room_id,
    p_session_id,
    p_kind,
    now(),                                  -- server clock, never a parameter
    coalesce(p_payload, '{}'::jsonb),
    p_client_event_id
  )
  on conflict (client_event_id) where client_event_id is not null do nothing
  returning * into v_row;

  -- A conflict leaves v_row entirely NULL (0 rows returned into a record
  -- variable) -- fetch and return the ORIGINAL row so a replay is genuinely
  -- idempotent from the caller's point of view (same row back, not an
  -- error, not a silent NULL) rather than merely "harmless to repeat".
  if v_row.id is null and p_client_event_id is not null then
    select * into v_row from public.activity_events e
    where e.client_event_id = p_client_event_id;
  end if;

  return v_row;
end;
$$;

alter function public.append_event(uuid, text, jsonb, uuid, uuid, uuid) owner to postgres;
revoke execute on function public.append_event(uuid, text, jsonb, uuid, uuid, uuid)
  from public, anon, authenticated;

create function public.record_event(
  p_kind text,
  p_payload jsonb default '{}'::jsonb,
  p_client_event_id uuid default null
)
returns public.activity_events
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
begin
  if v_uid is null then
    raise exception 'record_event: no authenticated user' using errcode = '42501';
  end if;

  -- Client-appendable subset of activity_events_kind_check. Everything
  -- omitted here (session_*, session_check_in_*, tutor_message_sent) is
  -- minted server-side, so that focus time, check-in provenance, and
  -- metered AI usage cannot be self-reported. KEEP IN SYNC with that CHECK.
  -- 0035 adds exactly one new client-appendable kind: session_visibility_changed
  -- (part 3 below) -- raw tab-visibility observation, not an authority claim.
  if p_kind is null or p_kind not in (
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
    'session_visibility_changed'
  ) then
    raise exception 'record_event: kind % is not client-appendable', p_kind
      using errcode = '22023';
  end if;

  if p_payload is not null and jsonb_typeof(p_payload) <> 'object' then
    raise exception 'record_event: payload must be a JSON object' using errcode = '22023';
  end if;

  -- Unchanged from 0001: ledger payloads are facts about an event, not
  -- documents, and the ledger has no DELETE path by design.
  if p_payload is not null and octet_length(p_payload::text) > 4096 then
    raise exception 'record_event: payload exceeds 4096 bytes' using errcode = '22023';
  end if;

  -- session_id/room_id stay null: a client has no business attributing its
  -- own event to a session or a room. p_client_event_id passes straight
  -- through -- it is an idempotency key the CLIENT generates and owns
  -- (e.g. crypto.randomUUID()), not a fact the server is asked to trust
  -- beyond "dedupe on this value if given".
  return public.append_event(v_uid, p_kind, coalesce(p_payload, '{}'::jsonb), null, null, p_client_event_id);
end;
$$;

alter function public.record_event(text, jsonb, uuid) owner to postgres;
revoke execute on function public.record_event(text, jsonb, uuid) from public, anon, authenticated;
grant execute on function public.record_event(text, jsonb, uuid) to authenticated;

comment on function public.record_event(text, jsonb, uuid) is
  'THE ONLY client-facing way to append to the ledger. p_client_event_id (0035) is an optional client-generated idempotency key -- replaying record_event() with the same id returns the ORIGINAL row rather than inserting a second one (see activity_events.client_event_id''s own comment). p_kind must be one of the client-appendable kinds (KEEP IN SYNC with activity_events_kind_check); everything else is server-minted only and fails 22023. See docs/architecture/api.md sec3r.';

-- ---------------------------------------------------------------------------
-- ENVELOPE FRAMING -- client_occurred_at / client_tz are CLAIMS, not columns
-- ---------------------------------------------------------------------------
-- This migration deliberately does NOT add `client_occurred_at` or
-- `client_tz` as columns on activity_events. `occurred_at` stays exactly
-- what D17/record_event()'s own header already establish: the SERVER clock,
-- always `now()`, never a parameter -- that property is the entire reason
-- the ledger is trustworthy (a client that could set its own occurred_at
-- could back-date focus time into an already-scored day, or into a day
-- before the account existed). Nothing in this migration weakens that.
--
-- What THIS migration prepares for is offline/late-arriving events: a client
-- that queues an event while offline and appends it minutes or hours later
-- has a real, useful fact -- "the user's device thought this happened at
-- T, in zone Z" -- that is not the same fact as "the server received this
-- at now()". The right place for that fact is INSIDE THE PAYLOAD, as two
-- ordinary keys (`client_occurred_at`, an ISO-8601 timestamp string; `client_tz`,
-- an IANA zone name), documented here and in api.md as CLAIMS: a future
-- consumer may read them to understand client-side sequencing or to explain
-- a gap between occurred_at and when the event visibly reflects in the UI,
-- but MUST NEVER treat them as authoritative for anything occurred_at
-- already answers authoritatively (ordering, day-bucketing, rollup
-- attribution). A device with a wrong clock, a stale queue, or a
-- deliberately falsified payload can put anything in these two keys --
-- they cost nothing to fabricate, same as any other payload field a client
-- controls, and unlike occurred_at there is no unique index or CHECK that
-- could ever make them trustworthy. session_visibility_changed (part 3
-- below) is the first, and so far only, kind that populates them.

-- ===========================================================================
-- 2. Post-session check-in -- self_difficulty / self_confidence /
--    self_help_level, and `check_in_state` (the column that is the whole
--    point).
-- ===========================================================================
-- WHY check_in_state EXISTS AT ALL: without it, self_difficulty being NULL
-- is ambiguous three different ways -- "we never offered a check-in for this
-- session", "we offered one and the user explicitly declined", and "the
-- question genuinely has no answer for some other reason" -- and a future
-- metric computing "average self-reported difficulty" could not tell any of
-- those apart from real missing data. This is the same null-vs-state
-- discipline 0033's `blocks.disposition` and study_profile()'s confidence
-- gate already established for this codebase: current state belongs in its
-- own column, not inferred from the absence of a value in an unrelated one.
alter table public.focus_sessions
  add column self_difficulty smallint,
  add column self_confidence smallint,
  add column self_help_level text,
  add column check_in_state text not null default 'not_offered';

alter table public.focus_sessions
  -- 1-5, a plain Likert scale -- the brief specifies the columns but not
  -- their range. JUDGMENT CALL, flagged: 1-5 was chosen as the smallest
  -- scale with a genuine midpoint (matches the "difficulty"/"confidence"
  -- framing of a self-rating far more legibly than, say, 0-10), and is easy
  -- to widen later since nothing downstream reads these columns yet.
  add constraint focus_sessions_self_difficulty_range
    check (self_difficulty is null or self_difficulty between 1 and 5),
  add constraint focus_sessions_self_confidence_range
    check (self_confidence is null or self_confidence between 1 and 5),
  -- JUDGMENT CALL, flagged: the brief names the column but not its
  -- vocabulary. Four values chosen to mirror the terminal app's own
  -- Learning Coach framing (how much help did you actually need, from none
  -- through being walked through it) rather than inventing new language:
  -- none/hint/walkthrough/full_solution.
  add constraint focus_sessions_self_help_level_values
    check (self_help_level is null or self_help_level in ('none', 'hint', 'walkthrough', 'full_solution')),
  add constraint focus_sessions_check_in_state_values
    check (check_in_state in ('not_offered', 'offered_pending', 'answered', 'declined'));

comment on column public.focus_sessions.self_difficulty is
  'Post-session self-report (0035), 1-5, NULL until answered. Set only by record_session_check_in() (via answer_session_check_in()), and only when check_in_state transitions to ''answered''. This is a raw self-rating, not a score -- no review_*/weekly_performance/study_profile function reads it.';
comment on column public.focus_sessions.self_confidence is
  'Post-session self-report (0035), 1-5, NULL until answered. Same write path and same "observation, not a metric" posture as self_difficulty above.';
comment on column public.focus_sessions.self_help_level is
  'Post-session self-report (0035): how much help the user says they needed -- one of none/hint/walkthrough/full_solution, NULL until answered. Same write path as self_difficulty above.';
comment on column public.focus_sessions.check_in_state is
  'THE column that makes a null self-report legible (0035). not_offered (default -- this session was never eligible, or settle_session() has not decided yet), offered_pending (settle_session() offered a check-in and is waiting on the client), answered (record_session_check_in() recorded a real self-report), declined (the user was asked and said no). Without this column, self_difficulty is null for three unrelated reasons at once -- see this migration''s header. Written only by settle_session() (offered_pending) and record_session_check_in() (answered/declined) -- never client-writable (focus_sessions stays SELECT-only for authenticated, 0001).';

-- ---------------------------------------------------------------------------
-- record_session_check_in() -- the ONE write path for a check-in answer.
-- Client says "record this answer"; the server decides whether that is a
-- legal thing to say right now.
-- ---------------------------------------------------------------------------
-- Two thin, pinned wrappers (answer_session_check_in / decline_session_check_in)
-- sit on top, same shape as settle_session()/complete_session()/
-- abandon_session() (0023): one shared implementation, two callable entry
-- points each pinning p_state to a literal so PostgREST callers cannot pass
-- an arbitrary state. record_session_check_in() itself is NEVER granted to
-- any client role -- same posture as settle_session() -- it exists only so
-- the two wrappers share one body rather than two copies that could drift.
--
-- THE GUARD THAT MAKES THIS SERVER-AUTHORITATIVE, NOT JUST SERVER-WRITTEN:
-- this function refuses to move check_in_state at all unless it currently
-- reads 'offered_pending'. A client cannot manufacture a self-report on a
-- session that was never offered one (check_in_state would still be
-- 'not_offered'), and cannot answer or decline the same offer twice
-- (check_in_state would already be 'answered'/'declined'). The client's
-- entire authority here is "record my answer to the question you already
-- decided to ask" -- it cannot decide to ask, and cannot re-ask itself.
create function public.record_session_check_in(
  p_id uuid,
  p_state text,
  p_self_difficulty smallint default null,
  p_self_confidence smallint default null,
  p_self_help_level text default null
)
returns public.focus_sessions
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_row public.focus_sessions;
begin
  if v_uid is null then
    raise exception 'record_session_check_in: no authenticated user' using errcode = '42501';
  end if;

  if p_state is null or p_state not in ('answered', 'declined') then
    raise exception 'record_session_check_in: p_state must be one of answered/declined'
      using errcode = '22023';
  end if;

  -- An "answer" that answers nothing is not a real self-report -- reject it
  -- here rather than silently recording an all-null answered row that a
  -- future reader would have no way to distinguish from a genuine
  -- three-way-null response the user actually gave.
  if p_state = 'answered'
     and p_self_difficulty is null and p_self_confidence is null and p_self_help_level is null then
    raise exception 'record_session_check_in: an answered check-in needs at least one of self_difficulty/self_confidence/self_help_level'
      using errcode = '22023';
  end if;

  if p_self_difficulty is not null and p_self_difficulty not between 1 and 5 then
    raise exception 'record_session_check_in: self_difficulty must be between 1 and 5'
      using errcode = '22023';
  end if;
  if p_self_confidence is not null and p_self_confidence not between 1 and 5 then
    raise exception 'record_session_check_in: self_confidence must be between 1 and 5'
      using errcode = '22023';
  end if;
  if p_self_help_level is not null and p_self_help_level not in ('none', 'hint', 'walkthrough', 'full_solution') then
    raise exception 'record_session_check_in: self_help_level must be one of none/hint/walkthrough/full_solution'
      using errcode = '22023';
  end if;

  -- Ownership is re-checked here, not just in RLS: this function is owned by
  -- postgres and is therefore exempt from RLS (focus_sessions is SELECT-only
  -- for authenticated regardless), so this predicate IS the access control.
  select s.* into v_row from public.focus_sessions s
  where s.id = p_id and s.user_id = v_uid
  for update;

  if v_row.id is null then
    -- Deliberately does not distinguish "not yours" from "no such session" --
    -- a distinguishable error would confirm the existence of another user's
    -- session id. Same posture as every other ownership-checked RPC.
    raise exception 'record_session_check_in: session % not available for this user', p_id
      using errcode = '42501';
  end if;

  -- THE authority guard -- see this function's own header comment above.
  if v_row.check_in_state is distinct from 'offered_pending' then
    raise exception 'record_session_check_in: session % has no pending check-in to record (state: %)',
      p_id, v_row.check_in_state
      using errcode = '55006';
  end if;

  update public.focus_sessions s
     set check_in_state = p_state,
         self_difficulty = case when p_state = 'answered' then p_self_difficulty else s.self_difficulty end,
         self_confidence = case when p_state = 'answered' then p_self_confidence else s.self_confidence end,
         self_help_level = case when p_state = 'answered' then p_self_help_level else s.self_help_level end
   where s.id = p_id and s.user_id = v_uid
  returning * into v_row;

  if p_state = 'answered' then
    perform public.append_event(
      v_uid, 'session_check_in_answered',
      jsonb_build_object(
        'session_id', v_row.id::text,
        'self_difficulty', p_self_difficulty,
        'self_confidence', p_self_confidence,
        'self_help_level', p_self_help_level
      ),
      v_row.id
    );
  else
    perform public.append_event(
      v_uid, 'session_check_in_declined',
      jsonb_build_object('session_id', v_row.id::text),
      v_row.id
    );
  end if;

  return v_row;
end;
$$;

alter function public.record_session_check_in(uuid, text, smallint, smallint, text) owner to postgres;
-- Never granted, same posture as settle_session(): p_state is a free
-- parameter here, and the two wrappers below pin it to a literal.
revoke execute on function public.record_session_check_in(uuid, text, smallint, smallint, text)
  from public, anon, authenticated;

create function public.answer_session_check_in(
  p_id uuid,
  p_self_difficulty smallint default null,
  p_self_confidence smallint default null,
  p_self_help_level text default null
)
returns public.focus_sessions
language plpgsql
security definer
set search_path = ''
as $$
begin
  return public.record_session_check_in(p_id, 'answered', p_self_difficulty, p_self_confidence, p_self_help_level);
end;
$$;

alter function public.answer_session_check_in(uuid, smallint, smallint, text) owner to postgres;
revoke execute on function public.answer_session_check_in(uuid, smallint, smallint, text)
  from public, anon, authenticated;
grant execute on function public.answer_session_check_in(uuid, smallint, smallint, text) to authenticated;

create function public.decline_session_check_in(p_id uuid)
returns public.focus_sessions
language plpgsql
security definer
set search_path = ''
as $$
begin
  return public.record_session_check_in(p_id, 'declined');
end;
$$;

alter function public.decline_session_check_in(uuid) owner to postgres;
revoke execute on function public.decline_session_check_in(uuid) from public, anon, authenticated;
grant execute on function public.decline_session_check_in(uuid) to authenticated;

comment on function public.answer_session_check_in(uuid, smallint, smallint, text) is
  'The client''s ONLY way to record a check-in answer -- "record this answer", never "ask this question" (settle_session() below owns that decision). Requires at least one of self_difficulty (1-5) / self_confidence (1-5) / self_help_level (none/hint/walkthrough/full_solution). Fails 55006 unless the session''s check_in_state currently reads offered_pending -- a client cannot fabricate a self-report on a session that was never offered one, and cannot answer the same offer twice. Mints session_check_in_answered. See docs/architecture/api.md sec3r.';
comment on function public.decline_session_check_in(uuid) is
  'The client''s ONLY way to record a check-in decline. Same offered_pending guard as answer_session_check_in() -- see its comment. Mints session_check_in_declined and leaves self_difficulty/self_confidence/self_help_level untouched (still null, or whatever they already were). See docs/architecture/api.md sec3r.';

-- ===========================================================================
-- 3. New server-minted and client-minted ledger kinds
-- ===========================================================================
-- Six new kinds. Same DROP+ADD CHECK pattern as 0023/0033/0034.
--
-- FIVE are server-minted only, and are NOT added to record_event()'s
-- client-appendable whitelist above -- a client that could self-report
-- "I was offered a check-in" or "I answered/declined one" could fabricate
-- exactly the provenance this migration exists to make trustworthy (see
-- part 4, sampling provenance, below). Tested: a client call to
-- record_event() with any of the three session_check_in_* kinds fails
-- 22023, same proof pattern 0033/0034 already established for their own
-- server-minted kinds.
--
-- ONE, session_visibility_changed, IS client-minted (part 4 below) and IS in
-- the whitelist above -- raw tab-visibility observation carries none of the
-- unfarmable-focus-time risk the other five exist to close, and it can only
-- ever originate on the client (the server has no way to observe a browser
-- tab's visibility state itself).
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
    -- 0034:
    'plan_target_changed',
    'category_target_changed',
    -- 0035, server-minted only:
    'session_check_in_offered',
    'session_check_in_answered',
    'session_check_in_declined',
    -- 0035, client-minted (record_event() whitelist above):
    'session_visibility_changed'
  ));

-- ===========================================================================
-- 4. Sampling provenance -- WHY a check-in was offered, recorded alongside
--    WHETHER it was, so a future reader can tell a roughly-random sample
--    from an event-triggered one.
-- ===========================================================================
-- Six-member trigger_reason vocabulary, documented here because it lives
-- inside a JSONB payload (session_check_in_offered has no dedicated column
-- for it -- there is exactly one producer of this event, so a CHECK on a
-- payload sub-field would be redundant with this function body):
--
--   periodic_sample     -- THE ONLY ONE WITH A PRODUCER IN THIS MIGRATION.
--                           settle_session() below, on a fixed cadence over
--                           sessions with real focus time. Unbiased by
--                           session difficulty/outcome -- see below for why
--                           that matters.
--   new_topic            -- vocabulary ready, no producer. A future feature:
--                           offer a check-in the first time a session
--                           attributes to a topic_id (0034) the user has
--                           never logged focus time against before.
--   low_evidence_topic   -- vocabulary ready, no producer. A future feature:
--                           bias sampling toward topics with few settled
--                           sessions, to avoid some topics never
--                           accumulating any self-report at all.
--   session_abandoned    -- vocabulary ready, no producer. settle_session()
--                           today applies the SAME periodic_sample rule to
--                           completed and abandoned sessions alike (see
--                           below) -- a future feature could instead treat
--                           "left early" as its own, deliberate trigger.
--   unusual_session       -- vocabulary ready, no producer. A future
--                           feature: a session whose length/pause pattern
--                           is an outlier for this user.
--   manual_user_request   -- vocabulary ready, no producer. A future
--                           feature: an explicit "ask me how that went"
--                           control somewhere in the UI, independent of any
--                           automatic trigger.
--
-- This is the SAME posture 0033 took for task_estimate_changed/
-- task_priority_changed/task_deleted: vocabulary and payload shape are
-- documented now so a future feature's migration is a one-line producer
-- addition, not a schema change. See docs/architecture/api.md sec3r for the
-- full table.
--
-- ---------------------------------------------------------------------------
-- WHY PERIODIC, NOT DIFFICULTY-TRIGGERED -- the bias this migration's own
-- brief calls out by name
-- ---------------------------------------------------------------------------
-- If confidence were only requested after HARD sessions, "average confidence
-- 2.7" would be a fact about the sampling policy, not about the user's
-- typical confidence -- and nothing downstream would be able to tell,
-- because the ledger would contain only the biased sample. periodic_sample
-- is keyed on `eligible_session_number` (this user's running count of
-- SETTLED sessions that cleared the real-focus-time floor below, including
-- the one just settled) modulo a fixed constant -- deliberately NOT on
-- anything about the session's difficulty, outcome, or duration beyond that
-- one floor. Every qualifying session has the same chance of being the one
-- that lands on the cadence, regardless of how it went.
--
-- ---------------------------------------------------------------------------
-- THE TRIGGER RULE ITSELF -- conservative, explicit, easy to change later
-- ---------------------------------------------------------------------------
-- 1. A session must be SETTLED (completed or abandoned) -- never offered
--    mid-session, and never for a session still `running`/`paused`.
-- 2. A session must clear v_min_focus_s (600 -- ten minutes) of REAL focus
--    time, via session_focus_seconds() (0023's one shared formula: wall
--    clock minus paused time, capped at planned). JUDGMENT CALL, flagged:
--    the brief says "only after a session with real focus time" but does
--    not name a floor. Ten minutes was chosen as long enough that the
--    session very likely involved genuine engagement with the task (not a
--    misclick immediately abandoned), short enough that it does not exclude
--    most real Pomodoro-length sessions. Easy to change: it is one `constant`
--    below, read by nothing else.
-- 3. Both completed AND abandoned sessions are eligible, as long as (2)
--    holds. JUDGMENT CALL, flagged: an abandoned session that still involved
--    real focus time is real signal too (the brief's own framing -- "a
--    flawless 50-minute timer proves a recorded session, not 50 minutes of
--    cognitive attention" -- cuts the same way for an honest abandon: the
--    user still did real work before leaving). Restricting to `completed`
--    only would be the more conservative alternative if this proves wrong in
--    practice; see the closing note on `session_abandoned` as its own
--    trigger_reason above.
-- 4. Among sessions that clear (1)-(3), offer a check-in on every THIRD one
--    (`eligible_session_number % 3 = 0`) for this user -- never every
--    session, never fewer than one in ten. JUDGMENT CALL, flagged: the
--    brief says "never after every timer" but does not name a cadence.
--    Every-3rd was chosen as the smallest interval that still reads as
--    conservative (roughly a third of real sessions, not "constant
--    interruption") while keeping the constant, `v_sample_every`, a single
--    line to change.
-- 5. When eligible, settle_session() sets check_in_state = 'offered_pending'
--    and mints session_check_in_offered ATOMICALLY inside the same
--    transaction that settles the session -- exactly the brief's own
--    recommended design, so the client can decide whether to prompt purely
--    by reading the check_in_state on settle_session()'s own return value,
--    with no second round trip and no window where the two could disagree.
--
-- settle_session() is modified below, VERBATIM except for this one addition
-- appended after the existing session_completed/session_abandoned mint and
-- the existing settle_block_outcome() passthrough -- nothing about pause/
-- resume/extend/outcome accounting changes.
create or replace function public.settle_session(
  p_id uuid,
  p_state text,
  p_block_outcome text default null,
  p_leftover_note text default null
)
returns public.focus_sessions
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_row public.focus_sessions;
  v_elapsed integer;
  v_min_focus_s constant integer := 600; -- part 4's rule (2) -- see header
  v_sample_every constant integer := 3;  -- part 4's rule (4) -- see header
  v_eligible_number bigint;
begin
  if v_uid is null then
    raise exception 'settle_session: no authenticated user' using errcode = '42501';
  end if;

  update public.focus_sessions s
     set state = p_state,
         completed_at = now(),
         total_paused_s = s.total_paused_s
           + case
               when s.paused_at is null then 0
               else greatest(0, floor(extract(epoch from (now() - s.paused_at)))::integer)
             end,
         paused_at = null
   where s.id = p_id
     and s.user_id = v_uid
     and s.state = 'running'
  returning * into v_row;

  if v_row.id is null then
    raise exception 'settle_session: no running session % for this user', p_id
      using errcode = '42501';
  end if;

  v_elapsed := public.session_focus_seconds(
    v_row.started_at, v_row.completed_at, v_row.total_paused_s, v_row.planned_duration_s
  );

  perform public.append_event(
    v_uid,
    case when p_state = 'completed' then 'session_completed' else 'session_abandoned' end,
    jsonb_build_object(
      'block_id', v_row.block_id,
      'planned_duration_s', v_row.planned_duration_s,
      'elapsed_s', greatest(0, floor(extract(epoch from (v_row.completed_at - v_row.started_at)))::integer),
      'focus_s', v_elapsed,
      'total_paused_s', v_row.total_paused_s,
      'extended_s', v_row.extended_s
    ),
    v_row.id
  );

  if p_block_outcome is not null then
    perform public.settle_block_outcome(p_id, p_block_outcome, p_leftover_note);
  end if;

  -- 0035: post-session check-in eligibility -- see this migration's part 4
  -- header for the full rule and every judgment call in it. Runs after the
  -- session_completed/session_abandoned mint (this is a DIFFERENT fact, the
  -- decision to ask a question, not part of settling the session itself)
  -- and regardless of p_block_outcome (the two are unrelated).
  if v_elapsed >= v_min_focus_s then
    -- Counts SETTLED sessions only (state in completed/abandoned), including
    -- the row just settled above (the UPDATE already committed it to
    -- 'completed'/'abandoned' within this same transaction, so it is
    -- already counted here) -- this is what keeps eligible_session_number a
    -- stable, monotonically increasing count per user rather than something
    -- that has to be reconstructed differently depending on when it's read.
    select count(*) into v_eligible_number
    from public.focus_sessions s
    where s.user_id = v_uid
      and s.state in ('completed', 'abandoned')
      and public.session_focus_seconds(s.started_at, s.completed_at, s.total_paused_s, s.planned_duration_s) >= v_min_focus_s;

    if v_eligible_number % v_sample_every = 0 then
      update public.focus_sessions s
         set check_in_state = 'offered_pending'
       where s.id = v_row.id
      returning * into v_row;

      perform public.append_event(
        v_uid, 'session_check_in_offered',
        jsonb_build_object(
          'session_id', v_row.id::text,
          'trigger_reason', 'periodic_sample',
          'sampling_policy', 'session_checkin_v1',
          'prompt_version', 'v1',
          'eligible_session_number', v_eligible_number
        ),
        v_row.id
      );
    end if;
  end if;
  -- ELSE: check_in_state stays at its default, 'not_offered' -- no event
  -- minted. This is not "a no-op re-call mints nothing" (0033/0034's own
  -- rule for an unchanged value) -- it is the FIRST and ONLY decision this
  -- session's check-in state will ever get from settle_session(), and "we
  -- decided not to ask" is itself correctly represented by the column's own
  -- default, not by a separate event.

  return v_row;
end;
$$;

alter function public.settle_session(uuid, text, text, text) owner to postgres;
revoke execute on function public.settle_session(uuid, text, text, text)
  from public, anon, authenticated;

comment on function public.settle_session(uuid, text, text, text) is
  'Ends a running (or paused) session as completed/abandoned, folding any open pause into total_paused_s and minting session_completed/session_abandoned with the server-measured focus_s (0023). With p_block_outcome, atomically applies the linked block''s fate via settle_block_outcome(). 0035: also decides post-session check-in eligibility ATOMICALLY in the same transaction -- a session with at least 600s of real focus time (session_focus_seconds()) that lands on every 3rd such session for this user (eligible_session_number % 3 = 0) gets check_in_state set to offered_pending and mints session_check_in_offered {trigger_reason: periodic_sample, sampling_policy: session_checkin_v1, prompt_version: v1, eligible_session_number}. The client reads check_in_state on this function''s own return value to decide whether to prompt -- no second round trip. See docs/architecture/api.md sec3r for the full trigger rule and every judgment call in it.';

-- ===========================================================================
-- 5. `session_visibility_changed` -- raw tab-visibility observation.
-- ===========================================================================
-- CLIENT-MINTED (added to record_event()'s whitelist in part 1 above), using
-- the client_event_id envelope from part 1 for idempotency and carrying
-- client_occurred_at/client_tz as CLAIMS inside its own payload (part 1's
-- envelope-framing note -- restated here verbatim because this is the kind
-- it actually governs):
--
--   { "session_id": "...", "visibility_state": "hidden" | "visible",
--     "client_event_id": "<uuid, via record_event's own parameter, not payload>",
--     "client_occurred_at": "2026-09-16T14:03:00.000Z",  -- CLAIM, not trusted
--     "client_tz": "America/Los_Angeles" }                -- CLAIM, not trusted
--
-- No schema object is added for this beyond the CHECK/whitelist entries in
-- parts 1 and 3 above -- session_visibility_changed is pure ledger evidence,
-- the same way task_completed/screen_opened/etc. already are, with nothing
-- for a migration to create beyond vocabulary. The producer is
-- web/app/session/page.tsx (a `visibilitychange` listener, debounced --
-- see that file's own comment for the debounce window and why).
--
-- ---------------------------------------------------------------------------
-- FRAMING RULE -- written here verbatim, and again in api.md, per this
-- migration's own brief: raw observation ONLY.
-- ---------------------------------------------------------------------------
-- A hidden tab may mean VS Code, LeetCode, documentation, a PDF, or notes.
-- It is NOT subtracted from focus time, NOT named "distraction", and NO
-- metric consumes it in this wave -- review_*/weekly_performance/
-- daily_rollups/study_profile are all untouched by this migration, same as
-- every other section above. Equally: a flawless 50-minute timer proves a
-- recorded session, not 50 minutes of cognitive attention. Both halves of
-- that sentence are the same caution, stated from opposite directions, and
-- both must survive into any future feature that reads this event.

-- ===========================================================================
-- Closing note: what this migration deliberately leaves unwired.
-- ===========================================================================
-- Five of trigger_reason's six members (new_topic, low_evidence_topic,
-- session_abandoned, unusual_session, manual_user_request) have NO PRODUCER
-- in this migration -- see part 4's own header for what each would take to
-- wire. Their names are documented now so a future feature's migration is a
-- one-line producer addition inside settle_session() (or a new, separate
-- RPC for manual_user_request specifically), not a schema change. Same
-- "vocabulary + shape ready, producer to follow" posture 0033 established
-- for task_estimate_changed/task_priority_changed/task_deleted.
--
-- The SessionCheckIn UI component itself (web/components/SessionCheckIn.tsx)
-- is explicitly NOT built by this migration or by this phase -- its props
-- contract is locked in docs/architecture/api.md sec3r for a later wave
-- (Codex) to build against, same posture api.md sec4.1 already established
-- for EmberMorph's trigger prop.
