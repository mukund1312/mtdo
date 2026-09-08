#!/usr/bin/env bash
# Runs the Supabase migration test suite against a throwaway
# PostgreSQL cluster.
#
# decisions.md's "Verified by execution, not by reading" note describes how
# 0001_seam.sql was validated -- a local cluster with a stubbed `auth` schema
# and Supabase's real default-privilege configuration, attacked from
# authenticated/anon/service_role sessions. That setup was not committed, so
# it had to be rebuilt from scratch to validate 0009. This script is it, kept
# this time.
#
#   ./supabase/tests/run.sh            # boot (or reuse) the cluster and run
#   ./supabase/tests/run.sh reset      # rebuild the cluster from initdb first
#
# Requires a local PostgreSQL 15+ (`brew install postgresql@18`). Does NOT
# require Docker or `supabase start` -- deliberately, so the suite runs in
# under a second and can be run per-edit while iterating on a migration.
#
# NOT covered here: 0010's pg_cron path. pg_cron is not in a stock Homebrew
# Postgres, so 0010 takes its "extension not available" branch under this
# harness (which is itself worth confirming -- the run below prints that
# notice). The scheduled statement itself is exercised directly.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
WORK="${MTDO_PGTEST_DIR:-${TMPDIR:-/tmp}/mtdo-pgtest}"
PGBIN="${MTDO_PGBIN:-$(dirname "$(command -v postgres)")}"

export PGDATA="$WORK/pgdata"
export PGHOST=127.0.0.1
export PGPORT="${MTDO_PGPORT:-54399}"
export PGUSER=postgres
export PGDATABASE=mtdo_rollup_test

mkdir -p "$WORK"

if [ "${1:-}" = "reset" ] || [ ! -d "$PGDATA" ]; then
  [ -d "$PGDATA" ] && "$PGBIN/pg_ctl" -D "$PGDATA" stop -m immediate >/dev/null 2>&1 || true
  rm -rf "$PGDATA"
  "$PGBIN/initdb" -D "$PGDATA" -U postgres --auth=trust >/dev/null
fi

"$PGBIN/pg_ctl" -D "$PGDATA" \
  -o "-p $PGPORT -c listen_addresses=127.0.0.1 -c unix_socket_directories=''" \
  -l "$WORK/pg.log" start >/dev/null 2>&1 || true
for _ in $(seq 1 20); do "$PGBIN/pg_isready" -q && break; sleep 0.2; done

"$PGBIN/psql" -d postgres -q -c "drop database if exists $PGDATABASE" >/dev/null 2>&1
"$PGBIN/psql" -d postgres -q -c "create database $PGDATABASE" >/dev/null

"$PGBIN/psql" -v ON_ERROR_STOP=1 -q -f "$ROOT/supabase/tests/00_stub_supabase.sql" >/dev/null
# A failing migration must stop the run. The previous form piped psql into
# grep and appended `|| true`, so a migration that errored outright was
# silently skipped and the suite carried on -- a broken migration then passed
# CI green for as long as no assertion happened to touch it. Caught by 0012
# failing to apply while the run still reported success.
for f in "$ROOT"/supabase/migrations/*.sql; do
  if ! out=$("$PGBIN/psql" -v ON_ERROR_STOP=1 -q -f "$f" 2>&1); then
    echo "MIGRATION FAILED: $(basename "$f")"
    printf '%s\n' "$out" | grep -v '^NOTICE' | head -20
    exit 1
  fi
  printf '%s\n' "$out" | grep -E '^NOTICE' || true
done

fail=0
"$PGBIN/psql" -v ON_ERROR_STOP=1 -q \
  -f "$ROOT/supabase/tests/01_harness.sql" \
  -f "$ROOT/supabase/tests/02_aggregation.sql" \
  -f "$ROOT/supabase/tests/03_idempotence_and_windows.sql" \
  -f "$ROOT/supabase/tests/04_privileges_and_plans.sql" \
  -f "$ROOT/supabase/tests/05_blocks_backlog_status.sql" \
  -f "$ROOT/supabase/tests/06_curriculum_menu_bridge.sql" \
  -f "$ROOT/supabase/tests/07_per_user_timezone.sql" \
  -f "$ROOT/supabase/tests/08_ai_provider_settings.sql" \
  -f "$ROOT/supabase/tests/09_extend_plan.sql" \
  -f "$ROOT/supabase/tests/10_planning_mode.sql" \
  -f "$ROOT/supabase/tests/11_task_priority_estimate.sql" 2>&1 \
  | sed 's/^psql:[^ ]* //; s/^NOTICE:  //' | grep -E "^(PASS|FAIL|ERROR|---)" || fail=1

echo
if [ "$fail" = 0 ]; then echo "migration suite: all assertions passed"; else echo "migration suite: FAILED"; fi
"$PGBIN/pg_ctl" -D "$PGDATA" stop -m fast >/dev/null 2>&1 || true
exit $fail
