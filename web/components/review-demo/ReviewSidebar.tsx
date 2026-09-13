"use client";

import { useState } from "react";
import { LayoutGrid, Search as SearchIcon, Clock3, CheckCircle2, Target, BarChart3, Calendar } from "lucide-react";

const ITEMS = [
  { id: "overview", label: "Overview", icon: LayoutGrid },
  { id: "deep-dive", label: "Deep Dive", icon: SearchIcon },
  { id: "time-analysis", label: "Time Analysis", icon: Clock3 },
  { id: "task-analysis", label: "Task Analysis", icon: CheckCircle2 },
  { id: "goal-progress", label: "Goal Progress", icon: Target },
  { id: "comparisons", label: "Comparisons", icon: BarChart3 },
  { id: "reports", label: "Reports", icon: Calendar },
];

export function ReviewSidebar() {
  const [active, setActive] = useState("overview");

  return (
    <aside className="rd-sidebar" aria-label="Review sections">
      <nav>
        {ITEMS.map(({ id, label, icon: Icon }) => (
          <div
            key={id}
            role="button"
            tabIndex={0}
            className={`rd-sidebar-item${active === id ? " is-active" : ""}`}
            onClick={() => setActive(id)}
            onKeyDown={(e) => e.key === "Enter" && setActive(id)}
          >
            <Icon size={16} strokeWidth={1.75} />
            {label}
          </div>
        ))}
      </nav>
      <div className="rd-sidebar-divider" />
      <p className="rd-sidebar-quote">
        Consistency
        <br />
        turns intention
        <br />
        into identity.
      </p>
    </aside>
  );
}
