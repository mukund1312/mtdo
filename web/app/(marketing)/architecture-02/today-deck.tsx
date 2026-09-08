"use client";

import { useCallback, useEffect, useState, type DragEvent } from "react";

import { recordEvent } from "@/lib/analytics/record-event";
import { createClient } from "@/lib/supabase/client";

import { fetchProfileTimezone } from "./profile-timezone";
import { utcToday } from "./product-data";
import { kanbanMetadataFor, priorityLabel, type TaskPriority } from "./kanban-metadata";

export type BlockStatus = "backlog" | "todo" | "in_progress" | "done";

export type TodayBlock = {
  claimed: boolean;
  elapsed_seconds: number;
  id: string;
  notes: string | null;
  position: number;
  status: BlockStatus;
  text: string;
};

type CurriculumMenuItem = {
  category_label: string;
  curriculum_item_id: string;
  meta: unknown;
  task: string;
};

const LANES: Array<{ id: BlockStatus; label: string; index: string }> = [
  { id: "backlog", label: "Backlog", index: "01" },
  { id: "todo", label: "Todo", index: "02" },
  { id: "in_progress", label: "In progress", index: "03" },
  { id: "done", label: "Done", index: "04" },
];

export function isBlockStatus(value: string): value is BlockStatus {
  return value === "backlog" || value === "todo" || value === "in_progress" || value === "done";
}

function databaseErrorMessage(error: unknown, fallback: string): string {
  if (!error || typeof error !== "object") return fallback;
  const candidate = error as { code?: string; details?: string; hint?: string; message?: string };
  const detail = [candidate.message, candidate.details, candidate.hint].filter(Boolean).join(" ");
  if (candidate.code === "23514" && detail.includes("status")) {
    return "We could not save this signal status. Refresh and try again.";
  }
  return candidate.message || candidate.details || fallback;
}

function roughDuration(seconds: number): string | null {
  return seconds > 0 ? `${Math.max(1, Math.round(seconds / 60))} min logged` : null;
}

function menuPreview(meta: unknown): string | null {
  if (!meta || typeof meta !== "object" || Array.isArray(meta)) return null;
  const focusPoints = (meta as { focus_points?: unknown }).focus_points;
  if (!Array.isArray(focusPoints)) return null;
  const points = focusPoints.filter((point): point is string => typeof point === "string").slice(0, 2);
  return points.length > 0 ? points.join(" · ") : null;
}

export function TodayDeck({ onOpenBlock }: { onOpenBlock: (block: TodayBlock) => void }) {
  const [blocks, setBlocks] = useState<TodayBlock[]>([]);
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");
  const [updatingId, setUpdatingId] = useState<string | null>(null);
  const [writeError, setWriteError] = useState<string | null>(null);
  const [hasActiveRoute, setHasActiveRoute] = useState(false);
  const [menuItems, setMenuItems] = useState<CurriculumMenuItem[]>([]);
  const [composerOpen, setComposerOpen] = useState(false);
  const [composerError, setComposerError] = useState<string | null>(null);
  const [pickingId, setPickingId] = useState<string | null>(null);
  const [draggedBlockId, setDraggedBlockId] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<BlockStatus | null>(null);
  const [timezone, setTimezone] = useState("UTC");
  const [isExhausted, setIsExhausted] = useState(false);
  const [checkInState, setCheckInState] = useState<"idle" | "loading" | "done" | "error">("idle");
  const [checkInMessage, setCheckInMessage] = useState("");
  const [statusFilter, setStatusFilter] = useState<BlockStatus | "all">("all");
  const [priorityFilter, setPriorityFilter] = useState<TaskPriority | "all">("all");

  const load = useCallback(async () => {
    setState("loading");
    const supabase = createClient();
    const { data: { user }, error: userError } = await supabase.auth.getUser();
    if (userError || !user) {
      setState("error");
      return;
    }

    // Read before the date-scoped queries below -- utcToday(timezone) has to
    // use the same zone the user's blocks were actually inserted under
    // (pick_curriculum_item(), migrations/0014) or Today would ask the
    // database for a different calendar day than the one it just wrote to.
    const userTimezone = await fetchProfileTimezone(supabase, user.id);
    setTimezone(userTimezone);

    const { data: activePlan, error: planError } = await supabase
      .from("plans").select("id, planning_mode").eq("user_id", user.id).eq("is_active", true).maybeSingle();
    if (planError) {
      console.error("[today] failed to load active route:", planError);
      setState("error");
      return;
    }
    setHasActiveRoute(Boolean(activePlan));

    // This RPC intentionally writes the active plan's ISO-week unlock cursor.
    // It is called from this explicit load path (never render) and returns every
    // unlocked, unpicked curriculum item for the current user.
    const [{ data, error }, { data: menuData, error: menuError }, { data: categoryRows, error: categoryError }] = await Promise.all([
      supabase
      .from("blocks")
      .select("id, text, status, notes, claimed, elapsed_seconds, position")
      .eq("user_id", user.id).eq("date", utcToday(userTimezone)).order("position"),
      supabase.rpc("ensure_curriculum_menu"),
      activePlan
        ? supabase.from("plan_categories").select("id, menu_unlocked_week_index, curriculum_items(week_index)").eq("plan_id", activePlan.id)
        : Promise.resolve({ data: [], error: null }),
    ]);
    if (error || menuError || categoryError) {
      console.error("[today] failed to load today's route:", error ?? menuError ?? categoryError);
      setState("error");
      return;
    }
    setBlocks((data ?? []).flatMap((block) => isBlockStatus(block.status) ? [{ ...block, status: block.status }] : []));
    setMenuItems((menuData ?? []).map((item) => ({
      category_label: item.category_label,
      curriculum_item_id: item.curriculum_item_id,
      meta: item.meta,
      task: item.task,
    })));
    // Curriculum check-in trigger (decisions.md 2026-09-08): every category's
    // cursor pinned (nothing left for ensure_curriculum_menu() to reveal even
    // next week) AND the whole menu is down to a handful of items. A
    // category with zero generated content at all doesn't count -- that's
    // "never generated", not "ran out". "Cursor pinned" only means anything
    // for a dynamic_weekly plan (migrations/0017) -- an overall-mode plan's
    // cursor never advances at all (by design, so switching back to
    // dynamic_weekly resumes correctly), so checking it there would almost
    // never detect exhaustion even though overall mode can genuinely run
    // its menu down to nothing. overall mode only needs the item-count check.
    const categoriesWithContent = (categoryRows ?? []).filter((category) => (category.curriculum_items ?? []).length > 0);
    const allPinned = categoriesWithContent.length > 0 && (
      activePlan?.planning_mode === "overall" ||
      categoriesWithContent.every((category) => {
        const maxWeek = Math.max(...category.curriculum_items.map((item) => item.week_index));
        return category.menu_unlocked_week_index >= maxWeek;
      })
    );
    setIsExhausted(allPinned && (menuData ?? []).length <= 3);
    setState("ready");
  }, []);

  const runCheckIn = useCallback(async () => {
    setCheckInState("loading");
    setCheckInMessage("");
    try {
      const response = await fetch("/api/plan/extend", { method: "POST" });
      const body = (await response.json()) as
        | { extended: true; categories: Array<{ categoryId: string; label: string; addedCount: number }> }
        | { extended: false; reason: string }
        | { error: string };
      if (!response.ok || "error" in body) {
        setCheckInState("error");
        setCheckInMessage("error" in body ? body.error : "Couldn't extend your route. Try again.");
        return;
      }
      if (!body.extended) {
        setCheckInState("error");
        setCheckInMessage(body.reason);
        return;
      }
      const totalAdded = body.categories.reduce((sum, category) => sum + category.addedCount, 0);
      setCheckInState("done");
      setCheckInMessage(`Added ${totalAdded} new task${totalAdded === 1 ? "" : "s"} across ${body.categories.length} subject${body.categories.length === 1 ? "" : "s"}.`);
      await load();
    } catch (checkInError) {
      console.error("[today] curriculum check-in failed:", checkInError);
      setCheckInState("error");
      setCheckInMessage("Couldn't extend your route. Try again.");
    }
  }, [load]);

  useEffect(() => {
    const timer = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(timer);
  }, [load]);

  const moveBlock = useCallback(async (block: TodayBlock, nextStatus: BlockStatus) => {
    if (block.status === nextStatus || updatingId) return;
    setWriteError(null);
    setUpdatingId(block.id);
    const supabase = createClient();
    const { error } = await supabase.from("blocks")
      .update({ claimed: nextStatus === "in_progress", status: nextStatus }).eq("id", block.id);
    if (error) {
      console.error("[today] failed to update block:", databaseErrorMessage(error, "Unknown database error."));
      setWriteError(databaseErrorMessage(error, "We could not move that signal. Try again."));
      setUpdatingId(null);
      return;
    }
    setBlocks((current) => current.map((item) => item.id === block.id
      ? { ...item, claimed: nextStatus === "in_progress", status: nextStatus } : item));
    if (nextStatus === "done") void recordEvent(supabase, "task_completed", { block_id: block.id });
    else if (block.status === "done") void recordEvent(supabase, "task_regressed", { block_id: block.id });
    setUpdatingId(null);
  }, [updatingId]);

  const draggedBlock = draggedBlockId ? blocks.find((block) => block.id === draggedBlockId) ?? null : null;

  const dropBlock = (nextStatus: BlockStatus) => {
    if (draggedBlock) void moveBlock(draggedBlock, nextStatus);
    setDraggedBlockId(null);
    setDropTarget(null);
  };

  const openComposer = () => {
    setComposerError(null);
    setComposerOpen(true);
  };

  const pickMenuItem = async (item: CurriculumMenuItem) => {
    if (pickingId) return;
    setPickingId(item.curriculum_item_id);
    setComposerError(null);
    const supabase = createClient();
    const { data, error } = await supabase.rpc("pick_curriculum_item", { p_item_id: item.curriculum_item_id });
    if (error || !data || !isBlockStatus(data.status)) {
      console.error("[today] failed to pick route item:", databaseErrorMessage(error, "No row returned."));
      setComposerError(databaseErrorMessage(error, "We could not add that route item. Your board is unchanged."));
      setPickingId(null);
      return;
    }
    const createdBlock: TodayBlock = {
      claimed: data.claimed,
      elapsed_seconds: data.elapsed_seconds,
      id: data.id,
      notes: data.notes,
      position: data.position,
      status: data.status,
      text: data.text,
    };
    setBlocks((current) => [...current.filter((block) => block.id !== createdBlock.id), createdBlock]
      .sort((a, b) => a.position - b.position));
    setMenuItems((current) => current.filter((menuItem) => menuItem.curriculum_item_id !== item.curriculum_item_id));
    setComposerOpen(false);
    setPickingId(null);
  };

  const hasFilters = statusFilter !== "all" || priorityFilter !== "all";
  const visibleBlocks = blocks.filter((block) => {
    const metadata = kanbanMetadataFor(block);
    return (statusFilter === "all" || block.status === statusFilter) && (priorityFilter === "all" || metadata.priority === priorityFilter);
  });

  return <section className="a02-work" aria-labelledby="today-title">
    <div className="a02-view-head"><div><span className="a02-eyebrow">KANBAN / TODAY</span><h1 id="today-title">Move the<br /><em>right pieces.</em></h1></div><div className="a02-view-controls"><button type="button" onClick={() => void load()}>Refresh</button><button type="button" disabled>Today / {timezone}</button><button className="a02-add" type="button" onClick={openComposer} disabled={state === "loading"}>+ Add from route</button></div></div>
    {isExhausted && state === "ready" && checkInState !== "done" && <section className="a02-checkin-banner" role="status">
      {checkInState === "idle" && <><p>Your route menu is running low across every subject.</p><button type="button" onClick={() => void runCheckIn()}>Check in for more ↗</button></>}
      {checkInState === "loading" && <p>Reading your progress and generating more…</p>}
      {checkInState === "error" && <><p role="alert">{checkInMessage}</p><button type="button" onClick={() => setCheckInState("idle")}>Try again</button></>}
    </section>}
    {checkInState === "done" && <p className="a02-checkin-done" role="status">{checkInMessage}</p>}
    <section className="a02-kanban-filters" aria-label="Kanban filters">
      <div className="a02-filter-group" role="group" aria-label="Filter by status"><span>STATUS</span><button type="button" className={statusFilter === "all" ? "is-active" : ""} aria-pressed={statusFilter === "all"} onClick={() => setStatusFilter("all")}>All</button>{LANES.map((lane) => <button type="button" key={lane.id} className={statusFilter === lane.id ? "is-active" : ""} aria-pressed={statusFilter === lane.id} onClick={() => setStatusFilter(lane.id)}>{lane.label}</button>)}</div>
      <div className="a02-filter-group" role="group" aria-label="Filter by priority"><span>PRIORITY</span><button type="button" className={priorityFilter === "all" ? "is-active" : ""} aria-pressed={priorityFilter === "all"} onClick={() => setPriorityFilter("all")}>All</button>{(["high", "medium", "low"] as TaskPriority[]).map((priority) => <button type="button" key={priority} className={priorityFilter === priority ? `is-active is-${priority}` : ""} aria-pressed={priorityFilter === priority} onClick={() => setPriorityFilter(priority)}>{priorityLabel(priority)}</button>)}</div>
      {hasFilters && <button className="a02-filter-reset" type="button" onClick={() => { setStatusFilter("all"); setPriorityFilter("all"); }}>Reset</button>}
    </section>
    {state === "error" ? <section className="a02-product-state" role="alert"><b>Today is unavailable.</b><p>We could not load your blocks. Your route is unchanged.</p><button type="button" onClick={() => void load()}>Try again ↗</button></section> : <div className={`a02-board a02-board--today ${state === "loading" ? "is-loading" : ""}`} aria-busy={state === "loading"}>{LANES.map((lane) => {
      const laneBlocks = visibleBlocks.filter((block) => block.status === lane.id);
      const totalInLane = blocks.filter((block) => block.status === lane.id).length;
      return <section key={lane.id} className={`a02-lane a02-today-lane a02-today-lane--${lane.id} ${dropTarget === lane.id ? "is-drop-target" : ""}`} onDragOver={(event) => { event.preventDefault(); setDropTarget(lane.id); }} onDragLeave={() => setDropTarget((current) => current === lane.id ? null : current)} onDrop={(event) => { event.preventDefault(); dropBlock(lane.id); }}><header><span>{lane.index}</span><b>{lane.label}</b><i>{state === "loading" ? "…" : laneBlocks.length === totalInLane ? totalInLane : `${laneBlocks.length}/${totalInLane}`}</i></header>{state === "loading" ? <LoadingBlocks /> : laneBlocks.length === 0 ? <p className="a02-lane-empty">{hasFilters ? "No signals match." : "Drop a signal here."}</p> : laneBlocks.map((block) => <KanbanCard key={block.id} block={block} updating={updatingId === block.id} onOpen={() => onOpenBlock(block)} onDragStart={(event) => { event.dataTransfer.effectAllowed = "move"; event.dataTransfer.setData("text/plain", block.id); setDraggedBlockId(block.id); }} onDragEnd={() => { setDraggedBlockId(null); setDropTarget(null); }} />)}</section>;
    })}</div>}
    {state === "ready" && blocks.length === 0 && <p className="a02-product-note">No blocks are scheduled for today. Add a route item to begin.</p>}
    {writeError && <p className="a02-product-write-error" role="alert">{writeError}</p>}
    {composerOpen && <CurriculumMenu hasActiveRoute={hasActiveRoute} items={menuItems} error={composerError} pickingId={pickingId} onClose={() => setComposerOpen(false)} onPick={(item) => void pickMenuItem(item)} />}
  </section>;
}

function KanbanCard({ block, updating, onOpen, onDragEnd, onDragStart }: {
  block: TodayBlock;
  updating: boolean;
  onOpen: () => void;
  onDragEnd: () => void;
  onDragStart: (event: DragEvent<HTMLElement>) => void;
}) {
  const metadata = kanbanMetadataFor(block);
  const stateLabel = block.status === "backlog" ? "BACKLOG" : block.status === "in_progress" ? "IN MOTION" : block.status === "done" ? "CLOSED" : "READY";
  return <article className={`a02-work-unit a02-live-block ${block.claimed || block.status === "in_progress" ? "is-claimed" : ""}`} key={block.id} aria-busy={updating} draggable={!updating} onDragStart={onDragStart} onDragEnd={onDragEnd}>
    <div className="a02-card-signal"><em>{stateLabel}</em><span className={`a02-priority a02-priority--${metadata.priority}`}>{priorityLabel(metadata.priority)}</span></div>
    <button type="button" className="a02-work-open" onClick={onOpen}><strong>{block.text}</strong></button>
    <div className="a02-card-footer"><small>{roughDuration(block.elapsed_seconds) ?? (block.notes?.trim() || "Personal route")}</small><span className="a02-card-estimate">{metadata.estimatedMinutes} min</span></div>
    {block.status === "in_progress" && <span className="a02-unit-pulse" aria-label="In progress" />}
    <span className="a02-drag-hint" aria-hidden="true">Drag to move</span>
  </article>;
}

function LoadingBlocks() { return <><div className="a02-work-unit a02-skeleton" /><div className="a02-work-unit a02-skeleton a02-skeleton--short" /></>; }

function CurriculumMenu({ hasActiveRoute, items, error, pickingId, onClose, onPick }: { hasActiveRoute: boolean; items: CurriculumMenuItem[]; error: string | null; pickingId: string | null; onClose: () => void; onPick: (item: CurriculumMenuItem) => void }) {
  return <section className="a02-record-overlay" role="dialog" aria-modal="true" aria-labelledby="route-menu-title"><section className="a02-composer"><button className="a02-lens-close" type="button" onClick={onClose}>ESC / close ×</button><span className="a02-eyebrow">TODAY / ROUTE MENU</span><h2 id="route-menu-title">Choose the<br /><em>next piece.</em></h2>{items.length > 0 ? <div className="a02-curriculum-menu">{items.map((item) => <button className="a02-curriculum-item" type="button" key={item.curriculum_item_id} onClick={() => onPick(item)} disabled={Boolean(pickingId)}><span>{item.category_label}</span><b>{item.task}</b>{menuPreview(item.meta) && <small>{menuPreview(item.meta)}</small>}<i>{pickingId === item.curriculum_item_id ? "Adding…" : "Add ↗"}</i></button>)}</div> : <p className="a02-composer-empty">{hasActiveRoute ? "Your route menu is clear for now. Time for a check-in before you extend it." : "Set up your route first, then return here for its first useful piece."}</p>}{error && <p className="a02-composer-error" role="alert">{error}</p>}<div className="a02-composer-actions"><button type="button" onClick={onClose}>Cancel</button></div></section></section>;
}
