-- Review page, Phase C: review_time_patterns() -- "when do you work best"
-- and "what session length works best". See
-- docs/designs/mtdo-web-review-study-profile-plan.md sec4 Phase C and
-- docs/architecture/api.md sec3l.
--
-- SCOPE: session-level behavior only. This does NOT report task/Execute
-- completion by hour -- that would need joining every session to a block and
-- re-deriving the ledger's done-ness per hour, which is a different question
-- ("when do I finish tasks") from the one this answers ("when do my FOCUS
-- SESSIONS tend to actually finish rather than get abandoned"). Naming is
-- deliberately `session_completion_rate`, never bare `completion_rate`, so it
-- is never confused with Execute's task-level number (api.md sec3j).
--
-- USER-SCOPED, same reasoning as review_consistency() (0026): "when do you
-- focus best" is a trait of the person, not of one goal, and filtering to
-- today's active plan would drop a user's whole history the moment they
-- switch goals.
--
-- THE MINIMUM-SAMPLE RULE IS NOT OPTIONAL. The founder's own brief is
-- explicit: "Require minimum sample sizes. Do not create conclusions from
-- one or two sessions." min_sample_size = 5 (a constant, versioned alongside
-- the rest of this schema) gates every "best_*" field -- a bucket below that
-- count still appears in the full hourly/weekday/duration breakdowns (so a
-- UI CAN show "3 sessions, too early to tell"), but is never eligible to be
-- reported as "your best time".
--
-- WHY A SINGLE BEST HOUR, NOT A RANGE ("08:00-10:30"). Finding a genuine
-- contiguous best RANGE needs a smoothing/merging algorithm this migration
-- does not attempt to justify from first principles. V1 reports the single
-- peak hour; a frontend can present it as an hour-wide window
-- ("08:00-09:00") without this function claiming a wider range it did not
-- actually compute. Revisit if real usage shows single-hour peaks are too
-- noisy to be useful.

create function public.review_time_patterns(p_start date, p_end date)
returns jsonb
language plpgsql
security definer
stable
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_tz text;
  v_min_sample constant integer := 5;
  v_result jsonb;
begin
  if v_uid is null then
    raise exception 'review_time_patterns: no authenticated user' using errcode = '42501';
  end if;

  if p_start is null or p_end is null or p_start > p_end then
    raise exception 'review_time_patterns: p_start (%) must be a real date on or before p_end (%)', p_start, p_end
      using errcode = '22023';
  end if;

  if (p_end - p_start) > 400 then
    raise exception 'review_time_patterns: range too wide (% days, max 400)', (p_end - p_start)
      using errcode = '22023';
  end if;

  select coalesce(pr.timezone, 'UTC') into v_tz
  from public.profiles pr where pr.id = v_uid;
  v_tz := coalesce(v_tz, 'UTC');

  with
  sessions as (
    select
      fs.id,
      (fs.started_at at time zone v_tz) as local_started,
      public.session_focus_seconds(
        fs.started_at, fs.completed_at, fs.total_paused_s, fs.planned_duration_s
      ) as focus_seconds,
      (fs.state = 'completed') as completed
    from public.focus_sessions fs
    where fs.user_id = v_uid
      and fs.state in ('completed', 'abandoned')
      and fs.completed_at is not null
      and (fs.started_at at time zone v_tz)::date between p_start and p_end
  ),
  tagged as (
    select
      s.*,
      extract(hour from local_started)::int as hour_of_day,
      -- isodow: Monday=1 .. Sunday=7, the same vocabulary iso_week_start()
      -- (0021) already uses for this schema.
      extract(isodow from local_started)::int as weekday,
      case
        when focus_seconds < 15 * 60 then '<15m'
        when focus_seconds < 30 * 60 then '15-30m'
        when focus_seconds < 45 * 60 then '30-45m'
        when focus_seconds < 60 * 60 then '45-60m'
        when focus_seconds < 90 * 60 then '60-90m'
        else '90m+'
      end as duration_bucket
    from sessions s
  ),
  -- All 24 hours always present, even at zero sessions -- a UI charts a
  -- fixed x-axis, not one that reshuffles with the data.
  hours as (
    select h.hour as hour_of_day,
           count(t.id) as session_count,
           count(t.id) filter (where t.completed) as completed_session_count,
           case when count(t.id) > 0
             then round(count(t.id) filter (where t.completed)::numeric / count(t.id), 4) end
             as session_completion_rate,
           case when count(t.id) > 0
             then round(avg(t.focus_seconds) / 60.0, 1) end as avg_focus_minutes,
           round(coalesce(sum(t.focus_seconds), 0) / 60.0, 1) as total_focus_minutes
    from generate_series(0, 23) as h(hour)
    left join tagged t on t.hour_of_day = h.hour
    group by h.hour
  ),
  weekdays as (
    select d.weekday,
           count(t.id) as session_count,
           count(t.id) filter (where t.completed) as completed_session_count,
           case when count(t.id) > 0
             then round(count(t.id) filter (where t.completed)::numeric / count(t.id), 4) end
             as session_completion_rate,
           case when count(t.id) > 0
             then round(avg(t.focus_seconds) / 60.0, 1) end as avg_focus_minutes,
           round(coalesce(sum(t.focus_seconds), 0) / 60.0, 1) as total_focus_minutes
    from generate_series(1, 7) as d(weekday)
    left join tagged t on t.weekday = d.weekday
    group by d.weekday
  ),
  duration_labels as (
    select unnest(array['<15m','15-30m','30-45m','45-60m','60-90m','90m+']) as bucket
  ),
  durations as (
    select dl.bucket,
           count(t.id) as session_count,
           count(t.id) filter (where t.completed) as completed_session_count,
           case when count(t.id) > 0
             then round(count(t.id) filter (where t.completed)::numeric / count(t.id), 4) end
             as session_completion_rate,
           case when count(t.id) > 0
             then round(avg(t.focus_seconds) / 60.0, 1) end as avg_focus_minutes
    from duration_labels dl
    left join tagged t on t.duration_bucket = dl.bucket
    group by dl.bucket
  ),
  best_hour as (
    select hour_of_day, session_count, session_completion_rate
    from hours
    where session_count >= v_min_sample
    order by session_completion_rate desc nulls last, avg_focus_minutes desc nulls last
    limit 1
  ),
  best_weekday as (
    select weekday, session_count, session_completion_rate
    from weekdays
    where session_count >= v_min_sample
    order by session_completion_rate desc nulls last, avg_focus_minutes desc nulls last
    limit 1
  ),
  best_duration as (
    select bucket, session_count, session_completion_rate
    from durations
    where session_count >= v_min_sample
    order by session_completion_rate desc nulls last
    limit 1
  )
  select jsonb_build_object(
    'schema_version', 'mtdo.review_time_patterns.v1',
    'from', p_start, 'to', p_end, 'timezone', v_tz, 'computed_at', now(),
    'min_sample_size', v_min_sample,
    'hourly', (select coalesce(jsonb_agg(jsonb_build_object(
        'hour', h.hour_of_day, 'session_count', h.session_count,
        'completed_session_count', h.completed_session_count,
        'session_completion_rate', h.session_completion_rate,
        'avg_focus_minutes', h.avg_focus_minutes, 'total_focus_minutes', h.total_focus_minutes
      ) order by h.hour_of_day), '[]'::jsonb) from hours h),
    'weekday', (select coalesce(jsonb_agg(jsonb_build_object(
        'weekday', w.weekday, 'session_count', w.session_count,
        'completed_session_count', w.completed_session_count,
        'session_completion_rate', w.session_completion_rate,
        'avg_focus_minutes', w.avg_focus_minutes, 'total_focus_minutes', w.total_focus_minutes
      ) order by w.weekday), '[]'::jsonb) from weekdays w),
    'duration_buckets', (select coalesce(jsonb_agg(jsonb_build_object(
        'bucket', d.bucket, 'session_count', d.session_count,
        'completed_session_count', d.completed_session_count,
        'session_completion_rate', d.session_completion_rate,
        'avg_focus_minutes', d.avg_focus_minutes
      ) order by array_position(array['<15m','15-30m','30-45m','45-60m','60-90m','90m+'], d.bucket)), '[]'::jsonb)
      from durations d),
    'best_hour', (select jsonb_build_object(
        'hour', bh.hour_of_day, 'sample_size', bh.session_count,
        'session_completion_rate', bh.session_completion_rate
      ) from best_hour bh),
    'best_weekday', (select jsonb_build_object(
        'weekday', bw.weekday, 'sample_size', bw.session_count,
        'session_completion_rate', bw.session_completion_rate
      ) from best_weekday bw),
    'best_duration_bucket', (select jsonb_build_object(
        'bucket', bd.bucket, 'sample_size', bd.session_count,
        'session_completion_rate', bd.session_completion_rate
      ) from best_duration bd)
  ) into v_result;

  return v_result;
end;
$$;

alter function public.review_time_patterns(date, date) owner to postgres;
revoke execute on function public.review_time_patterns(date, date) from public, anon;
grant execute on function public.review_time_patterns(date, date) to authenticated;

comment on function public.review_time_patterns(date, date) is
  'Session-level time-of-day/weekday/duration breakdown (schema mtdo.review_time_patterns.v1) for one date range, user-scoped across every plan. session_completion_rate is a SESSION outcome (completed vs abandoned), never a task/Execute rate -- do not conflate with review_daily_summary()''s execute.percentage. best_hour/best_weekday/best_duration_bucket are null unless a bucket has at least min_sample_size (5) sessions -- never inferred from fewer. See docs/architecture/api.md sec3l.';
