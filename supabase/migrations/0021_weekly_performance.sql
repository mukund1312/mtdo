-- Phase 7 of the operating-engine plan: deterministic weekly metrics.
--
-- READ THIS FIRST. The product decision this migration encodes (decisions.md
-- 2026-09-11, "The weekly engine is deterministic by design") is that the
-- recommendation engine sitting on top of these numbers is RULE-BASED, with
-- zero AI/LLM calls anywhere in the metrics or recommendation path. This file
-- is the metrics half. It makes no network call, reads no model output, and
-- has no branch that could. The plan's own sequencing rule -- "the metrics
-- must exist and be trusted before AI is allowed near them" -- is extended
-- here to the recommendations too.
--
-- WHY A READ-COMPUTED FUNCTION AND NOT A TRIGGER-MAINTAINED TABLE.
-- Same reasoning decisions.md 2026-09-06 records for daily_rollups, and it
-- applies more strongly here, not less:
--   * A trigger would put a week-wide aggregation on the user's write path,
--     where a failure fails the task write for the sake of a derived number.
--   * Incremental counters cannot self-heal. A late correction (a
--     task_regressed appended days after the fact) has to be able to move a
--     number DOWN, which means a full recompute has to exist anyway -- at
--     which point the trigger is a second, divergeable writer.
--   * Unlike daily_rollups there is not even a freshness argument for
--     materializing it: a weekly review is read a handful of times per user
--     per week, by a human, on demand.
-- The one thing that IS persisted is a SNAPSHOT (weekly_plans.metrics, 0022)
-- of whatever this returned at the moment a proposal was generated -- audit
-- history, deliberately frozen, never a cache to read back instead of calling
-- this.
--
-- WHY IT DELIBERATELY DOES NOT READ daily_rollups.
-- daily_rollups would have given study_days and focus time for free, already
-- bucketed per user zone. It is not read, because that table is materialized
-- by a pg_cron job every ten minutes (0010) and a review generated in the gap
-- would quietly under-report the work someone did in the last few minutes
-- before opening it. This function reads the same two SOURCE tables
-- daily_rollups reads (activity_events, focus_sessions) under the same
-- day-attribution rules (api.md sec3a), so the two agree by construction and
-- this one is never stale.

-- 1. the lever the engine is allowed to move ------------------------------
-- Added here, in the metrics migration, because weekly_performance() READS
-- both of these columns -- the engine cannot propose a delta without knowing
-- the current target, and cannot exclude a too-new category without knowing
-- its age. 0022's apply_weekly_plan_change() is the only thing that WRITES
-- weekly_target_blocks.
-- plan_categories.weekly_target_blocks: how many blocks of this category the
-- user is aiming to finish per week.
--
-- WHY A NEW COLUMN RATHER THAN REUSING min_blocks. min_blocks is a per-DAY
-- floor for calling a subject done that day -- that is what prompt.ts tells
-- every model to write ("floor for counting this subject 'done' that day,
-- 0-6"), what core.py's category_own_complete() means by it, and it is read
-- by nothing in the web product. Two things were therefore wrong with using
-- it as the pace lever: it would silently redefine a field the plan-generation
-- prompt still writes with the old meaning, and its real-world values are
-- 0 or 1, so the +/-25% adjustments this engine makes would round to no
-- change at all. A recommendation whose acceptance does nothing is theatre.
--
-- WHY THIS DOES NOT VIOLATE "never invent availability". plan_categories.days
-- is untouched and stays untouchable (see the hard constraints below): `days`
-- is what the user told us about their life. weekly_target_blocks is a GOAL,
-- not a schedule -- nothing is auto-placed because of it, no date is derived
-- from it, and ensure_curriculum_menu()'s unlock cursor does not read it. It
-- is the number the Review deck shows as "target" next to what actually
-- happened.
--
-- NULLABLE WITH NO DEFAULT, the same load-bearing NULL as profiles.timezone
-- and blocks.estimated_minutes: "the user has never set an explicit weekly
-- target" is a real, distinct state from "their target happens to equal the
-- default". Readers resolve it as
--   coalesce(weekly_target_blocks, array_length(days, 1))
-- -- the plan's own natural pace, since one unlocked week_index holds exactly
-- array_length(days, 1) items (api.md sec3b). That resolution is what the
-- rules engine takes +/-25% of.

alter table public.plan_categories
  add column weekly_target_blocks integer,
  add constraint plan_categories_weekly_target_nonneg
    check (weekly_target_blocks is null or weekly_target_blocks >= 0);

-- 2. how old is this category? -------------------------------------------
-- Needed to tell "this category has two weeks of history and is genuinely on
-- track" apart from "this category did not exist two weeks ago, so of course
-- it looks quiet". Without it the engine would read a data gap as a healthy
-- signal -- the just-added-category misclassification.
--
-- Backfilled from the owning plan's created_at rather than left at now() for
-- existing rows. Nothing in the product adds a category to a plan after
-- creation today (extend_plan() appends ITEMS to existing categories, never
-- new categories), so for every row that exists right now the plan's own
-- creation time IS the category's, exactly. Defaulting them all to now()
-- instead would have told the engine that every category on every existing
-- plan was brand new, freezing it into proposing nothing for two weeks.

alter table public.plan_categories
  add column created_at timestamptz not null default now();

update public.plan_categories pc
set created_at = p.created_at
from public.plans p
where p.id = pc.plan_id;

comment on column public.plan_categories.created_at is
  'When this category was added. Read by weekly_performance() (0021) so the rules engine can exclude a category that did not exist for the whole week under review, rather than reading its absence of activity as "on track". Backfilled from plans.created_at for rows predating 0022.';

comment on column public.plan_categories.weekly_target_blocks is
  'Blocks per week the user is aiming to finish in this category. NULL = never explicitly set; resolve as coalesce(weekly_target_blocks, array_length(days,1)). This is the ONLY field the weekly rules engine may adjust (0022) -- it is a goal, not a schedule: nothing is auto-placed from it and no date is derived from it. Distinct from min_blocks, which is a per-day floor written by plan generation. See docs/architecture/api.md sec3g.';

-- 3. iso_week_start() ------------------------------------------------------
-- Monday of an ISO-8601 week, from the exact 'IYYY-"W"IW' text format
-- 0012/0016/0017 already stamp into plan_categories.menu_unlocked_iso_week --
-- one vocabulary for "which week is this" across the whole schema.
--
-- Computed from the Jan-4 anchor rather than through to_date(..., 'IYYY-"W"IW')
-- deliberately: to_date's ISO-week field handling is subtle around year
-- boundaries (it happily mixes ISO and Gregorian fields when both are
-- present), whereas "Jan 4 is always in ISO week 1" is the definition itself
-- and is exact for every year, including the 53-week ones.

create function public.iso_week_start(p_iso_week text)
returns date
language plpgsql
immutable
as $$
declare
  v_year integer;
  v_week integer;
  v_jan4 date;
  v_week1_monday date;
begin
  if p_iso_week is null or p_iso_week !~ '^[0-9]{4}-W[0-9]{2}$' then
    raise exception 'iso_week_start: % is not an ISO week of the form YYYY-Www', p_iso_week
      using errcode = '22023';
  end if;

  v_year := substring(p_iso_week from 1 for 4)::integer;
  v_week := substring(p_iso_week from 7 for 2)::integer;

  if v_week < 1 or v_week > 53 then
    raise exception 'iso_week_start: week % is out of range 01..53', v_week
      using errcode = '22023';
  end if;

  v_jan4 := make_date(v_year, 1, 4);
  -- isodow: Monday = 1 .. Sunday = 7.
  v_week1_monday := v_jan4 - (extract(isodow from v_jan4)::integer - 1);
  return v_week1_monday + (v_week - 1) * 7;
end;
$$;

comment on function public.iso_week_start(text) is
  'Monday of the given ISO-8601 week, for the IYYY-"W"IW text format used by plan_categories.menu_unlocked_iso_week and weekly_plans.iso_week. Raises 22023 on a malformed week.';

-- Immutable and user-data-free, so unlike every other function in this schema
-- it is safe to expose broadly -- it is arithmetic on a string.
grant execute on function public.iso_week_start(text) to anon, authenticated, service_role;

-- 4. weekly_performance() --------------------------------------------------
-- Per-category and plan-level metrics for one plan for one ISO week. Pure
-- aggregation: no external calls, no AI, no writes.
--
-- CALLED WITH THE USER'S OWN ANON CLIENT, NOT THE SERVICE CLIENT. It derives
-- the user from auth.uid() and takes no user id, the same posture as every
-- other authenticated RPC here, and the same call-site rule api.md sec3e
-- states for the calendar routes ("ownership is proved with the user's own
-- anon client, never the service client"). A service-role caller has a null
-- auth.uid() and will be rejected -- that is intentional, not a gap.
--
-- WHAT IS PORTED, AND FROM WHERE. These are not new definitions; they are
-- src/mtdo/core.py's already-proven ones moved to SQL:
--   * compute_week_progress()  -> the per-category (done, total) pair over a
--     week's board, counted by DATE KEY. That is why "picked this week" means
--     "a block whose board date falls in this ISO week" and not "a block
--     created this week": core.py iterates the week's date keys, and blocks
--     has no created_at to iterate instead. A block moved to another week
--     moves its attribution with it, which is the same thing the terminal
--     app does and is the right frame for "what was on my board that week".
--   * compute_week_progress()'s deliberate second half -- counting the
--     still-unpicked weekly menu toward the denominator -- is the one place
--     this SPLITS rather than ports. See the pick_rate note below.
--   * compute_daily_score()    -> score := sum over categories of
--     round(score_weight * completion_rate), at week granularity instead of
--     day granularity. Categories nobody picked from are skipped, exactly as
--     `if not blocks: continue` does there.
--   * compute_day_streaks()    -> study_days. The terminal app's streaks are
--     a walk over days with activity; the weekly engine only needs the count
--     of such days inside the week, so that is what this exposes. (The
--     current/longest streak walk itself already exists on the web side, in
--     web/features/signal-deck/streak.ts, over daily_rollups -- not
--     duplicated here.)
--
-- WHERE "DONE" COMES FROM, and why it is not just blocks.status.
-- api.md sec3a's rule stands: blocks is ordinary client-writable data, so its
-- status and timestamps are whatever the client says they are, and the ledger
-- is the source of truth. So done-ness is the ledger's verdict -- a block's
-- LAST task_completed / task_regressed event wins, which is the same
-- last-event-wins rule recompute_daily_rollups() uses per day, applied to the
-- block's whole history rather than one day (compute_week_progress() reads
-- the CURRENT done-ness of a week's blocks, not "was it completed inside the
-- week", and a block dated Sunday and finished Monday morning is genuinely
-- done work for that week).
-- A block the ledger has NEVER seen falls back to blocks.status. This is a
-- deliberate, narrow fallback: task_completed/task_regressed only gained a
-- call site in Phase 1 (api.md sec2c/sec2d), so every block completed before
-- that has no event at all and would otherwise read as permanently unfinished
-- and drag a user's completion rate down forever. The ledger is authoritative
-- wherever it has an opinion; the status column is consulted only where it
-- has none.

create function public.weekly_performance(p_plan_id uuid, p_iso_week text)
returns jsonb
language plpgsql
security definer
stable
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_tz text;
  v_week_start date;
  v_week_end date;
  v_planning_mode text;
  v_cursor_week text;
  v_result jsonb;
begin
  if v_uid is null then
    raise exception 'weekly_performance: no authenticated user' using errcode = '42501';
  end if;

  -- Ownership is re-checked here, not just in RLS: this function is owned by
  -- postgres and is therefore exempt from RLS, so this predicate IS the
  -- access control. A RETIRED plan is deliberately still readable -- reviewing
  -- the history of a goal you have since put down is legitimate, and unlike
  -- pick_curriculum_item() nothing here writes to the board.
  select p.planning_mode into v_planning_mode
  from public.plans p
  where p.id = p_plan_id and p.user_id = v_uid;

  if v_planning_mode is null then
    -- Deliberately does not distinguish "not yours" from "no such plan" --
    -- same posture as pick_curriculum_item()/schedule_block().
    raise exception 'weekly_performance: plan % not available for this user', p_plan_id
      using errcode = '42501';
  end if;

  v_week_start := public.iso_week_start(p_iso_week);
  v_week_end := v_week_start + 6;

  -- Same coalesce(profiles.timezone, 'UTC') fallback as
  -- recompute_daily_rollups() (0013) and pick_curriculum_item() (0014). NULL
  -- is "never set a preference", a real state distinct from "chose UTC" --
  -- see that column's own comment.
  select coalesce(p.timezone, 'UTC') into v_tz
  from public.profiles p where p.id = v_uid;
  v_tz := coalesce(v_tz, 'UTC');

  with
  -- Every category of this plan, including ones with no activity at all --
  -- a category that saw nothing this week is a real, reportable state
  -- ("not engaged"), not a missing row. The TS rules engine depends on
  -- seeing it (a left join, never an inner one).
  cat as (
    select pc.id, pc.name, pc.label, pc.sort_order, pc.min_blocks,
           pc.score_weight, pc.days, pc.menu_unlocked_week_index,
           pc.menu_unlocked_iso_week, pc.weekly_target_blocks, pc.created_at
    from public.plan_categories pc
    where pc.plan_id = p_plan_id
  ),

  -- The ledger's verdict per block: the last completion/regression event of
  -- any time, plus how many regressions happened INSIDE the target week.
  ledger as (
    select (e.payload->>'block_id')::uuid as block_id,
           (array_agg(e.kind order by e.occurred_at desc, e.id desc))[1] as last_kind,
           count(*) filter (
             where e.kind = 'task_regressed'
               and (e.occurred_at at time zone v_tz)::date between v_week_start and v_week_end
           ) as regressed_in_week
    from public.activity_events e
    where e.user_id = v_uid
      and e.kind in ('task_completed', 'task_regressed')
      and e.payload ? 'block_id'
      and (e.payload->>'block_id') ~ '^[0-9a-fA-F-]{36}$'
    group by 1
  ),

  -- Real focus time per block, from focus_sessions and never from
  -- blocks.elapsed_seconds (a client-maintained convenience mirror, schema.md
  -- sec2). Both rules are recompute_daily_rollups()' rules, unchanged:
  -- attributed to the day the session STARTED, and each session capped at
  -- planned_duration_s so a tab left open for nine hours is not nine hours of
  -- focus (DESIGN.md's "the app never exaggerates the user's record").
  sess as (
    select fs.block_id,
           sum(least(
             extract(epoch from (fs.completed_at - fs.started_at)),
             fs.planned_duration_s
           )) as seconds,
           count(*) filter (where fs.state = 'completed') as completed_sessions,
           count(*) as settled_sessions
    from public.focus_sessions fs
    where fs.user_id = v_uid
      and fs.state in ('completed', 'abandoned')
      and fs.completed_at is not null
      and fs.block_id is not null
      and (fs.started_at at time zone v_tz)::date between v_week_start and v_week_end
    group by 1
  ),

  -- This week's board: every block whose DATE falls in the week (see the
  -- header note on why date and not a creation timestamp).
  wk as (
    select b.id, b.category_id, b.date, b.status, b.estimated_minutes,
           coalesce(s.seconds, 0) / 60.0 as actual_minutes,
           coalesce(s.completed_sessions, 0) as completed_sessions,
           coalesce(s.settled_sessions, 0) as settled_sessions,
           coalesce(l.regressed_in_week, 0) as regressed_in_week,
           case
             when l.last_kind is not null then l.last_kind = 'task_completed'
             else b.status = 'done'
           end as is_done
    from public.blocks b
    left join ledger l on l.block_id = b.id
    left join sess s on s.block_id = b.id
    where b.user_id = v_uid
      and b.plan_id = p_plan_id
      and b.date between v_week_start and v_week_end
  ),

  -- Open (not-done) blocks as of the end of the week, for backlog size.
  -- Anything dated BEFORE the week and still open is also the second,
  -- detectable shape of "postponed" -- see postponement_count below.
  openb as (
    select b.id, b.category_id, b.date
    from public.blocks b
    left join ledger l on l.block_id = b.id
    where b.user_id = v_uid
      and b.plan_id = p_plan_id
      and b.date <= v_week_end
      and not (case
                 when l.last_kind is not null then l.last_kind = 'task_completed'
                 else b.status = 'done'
               end)
  ),

  -- WHAT THE MENU OFFERED THAT WEEK -- the honest reconstruction, and the one
  -- number in this function that is an ESTIMATE rather than a measurement.
  --
  -- Nothing records the unlock cursor's historical position; plan_categories
  -- holds only where it is NOW (menu_unlocked_week_index) and when it last
  -- moved (menu_unlocked_iso_week). The cursor advances at most once per ISO
  -- week (0012), so walking it back one per elapsed week gives a LOWER BOUND
  -- on what was unlocked during the target week -- it may have advanced less,
  -- never more.
  --
  -- The direction of that error is chosen, not accidental. Under-counting
  -- what was offered INFLATES pick_rate, which makes the "avoided" signal
  -- (pick_rate < 0.3) harder to trigger. Since "avoided" proposes asking the
  -- user whether a category still matters to them, biasing against a false
  -- accusation is the right way to be wrong.
  --
  -- In `overall` mode (0017) the cursor is never used at all and the whole
  -- curriculum is on the menu at once, so there is nothing to reconstruct.
  cursor_at as (
    select c.id,
           case
             when v_planning_mode = 'overall' then null::integer
             when c.menu_unlocked_iso_week is null then -1
             else greatest(
               0,
               c.menu_unlocked_week_index - greatest(
                 0,
                 ((public.iso_week_start(c.menu_unlocked_iso_week) - v_week_start) / 7)::integer
               )
             )
           end as unlocked_through
    from cat c
  ),

  -- An item was "offered" in the target week if it was unlocked by then and
  -- had not already been pulled onto the board in an EARLIER week. Items
  -- picked earlier are neither offered nor skipped now -- they are simply
  -- gone from the menu, which is exactly what ensure_curriculum_menu() does
  -- ("picked" is derived from a block existing, api.md sec3b).
  menu as (
    select ci.category_id,
           count(*) as offered,
           count(*) filter (where b_in_week.id is not null) as picked_from_menu
    from public.curriculum_items ci
    join cat c on c.id = ci.category_id
    join cursor_at ca on ca.id = ci.category_id
    left join public.blocks b_prior
      on b_prior.curriculum_item_id = ci.id
     and b_prior.user_id = v_uid
     and b_prior.date < v_week_start
    left join public.blocks b_in_week
      on b_in_week.curriculum_item_id = ci.id
     and b_in_week.user_id = v_uid
     and b_in_week.date between v_week_start and v_week_end
    where b_prior.id is null
      and (ca.unlocked_through is null or ci.week_index <= ca.unlocked_through)
    group by 1
  ),

  -- Distinct days with real activity, per category and plan-wide. Ported from
  -- compute_day_streaks()' notion of "a day with activity": a completion
  -- event or a settled focus session. A day on which the user only opened the
  -- app is not a study day.
  days_cat as (
    select b.category_id, count(distinct d.day) as study_days
    from (
      select (e.occurred_at at time zone v_tz)::date as day,
             (e.payload->>'block_id')::uuid as block_id
      from public.activity_events e
      where e.user_id = v_uid
        and e.kind = 'task_completed'
        and e.payload ? 'block_id'
        and (e.payload->>'block_id') ~ '^[0-9a-fA-F-]{36}$'
        and (e.occurred_at at time zone v_tz)::date between v_week_start and v_week_end
      union all
      select (fs.started_at at time zone v_tz)::date, fs.block_id
      from public.focus_sessions fs
      where fs.user_id = v_uid
        and fs.state in ('completed', 'abandoned')
        and fs.block_id is not null
        and (fs.started_at at time zone v_tz)::date between v_week_start and v_week_end
    ) d
    join public.blocks b on b.id = d.block_id and b.plan_id = p_plan_id
    group by 1
  ),

  -- Scoped to THIS plan via the same blocks join days_cat uses, not just to
  -- the user: a review of one plan must not count a day the user spent
  -- entirely on a different (or since-retired) plan. Consequence worth
  -- knowing: a focus session with a null block_id is attributable to no plan
  -- and so counts toward no plan's study days.
  days_plan as (
    select count(distinct d.day) as study_days
    from (
      select (e.occurred_at at time zone v_tz)::date as day,
             (e.payload->>'block_id')::uuid as block_id
      from public.activity_events e
      where e.user_id = v_uid
        and e.kind = 'task_completed'
        and e.payload ? 'block_id'
        and (e.payload->>'block_id') ~ '^[0-9a-fA-F-]{36}$'
        and (e.occurred_at at time zone v_tz)::date between v_week_start and v_week_end
      union all
      select (fs.started_at at time zone v_tz)::date, fs.block_id
      from public.focus_sessions fs
      where fs.user_id = v_uid
        and fs.state in ('completed', 'abandoned')
        and fs.block_id is not null
        and (fs.started_at at time zone v_tz)::date between v_week_start and v_week_end
    ) d
    join public.blocks b on b.id = d.block_id and b.plan_id = p_plan_id
  ),

  -- PACE. Two guards, both load-bearing.
  --
  -- 1. estimated_minutes is genuinely NULL for most tasks (0018: no authoring
  --    surface collects it yet), so a null-estimate task is EXCLUDED from the
  --    pace calculation entirely. It is never treated as a zero estimate --
  --    that would divide by zero, or worse, read as infinitely slow.
  -- 2. A done block with NO settled focus session is also excluded. Without
  --    this, someone who finishes their tasks without ever running the timer
  --    computes as ~0 minutes against a real estimate -- a pace ratio near
  --    zero -- and gets classified "coasting" and handed 25% MORE work for
  --    the crime of not using a Pomodoro. That is the single most damaging
  --    false positive this engine can produce, and it is closed here in the
  --    metric rather than patched around in the rules.
  paced as (
    select w.category_id,
           sum(w.estimated_minutes)::numeric as est_minutes,
           sum(w.actual_minutes)::numeric as act_minutes,
           avg(w.actual_minutes / w.estimated_minutes)::numeric as ratio_mean,
           count(*) as paced_tasks
    from wk w
    where w.is_done
      and w.estimated_minutes is not null
      and w.settled_sessions > 0
    group by 1
  ),

  per_cat as (
    select c.id, c.name, c.label, c.sort_order, c.min_blocks, c.score_weight,
           coalesce(array_length(c.days, 1), 0) as days_per_week,
           c.weekly_target_blocks,
           -- The resolved pace the rules engine takes +/-25% of. NULL
           -- weekly_target_blocks falls back to the plan's own natural pace
           -- (one unlocked week_index holds array_length(days,1) items), and
           -- to 1 for a degenerate category with an empty days array, so the
           -- baseline is never 0 -- a 0 baseline makes every percentage
           -- meaningless and every proposal a division by zero.
           greatest(1, coalesce(c.weekly_target_blocks, array_length(c.days, 1), 1))
             as current_target,
           c.created_at as category_created_at,
           -- Strictly before the week began: a category created ON the
           -- Wednesday of the week under review has only a partial week of
           -- data, which is exactly the gap that must not be read as a
           -- healthy signal.
           (c.created_at < v_week_start::timestamptz) as existed_before_week,
           count(w.id) as picked_count,
           count(w.id) filter (where w.is_done) as done_count,
           coalesce(sum(w.actual_minutes), 0)::numeric as actual_minutes,
           coalesce(sum(w.completed_sessions), 0) as sessions_completed,
           coalesce(sum(w.regressed_in_week), 0) as regressed_count,
           coalesce(m.offered, 0) as menu_offered_count,
           coalesce(m.picked_from_menu, 0) as menu_picked_count,
           coalesce(p.est_minutes, 0)::numeric as estimated_minutes,
           coalesce(p.act_minutes, 0)::numeric as paced_actual_minutes,
           p.ratio_mean,
           coalesce(p.paced_tasks, 0) as paced_task_count,
           coalesce(d.study_days, 0) as study_days,
           (select count(*) from openb o where o.category_id = c.id) as backlog_count,
           (select count(*) from openb o
             where o.category_id = c.id and o.date < v_week_start) as stale_open_count
    from cat c
    left join wk w on w.category_id = c.id
    left join menu m on m.category_id = c.id
    left join paced p on p.category_id = c.id
    left join days_cat d on d.category_id = c.id
    group by c.id, c.name, c.label, c.sort_order, c.min_blocks, c.score_weight,
             c.days, c.weekly_target_blocks, c.created_at,
             m.offered, m.picked_from_menu,
             p.est_minutes, p.act_minutes, p.ratio_mean, p.paced_tasks, d.study_days
  ),

  -- EVERY RATE IS NULL WHEN ITS DENOMINATOR IS ZERO, NEVER 0.0.
  -- This is the distinction the whole engine turns on: "picked nothing" and
  -- "picked everything and finished none of it" are different facts about a
  -- human being, and collapsing both to 0% would have the rules propose
  -- cutting the load of a category the user simply never opened. The TS side
  -- treats null as "uncomputable, excluded from classification" and must
  -- never coalesce it to zero.
  shaped as (
    select pc.*,
           case when pc.picked_count > 0
                then round(pc.done_count::numeric / pc.picked_count, 4) end as completion_rate,
           case when pc.paced_task_count > 0 and pc.estimated_minutes > 0
                then round(pc.paced_actual_minutes / pc.estimated_minutes, 4) end as pace_ratio,
           case when pc.paced_task_count > 0
                then round(pc.ratio_mean, 4) end as pace_ratio_mean,
           case when pc.menu_offered_count > 0
                then round(pc.menu_picked_count::numeric / pc.menu_offered_count, 4) end as pick_rate
    from per_cat pc
  )

  select jsonb_build_object(
    'schema_version', 'mtdo.weekly_performance.v1',
    'plan_id', p_plan_id,
    'iso_week', p_iso_week,
    'week_start', v_week_start,
    'week_end', v_week_end,
    'timezone', v_tz,
    'planning_mode', v_planning_mode,
    'computed_at', now(),
    'plan', jsonb_build_object(
      'picked_count', coalesce(sum(s.picked_count), 0),
      'done_count', coalesce(sum(s.done_count), 0),
      'completion_rate', case when coalesce(sum(s.picked_count), 0) > 0
        then round(sum(s.done_count)::numeric / sum(s.picked_count), 4) end,
      'estimated_minutes', round(coalesce(sum(s.estimated_minutes), 0), 1),
      'actual_minutes', round(coalesce(sum(s.actual_minutes), 0), 1),
      'paced_actual_minutes', round(coalesce(sum(s.paced_actual_minutes), 0), 1),
      'paced_task_count', coalesce(sum(s.paced_task_count), 0),
      'pace_ratio', case when coalesce(sum(s.paced_task_count), 0) > 0
                          and coalesce(sum(s.estimated_minutes), 0) > 0
        then round(sum(s.paced_actual_minutes) / sum(s.estimated_minutes), 4) end,
      'menu_offered_count', coalesce(sum(s.menu_offered_count), 0),
      'menu_picked_count', coalesce(sum(s.menu_picked_count), 0),
      'pick_rate', case when coalesce(sum(s.menu_offered_count), 0) > 0
        then round(sum(s.menu_picked_count)::numeric / sum(s.menu_offered_count), 4) end,
      'regressed_count', coalesce(sum(s.regressed_count), 0),
      'stale_open_count', coalesce(sum(s.stale_open_count), 0),
      'postponement_count', coalesce(sum(s.regressed_count), 0) + coalesce(sum(s.stale_open_count), 0),
      'backlog_count', coalesce(sum(s.backlog_count), 0),
      'sessions_completed', coalesce(sum(s.sessions_completed), 0),
      'study_days', (select study_days from days_plan),
      -- compute_daily_score(), at week granularity. Categories nobody picked
      -- from are skipped entirely (core.py's `if not blocks: continue`), so
      -- score_max moves with what was actually attempted -- a user is never
      -- scored against a category that was not on their board.
      'score', coalesce(sum(round(s.score_weight * s.done_count::numeric / nullif(s.picked_count, 0)))
                        filter (where s.picked_count > 0), 0),
      'score_max', coalesce(sum(s.score_weight) filter (where s.picked_count > 0), 0)
    ),
    'categories', coalesce(jsonb_agg(jsonb_build_object(
      'category_id', s.id,
      'name', s.name,
      'label', s.label,
      'sort_order', s.sort_order,
      'min_blocks', s.min_blocks,
      'score_weight', s.score_weight,
      'days_per_week', s.days_per_week,
      'weekly_target_blocks', s.weekly_target_blocks,
      'current_target', s.current_target,
      'category_created_at', s.category_created_at,
      'existed_before_week', s.existed_before_week,
      'picked_count', s.picked_count,
      'done_count', s.done_count,
      'completion_rate', s.completion_rate,
      'estimated_minutes', round(s.estimated_minutes, 1),
      'actual_minutes', round(s.actual_minutes, 1),
      'paced_actual_minutes', round(s.paced_actual_minutes, 1),
      'paced_task_count', s.paced_task_count,
      'pace_ratio', s.pace_ratio,
      'pace_ratio_mean', s.pace_ratio_mean,
      'menu_offered_count', s.menu_offered_count,
      'menu_picked_count', s.menu_picked_count,
      'skipped_count', s.menu_offered_count - s.menu_picked_count,
      'pick_rate', s.pick_rate,
      'regressed_count', s.regressed_count,
      'stale_open_count', s.stale_open_count,
      'postponement_count', s.regressed_count + s.stale_open_count,
      'backlog_count', s.backlog_count,
      'sessions_completed', s.sessions_completed,
      'study_days', s.study_days
    ) order by s.sort_order, s.label), '[]'::jsonb)
  ) into v_result
  from shaped s;

  return v_result;
end;
$$;

alter function public.weekly_performance(uuid, text) owner to postgres;
revoke execute on function public.weekly_performance(uuid, text) from public, anon;
grant execute on function public.weekly_performance(uuid, text) to authenticated;

comment on function public.weekly_performance(uuid, text) is
  'Deterministic per-category and plan-level metrics for one plan for one ISO week, as jsonb (schema mtdo.weekly_performance.v1). Ports src/mtdo/core.py''s compute_week_progress/compute_daily_score/compute_day_streaks. Read-computed, never trigger-maintained (same reasoning as daily_rollups, decisions.md 2026-09-06). Pure aggregation -- no AI, no network, no writes. Every rate is NULL when its denominator is zero, never 0.0. See docs/architecture/api.md sec3f.';
