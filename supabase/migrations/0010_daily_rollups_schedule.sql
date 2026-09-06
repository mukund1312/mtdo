-- Attaches a schedule to recompute_daily_rollups() (0009, mtdo-bugs #93).
--
-- Deliberately a separate migration from the function. The function is the
-- unit of correctness and must apply everywhere -- a local `supabase db
-- reset`, a fresh branch database, a shadow database during `db diff`. The
-- schedule depends on pg_cron, which is a project-level extension that may or
-- may not be enabled. Putting them in one file would mean the correctness
-- lands or fails to land based on whether an extension happened to be
-- available, which is backwards. So this file is written to no-op with a
-- notice rather than fail, and everything below is idempotent.
--
-- THE THREE OPTIONS, AND WHY THIS ONE
--   * pg_cron (this file). The aggregation is a single SQL statement over
--     data already in Postgres. Cron-in-database means no network hop, no
--     service-role key on the wire or in a second platform's env, no third
--     deploy target to keep in sync with the migration that defines the
--     function. It is also the only option that keeps working on a database
--     branch nobody wired a deploy hook to.
--   * A Supabase Edge Function on a schedule. Would need the service-role key
--     in Deno env and would then... call this same function over HTTP. All of
--     the hop, none of the benefit.
--   * A Vercel cron hitting a Next.js Route Handler. Same objection, plus it
--     would put the service-role key into the web app's environment, which
--     web/lib/supabase/server.ts explicitly tells implementers not to do
--     ("do not add the service key here") and which today only the future W3b
--     tutor backend has a reason to hold. It also caps out at once per day on
--     Vercel's Hobby plan, which is not a heatmap refresh rate.
-- If pg_cron is ever unavailable, the fallback is not a rewrite: grant a
-- service-role caller EXECUTE (0009 already does) and have it invoke the
-- identical function. See docs/architecture/api.md §3a.

do $mig$
begin
  if not exists (select 1 from pg_available_extensions where name = 'pg_cron') then
    raise notice
      'pg_cron is not available on this server -- daily_rollups will NOT be recomputed automatically. Schedule public.recompute_daily_rollups() externally, or see docs/architecture/api.md section 3a.';
    return;
  end if;

  begin
    -- pg_cron is not relocatable; it always installs into the `cron` schema.
    execute 'create extension if not exists pg_cron';
  exception when insufficient_privilege then
    raise notice
      'pg_cron is available but this role may not create it -- enable it from the Supabase dashboard, then re-run this migration.';
    return;
  end;

  -- cron.schedule() upserts on the job name, so re-running this migration
  -- re-points the existing job instead of stacking a second one.
  --
  -- Every ten minutes. The window this recomputes is only three days wide and
  -- both of its scans are index-driven (0009), so the run is cheap; the
  -- interval is set by how stale the Progress heatmap is allowed to look
  -- right after a user finishes a session, not by cost. It is also the reason
  -- 0009's default window is three days rather than one: a tick that lands at
  -- 00:03 has to still be able to correct yesterday.
  --
  -- The arguments are passed explicitly rather than left to defaults, so the
  -- bucketing time zone is visible at the call site. THAT ZONE IS PINNED ON
  -- PURPOSE AND MUST NOT BE VARIED PER RUN: daily_rollups.date means "the
  -- local date in this zone", and running the job in a second zone does not
  -- migrate the old rows -- it writes new ones under new dates and leaves the
  -- originals in place, so a single event ends up counted on two days at
  -- once. (Pinned by test; see the 14b case in the suite referenced by
  -- docs/architecture/decisions.md.) Changing the zone later is a
  -- delete-then-backfill, not a parameter change.
  perform cron.schedule(
    'mtdo-daily-rollups',
    '*/10 * * * *',
    $job$select public.recompute_daily_rollups(null, null, 'UTC')$job$
  );

  raise notice 'scheduled cron job mtdo-daily-rollups (*/10 * * * *)';
end
$mig$;
