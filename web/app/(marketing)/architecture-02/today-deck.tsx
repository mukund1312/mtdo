"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { recordEvent } from "@/lib/analytics/record-event";
import { createClient } from "@/lib/supabase/client";
import type { Database } from "@/lib/supabase/database.types";
import "./today-deck.css";

type Block = Pick<
  Database["public"]["Tables"]["blocks"]["Row"],
  "id" | "plan_id" | "category_id" | "date" | "position" | "text" | "status" | "notes" | "claimed" | "elapsed_seconds"
>;
type Category = Pick<
  Database["public"]["Tables"]["plan_categories"]["Row"],
  "id" | "label" | "name"
>;
type ActivePlan = Pick<
  Database["public"]["Tables"]["plans"]["Row"],
  "id" | "app_name" | "goal_line"
>;

const lanes = [
  { status: "todo", number: "01", title: "To do", hint: "Choose the next useful move." },
  { status: "in_progress", number: "02", title: "In progress", hint: "Protect the work already open." },
  { status: "done", number: "03", title: "Done", hint: "Visible proof of a day used well." },
] as const;

type BlockStatus = (typeof lanes)[number]["status"];

function isBlockStatus(value: string): value is BlockStatus {
  return lanes.some((lane) => lane.status === value);
}

function todayKey() {
  const now = new Date();
  const offset = now.getTimezoneOffset() * 60_000;
  return new Date(now.getTime() - offset).toISOString().slice(0, 10);
}

function displayDate(value: string) {
  return new Intl.DateTimeFormat(undefined, { weekday: "long", month: "short", day: "numeric" }).format(
    new Date(`${value}T12:00:00`),
  );
}

export function TodayDeck() {
  const date = useMemo(() => todayKey(), []);
  const configured = Boolean(process.env.NEXT_PUBLIC_SUPABASE_URL && process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY);
  const [plan, setPlan] = useState<ActivePlan | null>(null);
  const [categories, setCategories] = useState<Category[]>([]);
  const [blocks, setBlocks] = useState<Block[]>([]);
  const [loading, setLoading] = useState(true);
  const [notice, setNotice] = useState<string | null>(null);
  const [draggedId, setDraggedId] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState("");
  const [categoryId, setCategoryId] = useState("");

  const loadToday = useCallback(async () => {
    if (!configured) {
      setNotice("Connect Supabase to load and save today’s blocks.");
      setLoading(false);
      return;
    }

    setLoading(true);
    setNotice(null);
    const supabase = createClient();
    const { data: activePlan, error: planError } = await supabase
      .from("plans")
      .select("id, app_name, goal_line")
      .eq("is_active", true)
      .maybeSingle();

    if (planError) {
      setNotice(planError.message);
      setLoading(false);
      return;
    }
    if (!activePlan) {
      setPlan(null);
      setCategories([]);
      setBlocks([]);
      setLoading(false);
      return;
    }

    const [{ data: planCategories, error: categoryError }, { data: todayBlocks, error: blocksError }] = await Promise.all([
      supabase.from("plan_categories").select("id, label, name").eq("plan_id", activePlan.id).order("sort_order"),
      supabase
        .from("blocks")
        .select("id, plan_id, category_id, date, position, text, status, notes, claimed, elapsed_seconds")
        .eq("plan_id", activePlan.id)
        .eq("date", date)
        .order("position"),
    ]);

    if (categoryError || blocksError) {
      setNotice(categoryError?.message ?? blocksError?.message ?? "Today could not be loaded.");
      setLoading(false);
      return;
    }

    setPlan(activePlan as ActivePlan);
    setCategories((planCategories ?? []) as Category[]);
    setBlocks((todayBlocks ?? []) as Block[]);
    setCategoryId((current) => current || planCategories?.[0]?.id || "");
    setLoading(false);
  }, [configured, date]);

  useEffect(() => {
    // Defer the first read one task so React can commit the loading shell
    // before the request settles (and so a local no-config state is not a
    // synchronous effect-driven render cascade).
    const loadTimer = window.setTimeout(() => void loadToday(), 0);
    return () => window.clearTimeout(loadTimer);
  }, [loadToday]);

  const changeStatus = async (block: Block, status: BlockStatus) => {
    if (block.status === status || !configured) return;
    const previous = blocks;
    setBlocks((items) => items.map((item) => (item.id === block.id ? { ...item, status } : item)));
    setNotice(null);

    const supabase = createClient();
    const { error } = await supabase.from("blocks").update({ status }).eq("id", block.id);
    if (error) {
      setBlocks(previous);
      setNotice(`Couldn’t move “${block.text}”: ${error.message}`);
      return;
    }
    if (status === "done" && block.status !== "done") {
      void recordEvent(supabase, "task_completed", { blockId: block.id, date });
    } else if (status !== "done" && block.status === "done") {
      void recordEvent(supabase, "task_regressed", { blockId: block.id, date });
    }
  };

  const addBlock = async () => {
    const text = draft.trim();
    if (!plan || !categoryId || !text || !configured) return;
    const position = blocks.filter((block) => block.category_id === categoryId).reduce((highest, block) => Math.max(highest, block.position), -1) + 1;
    const supabase = createClient();
    const {
      data: { user },
      error: userError,
    } = await supabase.auth.getUser();
    if (userError || !user) {
      setNotice("Your session is not ready yet. Refresh the page and try again.");
      return;
    }
    const { data, error } = await supabase
      .from("blocks")
      .insert({ user_id: user.id, plan_id: plan.id, category_id: categoryId, date, position, text, status: "todo" })
      .select("id, plan_id, category_id, date, position, text, status, notes, claimed, elapsed_seconds")
      .single();
    if (error || !data) {
      setNotice(error?.message ?? "Couldn’t create that block.");
      return;
    }
    setBlocks((items) => [...items, data as Block]);
    setDraft("");
    setAdding(false);
  };

  const categoryName = (id: string) => categories.find((category) => category.id === id)?.label ?? "Route block";

  return (
    <section className="a02-work a02-today" aria-label="Today’s blocks">
      <div className="a02-view-head">
        <div>
          <span className="a02-eyebrow">TODAY / {displayDate(date).toUpperCase()}</span>
          <h1>Keep the<br /><em>signal</em> moving.</h1>
          <p className="a02-today-goal">{plan?.goal_line ?? "Your next small commitment belongs here."}</p>
        </div>
        <div className="a02-view-controls">
          <button type="button" onClick={() => void loadToday()} disabled={loading}>↻ Refresh</button>
          {plan && <button type="button" className="a02-add" onClick={() => setAdding(true)}>+ Add block</button>}
        </div>
      </div>

      {notice && <p className="a02-today-notice" role="status">{notice}</p>}
      {!loading && !plan && configured && (
        <section className="a02-today-empty"><span>NO ACTIVE ROUTE</span><h2>Build a route<br />before today begins.</h2><p>Complete route setup once and MTDO can hold your daily work here.</p><a href="/architecture-02/onboarding">Set up your route ↗</a></section>
      )}
      {loading && <section className="a02-today-loading" aria-live="polite"><i /> Reading today’s blocks…</section>}
      {!loading && plan && (
        <>
          {adding && <section className="a02-add-block" aria-label="Add a block">
            <label>NEW BLOCK<input autoFocus value={draft} onChange={(event) => setDraft(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") void addBlock(); }} placeholder="What needs your attention?" /></label>
            <label>ROUTE AREA<select value={categoryId} onChange={(event) => setCategoryId(event.target.value)}>{categories.map((category) => <option key={category.id} value={category.id}>{category.label}</option>)}</select></label>
            <button type="button" onClick={() => void addBlock()} disabled={!draft.trim() || !categoryId}>Add to to do</button>
            <button type="button" className="a02-quiet-button" onClick={() => setAdding(false)}>Cancel</button>
          </section>}
          <div className="a02-today-planline"><span>ACTIVE ROUTE</span><b>{plan.app_name}</b><i>{blocks.length} blocks / today</i></div>
          <div className="a02-board a02-today-board">
            {lanes.map((lane) => {
              const laneBlocks = blocks.filter((block) => block.status === lane.status);
              return <section className={`a02-lane a02-today-lane lane-${lane.status}`} key={lane.status} onDragOver={(event) => event.preventDefault()} onDrop={() => {
                const block = blocks.find((item) => item.id === draggedId);
                if (block) void changeStatus(block, lane.status);
                setDraggedId(null);
              }}>
                <header><span>{lane.number}</span><div><b>{lane.title}</b><small>{lane.hint}</small></div><i>{laneBlocks.length}</i></header>
                <div className="a02-lane-body">
                  {laneBlocks.map((block) => <article className="a02-work-unit a02-today-unit" key={block.id} draggable onDragStart={() => setDraggedId(block.id)} onDragEnd={() => setDraggedId(null)}>
                    <em>{categoryName(block.category_id)}</em><strong>{block.text}</strong>
                    {block.notes && <small>{block.notes}</small>}
                    <footer><span>{block.elapsed_seconds ? `${Math.round(block.elapsed_seconds / 60)} MIN LOGGED` : "NOT STARTED"}</span><select value={isBlockStatus(block.status) ? block.status : "todo"} aria-label={`Move ${block.text}`} onChange={(event) => void changeStatus(block, event.target.value as BlockStatus)}>{lanes.map((option) => <option key={option.status} value={option.status}>{option.title}</option>)}</select></footer>
                  </article>)}
                  {laneBlocks.length === 0 && <p className="a02-lane-empty">Drop a block here</p>}
                </div>
              </section>;
            })}
          </div>
        </>
      )}
    </section>
  );
}
