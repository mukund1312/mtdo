"use client";

import { useCallback, useEffect, useState } from "react";

import { recordEvent } from "@/lib/analytics/record-event";
import { createClient } from "@/lib/supabase/client";

import { utcToday } from "./product-data";

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

type RouteCategory = { id: string; label: string };
type ActiveRoute = { categories: RouteCategory[]; planId: string };
type Draft = { categoryId: string; notes: string; status: BlockStatus; text: string };

const LANES: Array<{ id: BlockStatus; label: string; index: string }> = [
  { id: "backlog", label: "Backlog", index: "01" },
  { id: "todo", label: "Todo", index: "02" },
  { id: "in_progress", label: "In progress", index: "03" },
  { id: "done", label: "Done", index: "04" },
];

function isBlockStatus(value: string): value is BlockStatus {
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

export function TodayDeck({ onOpenBlock }: { onOpenBlock: (block: TodayBlock) => void }) {
  const [blocks, setBlocks] = useState<TodayBlock[]>([]);
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");
  const [updatingId, setUpdatingId] = useState<string | null>(null);
  const [writeError, setWriteError] = useState<string | null>(null);
  const [route, setRoute] = useState<ActiveRoute | null>(null);
  const [composerOpen, setComposerOpen] = useState(false);
  const [composerError, setComposerError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [draft, setDraft] = useState<Draft>({ categoryId: "", notes: "", status: "todo", text: "" });
  const [draggedBlockId, setDraggedBlockId] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<BlockStatus | null>(null);

  const load = useCallback(async () => {
    setState("loading");
    const supabase = createClient();
    const { data: { user }, error: userError } = await supabase.auth.getUser();
    if (userError || !user) {
      setState("error");
      return;
    }

    const { data: activePlan, error: planError } = await supabase
      .from("plans").select("id").eq("user_id", user.id).eq("is_active", true).maybeSingle();
    if (planError) console.error("[today] failed to load active route:", planError);
    if (activePlan) {
      const { data: categories, error: categoryError } = await supabase
        .from("plan_categories").select("id, label").eq("plan_id", activePlan.id).order("sort_order");
      if (categoryError) console.error("[today] failed to load route categories:", categoryError);
      setRoute({ categories: categories ?? [], planId: activePlan.id });
    } else {
      setRoute(null);
    }

    const { data, error } = await supabase
      .from("blocks")
      .select("id, text, status, notes, claimed, elapsed_seconds, position")
      .eq("user_id", user.id).eq("date", utcToday()).order("position");
    if (error) {
      console.error("[today] failed to load blocks:", error);
      setState("error");
      return;
    }
    setBlocks((data ?? []).flatMap((block) => isBlockStatus(block.status) ? [{ ...block, status: block.status }] : []));
    setState("ready");
  }, []);

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
    setDraft({ categoryId: route?.categories[0]?.id ?? "", notes: "", status: "todo", text: "" });
    setComposerOpen(true);
  };

  const createBlock = async () => {
    if (creating) return;
    if (!route || !draft.categoryId || !draft.text.trim()) {
      setComposerError(route ? "Give the signal a name and choose its route category." : "Set up a route with a category before adding a signal.");
      return;
    }
    setCreating(true);
    setComposerError(null);
    const supabase = createClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) {
      setComposerError("Your session is unavailable. Refresh and try again.");
      setCreating(false);
      return;
    }
    const date = utcToday();
    const { data: positioned, error: positionError } = await supabase.from("blocks").select("position")
      .eq("user_id", user.id).eq("category_id", draft.categoryId).eq("date", date).order("position", { ascending: false }).limit(1);
    if (positionError) {
      setComposerError("We could not prepare a place for this signal. Try again.");
      setCreating(false);
      return;
    }
    const { data, error } = await supabase.from("blocks").insert({
      category_id: draft.categoryId,
      claimed: draft.status === "in_progress",
      date,
      notes: draft.notes.trim() || null,
      plan_id: route.planId,
      position: (positioned?.[0]?.position ?? -1) + 1,
      status: draft.status,
      text: draft.text.trim(),
      user_id: user.id,
    }).select("id, text, status, notes, claimed, elapsed_seconds, position").single();
    if (error || !data || !isBlockStatus(data.status)) {
      console.error("[today] failed to create block:", databaseErrorMessage(error, "No row returned."));
      setComposerError(databaseErrorMessage(error, "We could not save that signal. Your route is unchanged."));
      setCreating(false);
      return;
    }
    const createdBlock: TodayBlock = { ...data, status: data.status };
    setBlocks((current) => [...current, createdBlock].sort((a, b) => a.position - b.position));
    setComposerOpen(false);
    setCreating(false);
  };

  return <section className="a02-work" aria-labelledby="today-title">
    <div className="a02-view-head"><div><span className="a02-eyebrow">TODAY / FLOW MAP</span><h1 id="today-title">Move the<br /><em>right pieces.</em></h1></div><div className="a02-view-controls"><button type="button" onClick={() => void load()}>Refresh</button><button type="button" disabled>Today / UTC</button><button className="a02-add" type="button" onClick={openComposer}>+ New signal</button></div></div>
    {state === "error" ? <section className="a02-product-state" role="alert"><b>Today is unavailable.</b><p>We could not load your blocks. Your route is unchanged.</p><button type="button" onClick={() => void load()}>Try again ↗</button></section> : <div className={`a02-board a02-board--today ${state === "loading" ? "is-loading" : ""}`} aria-busy={state === "loading"}>{LANES.map((lane) => {
      const laneBlocks = blocks.filter((block) => block.status === lane.id);
      return <section key={lane.id} className={`a02-lane a02-today-lane a02-today-lane--${lane.id} ${dropTarget === lane.id ? "is-drop-target" : ""}`} onDragOver={(event) => { event.preventDefault(); setDropTarget(lane.id); }} onDragLeave={() => setDropTarget((current) => current === lane.id ? null : current)} onDrop={(event) => { event.preventDefault(); dropBlock(lane.id); }}><header><span>{lane.index}</span><b>{lane.label}</b><i>{state === "loading" ? "…" : laneBlocks.length}</i></header>{state === "loading" ? <LoadingBlocks /> : laneBlocks.length === 0 ? <p className="a02-lane-empty">Drop a signal here.</p> : laneBlocks.map((block) => <article className={`a02-work-unit a02-live-block ${block.claimed || block.status === "in_progress" ? "is-claimed" : ""}`} key={block.id} aria-busy={updatingId === block.id} draggable={updatingId !== block.id} onDragStart={(event) => { event.dataTransfer.effectAllowed = "move"; event.dataTransfer.setData("text/plain", block.id); setDraggedBlockId(block.id); }} onDragEnd={() => { setDraggedBlockId(null); setDropTarget(null); }}><em>{block.status === "backlog" ? "BACKLOG" : block.status === "in_progress" ? "IN MOTION" : block.status === "done" ? "CLOSED" : "READY"}</em><button type="button" className="a02-work-open" onClick={() => onOpenBlock(block)}><strong>{block.text}</strong></button><small>{roughDuration(block.elapsed_seconds) ?? (block.notes?.trim() || "Personal route")}</small>{block.status === "in_progress" && <span className="a02-unit-pulse" aria-label="In progress" />}<span className="a02-drag-hint" aria-hidden="true">Drag to move</span></article>)}</section>;
    })}</div>}
    {state === "ready" && blocks.length === 0 && <p className="a02-product-note">No blocks are scheduled for today. Add a signal to begin your route.</p>}
    {writeError && <p className="a02-product-write-error" role="alert">{writeError}</p>}
    {composerOpen && <BlockComposer categories={route?.categories ?? []} draft={draft} error={composerError} creating={creating} onChange={setDraft} onClose={() => setComposerOpen(false)} onCreate={() => void createBlock()} />}
  </section>;
}

function LoadingBlocks() { return <><div className="a02-work-unit a02-skeleton" /><div className="a02-work-unit a02-skeleton a02-skeleton--short" /></>; }

function BlockComposer({ categories, draft, error, creating, onChange, onClose, onCreate }: { categories: RouteCategory[]; draft: Draft; error: string | null; creating: boolean; onChange: (next: Draft) => void; onClose: () => void; onCreate: () => void }) {
  return <section className="a02-record-overlay" role="dialog" aria-modal="true" aria-labelledby="new-signal-title"><form className="a02-composer" onSubmit={(event) => { event.preventDefault(); onCreate(); }}><button className="a02-lens-close" type="button" onClick={onClose}>ESC / close ×</button><span className="a02-eyebrow">TODAY / NEW SIGNAL</span><h2 id="new-signal-title">Add the next<br /><em>right piece.</em></h2>{categories.length > 0 ? <><label>Signal name<input autoFocus value={draft.text} onChange={(event) => onChange({ ...draft, text: event.target.value })} placeholder="What needs your attention?" /></label><label>Route category<select value={draft.categoryId} onChange={(event) => onChange({ ...draft, categoryId: event.target.value })}>{categories.map((category) => <option key={category.id} value={category.id}>{category.label}</option>)}</select></label><label>Place it in<select value={draft.status} onChange={(event) => onChange({ ...draft, status: event.target.value as BlockStatus })}><option value="backlog">Backlog</option><option value="todo">Todo</option><option value="in_progress">In progress</option><option value="done">Done</option></select></label><label>Context <small>optional</small><textarea value={draft.notes} onChange={(event) => onChange({ ...draft, notes: event.target.value })} placeholder="What would make this block useful?" /></label></> : <p className="a02-composer-empty">Create your route first, then return here to add its first signal.</p>}{error && <p className="a02-composer-error" role="alert">{error}</p>}<div className="a02-composer-actions"><button type="button" onClick={onClose}>Cancel</button>{categories.length > 0 && <button className="a02-add" type="submit" disabled={creating}>{creating ? "Saving…" : "Add signal ↗"}</button>}</div></form></section>;
}
