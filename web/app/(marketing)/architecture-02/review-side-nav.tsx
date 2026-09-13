"use client";

// Secondary left nav from the reference mock. "Overview" is the only real
// destination -- everything below it is deliberately inert (visually
// present, not clickable) rather than silently wired to nothing. Building
// out Deep Dive/Time Analysis/Task Analysis/Goal Progress/Comparisons/
// Reports as real destinations is a bigger nav-architecture decision this
// pass doesn't make unilaterally -- see review-visual-spec.md's original
// note on this exact point.

const ITEMS = ["Overview", "Deep Dive", "Time Analysis", "Task Analysis", "Goal Progress", "Comparisons", "Reports"];

export function ReviewSideNav() {
  return (
    <nav className="a02-review-side-nav" aria-label="Review sections">
      <ul>
        {ITEMS.map((item, i) => (
          <li key={item}>
            <button type="button" className={i === 0 ? "is-active" : undefined} disabled={i !== 0} aria-current={i === 0 ? "page" : undefined}>
              {item}
            </button>
          </li>
        ))}
      </ul>
      <p className="a02-review-side-nav-quote">&ldquo;Consistency turns intention into identity.&rdquo;</p>
    </nav>
  );
}
