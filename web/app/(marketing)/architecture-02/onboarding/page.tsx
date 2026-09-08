"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";
import type { OnboardingAnswers } from "@/lib/plan-generation/types";
import { PlanningModeSelector } from "../planning-mode-selector";
import "../signal-deck.css";
import "../planning-mode-selector.css";
import "./onboarding.css";

type Step = "method" | "intent" | "rhythm" | "generating" | "complete";
type PlanSummary = { appName: string; goalLine: string; categories: Array<{ id: string; name: string; label: string }> };

const days = [[0, "MON"], [1, "TUE"], [2, "WED"], [3, "THU"], [4, "FRI"], [5, "SAT"], [6, "SUN"]] as const;
const suggestions = ["Data Structures", "SQL", "System Design", "Backend", "Interview Prep"];

export default function SignalDeckOnboardingPage() {
  const router = useRouter();
  const [step, setStep] = useState<Step>("method");
  const [goalLine, setGoalLine] = useState("");
  const [appName, setAppName] = useState("");
  const [notes, setNotes] = useState("");
  const [focusAreas, setFocusAreas] = useState<string[]>([]);
  const [areaDraft, setAreaDraft] = useState("");
  const [experienceLevel, setExperienceLevel] = useState<OnboardingAnswers["experienceLevel"]>("intermediate");
  const [weeklyDaysAvailable, setWeeklyDaysAvailable] = useState<number[]>([0, 1, 2, 3, 4]);
  const [status, setStatus] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [plan, setPlan] = useState<PlanSummary | null>(null);
  const canContinue = useMemo(() => goalLine.trim().length > 4 && focusAreas.length > 0, [focusAreas.length, goalLine]);

  const addFocusArea = (value: string) => {
    const next = value.trim();
    if (!next || focusAreas.length >= 6 || focusAreas.some((area) => area.toLowerCase() === next.toLowerCase())) return;
    setFocusAreas((areas) => [...areas, next]);
    setAreaDraft("");
  };

  const toggleDay = (day: number) => setWeeklyDaysAvailable((selected) => selected.includes(day)
    ? selected.filter((value) => value !== day)
    : [...selected, day].sort((a, b) => a - b));

  const generatePlan = async () => {
    if (weeklyDaysAvailable.length === 0) {
      setError("Choose at least one day when you can realistically show up.");
      return;
    }
    setError(null);
    setStatus("Reading your route signal…");
    setStep("generating");
    const payload: OnboardingAnswers = { goalLine: goalLine.trim(), focusAreas, experienceLevel, weeklyDaysAvailable, ...(appName.trim() ? { appName: appName.trim() } : {}), ...(notes.trim() ? { notes: notes.trim() } : {}) };

    try {
      const response = await fetch("/api/onboarding/plan", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
      if (!response.ok || !response.body) {
        const body = await response.json().catch(() => null) as { error?: string } | null;
        throw new Error(body?.error ?? "We couldn't start plan generation. Try again.");
      }
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let complete = false;
      let receivedPlan = false;
      while (!complete) {
        const { done, value } = await reader.read();
        buffer += decoder.decode(value ?? new Uint8Array(), { stream: !done });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) {
          if (!line.trim()) continue;
          const event = JSON.parse(line) as { type: "delta"; text: string } | { type: "done"; usedFallback: boolean; plan: PlanSummary } | { type: "error"; message: string };
          if (event.type === "delta") setStatus(event.text.trim() || "Mapping your next useful steps…");
          if (event.type === "done") {
            setPlan(event.plan);
            try {
              window.localStorage.setItem("mtdo-active-plan", JSON.stringify(event.plan));
            } catch {
              // The persisted Supabase plan is authoritative; this local
              // convenience cache must not block a successful first run.
            }
            setStatus(event.usedFallback ? "Your starter route is ready." : "Your route is ready.");
            setStep("complete");
            complete = true;
            receivedPlan = true;
          }
          if (event.type === "error") throw new Error(event.message);
        }
        if (done) complete = true;
      }
      if (!receivedPlan) throw new Error("Plan generation ended before a route was returned. Please try again.");
    } catch (generationError) {
      setError(generationError instanceof Error ? generationError.message : "We couldn't build your route. Try again.");
      setStep("rhythm");
    }
  };

  return <main className="a02-shell a02-onboarding-shell">
    <div className="a02-grid-glow" />
    <header className="a02-onboarding-header"><Link href="/architecture-02" className="a02-wordmark">mtdo<span>◒</span></Link><span>ROUTE SETUP / FREE</span><Link href="/architecture-02">Exit setup ×</Link></header>
    <section className="a02-onboarding-layout">
      <aside className="a02-onboarding-aside"><span className="a02-eyebrow">SIGNAL DECK / FIRST RUN</span><h1>Give your<br /><em>effort</em><br />a route.</h1><p>MTDO turns one serious goal into a small, workable rhythm. No streak theater. Just the next useful move.</p><ol><li className={step === "intent" ? "is-current" : ""}><i>01</i><span>Intent</span></li><li className={step === "rhythm" ? "is-current" : ""}><i>02</i><span>Rhythm</span></li><li className={step === "generating" || step === "complete" ? "is-current" : ""}><i>03</i><span>Route</span></li></ol></aside>
      <section className="a02-onboarding-panel" aria-live="polite">
        {step === "method" && <section className="a02-onboarding-step">
          <span className="a02-eyebrow">CHOOSE YOUR PATH</span>
          <h2>How do you<br /><em>want to start?</em></h2>
          <p>Three ways to get a route on the board -- pick whichever fits.</p>
          <div className="a02-method-options">
            <button type="button" className="a02-method-option" onClick={() => setStep("intent")}>
              <b>Guided AI</b>
              <p>Answer a few questions; a personalized route is generated for you.</p>
              <i>Recommended ↗</i>
            </button>
            <button type="button" className="a02-method-option" onClick={() => router.push("/architecture-02/onboarding/manual")}>
              <b>Manual setup</b>
              <p>Build your own goals, subjects, and tasks by hand.</p>
              <i>Full control ↗</i>
            </button>
            <button type="button" className="a02-method-option" onClick={() => router.push("/architecture-02/onboarding/import")}>
              <b>Import a plan</b>
              <p>Paste or upload an existing mtdo.plan.v1 JSON file.</p>
              <i>From a file ↗</i>
            </button>
          </div>
        </section>}
        {step === "intent" && <section className="a02-onboarding-step"><span className="a02-eyebrow">01 / DEFINE THE SIGNAL</span><h2>What are you<br />working toward?</h2><p>Be specific enough that a good next step can exist.</p><label>YOUR GOAL<textarea value={goalLine} onChange={(event) => setGoalLine(event.target.value)} autoFocus placeholder="e.g. Prepare for software engineering interviews by December" /></label><label>FOCUS AREAS <span>UP TO 6</span><div className="a02-chip-field"><input value={areaDraft} onChange={(event) => setAreaDraft(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); addFocusArea(areaDraft); } }} placeholder="Add a subject or skill" /><button type="button" onClick={() => addFocusArea(areaDraft)}>Add</button></div></label><div className="a02-chip-list">{focusAreas.map((area) => <button type="button" key={area} onClick={() => setFocusAreas((areas) => areas.filter((item) => item !== area))}>{area} <i>×</i></button>)}</div><div className="a02-suggestions">{suggestions.map((suggestion) => <button type="button" key={suggestion} onClick={() => addFocusArea(suggestion)}>+ {suggestion}</button>)}</div><button type="button" className="a02-onboarding-primary" disabled={!canContinue} onClick={() => setStep("rhythm")}>Set the rhythm <i>→</i></button></section>}
        {step === "rhythm" && <section className="a02-onboarding-step"><span className="a02-eyebrow">02 / SET THE RHYTHM</span><h2>Build for the<br />week you have.</h2><p>A small honest route will beat an ambitious one you cannot return to.</p><fieldset><legend>YOUR CURRENT LEVEL</legend><div className="a02-level-options">{(["beginner", "intermediate", "advanced"] as const).map((level) => <button type="button" className={experienceLevel === level ? "is-selected" : ""} key={level} onClick={() => setExperienceLevel(level)}>{level}</button>)}</div></fieldset><fieldset><legend>WHEN CAN YOU STUDY?</legend><div className="a02-day-options">{days.map(([day, label]) => <button type="button" className={weeklyDaysAvailable.includes(day) ? "is-selected" : ""} key={day} onClick={() => toggleDay(day)} aria-pressed={weeklyDaysAvailable.includes(day)}>{label}</button>)}</div></fieldset><PlanningModeSelector /><label>OPTIONAL CONTEXT<textarea value={notes} onChange={(event) => setNotes(event.target.value)} placeholder="Target role, constraints, deadline, or anything your plan should respect." /></label><label>NAME THIS ROUTE <span>OPTIONAL</span><input value={appName} onChange={(event) => setAppName(event.target.value)} placeholder="e.g. Autumn interview sprint" /></label>{error && <p className="a02-onboarding-error" role="alert">{error}</p>}<div className="a02-onboarding-actions"><button type="button" onClick={() => setStep("intent")}>← Back</button><button type="button" className="a02-onboarding-primary" onClick={generatePlan}>Build my route <i>↗</i></button></div></section>}
        {step === "generating" && <section className="a02-onboarding-progress"><span className="a02-live-pip" /> ROUTE ENGINE ACTIVE<div className="a02-onboarding-orbit"><i /><i /><b>◒</b></div><h2>Making the<br /><em>next move</em><br />visible.</h2><p>{status}</p><div className="a02-progress-line"><i /></div><small>YOUR PLAN IS BUILT WITH A FALLBACK ROUTE IF AI IS UNAVAILABLE.</small></section>}
        {step === "complete" && plan && <section className="a02-onboarding-complete"><span className="a02-eyebrow">03 / ROUTE READY</span><h2>{status}</h2><p>{plan.goalLine}</p><div>{plan.categories.map((category, index) => <article key={category.id}><i>0{index + 1}</i><b>{category.label}</b><span>{category.name.replaceAll("_", " ")}</span></article>)}</div><button type="button" className="a02-onboarding-primary" onClick={() => router.push("/architecture-02?deck=work")}>Enter Today <i>→</i></button></section>}
      </section>
    </section>
  </main>;
}
