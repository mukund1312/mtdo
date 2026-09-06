"use client";

import { useCallback, useEffect, useState } from "react";

import { recordEvent } from "@/lib/analytics/record-event";
import { createClient } from "@/lib/supabase/client";

import { utcToday } from "./product-data";

export type BlockStatus = "todo" | "in_progress" | "done";

export type TodayBlock = {
  claimed: boolean;
  elapsed_seconds: number;
  id: string;
  notes: string | null;
  position: number;
  status: BlockStatus;
  text: string;
};

const LANES: Array<{ id: BlockStatus; label: string; index: string }> = [
  { id: "todo", label: "Todo", index: "01" },
  { id: "in_progress", label: "In progress", index: "02" },
  { id: "done", label: "Done", index: "03" },
];

function isBlockStatus(value: string): value is BlockStatus {
  return value === "todo" || value === "in_progress" || value === "done";
}

function roughDuration(seconds: number): string | null {
  if (seconds <= 0) return null;
  return `${Math.max(1, Math.round(seconds / 60))} min logged`;
}

export function TodayDeck({ onOpenBlock }: { onOpenBlock: (block: TodayBlock) => void }) {
  const [blocks, setBlocks] = useState<TodayBlock[]>([]);
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");
  const [updatingId, setUpdatingId] = useState<string | null>(null);

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

    const { data, error } = await supabase
      .from("blocks")
      .select("id, text, status, notes, claimed, elapsed_seconds, position")
      .eq("user_id", user.id)
      .eq("date", utcToday())
      .order("position", { ascending: true });

    if (error) {
      console.error("[today] failed to load blocks:", error);
      setState("error");
      return;
    }

    setBlocks(
      (data ?? []).flatMap((block) =>
        isBlockStatus(block.status)
          ? [
              {
                claimed: block.claimed,
                elapsed_seconds: block.elapsed_seconds,
                id: block.id,
                notes: block.notes,
                position: block.position,
                status: block.status,
                text: block.text,
              },
            ]
          : [],
      ),
    );
    setState("ready");
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(timer);
  }, [load]);

  const moveBlock = useCallback(
    async (block: TodayBlock, nextStatus: BlockStatus) => {
      if (block.status === nextStatus || updatingId) return;
      setUpdatingId(block.id);
      const supabase = createClient();
      const { error } = await supabase
        .from("blocks")
        .update({ claimed: nextStatus === "in_progress", status: nextStatus })
        .eq("id", block.id);

      if (error) {
        console.error("[today] failed to update block:", error);
        setUpdatingId(null);
        return;
      }

      setBlocks((current) =>
        current.map((item) =>
          item.id === block.id
            ? { ...item, claimed: nextStatus === "in_progress", status: nextStatus }
            : item,
        ),
      );

      if (nextStatus === "done") {
        void recordEvent(supabase, "task_completed", { block_id: block.id });
      } else if (block.status === "done") {
        void recordEvent(supabase, "task_regressed", { block_id: block.id });
      }
      setUpdatingId(null);
    },
    [updatingId],
  );

  return (
    <section className="a02-work" aria-labelledby="today-title">
      <div className="a02-view-head">
        <div>
          <span className="a02-eyebrow">TODAY / FLOW MAP</span>
          <h1 id="today-title">Move the<br /><em>right pieces.</em></h1>
        </div>
        <div className="a02-view-controls"><button type="button" onClick={() => void load()}>Refresh</button><button type="button" disabled>Today / UTC</button></div>
      </div>

      {state === "error" ? (
        <section className="a02-product-state" role="alert">
          <b>Today is unavailable.</b>
          <p>We could not load your blocks. Your route is unchanged.</p>
          <button type="button" onClick={() => void load()}>Try again ↗</button>
        </section>
      ) : (
        <div className={`a02-board a02-board--today ${state === "loading" ? "is-loading" : ""}`} aria-busy={state === "loading"}>
          {LANES.map((lane) => {
            const laneBlocks = blocks.filter((block) => block.status === lane.id);
            return (
              <section key={lane.id} className={`a02-lane a02-today-lane a02-today-lane--${lane.id}`}>
                <header><span>{lane.index}</span><b>{lane.label}</b><i>{state === "loading" ? "…" : laneBlocks.length}</i></header>
                {state === "loading" ? <LoadingBlocks /> : laneBlocks.length === 0 ? <p className="a02-lane-empty">No blocks here yet.</p> : laneBlocks.map((block) => (
                  <article className={`a02-work-unit a02-live-block ${block.claimed || block.status === "in_progress" ? "is-claimed" : ""}`} key={block.id} aria-busy={updatingId === block.id}>
                    <em>{block.status === "in_progress" ? "IN MOTION" : block.status === "done" ? "CLOSED" : "READY"}</em>
                    <button type="button" className="a02-work-open" onClick={() => onOpenBlock(block)}><strong>{block.text}</strong></button>
                    <small>{roughDuration(block.elapsed_seconds) ?? (block.notes?.trim() || "Personal route")}</small>
                    {block.status === "in_progress" && <span className="a02-unit-pulse" aria-label="In progress" />}
                    <label className="a02-status-control">Move to <select value={block.status} disabled={updatingId === block.id} onChange={(event) => void moveBlock(block, event.target.value as BlockStatus)}><option value="todo">Todo</option><option value="in_progress">In progress</option><option value="done">Done</option></select></label>
                  </article>
                ))}
              </section>
            );
          })}
        </div>
      )}

      {state === "ready" && blocks.length === 0 && <p className="a02-product-note">No blocks are scheduled for today. Set up a route or return when your plan has placed its first block.</p>}
    </section>
  );
}

function LoadingBlocks() {
  return <><div className="a02-work-unit a02-skeleton" /><div className="a02-work-unit a02-skeleton a02-skeleton--short" /></>;
}
