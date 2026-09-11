\set ON_ERROR_STOP on
\pset pager off
set client_min_messages = notice;
set timezone = 'UTC';

-- migrations/0022: weekly_plans / weekly_plan_changes, save_weekly_plan(),
-- apply_weekly_plan_change(), accept_all_weekly_plan_changes().
--
-- The point of most of these assertions is not that the happy path works --
-- it is that the HARD CONSTRAINTS hold against a caller that is actively
-- trying to get around them. The rules engine lives in TypeScript
-- (web/lib/planning/**), so the database cannot assume its input came from
-- the engine; everything the engine promises is re-checked here.

-- A reusable fixture: one plan, two categories, one stored review with one
-- numeric change (dsa 4 -> 3) and one flagged question.
create or replace function t.mkreview(tag text)
returns jsonb language plpgsql as $$
declare
  v_uid uuid := t.mkuser(tag);
  v_plan uuid;
  v_dsa uuid;
  v_sysd uuid;
  v_review uuid;
begin
  insert into public.plans (user_id, app_name, goal_line, is_active)
    values (v_uid, 'test', 'Land a senior backend role', false) returning id into v_plan;
  insert into public.plan_categories (plan_id, name, label, days, sort_order, created_at)
    values (v_plan, 'dsa', 'DSA', '{0,1,2,3}', 0, '2026-01-01'::timestamptz) returning id into v_dsa;
  insert into public.plan_categories (plan_id, name, label, days, sort_order, created_at)
    values (v_plan, 'sysd', 'System Design', '{0,1}', 1, '2026-01-01'::timestamptz) returning id into v_sysd;

  perform set_config('request.jwt.claim.sub', v_uid::text, true);
  v_review := public.save_weekly_plan(
    v_plan, '2026-W36', '2026-W37',
    jsonb_build_object('schema_version', 'mtdo.weekly_review.v1'),
    jsonb_build_array(
      jsonb_build_object(
        'change_type', 'weekly_target_blocks', 'target_category_id', v_dsa,
        'old_value', 4, 'new_value', 3,
        'reason', 'Finished 1 of 4 tasks this week (25%) and 2 of 6 the week before (33%) - under half both weeks.',
        'signal', 'struggling'),
      jsonb_build_object(
        'change_type', 'flag_question', 'target_category_id', v_sysd,
        'old_value', null, 'new_value', null,
        'reason', 'Picked 1 of 6 tasks offered this week (17%). Is System Design still a priority?',
        'signal', 'avoided')
    ));
  return jsonb_build_object('uid', v_uid, 'plan', v_plan, 'dsa', v_dsa,
                            'sysd', v_sysd, 'review', v_review);
end $$;
grant execute on function t.mkreview(text) to anon, authenticated, service_role;

-- ===== save_weekly_plan(): what gets stored ================================
do $test$
declare
  v_f jsonb := t.mkreview('wpc_store');
begin
  perform t.eq('1 a generated review is stored as proposed',
    (select status from public.weekly_plans where id = (v_f->>'review')::uuid), 'proposed');
  perform t.eq('1b generated_by records a rules engine, NOT ai',
    (select generated_by from public.weekly_plans where id = (v_f->>'review')::uuid), 'rules_v1');
  perform t.eq('1c the reviewed week and the week it takes effect in are separate facts',
    (select iso_week || ' -> ' || effective_iso_week
       from public.weekly_plans where id = (v_f->>'review')::uuid), '2026-W36 -> 2026-W37');
  perform t.eq('1d both proposed changes were stored',
    (select count(*) from public.weekly_plan_changes
      where weekly_plan_id = (v_f->>'review')::uuid), 2::bigint);
  perform t.eq('1e every change starts pending, with no decision timestamp',
    (select count(*) from public.weekly_plan_changes
      where weekly_plan_id = (v_f->>'review')::uuid
        and status = 'pending' and decided_at is null), 2::bigint);
  -- Nothing is applied by generation itself. This is the whole premise of the
  -- change-review screen: a proposal is a proposal until a human says yes.
  perform t.eq('1f generating a proposal changes NOTHING about the plan yet',
    (select weekly_target_blocks from public.plan_categories where id = (v_f->>'dsa')::uuid),
    null::integer);
end $test$;

-- A review that proposes nothing is settled, not left waiting on the user.
do $test$
declare
  v_uid uuid := t.mkuser('wpc_empty');
  v_plan uuid;
  v_review uuid;
begin
  insert into public.plans (user_id, app_name, goal_line, is_active)
    values (v_uid, 'test', 'all on track', false) returning id into v_plan;
  perform set_config('request.jwt.claim.sub', v_uid::text, true);
  v_review := public.save_weekly_plan(v_plan, '2026-W36', '2026-W37',
    '{"schema_version":"mtdo.weekly_review.v1"}'::jsonb, '[]'::jsonb);
  perform t.eq('2 a review with nothing to change is settled immediately, not left proposed',
    (select status from public.weekly_plans where id = v_review), 'accepted');
end $test$;

-- ===== save_weekly_plan(): the rails, against a hostile caller =============
do $test$
declare
  v_f jsonb := t.mkreview('wpc_rails');
  v_uid uuid := (v_f->>'uid')::uuid;
  v_plan uuid := (v_f->>'plan')::uuid;
  v_dsa uuid := (v_f->>'dsa')::uuid;
  v_other_plan uuid;
  v_other_cat uuid;
begin
  perform set_config('request.jwt.claim.sub', v_uid::text, true);

  -- 4 -> 7 is +75%: more than one block AND more than 30%.
  perform t.raises('3 a proposal beyond the cap cannot even be STORED',
    format($$select public.save_weekly_plan(%L::uuid, '2026-W40', '2026-W41', '{}'::jsonb,
      jsonb_build_array(jsonb_build_object('change_type','weekly_target_blocks',
        'target_category_id',%L::uuid,'old_value',4,'new_value',7,
        'reason','x','signal','coasting')))$$, v_plan, v_dsa), '22023');

  perform t.raises('3b a target of zero is rejected -- stopping is a choice, not a nudge',
    format($$select public.save_weekly_plan(%L::uuid, '2026-W40', '2026-W41', '{}'::jsonb,
      jsonb_build_array(jsonb_build_object('change_type','weekly_target_blocks',
        'target_category_id',%L::uuid,'old_value',4,'new_value',0,
        'reason','x','signal','struggling')))$$, v_plan, v_dsa), '22023');

  perform t.raises('3c a flagged question carrying values is rejected',
    format($$select public.save_weekly_plan(%L::uuid, '2026-W40', '2026-W41', '{}'::jsonb,
      jsonb_build_array(jsonb_build_object('change_type','flag_question',
        'target_category_id',%L::uuid,'old_value',4,'new_value',3,
        'reason','x','signal','avoided')))$$, v_plan, v_dsa), '22023');

  perform t.raises('3d an unknown change_type is rejected, not stored as open text',
    format($$select public.save_weekly_plan(%L::uuid, '2026-W40', '2026-W41', '{}'::jsonb,
      jsonb_build_array(jsonb_build_object('change_type','goal_line',
        'target_category_id',%L::uuid,'old_value',1,'new_value',2,
        'reason','x','signal','coasting')))$$, v_plan, v_dsa), '22023');

  -- ONE BLOCK IS ALWAYS EXPRESSIBLE. 3 -> 4 is +33%, past the proportional
  -- rail, and must still be allowed -- otherwise every small-target category
  -- sits in a dead zone the engine can never move.
  insert into public.plans (user_id, app_name, goal_line, is_active)
    values (v_uid, 'test2', 'second', false) returning id into v_other_plan;
  insert into public.plan_categories (plan_id, name, label, days, sort_order, created_at)
    values (v_other_plan, 'c', 'C', '{0,1,2}', 0, '2026-01-01'::timestamptz)
    returning id into v_other_cat;
  perform public.save_weekly_plan(v_other_plan, '2026-W36', '2026-W37', '{}'::jsonb,
    jsonb_build_array(jsonb_build_object('change_type','weekly_target_blocks',
      'target_category_id',v_other_cat,'old_value',3,'new_value',4,
      'reason','one whole block at a small target','signal','coasting')));
  perform t.eq('4 a one-block move is allowed even when it exceeds 30% (3 -> 4 = +33%)',
    (select new_value from public.weekly_plan_changes
      where target_category_id = v_other_cat), 4::numeric);

  -- A category from a DIFFERENT plan cannot be targeted.
  perform t.raises('5 a change targeting another plan''s category is rejected',
    format($$select public.save_weekly_plan(%L::uuid, '2026-W41', '2026-W42', '{}'::jsonb,
      jsonb_build_array(jsonb_build_object('change_type','weekly_target_blocks',
        'target_category_id',%L::uuid,'old_value',3,'new_value',3,
        'reason','x','signal','coasting')))$$, v_plan, v_other_cat), '22023');
end $test$;

-- ===== apply_weekly_plan_change(): accepted actually applies ===============
do $test$
declare
  v_f jsonb := t.mkreview('wpc_accept');
  v_change uuid;
  v_row public.weekly_plan_changes;
begin
  perform set_config('request.jwt.claim.sub', (v_f->>'uid')::text, true);
  select id into v_change from public.weekly_plan_changes
   where weekly_plan_id = (v_f->>'review')::uuid and change_type = 'weekly_target_blocks';

  v_row := public.apply_weekly_plan_change(v_change, 'accepted');

  perform t.eq('6 pending -> accepted marks the change accepted',
    v_row.status, 'accepted');
  perform t.eq('6b ...and stamps when it was decided',
    (v_row.decided_at is not null), true);
  -- The assertion that matters: the plan actually changed.
  perform t.eq('6c ...and ACTUALLY writes the new weekly target to the category',
    (select weekly_target_blocks from public.plan_categories where id = (v_f->>'dsa')::uuid), 3);
  -- One question is still pending, so the review is not finished.
  perform t.eq('6d the review stays open while a flagged question is unanswered',
    (select status from public.weekly_plans where id = (v_f->>'review')::uuid), 'proposed');

  perform t.raises('7 a decision is final -- re-accepting cannot compound the adjustment',
    format($$select public.apply_weekly_plan_change(%L::uuid, 'accepted')$$, v_change), '22023');
end $test$;

-- ===== rejected applies NOTHING ============================================
do $test$
declare
  v_f jsonb := t.mkreview('wpc_reject');
  v_change uuid;
  v_row public.weekly_plan_changes;
begin
  perform set_config('request.jwt.claim.sub', (v_f->>'uid')::text, true);
  select id into v_change from public.weekly_plan_changes
   where weekly_plan_id = (v_f->>'review')::uuid and change_type = 'weekly_target_blocks';

  v_row := public.apply_weekly_plan_change(v_change, 'rejected');
  perform t.eq('8 pending -> rejected marks it rejected', v_row.status, 'rejected');
  perform t.eq('8b ...and the category is left exactly as it was',
    (select weekly_target_blocks from public.plan_categories where id = (v_f->>'dsa')::uuid),
    null::integer);
end $test$;

-- ===== an edited value: applied, capped, and recorded honestly =============
do $test$
declare
  v_f jsonb := t.mkreview('wpc_edit');
  v_change uuid;
  v_row public.weekly_plan_changes;
begin
  perform set_config('request.jwt.claim.sub', (v_f->>'uid')::text, true);
  select id into v_change from public.weekly_plan_changes
   where weekly_plan_id = (v_f->>'review')::uuid and change_type = 'weekly_target_blocks';

  -- Proposed 4 -> 3; the user says 5 instead (+25%, inside the rail).
  v_row := public.apply_weekly_plan_change(v_change, 'accepted', 5);
  perform t.eq('9 an accepted-with-an-edit is recorded as edited, not accepted',
    v_row.status, 'edited');
  perform t.eq('9b the edited value is what lands on the category',
    (select weekly_target_blocks from public.plan_categories where id = (v_f->>'dsa')::uuid), 5);
  -- History must say what HAPPENED, not what was suggested.
  perform t.eq('9c new_value is rewritten to what was actually applied',
    v_row.new_value, 5::numeric);
end $test$;

do $test$
declare
  v_f jsonb := t.mkreview('wpc_edit_cap');
  v_change uuid;
begin
  perform set_config('request.jwt.claim.sub', (v_f->>'uid')::text, true);
  select id into v_change from public.weekly_plan_changes
   where weekly_plan_id = (v_f->>'review')::uuid and change_type = 'weekly_target_blocks';

  -- THE CAP BINDS A HAND-EDITED VALUE TOO. Without this, every rail in the
  -- engine would be bypassable by clicking "edit" before "accept".
  perform t.raises('10 a hand-edited value beyond the cap is refused (4 -> 9)',
    format($$select public.apply_weekly_plan_change(%L::uuid, 'accepted', 9)$$, v_change), '22023');
  perform t.raises('10b ...and so is an edit below the minimum target of 1',
    format($$select public.apply_weekly_plan_change(%L::uuid, 'accepted', 0)$$, v_change), '22023');
  perform t.eq('10c a refused edit leaves the change pending and the plan untouched',
    (select status || ':' || coalesce(
       (select weekly_target_blocks::text from public.plan_categories
         where id = (v_f->>'dsa')::uuid), 'null')
       from public.weekly_plan_changes where id = v_change), 'pending:null');
  perform t.raises('10d an invalid decision word is rejected outright',
    format($$select public.apply_weekly_plan_change(%L::uuid, 'maybe')$$, v_change), '22023');
end $test$;

-- ===== a flagged question never applies anything ===========================
do $test$
declare
  v_f jsonb := t.mkreview('wpc_question');
  v_q uuid;
  v_row public.weekly_plan_changes;
begin
  perform set_config('request.jwt.claim.sub', (v_f->>'uid')::text, true);
  select id into v_q from public.weekly_plan_changes
   where weekly_plan_id = (v_f->>'review')::uuid and change_type = 'flag_question';

  perform t.raises('11 a flagged question cannot be accepted WITH a value',
    format($$select public.apply_weekly_plan_change(%L::uuid, 'accepted', 3)$$, v_q), '22023');

  v_row := public.apply_weekly_plan_change(v_q, 'accepted');
  perform t.eq('11b answering a question records the answer', v_row.status, 'accepted');
  perform t.eq('11c ...and changes no number anywhere',
    (select weekly_target_blocks from public.plan_categories where id = (v_f->>'sysd')::uuid),
    null::integer);
end $test$;

-- ===== accept_all skips questions, structurally ============================
do $test$
declare
  v_f jsonb := t.mkreview('wpc_accept_all');
  v_result jsonb;
begin
  perform set_config('request.jwt.claim.sub', (v_f->>'uid')::text, true);
  v_result := public.accept_all_weekly_plan_changes((v_f->>'review')::uuid);

  perform t.eq('12 accept-all applies the numeric change', v_result->>'applied', '1');
  -- The load-bearing one. "Accept all" means "yes to everything you
  -- suggested"; a question's honest answer might be no, so a bulk gesture
  -- must not answer it.
  perform t.eq('12b ...and DELIBERATELY skips the flagged question',
    v_result->>'skipped_questions', '1');
  perform t.eq('12c the skipped question is still pending, awaiting a real answer',
    (select status from public.weekly_plan_changes
      where weekly_plan_id = (v_f->>'review')::uuid and change_type = 'flag_question'), 'pending');
  perform t.eq('12d so the review as a whole is still open',
    (select status from public.weekly_plans where id = (v_f->>'review')::uuid), 'proposed');
  perform t.eq('12e the numeric change did apply, though',
    (select weekly_target_blocks from public.plan_categories where id = (v_f->>'dsa')::uuid), 3);
end $test$;

-- ===== the parent status is derived, and cannot drift ======================
do $test$
declare
  v_f jsonb := t.mkreview('wpc_status');
  v_num uuid;
  v_q uuid;
begin
  perform set_config('request.jwt.claim.sub', (v_f->>'uid')::text, true);
  select id into v_num from public.weekly_plan_changes
   where weekly_plan_id = (v_f->>'review')::uuid and change_type = 'weekly_target_blocks';
  select id into v_q from public.weekly_plan_changes
   where weekly_plan_id = (v_f->>'review')::uuid and change_type = 'flag_question';

  perform public.apply_weekly_plan_change(v_num, 'accepted');
  perform public.apply_weekly_plan_change(v_q, 'rejected');
  perform t.eq('13 one accepted and one rejected makes the review partial',
    (select status from public.weekly_plans where id = (v_f->>'review')::uuid), 'partial');
end $test$;

do $test$
declare
  v_f jsonb := t.mkreview('wpc_status_all_rejected');
begin
  perform set_config('request.jwt.claim.sub', (v_f->>'uid')::text, true);
  perform public.apply_weekly_plan_change(id, 'rejected')
    from public.weekly_plan_changes where weekly_plan_id = (v_f->>'review')::uuid;
  perform t.eq('13b rejecting everything makes the review rejected',
    (select status from public.weekly_plans where id = (v_f->>'review')::uuid), 'rejected');
end $test$;

-- ===== THE HARD CONSTRAINTS ================================================
-- Two of the four are structural: there is no branch in any of these
-- functions that writes plans.goal_line or plan_categories.days. These
-- assertions pin that, so a future edit that adds such a branch fails loudly
-- rather than being caught in review or not at all.
do $test$
declare
  v_f jsonb := t.mkreview('wpc_hard');
  v_goal_before text;
  v_days_before int[];
begin
  perform set_config('request.jwt.claim.sub', (v_f->>'uid')::text, true);
  select goal_line into v_goal_before from public.plans where id = (v_f->>'plan')::uuid;
  select days into v_days_before from public.plan_categories where id = (v_f->>'dsa')::uuid;

  perform public.accept_all_weekly_plan_changes((v_f->>'review')::uuid);

  perform t.eq('14 accepting a change NEVER touches the goal line',
    (select goal_line from public.plans where id = (v_f->>'plan')::uuid), v_goal_before);
  perform t.eq('14b ...and NEVER touches plan_categories.days (inventing availability)',
    (select days from public.plan_categories where id = (v_f->>'dsa')::uuid), v_days_before);
  perform t.eq('14c ...and never activates or retires a plan as a side effect',
    (select is_active from public.plans where id = (v_f->>'plan')::uuid), false);
  perform t.eq('14d ...and never touches min_blocks, which means something else entirely',
    (select min_blocks from public.plan_categories where id = (v_f->>'dsa')::uuid), 0);
end $test$;

-- ===== regeneration cannot destroy recorded decisions ======================
do $test$
declare
  v_f jsonb := t.mkreview('wpc_regen');
  v_change uuid;
begin
  perform set_config('request.jwt.claim.sub', (v_f->>'uid')::text, true);

  -- Re-running generation before anything is decided is fine: it replaces the
  -- pending proposal.
  perform public.save_weekly_plan((v_f->>'plan')::uuid, '2026-W36', '2026-W37', '{}'::jsonb, '[]'::jsonb);
  perform t.eq('15 regenerating an untouched review replaces its changes',
    (select count(*) from public.weekly_plan_changes
      where weekly_plan_id = (v_f->>'review')::uuid), 0::bigint);

  -- Now record a decision, then try again.
  perform public.save_weekly_plan((v_f->>'plan')::uuid, '2026-W36', '2026-W37', '{}'::jsonb,
    jsonb_build_array(jsonb_build_object('change_type','weekly_target_blocks',
      'target_category_id',(v_f->>'dsa')::uuid,'old_value',4,'new_value',3,
      'reason','x','signal','struggling')));
  select id into v_change from public.weekly_plan_changes
   where weekly_plan_id = (v_f->>'review')::uuid;
  perform public.apply_weekly_plan_change(v_change, 'accepted');

  perform t.raises('15b regenerating a review that has been acted on is refused',
    format($$select public.save_weekly_plan(%L::uuid, '2026-W36', '2026-W37', '{}'::jsonb, '[]'::jsonb)$$,
      (v_f->>'plan')::uuid), '22023');
  perform t.eq('15c ...so the decision survives',
    (select status from public.weekly_plan_changes where id = v_change), 'accepted');
end $test$;

-- ===== access control ======================================================
do $test$
declare
  v_f jsonb := t.mkreview('wpc_owner');
  v_intruder uuid := t.mkuser('wpc_intruder');
  v_change uuid;
begin
  select id into v_change from public.weekly_plan_changes
   where weekly_plan_id = (v_f->>'review')::uuid limit 1;

  set local role authenticated;
  perform set_config('request.jwt.claim.sub', v_intruder::text, true);

  perform t.eq('16 another user cannot SELECT your review',
    (select count(*) from public.weekly_plans where id = (v_f->>'review')::uuid), 0::bigint);
  perform t.eq('16b ...nor its changes',
    (select count(*) from public.weekly_plan_changes where id = v_change), 0::bigint);
  perform t.raises('16c ...nor decide one (and the error does not confirm it exists)',
    format($$select public.apply_weekly_plan_change(%L::uuid, 'accepted')$$, v_change), '42501');
  perform t.raises('16d ...nor accept-all someone else''s review',
    format($$select public.accept_all_weekly_plan_changes(%L::uuid)$$, (v_f->>'review')::uuid), '42501');
  perform t.raises('16e ...nor save a review against a plan that is not theirs',
    format($$select public.save_weekly_plan(%L::uuid, '2026-W36','2026-W37','{}'::jsonb,'[]'::jsonb)$$,
      (v_f->>'plan')::uuid), '42501');
end $test$;

-- The write surface is closed by GRANT, not merely by a missing policy --
-- schema.md sec6's rule, re-checked for every new table.
do $test$
declare
  v_f jsonb := t.mkreview('wpc_grants');
  v_uid uuid := (v_f->>'uid')::uuid;
begin
  set local role authenticated;
  perform set_config('request.jwt.claim.sub', v_uid::text, true);

  perform t.eq('17 a user can read their own review',
    (select count(*) from public.weekly_plans where id = (v_f->>'review')::uuid), 1::bigint);
  perform t.raises('17b ...but cannot INSERT a review directly',
    format($$insert into public.weekly_plans (user_id, plan_id, iso_week, effective_iso_week, metrics)
             values (%L::uuid, %L::uuid, '2026-W40','2026-W41','{}'::jsonb)$$, v_uid, (v_f->>'plan')::uuid),
    '42501');
  perform t.raises('17c ...nor UPDATE one (metrics is an audit record, not editable after the fact)',
    $$update public.weekly_plans set status = 'accepted'$$, '42501');
  perform t.raises('17d ...nor DELETE one',
    $$delete from public.weekly_plans$$, '42501');
  perform t.raises('17e ...nor UPDATE a change''s status, bypassing every constraint in the RPC',
    $$update public.weekly_plan_changes set status = 'accepted'$$, '42501');
  perform t.raises('17f ...nor TRUNCATE either table (RLS does not apply to TRUNCATE)',
    $$truncate public.weekly_plan_changes$$, '42501');
  perform t.raises('17g refresh_weekly_plan_status() is internal and reachable by nobody',
    format($$select public.refresh_weekly_plan_status(%L::uuid)$$, (v_f->>'review')::uuid), '42501');
end $test$;

do $test$
begin
  raise notice '--- weekly plan changes: complete ---';
end $test$;
