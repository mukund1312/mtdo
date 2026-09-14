"use client";

// Secondary left nav from the reference mock. "Overview" and "Deep Dive"
// are real destinations (Deep Dive renders the Study Profile, moved out of
// the Today flow -- see review-deck.tsx's audit-driven Phase 1 restructure).
// Everything else stays deliberately inert (visually present, not
// clickable) rather than silently wired to nothing -- building those out
// as real destinations is a bigger nav-architecture decision this pass
// doesn't make unilaterally.

const ITEMS = ["Overview", "Deep Dive", "Time Analysis", "Task Analysis", "Goal Progress", "Comparisons", "Reports"];
const ENABLED = new Set(["Overview", "Deep Dive"]);

export function ReviewSideNav({ active, onSelect }: { active: string; onSelect: (item: string) => void }) {
  return (
    <nav className="a02-review-side-nav" aria-label="Review sections">
      <ul>
        {ITEMS.map((item) => {
          const enabled = ENABLED.has(item);
          const isActive = item === active;
          return (
            <li key={item}>
              <button
                type="button"
                className={isActive ? "is-active" : undefined}
                disabled={!enabled}
                aria-current={isActive ? "page" : undefined}
                onClick={enabled ? () => onSelect(item) : undefined}
              >
                {item}
              </button>
            </li>
          );
        })}
      </ul>
      <p className="a02-review-side-nav-quote">&ldquo;Consistency turns intention into identity.&rdquo;</p>
    </nav>
  );
}
