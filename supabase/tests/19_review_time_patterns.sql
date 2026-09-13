\set ON_ERROR_STOP on
\pset pager off
set client_min_messages = notice;
set timezone = 'UTC';

-- migrations/0028: review_time_patterns() (docs/designs/mtdo-web-review-study-profile-plan.md
-- sec4 Phase C, docs/architecture/api.md sec3l).
-- 2026-09-01 is a Tuesday (isodow 2), same fixture date used elsewhere in this suite.

-- ===== a clear best hour/weekday/duration, plus a below-threshold bucket ====
do $test$
declare
  v_uid uuid := t.mkuser('time_patterns_normal');
  v_out jsonb;
  v_hour8 jsonb;
  v_hour14 jsonb;
  v_weekday2 jsonb;
  v_dur_mid jsonb;
  v_dur_short jsonb;
  i int;
begin
  -- 6 completed 40-minute sessions at 08:0X, all comfortably over the
  -- min_sample_size=5 threshold.
  for i in 0..5 loop
    insert into public.focus_sessions (user_id, started_at, completed_at, planned_duration_s, state)
    values (v_uid, ('2026-09-01 08:0' || i || ':00+00')::timestamptz,
            ('2026-09-01 08:0' || i || ':00+00')::timestamptz + interval '40 minutes', 2400, 'completed');
  end loop;
  -- 2 abandoned 10-minute sessions at 14:00/14:05 -- below the threshold.
  insert into public.focus_sessions (user_id, started_at, completed_at, planned_duration_s, state)
  values
    (v_uid, '2026-09-01 14:00:00+00', '2026-09-01 14:10:00+00', 1800, 'abandoned'),
    (v_uid, '2026-09-01 14:05:00+00', '2026-09-01 14:15:00+00', 1800, 'abandoned');

  set local role authenticated;
  perform set_config('request.jwt.claim.sub', v_uid::text, true);

  v_out := public.review_time_patterns('2026-09-01'::date, '2026-09-01'::date);

  perform t.eq('1 declares its schema version', v_out->>'schema_version', 'mtdo.review_time_patterns.v1');
  perform t.eq('1b declares the minimum sample size', v_out->>'min_sample_size', '5');
  perform t.eq('1c hourly covers all 24 hours regardless of data', jsonb_array_length(v_out->'hourly'), 24);
  perform t.eq('1d weekday covers all 7 days', jsonb_array_length(v_out->'weekday'), 7);
  perform t.eq('1e duration_buckets covers all 6 buckets', jsonb_array_length(v_out->'duration_buckets'), 6);

  v_hour8 := (select h from jsonb_array_elements(v_out->'hourly') h where (h->>'hour')::int = 8);
  v_hour14 := (select h from jsonb_array_elements(v_out->'hourly') h where (h->>'hour')::int = 14);
  perform t.eq('2 hour 8: 6 sessions, all completed', v_hour8->>'session_count', '6');
  perform t.eq('2b hour 8: completion rate 1.0', v_hour8->>'session_completion_rate', '1.0000');
  perform t.eq('2c hour 8: avg focus minutes', v_hour8->>'avg_focus_minutes', '40.0');
  perform t.eq('3 hour 14: 2 sessions, 0 completed', v_hour14->>'session_count', '2');
  perform t.eq('3b hour 14: completion rate 0.0 -- a real rate, not missing', v_hour14->>'session_completion_rate', '0.0000');
  -- An hour with zero sessions at all still reports a real 0 count and a
  -- NULL rate (nothing to divide), never a fake 0% or 100%.
  perform t.eq('3c an untouched hour has session_count 0',
    (select h->>'session_count' from jsonb_array_elements(v_out->'hourly') h where (h->>'hour')::int = 3), '0');
  perform t.eq('3d ...and a NULL rate, not 0', (select h->'session_completion_rate' from jsonb_array_elements(v_out->'hourly') h
    where (h->>'hour')::int = 3), 'null'::jsonb);

  v_weekday2 := (select w from jsonb_array_elements(v_out->'weekday') w where (w->>'weekday')::int = 2);
  perform t.eq('4 Tuesday: all 8 sessions', v_weekday2->>'session_count', '8');
  perform t.eq('4b Tuesday: 6 of 8 completed', v_weekday2->>'session_completion_rate', '0.7500');

  v_dur_mid := (select d from jsonb_array_elements(v_out->'duration_buckets') d where d->>'bucket' = '30-45m');
  v_dur_short := (select d from jsonb_array_elements(v_out->'duration_buckets') d where d->>'bucket' = '<15m');
  perform t.eq('5 30-45m bucket: the 6 forty-minute sessions', v_dur_mid->>'session_count', '6');
  perform t.eq('5b <15m bucket: the 2 ten-minute sessions', v_dur_short->>'session_count', '2');

  perform t.eq('6 best_hour is 8 -- the only hour meeting min_sample_size',
    v_out->'best_hour'->>'hour', '8');
  perform t.eq('6b ...with the right sample size', v_out->'best_hour'->>'sample_size', '6');
  perform t.eq('7 best_weekday is Tuesday -- the only day with any data at all',
    v_out->'best_weekday'->>'weekday', '2');
  perform t.eq('8 best_duration_bucket is 30-45m, not <15m (which has only 2 sessions)',
    v_out->'best_duration_bucket'->>'bucket', '30-45m');
end $test$;

-- ===== nothing meets the sample threshold: every best_* is NULL ============
do $test$
declare
  v_uid uuid := t.mkuser('time_patterns_sparse');
  v_out jsonb;
begin
  insert into public.focus_sessions (user_id, started_at, completed_at, planned_duration_s, state)
  values
    (v_uid, '2026-09-01 08:00:00+00', '2026-09-01 08:20:00+00', 1200, 'completed'),
    (v_uid, '2026-09-02 09:00:00+00', '2026-09-02 09:20:00+00', 1200, 'completed');

  set local role authenticated;
  perform set_config('request.jwt.claim.sub', v_uid::text, true);
  v_out := public.review_time_patterns('2026-09-01'::date, '2026-09-02'::date);

  perform t.eq('9 best_hour is NULL -- only 1-2 sessions per bucket, never enough',
    v_out->'best_hour', 'null'::jsonb);
  perform t.eq('9b best_weekday is NULL for the same reason', v_out->'best_weekday', 'null'::jsonb);
  perform t.eq('9c best_duration_bucket is NULL too', v_out->'best_duration_bucket', 'null'::jsonb);
end $test$;

-- ===== validation and isolation =============================================
do $test$
declare
  v_a uuid := t.mkuser('time_patterns_a');
  v_b uuid := t.mkuser('time_patterns_b');
  v_out jsonb;
begin
  insert into public.focus_sessions (user_id, started_at, completed_at, planned_duration_s, state)
  values (v_b, '2026-09-01 08:00:00+00', '2026-09-01 08:20:00+00', 1200, 'completed');

  set local role authenticated;
  perform set_config('request.jwt.claim.sub', v_a::text, true);
  v_out := public.review_time_patterns('2026-09-01'::date, '2026-09-01'::date);
  perform t.eq('10 user A sees none of user B''s sessions',
    (select h->>'session_count' from jsonb_array_elements(v_out->'hourly') h where (h->>'hour')::int = 8), '0');

  perform t.raises('11 p_start after p_end is rejected',
    $$select public.review_time_patterns('2026-09-05'::date, '2026-09-01'::date)$$, '22023');
  perform t.raises('11b a range over 400 days is rejected',
    $$select public.review_time_patterns('2025-01-01'::date, '2026-06-01'::date)$$, '22023');
end $test$;

do $test$
begin
  raise notice '--- review_time_patterns: complete ---';
end $test$;
