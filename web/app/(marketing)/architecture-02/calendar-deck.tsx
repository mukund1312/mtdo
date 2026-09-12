"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent } from "react";

import { createClient } from "@/lib/supabase/client";

import { isBlockStatus, type BlockStatus } from "./today-deck";
import { isTaskPriority, priorityLabel, type TaskPriority } from "./kanban-metadata";
import { categoryColorToken } from "./category-color";
import { laneStyle, layoutDayOverlaps, type LanePlacement } from "./calendar-overlap";

// The Time deck (Phase 6 frontend, operating-engine plan). Renders and
// reschedules real `blocks` rows against schedule_block() (docs/architecture/
// api.md §3d) -- this replaces the honest "not built yet" placeholder that
// lived inline in page.tsx since Phase 1.
//
// Read schedule_block()'s contract carefully before touching this file: the
// RPC REPLACES a schedule, it does not patch it, and all three optional args
// must be OMITTED (never passed as `null`) to hit the SQL DEFAULT -- the
// generated types deliberately don't union them with `null`, so
// `{ p_start_at: null }` fails to typecheck. The un-schedule call is
// literally `rpc("schedule_block", { p_block_id })`.
//
// Judgment call, flagged for review: dragging a block to a new day/time on
// this calendar only ever sets p_start_at/p_end_at -- it never passes
// p_date. schema.md is explicit that a block's board date (Kanban lane) and
// its calendar window are "related concepts, not redundant ones" and are
// deliberately not constrained to agree; moving a task's calendar slot
// should not silently relocate it to a different day on the Kanban board.
// A user who wants both can still move the Kanban card separately.

export type CalendarBlock = {
  id: string;
  text: string;
  status: BlockStatus;
  notes: string | null;
  priority: TaskPriority;
  estimated_minutes: number | null;
  category_id: string;
  category_label: string | null;
  date: string;
  scheduled_start_at: string | null;
  scheduled_end_at: string | null;
};

type CalendarView = "day" | "week" | "month";
type LoadState = "loading" | "ready" | "error";

type CalendarStatus = {
  configured: boolean;
  connected: boolean;
  connection: { calendarId: string; connectedAt: string; scopes: string[] } | null;
  missing: string[];
  provider: string;
};

const DAY_START_HOUR = 6;
const DAY_END_HOUR = 22; // grid runs 6a-10p; events outside this window still render, just clipped visually
const HOURS = Array.from({ length: DAY_END_HOUR - DAY_START_HOUR }, (_, index) => DAY_START_HOUR + index);
const ROW_HEIGHT = 48;
const DEFAULT_DURATION_MINUTES = 30;
const DEFAULT_SCHEDULE_HOUR = 9; // for a block dropped somewhere with no time granularity (Month view)
// Resize snap increment. Free-form second-level precision from raw pixel
// deltas would be unusable (nobody can drag to exactly 11:47) -- 15 minutes
// matches the granularity the founder's own brief asked for ("1h, or 30
// mins, or 15 mins") and divides ROW_HEIGHT (48px/hour) into a whole
// number of pixels per snap (12px), so there's no rounding drift between
// the snapped minute value and the pixel the handle visually settles at.
const RESIZE_SNAP_MINUTES = 15;
const MIN_DURATION_MINUTES = 15; // a resize can never shrink a block below one snap increment
const WEEKDAY_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function startOfDay(date: Date): Date {
  const next = new Date(date);
  next.setHours(0, 0, 0, 0);
  return next;
}

function addDays(date: Date, count: number): Date {
  const next = new Date(date);
  next.setDate(next.getDate() + count);
  return next;
}

function startOfWeek(date: Date): Date {
  return addDays(startOfDay(date), -date.getDay());
}

function startOfMonth(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), 1);
}

function sameDay(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

function isoDate(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function formatHourLabel(hour: number): string {
  const suffix = hour < 12 ? "a" : "p";
  const value = hour % 12 === 0 ? 12 : hour % 12;
  return `${value}${suffix}`;
}

function formatTimeRange(start: Date, end: Date): string {
  const fmt = new Intl.DateTimeFormat("en", { hour: "numeric", minute: "2-digit" });
  return `${fmt.format(start)} – ${fmt.format(end)}`;
}

function timeInputValue(date: Date): string {
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

function withTime(day: Date, value: string): Date | null {
  const match = /^(\d{2}):(\d{2})$/.exec(value);
  if (!match) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (hours > 23 || minutes > 59) return null;
  const result = new Date(day);
  result.setHours(hours, minutes, 0, 0);
  return result;
}

/** The visible fetch/navigation window for a view, as [start, end) local `Date`s. */
function viewRange(view: CalendarView, anchor: Date): { start: Date; end: Date } {
  if (view === "day") {
    const start = startOfDay(anchor);
    return { start, end: addDays(start, 1) };
  }
  if (view === "week") {
    const start = startOfWeek(anchor);
    return { start, end: addDays(start, 7) };
  }
  const monthStart = startOfMonth(anchor);
  const gridStart = startOfWeek(monthStart);
  const monthEnd = new Date(monthStart.getFullYear(), monthStart.getMonth() + 1, 1);
  const gridEnd = addDays(startOfWeek(addDays(monthEnd, -1)), 7);
  return { start: gridStart, end: gridEnd };
}

function shiftAnchor(view: CalendarView, anchor: Date, direction: 1 | -1): Date {
  if (view === "day") return addDays(anchor, direction);
  if (view === "week") return addDays(anchor, direction * 7);
  return new Date(anchor.getFullYear(), anchor.getMonth() + direction, 1);
}

function rangeLabel(view: CalendarView, anchor: Date): string {
  if (view === "day") {
    return new Intl.DateTimeFormat("en", { weekday: "long", month: "short", day: "numeric" }).format(anchor);
  }
  if (view === "week") {
    const start = startOfWeek(anchor);
    const end = addDays(start, 6);
    const sameMonth = start.getMonth() === end.getMonth();
    const startFmt = new Intl.DateTimeFormat("en", { month: "short", day: "numeric" }).format(start);
    const endFmt = new Intl.DateTimeFormat("en", sameMonth ? { day: "numeric" } : { month: "short", day: "numeric" }).format(end);
    return `${startFmt} – ${endFmt}`;
  }
  return new Intl.DateTimeFormat("en", { month: "long", year: "numeric" }).format(anchor);
}

function eventGeometry(start: Date, end: Date): { top: number; height: number } {
  const minutesFromStart = (start.getHours() - DAY_START_HOUR) * 60 + start.getMinutes();
  const durationMinutes = Math.max(15, (end.getTime() - start.getTime()) / 60000);
  const top = (minutesFromStart / 60) * ROW_HEIGHT;
  const height = (durationMinutes / 60) * ROW_HEIGHT;
  return { top, height };
}

/** Inverse of eventGeometry's own height math -- the ONLY place resize
 * converts a dragged pixel delta back into minutes, so it can never drift
 * from the vertical math eventGeometry and the drag-to-reschedule path
 * already use. Snapped to RESIZE_SNAP_MINUTES so a drag lands on a sensible
 * increment rather than an arbitrary number of seconds. */
function snapMinutesFromPixels(deltaPx: number): number {
  const rawMinutes = (deltaPx / ROW_HEIGHT) * 60;
  return Math.round(rawMinutes / RESIZE_SNAP_MINUTES) * RESIZE_SNAP_MINUTES;
}

function databaseErrorMessage(error: unknown, fallback: string): string {
  if (!error || typeof error !== "object") return fallback;
  const candidate = error as { code?: string; message?: string };
  if (candidate.code === "22023") return "That time doesn't work -- check the start is before the end.";
  if (candidate.code === "42501") return "We couldn't find that task on your board.";
  return candidate.message || fallback;
}

export function CalendarDeck() {
  const [view, setView] = useState<CalendarView>("day");
  const [anchorDate, setAnchorDate] = useState<Date>(() => startOfDay(new Date()));
  const [state, setState] = useState<LoadState>("loading");
  const [scheduled, setScheduled] = useState<CalendarBlock[]>([]);
  const [unscheduled, setUnscheduled] = useState<CalendarBlock[]>([]);
  const [writeError, setWriteError] = useState<string | null>(null);
  const [movingId, setMovingId] = useState<string | null>(null);
  const [draggedBlockId, setDraggedBlockId] = useState<string | null>(null);
  const [dropHint, setDropHint] = useState<string | null>(null);
  const [selectedBlockId, setSelectedBlockId] = useState<string | null>(null);

  // Resize (bottom-edge drag-to-extend/shrink). Deliberately plain
  // mouse events, not the HTML5 DnD the move-drag path uses -- a resize
  // needs continuous pixel feedback while dragging, which HTML5 DnD's
  // opaque drag-image model doesn't give a clean hook into. resizeStateRef
  // holds the authoritative in-progress values (read at mouseup, when
  // React state from the last mousemove render may not have committed
  // yet); resizeDeltaMinutes is state purely so EventChip can render a
  // live preview height while dragging.
  const resizeStateRef = useRef<{ blockId: string; startClientY: number; baseDurationMinutes: number; deltaMinutes: number } | null>(null);
  const [resizingId, setResizingId] = useState<string | null>(null);
  const [resizeDeltaMinutes, setResizeDeltaMinutes] = useState(0);

  const [calendarStatus, setCalendarStatus] = useState<CalendarStatus | null>(null);
  const [calendarStatusState, setCalendarStatusState] = useState<LoadState>("loading");
  const [syncedIds, setSyncedIds] = useState<Set<string>>(new Set());
  const [syncingId, setSyncingId] = useState<string | null>(null);
  const [syncError, setSyncError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setState("loading");
    const supabase = createClient();
    const {
      data: { user },
      error: userError,
    } = await supabase.auth.getUser();
    if (userError || !user) {
      setState("error");
      return;
    }

    const { start, end } = viewRange(view, anchorDate);
    const columns = "id, text, status, notes, priority, estimated_minutes, category_id, date, scheduled_start_at, scheduled_end_at, plan_categories(label)";

    const [{ data: scheduledRows, error: scheduledError }, { data: unscheduledRows, error: unscheduledError }] = await Promise.all([
      supabase
        .from("blocks")
        .select(columns)
        .eq("user_id", user.id)
        .gte("scheduled_start_at", start.toISOString())
        .lt("scheduled_start_at", end.toISOString())
        .order("scheduled_start_at"),
      supabase
        .from("blocks")
        .select(columns)
        .eq("user_id", user.id)
        .is("scheduled_start_at", null)
        .neq("status", "done")
        .order("date", { ascending: false })
        .order("position")
        .limit(30),
    ]);
    if (scheduledError || unscheduledError) {
      console.error("[calendar] failed to load blocks:", scheduledError ?? unscheduledError);
      setState("error");
      return;
    }

    const narrow = (rows: typeof scheduledRows): CalendarBlock[] =>
      (rows ?? []).flatMap((block) => {
        if (!isBlockStatus(block.status) || !isTaskPriority(block.priority)) return [];
        return [{ ...block, status: block.status, priority: block.priority, category_label: block.plan_categories?.label ?? null }];
      });

    const scheduledBlocks = narrow(scheduledRows);
    setScheduled(scheduledBlocks);
    setUnscheduled(narrow(unscheduledRows));

    if (scheduledBlocks.length > 0) {
      const { data: links, error: linksError } = await supabase
        .from("calendar_event_links")
        .select("block_id")
        .in("block_id", scheduledBlocks.map((block) => block.id))
        .eq("provider", "google");
      if (!linksError) setSyncedIds(new Set((links ?? []).map((link) => link.block_id)));
    } else {
      setSyncedIds(new Set());
    }

    setState("ready");
  }, [view, anchorDate]);

  useEffect(() => {
    const timer = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(timer);
  }, [load]);

  const loadCalendarStatus = useCallback(async () => {
    setCalendarStatusState("loading");
    try {
      const response = await fetch("/api/calendar/status");
      if (!response.ok) {
        setCalendarStatusState("error");
        return;
      }
      setCalendarStatus((await response.json()) as CalendarStatus);
      setCalendarStatusState("ready");
    } catch (err) {
      console.error("[calendar] failed to load Google Calendar status:", err);
      setCalendarStatusState("error");
    }
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => void loadCalendarStatus(), 0);
    return () => window.clearTimeout(timer);
  }, [loadCalendarStatus]);

  const blocksById = useMemo(() => {
    const map = new Map<string, CalendarBlock>();
    for (const block of scheduled) map.set(block.id, block);
    for (const block of unscheduled) map.set(block.id, block);
    return map;
  }, [scheduled, unscheduled]);

  const rescheduleBlock = useCallback(
    async (block: CalendarBlock, start: Date, end: Date): Promise<boolean> => {
      setWriteError(null);
      setMovingId(block.id);
      const supabase = createClient();
      const { data, error } = await supabase.rpc("schedule_block", {
        p_block_id: block.id,
        p_start_at: start.toISOString(),
        p_end_at: end.toISOString(),
      });
      if (error || !data) {
        console.error("[calendar] failed to schedule block:", error);
        setWriteError(databaseErrorMessage(error, "We could not move that task. Your schedule is unchanged."));
        setMovingId(null);
        return false;
      }
      await load();
      setMovingId(null);
      return true;
    },
    [load],
  );

  // Resize: bottom-edge drag extends/shrinks a block's end time. Deliberately
  // reuses rescheduleBlock (same schedule_block() call, existing start,
  // computed end) rather than a parallel write path -- resize IS a
  // reschedule, just one whose start never moves.
  const finishResize = useCallback(() => {
    const state = resizeStateRef.current;
    resizeStateRef.current = null;
    setResizingId(null);
    setResizeDeltaMinutes(0);
    if (!state) return;
    const block = blocksById.get(state.blockId);
    if (!block || !block.scheduled_start_at) return;
    const start = new Date(block.scheduled_start_at);
    const finalDurationMinutes = Math.max(MIN_DURATION_MINUTES, state.baseDurationMinutes + state.deltaMinutes);
    const end = new Date(start.getTime() + finalDurationMinutes * 60000);
    void rescheduleBlock(block, start, end);
  }, [blocksById, rescheduleBlock]);

  useEffect(() => {
    if (!resizingId) return;
    const handleMove = (event: MouseEvent) => {
      const state = resizeStateRef.current;
      if (!state) return;
      const deltaPx = event.clientY - state.startClientY;
      const deltaMinutes = snapMinutesFromPixels(deltaPx);
      state.deltaMinutes = deltaMinutes;
      setResizeDeltaMinutes(deltaMinutes);
    };
    const handleUp = () => finishResize();
    window.addEventListener("mousemove", handleMove);
    window.addEventListener("mouseup", handleUp);
    return () => {
      window.removeEventListener("mousemove", handleMove);
      window.removeEventListener("mouseup", handleUp);
    };
  }, [resizingId, finishResize]);

  const startResize = useCallback((block: CalendarBlock, clientY: number) => {
    if (!block.scheduled_start_at || !block.scheduled_end_at) return;
    const baseDurationMinutes = (new Date(block.scheduled_end_at).getTime() - new Date(block.scheduled_start_at).getTime()) / 60000;
    resizeStateRef.current = { blockId: block.id, startClientY: clientY, baseDurationMinutes, deltaMinutes: 0 };
    setResizingId(block.id);
    setResizeDeltaMinutes(0);
  }, []);

  const unscheduleBlock = useCallback(
    async (block: CalendarBlock) => {
      setWriteError(null);
      setMovingId(block.id);
      const supabase = createClient();
      const { error } = await supabase.rpc("schedule_block", { p_block_id: block.id });
      if (error) {
        console.error("[calendar] failed to clear the schedule:", error);
        setWriteError(databaseErrorMessage(error, "We could not clear that task's schedule."));
        setMovingId(null);
        return;
      }
      // Best-effort, non-blocking: api.md §3e says this is safe to call
      // unconditionally and the core action (schedule_block above) has
      // already succeeded regardless of how this responds -- a block that
      // was never synced, or a server with no Google config at all, both
      // resolve here without this ever surfacing an error to the user.
      if (syncedIds.has(block.id)) {
        fetch("/api/calendar/sync", {
          body: JSON.stringify({ blockId: block.id, enabled: false }),
          headers: { "Content-Type": "application/json" },
          method: "POST",
        }).catch((err) => console.error("[calendar] best-effort unsync failed:", err));
      }
      setSelectedBlockId(null);
      await load();
      setMovingId(null);
    },
    [load, syncedIds],
  );

  const toggleSync = useCallback(
    async (block: CalendarBlock, enabled: boolean) => {
      setSyncError(null);
      setSyncingId(block.id);
      try {
        const response = await fetch("/api/calendar/sync", {
          body: JSON.stringify({ blockId: block.id, enabled }),
          headers: { "Content-Type": "application/json" },
          method: "POST",
        });
        const body = (await response.json()) as { synced?: boolean; error?: string };
        if (!response.ok) {
          setSyncError(body.error ?? "Couldn't update Google Calendar sync. Try again.");
          return;
        }
        setSyncedIds((current) => {
          const next = new Set(current);
          if (body.synced) next.add(block.id);
          else next.delete(block.id);
          return next;
        });
      } catch (err) {
        console.error("[calendar] failed to update Google Calendar sync:", err);
        setSyncError("Couldn't reach Google Calendar sync. Try again.");
      } finally {
        setSyncingId(null);
      }
    },
    [],
  );

  // Per-event notes. blocks.notes is an ordinary client-writable column
  // (schema.md §6's grants table) -- no RPC exists or is needed for this,
  // same as api.md's own framing of blocks as "an ordinary client-writable
  // table" for everything schedule_block() doesn't specifically own.
  // Updates local state directly (both scheduled/unscheduled arrays,
  // whichever the block lives in) instead of a full load() -- a save-on-
  // blur shouldn't force-refetch and re-render the whole grid/panel.
  const saveBlockNotes = useCallback(async (blockId: string, notes: string): Promise<{ ok: true } | { ok: false; message: string }> => {
    const supabase = createClient();
    const { error } = await supabase.from("blocks").update({ notes: notes.trim().length > 0 ? notes : null }).eq("id", blockId);
    if (error) {
      console.error("[calendar] failed to save note:", error);
      return { ok: false, message: databaseErrorMessage(error, "Couldn't save that note. Try again.") };
    }
    const patch = (list: CalendarBlock[]) => list.map((block) => (block.id === blockId ? { ...block, notes: notes.trim().length > 0 ? notes : null } : block));
    setScheduled(patch);
    setUnscheduled(patch);
    return { ok: true };
  }, []);

  const dropAtSlot = (day: Date, hour: number | null) => {
    if (!draggedBlockId) return;
    const block = blocksById.get(draggedBlockId);
    setDraggedBlockId(null);
    setDropHint(null);
    if (!block) return;

    const priorStart = block.scheduled_start_at ? new Date(block.scheduled_start_at) : null;
    const priorEnd = block.scheduled_end_at ? new Date(block.scheduled_end_at) : null;
    const durationMs = priorStart && priorEnd ? priorEnd.getTime() - priorStart.getTime() : (block.estimated_minutes ?? DEFAULT_DURATION_MINUTES) * 60000;

    const start = new Date(day);
    if (hour !== null) {
      start.setHours(hour, 0, 0, 0);
    } else if (priorStart) {
      start.setHours(priorStart.getHours(), priorStart.getMinutes(), 0, 0);
    } else {
      start.setHours(DEFAULT_SCHEDULE_HOUR, 0, 0, 0);
    }
    const end = new Date(start.getTime() + durationMs);
    void rescheduleBlock(block, start, end);
  };

  const dropOnUnscheduled = () => {
    if (!draggedBlockId) return;
    const block = blocksById.get(draggedBlockId);
    setDraggedBlockId(null);
    setDropHint(null);
    if (block && block.scheduled_start_at) void unscheduleBlock(block);
  };

  const selectedBlock = selectedBlockId ? (blocksById.get(selectedBlockId) ?? null) : null;

  const { start: rangeStart } = viewRange(view, anchorDate);

  return (
    <section className="a02-calendar" aria-labelledby="calendar-title">
      <div className="a02-view-head">
        <div>
          <span className="a02-eyebrow">TIME FIELD</span>
          <h1 id="calendar-title">
            Give time
            <br />
            <em>a shape.</em>
          </h1>
        </div>
        <div className="a02-view-controls">
          <div className="a02-view-switch" role="group" aria-label="Calendar view">
            {(["day", "week", "month"] as const).map((option) => (
              <button key={option} type="button" className={view === option ? "is-active" : ""} aria-pressed={view === option} onClick={() => setView(option)}>
                {option.charAt(0).toUpperCase() + option.slice(1)}
              </button>
            ))}
          </div>
          <div className="a02-date-switch">
            <button type="button" onClick={() => setAnchorDate((current) => shiftAnchor(view, current, -1))} aria-label="Previous period">
              ←
            </button>
            <b>{rangeLabel(view, anchorDate)}</b>
            <button type="button" onClick={() => setAnchorDate((current) => shiftAnchor(view, current, 1))} aria-label="Next period">
              →
            </button>
            <button type="button" onClick={() => { setView("day"); setAnchorDate(startOfDay(new Date())); }}>
              Today
            </button>
          </div>
        </div>
      </div>

      {state === "error" ? (
        <section className="a02-product-state" role="alert">
          <b>Your schedule is unavailable.</b>
          <p>We could not load your calendar. Nothing has changed.</p>
          <button type="button" onClick={() => void load()}>
            Try again ↗
          </button>
        </section>
      ) : (
        <div className={`a02-calendar-body ${state === "loading" ? "is-loading" : ""}`} aria-busy={state === "loading"}>
          <div className="a02-calendar-main">
            {view === "month" ? (
              <MonthGrid
                anchorDate={anchorDate}
                blocks={scheduled}
                draggedBlockId={draggedBlockId}
                dropHint={dropHint}
                movingId={movingId}
                onDayClick={(day) => { setAnchorDate(day); setView("day"); }}
                onDragStart={setDraggedBlockId}
                onDragEnd={() => { setDraggedBlockId(null); setDropHint(null); }}
                onDrop={dropAtSlot}
                onHover={setDropHint}
                onOpenBlock={setSelectedBlockId}
              />
            ) : (
              <TimeGrid
                days={view === "day" ? [rangeStart] : Array.from({ length: 7 }, (_, index) => addDays(rangeStart, index))}
                blocks={scheduled}
                draggedBlockId={draggedBlockId}
                dropHint={dropHint}
                movingId={movingId}
                onDragStart={setDraggedBlockId}
                onDragEnd={() => { setDraggedBlockId(null); setDropHint(null); }}
                onDrop={dropAtSlot}
                onHover={setDropHint}
                onOpenBlock={setSelectedBlockId}
                resizingId={resizingId}
                resizeDeltaMinutes={resizeDeltaMinutes}
                onResizeStart={startResize}
              />
            )}
          </div>
          <UnscheduledPanel
            items={unscheduled}
            draggedBlockId={draggedBlockId}
            isDropTarget={dropHint === "unscheduled"}
            onDragEnd={() => { setDraggedBlockId(null); setDropHint(null); }}
            onDragStart={setDraggedBlockId}
            onDrop={dropOnUnscheduled}
            onHover={() => setDropHint("unscheduled")}
            onOpenBlock={setSelectedBlockId}
          />
        </div>
      )}

      {writeError && (
        <p className="a02-product-write-error" role="alert">
          {writeError}
        </p>
      )}

      {selectedBlock && (
        <BlockDetailPopover
          block={selectedBlock}
          calendarStatus={calendarStatus}
          calendarStatusState={calendarStatusState}
          moving={movingId === selectedBlock.id}
          onReschedule={(start, end) => rescheduleBlock(selectedBlock, start, end)}
          onClose={() => setSelectedBlockId(null)}
          onSaveNotes={saveBlockNotes}
          onToggleSync={(enabled) => void toggleSync(selectedBlock, enabled)}
          onUnschedule={() => void unscheduleBlock(selectedBlock)}
          synced={syncedIds.has(selectedBlock.id)}
          syncError={syncError}
          syncing={syncingId === selectedBlock.id}
        />
      )}
    </section>
  );
}

function EventChip({ block, lanePlacement, moving, resizeDeltaMinutes, resizing, onDragEnd, onDragStart, onOpen, onResizeStart }: {
  block: CalendarBlock;
  lanePlacement: LanePlacement;
  moving: boolean;
  resizeDeltaMinutes: number;
  resizing: boolean;
  onDragEnd: () => void;
  onDragStart: (event: DragEvent<HTMLElement>) => void;
  onOpen: () => void;
  onResizeStart: (clientY: number) => void;
}) {
  const start = block.scheduled_start_at ? new Date(block.scheduled_start_at) : null;
  const end = block.scheduled_end_at ? new Date(block.scheduled_end_at) : null;
  const geometry = start && end ? eventGeometry(start, end) : null;
  const baseDurationMinutes = start && end ? (end.getTime() - start.getTime()) / 60000 : null;
  // While a resize is in progress, preview the dragged height live rather
  // than waiting for schedule_block()'s round trip -- same
  // baseDuration+deltaMinutes math finishResize() commits with, so the
  // preview never shows something the commit wouldn't actually save.
  const previewDurationMinutes = resizing && baseDurationMinutes !== null ? Math.max(MIN_DURATION_MINUTES, baseDurationMinutes + resizeDeltaMinutes) : baseDurationMinutes;
  // 40px is the real floor, not a stylistic choice: task name + time (the
  // two lines that must never disappear) need ~26px of content height
  // once padding is subtracted, and anything smaller reintroduces the
  // "block only shows its time, not what it is" bug -- any block under
  // ~50min hits this floor, which is most of them. A short block visually
  // overlapping its true time-proportional height is the accepted
  // tradeoff, same one most calendar UIs make for legibility.
  const height = previewDurationMinutes !== null ? Math.max(40, (previewDurationMinutes / 60) * ROW_HEIGHT) : undefined;
  const lane = laneStyle(lanePlacement.lane, lanePlacement.laneCount);
  const style = geometry
    ? { top: `${geometry.top}px`, height: height !== undefined ? `${height}px` : undefined, ...(lane ?? {}) }
    : undefined;
  const colorToken = categoryColorToken(block.category_id);
  return (
    <button
      type="button"
      className={`a02-calendar-event a02-calendar-event--cat-${colorToken} ${moving ? "is-moving" : ""} ${resizing ? "is-resizing" : ""}`}
      style={style}
      draggable={!moving && !resizing}
      data-testid={`calendar-event-${block.id}`}
      // Exposed for tests only, not read by any app code: category_id is a
      // server-generated UUID, so two real categories can legitimately (if
      // unluckily) land on the same of the four palette slots -- that's the
      // documented tradeoff in category-color.ts, not a bug. A test can't
      // assert "these two differ" against a random UUID without sometimes
      // being wrong; this lets a test compute the real expected token via
      // categoryColorToken(realCategoryId) instead of guessing.
      data-category-id={block.category_id}
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      onClick={onOpen}
    >
      {/* Task name first: overflow:hidden clips from the bottom on a short
          (e.g. 20-30min) block, and knowing WHAT this is matters more than
          precisely when -- the block's position on the grid already shows
          when, this text is the only place that says what. */}
      <b>{block.text}</b>
      {start && end && <small>{formatTimeRange(start, end)}</small>}
      {/* Colour by category is now the dominant signal (founder: "each
          block each event meaning should be of different colours like
          Google Calendar"); priority stays visible as this small dot +
          label rather than disappearing, kept on the SAME line as the
          category label so this never grows the chip past the 40px floor
          above -- a 4th line here would reopen the short-block clipping
          bug PR #161 fixed. */}
      <span className="a02-calendar-event-meta">
        <i className={`a02-calendar-event-priority-dot a02-calendar-event-priority-dot--${block.priority}`} title={`${priorityLabel(block.priority)} priority`} />
        {block.category_label}
      </span>
      {start && end && (
        <span
          className="a02-calendar-event-resize-handle"
          // Deliberately NOT prefixed `calendar-event-` -- every existing
          // test (and every new one here) locates the chip itself via
          // `[data-testid^="calendar-event-"]`, and that attribute
          // selector matches on substring prefix regardless of DOM
          // nesting. A `calendar-event-resize-<id>` testid would silently
          // become a second match under that same selector.
          data-testid={`calendar-resize-handle-${block.id}`}
          draggable={false}
          onClick={(event) => event.stopPropagation()}
          onMouseDown={(event) => {
            event.preventDefault();
            event.stopPropagation();
            onResizeStart(event.clientY);
          }}
        />
      )}
    </button>
  );
}

function TimeGrid({ days, blocks, draggedBlockId, dropHint, movingId, onDragStart, onDragEnd, onDrop, onHover, onOpenBlock, resizingId, resizeDeltaMinutes, onResizeStart }: {
  days: Date[];
  blocks: CalendarBlock[];
  draggedBlockId: string | null;
  dropHint: string | null;
  movingId: string | null;
  onDragStart: (id: string) => void;
  onDragEnd: () => void;
  onDrop: (day: Date, hour: number | null) => void;
  onHover: (hint: string | null) => void;
  onOpenBlock: (id: string) => void;
  resizingId: string | null;
  resizeDeltaMinutes: number;
  onResizeStart: (block: CalendarBlock, clientY: number) => void;
}) {
  const today = new Date();
  return (
    <div className={`a02-time-map ${days.length > 1 ? "a02-time-map--week" : ""}`}>
      <aside>
        {HOURS.map((hour) => (
          <span key={hour}>{formatHourLabel(hour)}</span>
        ))}
      </aside>
      {days.map((day) => {
        const dayBlocks = blocks.filter((block) => block.scheduled_start_at && sameDay(new Date(block.scheduled_start_at), day));
        const key = isoDate(day);
        // Overlap lanes are computed per day column, from this day's own
        // blocks only -- see calendar-overlap.ts. Horizontal placement
        // only; ROW_HEIGHT/eventGeometry's vertical math is untouched.
        const lanePlacements = layoutDayOverlaps(
          dayBlocks
            .filter((block) => block.scheduled_start_at && block.scheduled_end_at)
            .map((block) => ({ id: block.id, start: new Date(block.scheduled_start_at as string), end: new Date(block.scheduled_end_at as string) })),
        );
        return (
          <div key={key} className={`a02-time-column ${sameDay(day, today) ? "is-today" : ""}`}>
            {days.length > 1 && (
              <header className="a02-time-column-head">
                <span>{WEEKDAY_LABELS[day.getDay()]}</span>
                <b>{day.getDate()}</b>
              </header>
            )}
            <div className="a02-time-lines">
              {HOURS.map((hour) => (
                <i
                  key={hour}
                  className={draggedBlockId && dropHint === `${key}:${hour}` ? "is-drop-target" : ""}
                  data-testid={`calendar-slot-${key}-${hour}`}
                  onDragOver={(event) => { event.preventDefault(); onHover(`${key}:${hour}`); }}
                  onDragLeave={() => onHover(null)}
                  onDrop={(event) => { event.preventDefault(); onDrop(day, hour); }}
                />
              ))}
              {dayBlocks.map((block) => (
                <EventChip
                  key={block.id}
                  block={block}
                  lanePlacement={lanePlacements.get(block.id) ?? { lane: 0, laneCount: 1 }}
                  moving={movingId === block.id}
                  resizing={resizingId === block.id}
                  resizeDeltaMinutes={resizeDeltaMinutes}
                  onDragStart={(event) => { event.dataTransfer.effectAllowed = "move"; event.dataTransfer.setData("text/plain", block.id); onDragStart(block.id); }}
                  onDragEnd={onDragEnd}
                  onOpen={() => onOpenBlock(block.id)}
                  onResizeStart={(clientY) => onResizeStart(block, clientY)}
                />
              ))}
            </div>
          </div>
        );
      })}
    </div>
  );
}

// Month view deliberately gets NO overlap-lane layout, category colour
// only. Reasoning: lanes exist to solve blocks visually covering each
// other at absolute pixel positions on the hour grid (TimeGrid) -- Month's
// `.a02-month-chip`s are never absolutely positioned by time at all, they
// are an ordinary vertical list (up to 3 + an overflow count) inside a flex
// column cell, so two overlapping-in-time blocks already render as two
// separate, fully visible, independently clickable rows with zero changes
// needed. Adding lane math here would solve a collision that structurally
// cannot happen in this view. Month's own "click a day to see it in Day
// view" (`onDayClick`) is where a user goes to see the real time layout.
function MonthGrid({ anchorDate, blocks, draggedBlockId, dropHint, movingId, onDayClick, onDragStart, onDragEnd, onDrop, onHover, onOpenBlock }: {
  anchorDate: Date;
  blocks: CalendarBlock[];
  draggedBlockId: string | null;
  dropHint: string | null;
  movingId: string | null;
  onDayClick: (day: Date) => void;
  onDragStart: (id: string) => void;
  onDragEnd: () => void;
  onDrop: (day: Date, hour: number | null) => void;
  onHover: (hint: string | null) => void;
  onOpenBlock: (id: string) => void;
}) {
  const { start } = viewRange("month", anchorDate);
  const today = new Date();
  const days = Array.from({ length: 42 }, (_, index) => addDays(start, index));
  const currentMonth = anchorDate.getMonth();

  return (
    <div className="a02-month-grid">
      <div className="a02-month-weekdays">
        {WEEKDAY_LABELS.map((label) => (
          <span key={label}>{label}</span>
        ))}
      </div>
      <div className="a02-month-cells">
        {days.map((day) => {
          const key = isoDate(day);
          const dayBlocks = blocks.filter((block) => block.scheduled_start_at && sameDay(new Date(block.scheduled_start_at), day));
          const visible = dayBlocks.slice(0, 3);
          const overflow = dayBlocks.length - visible.length;
          return (
            <div
              key={key}
              className={[
                "a02-month-cell",
                day.getMonth() !== currentMonth ? "is-outside" : "",
                sameDay(day, today) ? "is-today" : "",
                draggedBlockId && dropHint === key ? "is-drop-target" : "",
              ].join(" ").trim()}
              data-testid={`calendar-month-cell-${key}`}
              onDragOver={(event) => { event.preventDefault(); onHover(key); }}
              onDragLeave={() => onHover(null)}
              onDrop={(event) => { event.preventDefault(); onDrop(day, null); }}
            >
              <button type="button" className="a02-month-cell-date" onClick={() => onDayClick(day)}>
                {day.getDate()}
              </button>
              {visible.map((block) => (
                <button
                  key={block.id}
                  type="button"
                  className={`a02-month-chip a02-month-chip--cat-${categoryColorToken(block.category_id)} ${movingId === block.id ? "is-moving" : ""}`}
                  draggable={movingId !== block.id}
                  data-testid={`calendar-month-chip-${block.id}`}
                  onDragStart={(event) => { event.dataTransfer.effectAllowed = "move"; event.dataTransfer.setData("text/plain", block.id); onDragStart(block.id); }}
                  onDragEnd={onDragEnd}
                  onClick={(event) => { event.stopPropagation(); onOpenBlock(block.id); }}
                >
                  <i className={`a02-calendar-event-priority-dot a02-calendar-event-priority-dot--${block.priority}`} title={`${priorityLabel(block.priority)} priority`} />
                  {block.text}
                </button>
              ))}
              {overflow > 0 && <span className="a02-month-overflow">+{overflow} more</span>}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function UnscheduledPanel({ items, draggedBlockId, isDropTarget, onDragStart, onDragEnd, onDrop, onHover, onOpenBlock }: {
  items: CalendarBlock[];
  draggedBlockId: string | null;
  isDropTarget: boolean;
  onDragStart: (id: string) => void;
  onDragEnd: () => void;
  onDrop: () => void;
  onHover: () => void;
  onOpenBlock: (id: string) => void;
}) {
  return (
    <aside
      className={`a02-unscheduled ${isDropTarget ? "is-drop-target" : ""}`}
      data-testid="calendar-unscheduled-panel"
      onDragOver={(event) => { event.preventDefault(); onHover(); }}
      onDragLeave={() => onHover()}
      onDrop={(event) => { event.preventDefault(); onDrop(); }}
    >
      <span>UNSCHEDULED · drag onto the calendar, or drop here to clear a time</span>
      {items.length === 0 ? (
        <p className="a02-lane-empty">Nothing waiting -- every active task has a time.</p>
      ) : (
        items.map((block) => (
          <button
            key={block.id}
            type="button"
            draggable={draggedBlockId !== block.id}
            data-testid={`calendar-unscheduled-${block.id}`}
            onDragStart={(event) => { event.dataTransfer.effectAllowed = "move"; event.dataTransfer.setData("text/plain", block.id); onDragStart(block.id); }}
            onDragEnd={onDragEnd}
            onClick={() => onOpenBlock(block.id)}
          >
            <span>{block.text}</span>
            <i>{block.estimated_minutes ? `${block.estimated_minutes}m` : priorityLabel(block.priority)}</i>
          </button>
        ))
      )}
    </aside>
  );
}

type NotesSaveState = "idle" | "saving" | "saved" | "error";

function BlockDetailPopover({ block, calendarStatus, calendarStatusState, moving, onClose, onReschedule, onSaveNotes, onToggleSync, onUnschedule, synced, syncError, syncing }: {
  block: CalendarBlock;
  calendarStatus: CalendarStatus | null;
  calendarStatusState: LoadState;
  moving: boolean;
  onClose: () => void;
  onReschedule: (start: Date, end: Date) => Promise<boolean>;
  onSaveNotes: (blockId: string, notes: string) => Promise<{ ok: true } | { ok: false; message: string }>;
  onToggleSync: (enabled: boolean) => void;
  onUnschedule: () => void;
  synced: boolean;
  syncError: string | null;
  syncing: boolean;
}) {
  const start = block.scheduled_start_at ? new Date(block.scheduled_start_at) : null;
  const end = block.scheduled_end_at ? new Date(block.scheduled_end_at) : null;

  // Draft resets whenever a different block is opened -- keyed on block.id
  // (not just block.notes) so switching blocks always shows that block's
  // own saved note, never a stale draft left over from the previous one.
  // Plain useState comparison (not a ref) per React's own "adjusting state
  // when a prop changes" pattern -- setState calls during render are fine,
  // reading/writing a ref during render is not.
  const [lastOpenBlockId, setLastOpenBlockId] = useState(block.id);
  const [noteDraft, setNoteDraft] = useState(block.notes ?? "");
  const [noteSaveState, setNoteSaveState] = useState<NotesSaveState>("idle");
  const [noteError, setNoteError] = useState<string | null>(null);
  const [startTime, setStartTime] = useState(start ? timeInputValue(start) : "");
  const [endTime, setEndTime] = useState(end ? timeInputValue(end) : "");
  const [timeError, setTimeError] = useState<string | null>(null);
  if (lastOpenBlockId !== block.id) {
    setLastOpenBlockId(block.id);
    setNoteDraft(block.notes ?? "");
    setNoteSaveState("idle");
    setNoteError(null);
  }

  const commitNote = async () => {
    if (noteDraft === (block.notes ?? "")) return; // nothing changed since the last save
    setNoteSaveState("saving");
    setNoteError(null);
    const result = await onSaveNotes(block.id, noteDraft);
    if (result.ok) {
      setNoteSaveState("saved");
    } else {
      setNoteSaveState("error");
      setNoteError(result.message);
    }
  };

  const commitTime = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!start || !end) return;
    const nextStart = withTime(start, startTime);
    const nextEnd = withTime(start, endTime);
    if (!nextStart || !nextEnd || nextEnd <= nextStart) {
      setTimeError("End time must be later than start time.");
      return;
    }
    setTimeError(null);
    const saved = await onReschedule(nextStart, nextEnd);
    if (saved) onClose();
  };

  return (
    <section className="a02-record-overlay" role="dialog" aria-modal="true" aria-labelledby="calendar-detail-title" data-testid="calendar-detail-popover" onClick={onClose}>
      <section className="a02-composer" onClick={(event) => event.stopPropagation()}>
        <button className="a02-lens-close" type="button" onClick={onClose}>
          ESC / close ×
        </button>
        <span className="a02-eyebrow">SCHEDULED TASK</span>
        <h2 id="calendar-detail-title">{block.text}</h2>
        {start && end ? (
          <p className="a02-calendar-detail-time">
            {new Intl.DateTimeFormat("en", { weekday: "long", month: "short", day: "numeric" }).format(start)} · {formatTimeRange(start, end)}
          </p>
        ) : (
          <p className="a02-calendar-detail-time">Not yet on the calendar.</p>
        )}
        <div className="a02-lens-meta">
          <span className={`a02-priority a02-priority--${block.priority}`}>{priorityLabel(block.priority)}</span>
          {block.category_label && <span>{block.category_label}</span>}
          <span>{block.status.replace("_", " ")}</span>
        </div>

        {start && end && (
          <form className="a02-calendar-time-editor" onSubmit={(event) => void commitTime(event)}>
            <span>TIME WINDOW</span>
            <label>
              Start time
              <input aria-label="Start time" type="time" value={startTime} onChange={(event) => { setStartTime(event.target.value); setTimeError(null); }} disabled={moving} required />
            </label>
            <label>
              End time
              <input aria-label="End time" type="time" value={endTime} onChange={(event) => { setEndTime(event.target.value); setTimeError(null); }} disabled={moving} required />
            </label>
            <button type="submit" disabled={moving}>{moving ? "Saving…" : "Save time"}</button>
            {timeError && <p role="alert">{timeError}</p>}
          </form>
        )}

        <div className="a02-calendar-notes">
          <label htmlFor="calendar-detail-notes">NOTE</label>
          <textarea
            id="calendar-detail-notes"
            data-testid="calendar-detail-notes"
            placeholder="Add a note for this task -- what you're focusing on, what's left, anything worth remembering next time."
            value={noteDraft}
            onChange={(event) => { setNoteDraft(event.target.value); if (noteSaveState !== "idle") setNoteSaveState("idle"); }}
            onBlur={() => void commitNote()}
          />
          <p className="a02-calendar-notes-status" data-testid="calendar-notes-status" aria-live="polite">
            {noteSaveState === "saving" && "Saving…"}
            {noteSaveState === "saved" && "Saved"}
            {noteSaveState === "error" && (noteError ?? "Couldn't save that note.")}
          </p>
        </div>

        {start && end && (
          <div className="a02-calendar-sync">
            {calendarStatusState === "loading" && <p>Checking Google Calendar…</p>}
            {calendarStatusState === "error" && <p>Couldn&apos;t check Google Calendar&apos;s status.</p>}
            {calendarStatusState === "ready" && calendarStatus && !calendarStatus.configured && (
              <p data-testid="calendar-sync-not-configured">Google Calendar isn&apos;t connected yet. This server has no Google credentials configured, so scheduling here still works, it just doesn&apos;t leave the app.</p>
            )}
            {calendarStatusState === "ready" && calendarStatus?.configured && !calendarStatus.connected && (
              <p>Connect Google Calendar in Settings to mirror this task there.</p>
            )}
            {calendarStatusState === "ready" && calendarStatus?.configured && calendarStatus.connected && (
              <label className="a02-calendar-sync-toggle">
                <input type="checkbox" checked={synced} disabled={syncing} onChange={(event) => onToggleSync(event.target.checked)} />
                <span>{syncing ? "Updating…" : synced ? "Synced to Google Calendar" : "Add to Google Calendar"}</span>
              </label>
            )}
            {syncError && (
              <p role="alert" className="a02-composer-error">
                {syncError}
              </p>
            )}
          </div>
        )}

        <div className="a02-composer-actions">
          <button type="button" onClick={onClose}>
            Close
          </button>
          {start && end && (
            <button type="button" className="a02-calendar-unschedule" data-testid="calendar-unschedule-button" disabled={moving} onClick={onUnschedule}>
              {moving ? "Clearing…" : "Remove from calendar ↗"}
            </button>
          )}
        </div>
      </section>
    </section>
  );
}
