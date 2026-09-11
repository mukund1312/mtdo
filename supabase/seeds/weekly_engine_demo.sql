-- ===========================================================================
-- Weekly-engine demo fixture (Phase 7). Backdated, realistic, 3 synthetic
-- weeks of history for one plan, built so that EVERY classification the
-- rules engine can produce is actually crossed by real data.
--
-- WHY THIS FILE EXISTS AT ALL. Weekly metrics are meaningless without
-- multi-week history, and neither the pgTAP suite nor a manual browser
-- walkthrough can wait three real calendar weeks for one. This is the shared
-- fixture both use, so a test and a hand-check are looking at the same
-- numbers.
--
-- THIS IS NOT A MIGRATION. It lives in supabase/seeds/ and is never applied
-- by `supabase db push`. It only DEFINES a function; nothing happens until
-- you call it.
--
-- ---------------------------------------------------------------------------
-- HOW TO RUN IT
--
-- 1. Local test cluster (what supabase/tests/run.sh does -- the file is
--    sourced there automatically, before the test files):
--
--      psql -f supabase/seeds/weekly_engine_demo.sql
--      select public.seed_weekly_engine_demo('<user-uuid>');
--
-- 2. Against a real (scratch or dev) Supabase project, as service_role, for a
--    manual walkthrough of the Review deck:
--
--      psql "$SUPABASE_DB_URL" -f supabase/seeds/weekly_engine_demo.sql
--      psql "$SUPABASE_DB_URL" -c \
--        "select public.seed_weekly_engine_demo('<your-auth-user-uuid>');"
--
--    Then open the app as that user and generate a review
--    (POST /api/plan/weekly-review).
--
--    DO NOT run this against production. It creates a whole plan with three
--    weeks of fabricated history and (by default) makes it the user's active
--    plan, retiring whatever they were actually working on.
--
-- Returns jsonb: { plan_id, user_id, weeks: {w1,w2,w3}, categories: {...},
--                  expected: {...} } -- `expected` is the classification each
-- category is BUILT to produce, so a test or a human can check the engine
-- against the fixture's intent rather than against its own output.
--
-- Clean up the function itself afterwards, if you want to:
--   drop function public.seed_weekly_engine_demo(uuid, text, boolean);
--
-- ---------------------------------------------------------------------------
-- WHAT IT BUILDS, AND WHY THESE EXACT NUMBERS
--
-- Four categories, each engineered to sit unambiguously in one bucket over
-- the trailing two weeks (w2 and w3 -- w1 exists so "the week before the
-- trailing window" is a real thing tests can reason about, and so the
-- decline in `dsa` reads as a trend rather than a single bad week):
--
--   dsa   (target 4/wk)  STRUGGLING  completion .50 -> .33 -> .25, pace 1.5
--   sql   (target 4/wk)  COASTING    completion 1.0 every week, pace 0.60
--   sysd  (target 2/wk)  AVOIDED     pick_rate .20 / .17 -- note it completes
--                                    everything it DOES pick (1.0): avoided is
--                                    about engagement, not failure, and the
--                                    fixture proves the two are separable
--   behav (target 3/wk)  ON TRACK    completion .75, pace 1.0, pick_rate high
--
-- Overall completion is deliberately kept ABOVE the 40% low-week floor
-- (w2 = 10/15 = .67, w3 = 9/13 = .69). If it dipped below, the engine would
-- correctly suppress `sql`'s increase and the fixture would silently stop
-- exercising the coasting path at all -- the kind of fixture bug that looks
-- like a passing test.
--
-- FOCUS TIME IS RECORDED AS REAL POMODOROS, not one long session, and that
-- detail is load-bearing. recompute_daily_rollups() and weekly_performance()
-- both cap a session at `least(elapsed, planned_duration_s)`, so a 45-minute
-- actual against a 30-minute estimate CANNOT be recorded as one 30-minute
-- session -- it would be capped straight back to 30 and the pace ratio would
-- read 1.0 instead of 1.5. Slow work is therefore seeded as 25-minute
-- sessions plus a remainder, which is both what the cap requires and what a
-- real user's day actually looks like.
-- ===========================================================================

create or replace function public.seed_weekly_engine_demo(
  p_user_id uuid,
  p_anchor_iso_week text default null,
  p_activate boolean default true
)
returns jsonb
language plpgsql
security definer
as $$
declare
  -- name, label, days_len, est_minutes, actual_minutes_per_done,
  -- picked w1/w2/w3, done w1/w2/w3, regressions w2, regressions w3
  v_spec jsonb := '[
    {"name":"dsa","label":"DSA","days":4,"est":30,"act":45,"weight":40,
     "picked":[6,6,4],"done":[3,2,1],"regressed":[0,2,1],"expect":"struggling"},
    {"name":"sql","label":"SQL","days":4,"est":30,"act":18,"weight":25,
     "picked":[4,4,4],"done":[4,4,4],"regressed":[0,0,0],"expect":"coasting"},
    {"name":"system_design","label":"System Design","days":2,"est":45,"act":45,"weight":20,
     "picked":[1,1,1],"done":[1,1,1],"regressed":[0,0,0],"expect":"avoided"},
    {"name":"behavioral","label":"Behavioral","days":3,"est":20,"act":20,"weight":15,
     "picked":[4,4,4],"done":[3,3,3],"regressed":[0,0,0],"expect":"on_track"}
  ]'::jsonb;

  v_anchor text;
  v_w text[];
  v_week_start date;
  v_plan_id uuid;
  v_cat_id uuid;
  v_block_id uuid;
  v_item_id uuid;
  v_cats jsonb := '{}'::jsonb;
  v_spec_row jsonb;
  v_days integer;
  v_week integer;
  v_picked integer;
  v_done integer;
  v_regressed integer;
  v_item_cursor integer;
  v_i integer;
  v_d date;
  v_is_done boolean;
  v_remaining integer;
  v_chunk integer;
  v_sess_start timestamptz;
  v_sess_no integer;
  v_total_items integer;
  v_sort integer := 0;
begin
  if p_user_id is null then
    raise exception 'seed_weekly_engine_demo: p_user_id is required';
  end if;
  if not exists (select 1 from auth.users u where u.id = p_user_id) then
    raise exception 'seed_weekly_engine_demo: no auth user %', p_user_id;
  end if;

  -- Anchor on the most recently COMPLETED week by default: the review a user
  -- would actually be shown today is of the week that just ended, not the one
  -- they are still living in.
  v_anchor := coalesce(p_anchor_iso_week, to_char(current_date - 7, 'IYYY-"W"IW'));
  v_w := array[
    to_char(public.iso_week_start(v_anchor) - 14, 'IYYY-"W"IW'),
    to_char(public.iso_week_start(v_anchor) - 7, 'IYYY-"W"IW'),
    v_anchor
  ];

  -- Idempotent re-seed. Blocks reference plans ON DELETE RESTRICT, so the
  -- teardown order matters and is the reverse of the build order. Ledger rows
  -- are deliberately NOT deleted -- activity_events is append-only by design
  -- (schema.md sec6) and this fixture does not get to be the one exception.
  -- Orphaned events are harmless: every read path in weekly_performance()
  -- joins them back to a block of the plan under review, so events whose
  -- block no longer exists match nothing.
  for v_plan_id in
    select id from public.plans
    where user_id = p_user_id and app_name = 'mtdo-weekly-engine-demo'
  loop
    delete from public.weekly_plan_changes where plan_id = v_plan_id;
    delete from public.weekly_plans where plan_id = v_plan_id;
    delete from public.focus_sessions
      where block_id in (select id from public.blocks where plan_id = v_plan_id);
    delete from public.blocks where plan_id = v_plan_id;
    delete from public.curriculum_items
      where category_id in (select id from public.plan_categories where plan_id = v_plan_id);
    delete from public.plan_categories where plan_id = v_plan_id;
    delete from public.plans where id = v_plan_id;
  end loop;

  insert into public.plans (user_id, app_name, goal_line, is_active, planning_mode)
  values (p_user_id, 'mtdo-weekly-engine-demo',
          'Land a senior backend role in 12 weeks', false, 'dynamic_weekly')
  returning id into v_plan_id;

  for v_spec_row in select * from jsonb_array_elements(v_spec)
  loop
    v_days := (v_spec_row->>'days')::integer;

    insert into public.plan_categories
      (plan_id, name, label, days, min_blocks, score_weight, sort_order,
       menu_unlocked_week_index, menu_unlocked_iso_week, created_at)
    values (
      v_plan_id,
      v_spec_row->>'name',
      v_spec_row->>'label',
      -- `days` for a curriculum category is a COUNT, not a weekday filter
      -- (api.md sec3b) -- only its length is ever read. The specific weekday
      -- numbers here are arbitrary and deliberately so.
      (select array_agg(g) from generate_series(0, v_days - 1) g),
      1,
      (v_spec_row->>'weight')::numeric,
      v_sort,
      -- Cursor fully unlocked through week_index 3, last advanced in the
      -- anchor week. weekly_performance() walks this back one week_index per
      -- elapsed ISO week to reconstruct what the menu offered in a PAST week;
      -- stamping it here is what makes that reconstruction exercisable.
      3,
      v_anchor,
      -- Backdated to a week BEFORE the oldest seeded week. Without this the
      -- categories would carry created_at = now(), weekly_performance() would
      -- correctly report existed_before_week = false for every seeded week,
      -- and the engine would exclude all four as too new -- the fixture would
      -- pass its own inserts and prove nothing about classification.
      (public.iso_week_start(v_w[1]) - 7)::timestamptz
    )
    returning id into v_cat_id;

    v_cats := v_cats || jsonb_build_object(v_spec_row->>'name', v_cat_id);
    v_sort := v_sort + 1;

    -- Four week_indexes of content, days_len items each -- the same
    -- "array_length(days,1) items make one week" bucketing persist.ts and
    -- extend_plan() use.
    v_total_items := v_days * 4;
    for v_i in 0 .. v_total_items - 1 loop
      insert into public.curriculum_items
        (category_id, week_index, position, task, meta, priority, estimated_minutes)
      values (
        v_cat_id,
        v_i / v_days,
        v_i,
        (v_spec_row->>'label') || ' task ' || (v_i + 1),
        jsonb_build_object(
          'focus_points', jsonb_build_array('Focus point for ' || (v_spec_row->>'label')),
          'mistakes', jsonb_build_array('A common mistake here')
        ),
        'medium',
        (v_spec_row->>'est')::integer
      );
    end loop;

    -- Blocks, week by week. Items are consumed in curriculum order, so
    -- "already picked in an earlier week" is true of exactly the right items
    -- and weekly_performance()'s menu reconstruction has something real to
    -- exclude.
    v_item_cursor := 0;
    for v_week in 1 .. 3 loop
      v_week_start := public.iso_week_start(v_w[v_week]);
      v_picked := (v_spec_row->'picked'->>(v_week - 1))::integer;
      v_done := (v_spec_row->'done'->>(v_week - 1))::integer;
      v_regressed := (v_spec_row->'regressed'->>(v_week - 1))::integer;

      for v_i in 0 .. v_picked - 1 loop
        -- Spread across Mon-Fri so study_days is a real count and not just
        -- "everything happened on Monday".
        v_d := v_week_start + (v_i % 5);
        v_is_done := v_i < v_done;

        select id into v_item_id from public.curriculum_items
        where category_id = v_cat_id and position = v_item_cursor;
        v_item_cursor := v_item_cursor + 1;

        insert into public.blocks
          (user_id, plan_id, category_id, curriculum_item_id, date, position,
           text, status, coaching, priority, estimated_minutes, completed_at)
        values (
          p_user_id, v_plan_id, v_cat_id, v_item_id, v_d,
          -- position is unique within (user, date, category) because v_i is
          -- unique within the week and dates only repeat for a different v_i.
          v_i,
          (v_spec_row->>'label') || ' task ' || v_item_cursor,
          case when v_is_done then 'done' else 'todo' end,
          jsonb_build_object('focus_points',
            jsonb_build_array('Focus point for ' || (v_spec_row->>'label'))),
          'medium',
          (v_spec_row->>'est')::integer,
          case when v_is_done then (v_d + time '18:00')::timestamptz end
        )
        returning id into v_block_id;

        if v_is_done then
          -- The ledger is what weekly_performance() actually reads for
          -- done-ness (blocks.status is only its fallback for blocks the
          -- ledger has never seen), so a seeded completion has to be a real
          -- event with a real payload.block_id -- api.md sec2d.
          insert into public.activity_events (user_id, kind, occurred_at, payload)
          values (p_user_id, 'task_completed', (v_d + time '18:00')::timestamptz,
                  jsonb_build_object('block_id', v_block_id::text));

          -- Focus time, as 25-minute pomodoros plus a remainder. See this
          -- file's header for why one long session would be capped back to
          -- the estimate and quietly destroy the pace signal.
          v_remaining := (v_spec_row->>'act')::integer;
          v_sess_no := 0;
          while v_remaining > 0 loop
            v_chunk := least(25, v_remaining);
            v_sess_start := (v_d + time '14:00')::timestamptz
                            + (v_sess_no * interval '30 minutes');
            insert into public.focus_sessions
              (user_id, block_id, started_at, planned_duration_s, state, completed_at)
            values (p_user_id, v_block_id, v_sess_start, 1500, 'completed',
                    v_sess_start + (v_chunk * interval '1 minute'));
            v_remaining := v_remaining - v_chunk;
            v_sess_no := v_sess_no + 1;
          end loop;

        elsif v_i - v_done < v_regressed then
          -- A postponement, in the one shape the ledger can actually express:
          -- completed, then walked back. Last-event-wins makes this NOT done
          -- while still counting a regression inside the week.
          insert into public.activity_events (user_id, kind, occurred_at, payload)
          values (p_user_id, 'task_completed', (v_d + time '18:00')::timestamptz,
                  jsonb_build_object('block_id', v_block_id::text)),
                 (p_user_id, 'task_regressed', (v_d + time '20:00')::timestamptz,
                  jsonb_build_object('block_id', v_block_id::text));
        end if;
      end loop;
    end loop;
  end loop;

  if p_activate then
    -- Mirrors activate_plan()'s own mechanism (0005/0006/0008): the
    -- plans_guard_activation trigger rejects any write leaving is_active true
    -- unless this transaction-local flag is set, and activate_plan() is
    -- normally the only thing that sets it. The RPC itself cannot be used
    -- here because it derives its user from auth.uid(), which is null in a
    -- seed run.
    perform set_config('mtdo.activating_plan', 'true', true);
    update public.plans set is_active = false
      where user_id = p_user_id and is_active and id <> v_plan_id;
    update public.plans set is_active = true where id = v_plan_id;
  end if;

  return jsonb_build_object(
    'plan_id', v_plan_id,
    'user_id', p_user_id,
    'weeks', jsonb_build_object('w1', v_w[1], 'w2', v_w[2], 'w3', v_w[3]),
    'categories', v_cats,
    'expected', jsonb_build_object(
      'dsa', 'struggling',
      'sql', 'coasting',
      'system_design', 'avoided',
      'behavioral', 'on_track'
    )
  );
end;
$$;

comment on function public.seed_weekly_engine_demo(uuid, text, boolean) is
  'DEV/TEST FIXTURE, not a migration. Builds 3 backdated weeks of realistic history for one plan with four categories engineered to cross each weekly-engine classification (struggling/coasting/avoided/on track). See the header of supabase/seeds/weekly_engine_demo.sql for how to invoke it and why the numbers are what they are. Never run against production.';
