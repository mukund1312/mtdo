"use client";

import { useState } from "react";
import { Home, LayoutGrid, Target, Clock3, BarChart3, Headphones, Search } from "lucide-react";

const NAV_ITEMS = [
  { id: "home", label: "Home", icon: Home },
  { id: "kanban", label: "Kanban", icon: LayoutGrid },
  { id: "goals", label: "Goals", icon: Target },
  { id: "time", label: "Time", icon: Clock3 },
  { id: "review", label: "Review", icon: BarChart3 },
  { id: "listen", label: "Listen", icon: Headphones },
];

export function TopNavigation() {
  const [active, setActive] = useState("review");

  return (
    <header className="rd-topnav">
      <div style={{ display: "flex", alignItems: "center", gap: 32 }}>
        <div className="rd-logo">
          mtdo
          <span className="rd-logo-dot" aria-hidden="true" />
        </div>
        <nav className="rd-nav-items" aria-label="Primary navigation">
          {NAV_ITEMS.map(({ id, label, icon: Icon }) => (
            <button
              key={id}
              type="button"
              className={`rd-nav-item${active === id ? " is-active" : ""}`}
              onClick={() => setActive(id)}
              aria-pressed={active === id}
            >
              <Icon size={15} strokeWidth={1.75} />
              {label}
            </button>
          ))}
        </nav>
      </div>
      <div className="rd-topnav-right">
        <label className="rd-search">
          <Search size={14} strokeWidth={1.75} />
          <input type="text" placeholder="Search..." aria-label="Search" />
          <kbd>⌘K</kbd>
        </label>
        <div className="rd-divider-v" aria-hidden="true" />
        <div className="rd-avatar" title="Profile">M</div>
      </div>
    </header>
  );
}
