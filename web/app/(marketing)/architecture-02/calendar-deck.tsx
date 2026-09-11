"use client";

import { useCallback, useEffect, useMemo, useState, type DragEvent } from "react";

import { createClient } from "@/lib/supabase/client";

import { isBlockStatus, type BlockStatus } from "./today-deck";
import { isTaskPriority, priorityLabel, type TaskPriority } from "./kanban-metadata";

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
    async (block: CalendarBlock, start: Date, end: Date) => {
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
        return;
      }
      await load();
      setMovingId(null);
    },
    [load],
  );

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
          onClose={() => setSelectedBlockId(null)}
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

function EventChip({ block, moving, onDragEnd, onDragStart, onOpen }: {
  block: CalendarBlock;
  moving: boolean;
  onDragEnd: () => void;
  onDragStart: (event: DragEvent<HTMLElement>) => void;
  onOpen: () => void;
}) {
  const start = block.scheduled_start_at ? new Date(block.scheduled_start_at) : null;
  const end = block.scheduled_end_at ? new Date(block.scheduled_end_at) : null;
  const geometry = start && end ? eventGeometry(start, end) : null;
  const style = geometry ? { top: `${geometry.top}px`, height: `${Math.max(22, geometry.height)}px` } : undefined;
  return (
    <button
      type="button"
      className={`a02-calendar-event a02-calendar-event--${block.priority} ${moving ? "is-moving" : ""}`}
      style={style}
      draggable={!moving}
      data-testid={`calendar-event-${block.id}`}
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      onClick={onOpen}
    >
      {start && end && <small>{formatTimeRange(start, end)}</small>}
      <b>{block.text}</b>
      {block.category_label && <span>{block.category_label}</span>}
    </button>
  );
}

function TimeGrid({ days, blocks, draggedBlockId, dropHint, movingId, onDragStart, onDragEnd, onDrop, onHover, onOpenBlock }: {
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
                  moving={movingId === block.id}
                  onDragStart={(event) => { event.dataTransfer.effectAllowed = "move"; event.dataTransfer.setData("text/plain", block.id); onDragStart(block.id); }}
                  onDragEnd={onDragEnd}
                  onOpen={() => onOpenBlock(block.id)}
                />
              ))}
            </div>
          </div>
        );
      })}
    </div>
  );
}

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
                  className={`a02-month-chip a02-month-chip--${block.priority} ${movingId === block.id ? "is-moving" : ""}`}
                  draggable={movingId !== block.id}
                  data-testid={`calendar-month-chip-${block.id}`}
                  onDragStart={(event) => { event.dataTransfer.effectAllowed = "move"; event.dataTransfer.setData("text/plain", block.id); onDragStart(block.id); }}
                  onDragEnd={onDragEnd}
                  onClick={(event) => { event.stopPropagation(); onOpenBlock(block.id); }}
                >
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

function BlockDetailPopover({ block, calendarStatus, calendarStatusState, moving, onClose, onToggleSync, onUnschedule, synced, syncError, syncing }: {
  block: CalendarBlock;
  calendarStatus: CalendarStatus | null;
  calendarStatusState: LoadState;
  moving: boolean;
  onClose: () => void;
  onToggleSync: (enabled: boolean) => void;
  onUnschedule: () => void;
  synced: boolean;
  syncError: string | null;
  syncing: boolean;
}) {
  const start = block.scheduled_start_at ? new Date(block.scheduled_start_at) : null;
  const end = block.scheduled_end_at ? new Date(block.scheduled_end_at) : null;

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
