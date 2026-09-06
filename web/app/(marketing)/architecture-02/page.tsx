"use client";

import Link from "next/link";
import { useState } from "react";
import { ProgressDeck } from "./progress-deck";
import { TodayDeck } from "./today-deck";
import "./v1.css";

type View = "today" | "progress";

export default function ArchitectureTwoPage() {
  const [view, setView] = useState<View>("today");

  return <main className="a02v1Shell">
    <header className="a02v1Nav">
      <Link href="/architecture-02" className="a02v1Mark">mtdo</Link>
      <nav aria-label="Application navigation">
        <button type="button" className={view === "today" ? "isActive" : ""} onClick={() => setView("today")}>Today</button>
        <button type="button" className={view === "progress" ? "isActive" : ""} onClick={() => setView("progress")}>Progress</button>
      </nav>
      <div>
        <Link href="/architecture-02/onboarding">Set up route</Link>
        <Link href="/session">Focus ↗</Link>
      </div>
    </header>
    {view === "today" ? <TodayDeck /> : <ProgressDeck />}
  </main>;
}
