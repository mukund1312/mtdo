"use client";

import { useState } from "react";

// Small quote card, top-right of the header, per the reference mock. No
// backend for this -- a short fixed rotation, picked deterministically by
// day-of-year so it's stable across re-renders and reloads within a day,
// not random noise on every refresh. Computed once via useState's lazy
// initializer, not read from Date.now() during render (an impure call react
// itself now flags -- see react-hooks/purity).

const QUOTES = [
  "A little progress each day adds up to big results.",
  "Consistency turns intention into identity.",
  "You don't have to be great to start, but you have to start to be great.",
  "Small steps, repeated daily, outrun big leaps taken rarely.",
  "Discipline is choosing between what you want now and what you want most.",
];

function pickQuote(): string {
  const now = new Date();
  const dayOfYear = Math.floor((now.getTime() - Date.UTC(now.getUTCFullYear(), 0, 0)) / 86_400_000);
  return QUOTES[dayOfYear % QUOTES.length]!;
}

export function ReviewQuote() {
  const [quote] = useState(pickQuote);

  return (
    <blockquote className="a02-review-quote">
      <p>&ldquo;{quote}&rdquo;</p>
    </blockquote>
  );
}
