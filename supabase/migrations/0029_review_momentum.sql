-- Review page, Phase C: review_momentum() -- a SMOOTHED score across recent
-- weeks, not a raw streak counter. See
-- docs/designs/mtdo-web-review-study-profile-plan.md sec4 Phase C and
-- docs/architecture/api.md sec3m.
--
-- WHY NOT JUST A STREAK. The founder's own brief is explicit: missing one day
-- should not collapse the whole psychological signal (91 -> 88, never
-- 145 -> 0). A raw "consecutive days" counter is exactly that cliff. This
-- function still reports current_streak/longest_streak (useful, concrete
-- facts), but the headline `momentum_score` is an exponentially-weighted
-- average of daily Effort Scores, which degrades gracefully.
--
-- WHY THIS CALLS review_consistency() RATHER THAN RE-DERIVING EFFORT SCORES.
-- Same "no metric gets two implementations" rule review_consistency()'s own
-- header states. This function is pure composition: it asks
-- review_consistency() for the window's per-day effort_score series and
-- summarizes it. If that formula changes (effort_v2), momentum changes with
-- it automatically and never silently disagrees.
--
-- momentum_v1 WEIGHTS, REASONED NOT MEASURED (same standing caveat as
-- effort_v1 in 0026): decay = 0.9 per day, giving a ~6.6-day half-life --
-- long enough that a single missed day barely moves the number, short enough
-- that the score still reflects "recent weeks" rather than the user's entire
-- history. Not yet checked against real usage; revisit once real
-- daily_rollups/review_consistency history exists.

create function public.review_momentum(p_window_days integer default 42)
returns jsonb
language plpgsql
security definer
stable
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_tz text;
  v_today date;
  v_from date;
  v_consistency jsonb;
  v_result jsonb;
  v_decay constant numeric := 0.9;
begin
  if v_uid is null then
    raise exception 'review_momentum: no authenticated user' using errcode = '42501';
  end if;

  if p_window_days is null or p_window_days < 1 or p_window_days > 400 then
    raise exception 'review_momentum: p_window_days (%) must be between 1 and 400', p_window_days
      using errcode = '22023';
  end if;

  select coalesce(pr.timezone, 'UTC') into v_tz
  from public.profiles pr where pr.id = v_uid;
  v_tz := coalesce(v_tz, 'UTC');

  v_today := (now() at time zone v_tz)::date;
  v_from := v_today - (p_window_days - 1);

  -- Ownership/auth is already enforced inside review_consistency() itself --
  -- this call runs as the same authenticated caller, not a service role.
  v_consistency := public.review_consistency(v_from, v_today);

  -- ->> (not ->) so a JSON null actually reads as SQL NULL here, not the
  -- jsonb scalar 'null' (which "is null" would never match).
  if v_consistency->>'plan_id' is null then
    return jsonb_build_object(
      'schema_version', 'mtdo.review_momentum.v1',
      'from', v_from, 'to', v_today, 'window_days', p_window_days, 'timezone', v_tz,
      'computed_at', now(), 'status', 'no_active_plan', 'metric_version', 'momentum_v1',
      'momentum_score', null, 'current_streak', null, 'longest_streak', null,
      'active_days_rate', null
    );
  end if;

  with
  days as (
    select
      (elem->>'date')::date as d,
      (elem->>'effort_score')::numeric as effort_score,
      row_number() over (order by (elem->>'date')::date) as rn,
      count(*) over () as n
    from jsonb_array_elements(v_consistency->'days') as elem
  ),
  weighted as (
    -- distance 0 = most recent day (rn = n), growing older going back.
    select d.*, power(v_decay, (n - rn)) as w
    from days d
  ),
  momentum as (
    select round(sum(effort_score * w) / nullif(sum(w), 0), 1) as score
    from weighted
  ),
  active_flagged as (
    select d, (effort_score > 0) as active, rn
    from days
  ),
  islands as (
    select d, active, rn, rn - row_number() over (partition by active order by rn) as grp
    from active_flagged
  ),
  active_runs as (
    select grp, count(*) as len, max(d) as run_end
    from islands
    where active
    group by grp
  ),
  streaks as (
    select
      coalesce(max(len), 0) as longest_streak,
      -- The "current" streak is only real if its run reaches all the way to
      -- the most recent day in the window (today) -- a run that ended three
      -- days ago is history, not a current streak.
      coalesce((select len from active_runs where run_end = (select max(d) from days) limit 1), 0)
        as current_streak
    from active_runs
  )
  select jsonb_build_object(
    'schema_version', 'mtdo.review_momentum.v1',
    'from', v_from, 'to', v_today, 'window_days', p_window_days, 'timezone', v_tz,
    'computed_at', now(), 'status', 'ok', 'metric_version', 'momentum_v1',
    'momentum_score', (select score from momentum),
    'current_streak', (select current_streak from streaks),
    'longest_streak', (select longest_streak from streaks),
    'active_days_rate', round((select count(*) filter (where effort_score > 0) from days)::numeric
      / nullif((select count(*) from days), 0), 4)
  ) into v_result;

  return v_result;
end;
$$;

alter function public.review_momentum(integer) owner to postgres;
revoke execute on function public.review_momentum(integer) from public, anon;
grant execute on function public.review_momentum(integer) to authenticated;

comment on function public.review_momentum(integer) is
  'Exponentially-weighted (momentum_v1, decay 0.9/day) smoothing of review_consistency()''s daily Effort Score over the trailing p_window_days (default 42), plus current_streak/longest_streak/active_days_rate over the same window. Composed entirely from review_consistency() -- never a second Effort Score formula. status=no_active_plan with every field null when the caller has no active plan, matching review_daily_summary()/review_consistency()''s own convention. See docs/architecture/api.md sec3m.';
