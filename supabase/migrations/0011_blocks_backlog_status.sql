-- Requested by J for the Today board's drag-and-drop rework: a fourth,
-- persisted `blocks.status` value, `backlog`, distinct from `todo` so a
-- separate Backlog lane survives reloads and devices (a visual-only
-- grouping of `todo` was considered and rejected -- it can't reliably stay
-- separate).
--
-- Scope, deliberately narrow per the request: only the CHECK constraint
-- changes. `status`'s default stays `'todo'` (unaffected -- new backlog
-- items are still todo unless the client explicitly sets backlog). RLS
-- (`blocks_owner_all`, 0001_seam.sql) references no status value, so it's
-- untouched. `recompute_daily_rollups()` (0009) deliberately does not read
-- blocks.status at all (see that migration's own "SOURCE CHOICE" comment --
-- it reads activity_events instead), so daily_rollups behavior is
-- unaffected by this migration, confirmed by inspection, not just assumed.
-- task_completed/task_regressed emission is client-side (today-deck.tsx),
-- not a DB trigger -- nothing here to change for that either.
alter table public.blocks
  drop constraint blocks_status_check,
  add constraint blocks_status_check
    check (status in ('backlog', 'todo', 'in_progress', 'done'));
