"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

import { createClient } from "@/lib/supabase/client";

type Goal = {
  id: string;
  label: string;
  target: number;
  sortOrder: number;
  completed: number;
  scheduled: number;
};

type GoalsState = "loading" | "ready" | "error";

export function GoalsDeck({ onReview }: { onReview: () => void }) {
  const [state, setState] = useState<GoalsState>("loading");
  const [planId, setPlanId] = useState<string | null>(null);
  const [goalLine, setGoalLine] = useState<string | null>(null);
  const [goals, setGoals] = useState<Goal[]>([]);
  const [selectedGoal, setSelectedGoal] = useState<Goal | null>(null);
  const [addingGoal, setAddingGoal] = useState(false);
  const [newGoalName, setNewGoalName] = useState("");
  const [newGoalTarget, setNewGoalTarget] = useState("1");
  const [addGoalError, setAddGoalError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setState("loading");
    const supabase = createClient();
    const { data: { user }, error: userError } = await supabase.auth.getUser();
    if (userError || !user) {
      setState("error");
      return;
    }

    const { data: plan, error: planError } = await supabase
      .from("plans")
      .select("id, goal_line")
      .eq("user_id", user.id)
      .eq("is_active", true)
      .maybeSingle();

    if (planError) {
      console.error("[goals] failed to load active route:", planError);
      setState("error");
      return;
    }

    if (!plan) {
      setPlanId(null);
      setGoalLine(null);
      setGoals([]);
      setState("ready");
      return;
    }

    const weekStart = new Date();
    weekStart.setHours(0, 0, 0, 0);
    weekStart.setDate(weekStart.getDate() - ((weekStart.getDay() + 6) % 7));
    const weekEnd = new Date(weekStart);
    weekEnd.setDate(weekEnd.getDate() + 7);
    const [{ data: categories, error: categoryError }, { data: blocks, error: blocksError }] = await Promise.all([
      supabase
      .from("plan_categories")
      .select("id, label, min_blocks, weekly_target_blocks, sort_order")
      .eq("plan_id", plan.id)
      .order("sort_order"),
      supabase.from("blocks").select("category_id, status, scheduled_start_at, date").eq("plan_id", plan.id).gte("date", weekStart.toISOString().slice(0, 10)).lt("date", weekEnd.toISOString().slice(0, 10)),
    ]);
    if (categoryError || blocksError) {
      console.error("[goals] failed to load route goals:", categoryError);
      setState("error");
      return;
    }

    setPlanId(plan.id);
    setGoalLine(plan.goal_line);
    setGoals((categories ?? []).map((category) => {
      const categoryBlocks = (blocks ?? []).filter((block) => block.category_id === category.id);
      return {
      id: category.id,
      label: category.label,
      target: category.weekly_target_blocks ?? category.min_blocks,
      sortOrder: category.sort_order,
      completed: categoryBlocks.filter((block) => block.status === "done").length,
      scheduled: categoryBlocks.filter((block) => Boolean(block.scheduled_start_at)).length,
    }; }));
    setState("ready");
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(timer);
  }, [load]);

  const direction = useMemo(() => {
    if (!goalLine) return { title: "", support: "" };
    const [title, support] = goalLine.split(/\s+while\s+/i, 2);
    return { title: (title ?? "").replace(/[.]$/, ""), support: support ? `${support.charAt(0).toUpperCase()}${support.slice(1)}` : "Build the work and routine that make this direction sustainable." };
  }, [goalLine]);
  const completedBlocks = goals.reduce((total, goal) => total + goal.completed, 0);
  const scheduledBlocks = goals.reduce((total, goal) => total + goal.scheduled, 0);
  const onTrackGoals = goals.filter((goal) => goal.completed >= goal.target).length;

  const addGoal = async () => {
    const label = newGoalName.trim();
    const target = Number.parseInt(newGoalTarget, 10);
    if (!planId || !label || !Number.isFinite(target) || target < 1) {
      setAddGoalError("Give this goal a name and a weekly target of at least one block.");
      return;
    }
    setAddGoalError(null);
    const supabase = createClient();
    const { error } = await supabase.from("plan_categories").insert({
      plan_id: planId,
      label,
      name: label,
      min_blocks: target,
      weekly_target_blocks: target,
      sort_order: goals.length,
    });
    if (error) {
      console.error("[goals] failed to add goal:", error);
      setAddGoalError("This goal could not be added. Try again.");
      return;
    }
    setAddingGoal(false);
    setNewGoalName("");
    setNewGoalTarget("1");
    void load();
  };

  return <section className="a02-goals" aria-labelledby="goals-title">
    <div className="a02-view-head">
      <div>
        <span className="a02-eyebrow">ROUTE / GOALS</span>
        <h1 id="goals-title">Hold the<br /><em>line.</em></h1>
      </div>
      <div className="a02-view-controls"><a className="a02-goals-import-export" href="/architecture-02/onboarding/import">⋯ Route tools</a><button type="button" onClick={() => void load()} disabled={state === "loading"}>Refresh</button></div>
    </div>

    {state === "loading" && <section className="a02-goals-state" aria-busy="true"><span className="a02-goals-orbit" /><b>Reading your route…</b><p>Finding the commitments that shape this plan.</p></section>}
    {state === "error" && <section className="a02-product-state" role="alert"><b>Goals are unavailable.</b><p>We could not read your active route. Your plan is unchanged.</p><button type="button" onClick={() => void load()}>Try again ↗</button></section>}
    {state === "ready" && !goalLine && <section className="a02-product-state"><b>No active goal yet.</b><p>Set up a route, then its goals will stay visible here.</p><a href="/architecture-02/onboarding">Set up your route ↗</a></section>}
    {state === "ready" && goalLine && <><div className="a02-goals-grid">
      <section className="a02-goal-line"><span className="a02-eyebrow">ACTIVE DIRECTION</span><strong>{direction.title}</strong><p>{direction.support}</p><div className="a02-goal-why"><span>WHY THIS ROUTE</span><b>Career transition</b><b>Technical growth</b><b>Consistent routine</b></div></section>
      <section className="a02-route-snapshot"><span>ROUTE SNAPSHOT</span><div><b>{goals.length}<small>goals active</small></b><b>{scheduledBlocks}<small>blocks this week</small></b><b>{completedBlocks}<small>completed</small></b></div><p>ROUTE HEALTH <strong className={onTrackGoals === goals.length && goals.length > 0 ? "is-on-track" : ""}>{onTrackGoals === goals.length && goals.length > 0 ? "ON TRACK" : `${goals.length - onTrackGoals} GOALS NEED ATTENTION`}</strong></p><small>Target date not set</small></section>
    </div><section className="a02-goal-list" aria-label="Active route goals"><header><span>SUPPORTING GOALS · {goals.length}</span><button type="button" onClick={() => { setAddGoalError(null); setAddingGoal(true); }}>+ Add goal</button></header>{goals.length > 0 ? goals.map((goal) => { const progress = Math.min(100, Math.round((goal.completed / Math.max(1, goal.target)) * 100)); return <button type="button" key={goal.id} onClick={() => setSelectedGoal(goal)}><span>{String(goal.sortOrder + 1).padStart(2, "0")}</span><div><b>{goal.label}</b><small>{goal.completed} / {goal.target} blocks this week</small><i><em style={{ width: `${progress}%` }} /></i></div><strong>{progress}% <i>→</i></strong></button>; }) : <p className="a02-goal-list-empty">This route has no goals to show yet.</p>}</section>
    {selectedGoal && <GoalDetail goal={selectedGoal} onClose={() => setSelectedGoal(null)} onReview={onReview} />}{addingGoal && <AddGoalDialog name={newGoalName} target={newGoalTarget} error={addGoalError} onName={setNewGoalName} onTarget={setNewGoalTarget} onClose={() => setAddingGoal(false)} onAdd={() => void addGoal()} />}</>}
  </section>;
}

function GoalDetail({ goal, onClose, onReview }: { goal: Goal; onClose: () => void; onReview: () => void }) {
  const progress = Math.min(100, Math.round((goal.completed / Math.max(1, goal.target)) * 100));
  return <section className="a02-record-overlay" role="dialog" aria-modal="true" aria-labelledby="goal-detail-title"><section className="a02-goal-detail"><button className="a02-lens-close" type="button" onClick={onClose} aria-label="Close goal details">×</button><span className="a02-eyebrow">SUPPORTING GOAL</span><h2 id="goal-detail-title">{goal.label}</h2><p>This week: {goal.completed} of {goal.target} completed.</p><div className="a02-goal-detail-progress"><i style={{ width: `${progress}%` }} /></div><small>{goal.scheduled} blocks scheduled this week · {progress}% toward current target</small><button className="a02-goal-protect" type="button" onClick={() => { onClose(); onReview(); }}>Protect this goal →</button></section></section>;
}

function AddGoalDialog({ name, target, error, onName, onTarget, onClose, onAdd }: { name: string; target: string; error: string | null; onName: (value: string) => void; onTarget: (value: string) => void; onClose: () => void; onAdd: () => void }) {
  return <section className="a02-record-overlay" role="dialog" aria-modal="true" aria-labelledby="add-goal-title"><section className="a02-goal-detail"><button className="a02-lens-close" type="button" onClick={onClose} aria-label="Close add goal">×</button><span className="a02-eyebrow">ROUTE / NEW GOAL</span><h2 id="add-goal-title">Add a goal.</h2><label className="a02-goal-field">Goal name<input autoFocus value={name} onChange={(event) => onName(event.target.value)} placeholder="e.g. System Design" /></label><label className="a02-goal-field">Weekly target <input type="number" min="1" value={target} onChange={(event) => onTarget(event.target.value)} /><small>Focus blocks per week</small></label>{error && <p className="a02-goal-form-error" role="alert">{error}</p>}<button className="a02-goal-add" type="button" onClick={onAdd}>Add goal →</button></section></section>;
}
