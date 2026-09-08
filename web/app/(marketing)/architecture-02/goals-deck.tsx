"use client";

import { useCallback, useEffect, useState } from "react";

import { createClient } from "@/lib/supabase/client";

type Goal = {
  id: string;
  label: string;
  minBlocks: number;
  sortOrder: number;
};

type GoalsState = "loading" | "ready" | "error";

export function GoalsDeck() {
  const [state, setState] = useState<GoalsState>("loading");
  const [goalLine, setGoalLine] = useState<string | null>(null);
  const [goals, setGoals] = useState<Goal[]>([]);

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
      setGoalLine(null);
      setGoals([]);
      setState("ready");
      return;
    }

    const { data: categories, error: categoryError } = await supabase
      .from("plan_categories")
      .select("id, label, min_blocks, sort_order")
      .eq("plan_id", plan.id)
      .order("sort_order");
    if (categoryError) {
      console.error("[goals] failed to load route goals:", categoryError);
      setState("error");
      return;
    }

    setGoalLine(plan.goal_line);
    setGoals((categories ?? []).map((category) => ({
      id: category.id,
      label: category.label,
      minBlocks: category.min_blocks,
      sortOrder: category.sort_order,
    })));
    setState("ready");
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(timer);
  }, [load]);

  return <section className="a02-goals" aria-labelledby="goals-title">
    <div className="a02-view-head">
      <div>
        <span className="a02-eyebrow">ROUTE / GOALS</span>
        <h1 id="goals-title">Hold the<br /><em>line.</em></h1>
      </div>
      <div className="a02-view-controls"><a className="a02-goals-import-export" href="/architecture-02/onboarding/import">Import / Export ↗</a><button type="button" onClick={() => void load()} disabled={state === "loading"}>Refresh</button></div>
    </div>

    {state === "loading" && <section className="a02-goals-state" aria-busy="true"><span className="a02-goals-orbit" /><b>Reading your route…</b><p>Finding the commitments that shape this plan.</p></section>}
    {state === "error" && <section className="a02-product-state" role="alert"><b>Goals are unavailable.</b><p>We could not read your active route. Your plan is unchanged.</p><button type="button" onClick={() => void load()}>Try again ↗</button></section>}
    {state === "ready" && !goalLine && <section className="a02-product-state"><b>No active goal yet.</b><p>Set up a route, then its goals will stay visible here.</p><a href="/architecture-02/onboarding">Set up your route ↗</a></section>}
    {state === "ready" && goalLine && <div className="a02-goals-grid">
      <section className="a02-goal-line"><span className="a02-eyebrow">ACTIVE DIRECTION</span><strong>{goalLine}</strong><p>Your route creates these commitments. Goal edits arrive with the plan tools; nothing is fabricated here.</p></section>
      <section className="a02-goal-list" aria-label="Active route goals"><header><span>GOALS IN THIS ROUTE</span><i>{goals.length}</i></header>{goals.length > 0 ? goals.map((goal) => <article key={goal.id}><span>{String(goal.sortOrder + 1).padStart(2, "0")}</span><b>{goal.label}</b><small>{goal.minBlocks} {goal.minBlocks === 1 ? "block" : "blocks"} / route</small></article>) : <p className="a02-goal-list-empty">This route has no goals to show yet.</p>}</section>
    </div>}
  </section>;
}
