// Per-category colour for the Time deck (calendar-deck extension). The
// founder's own words: "each block each event meaning should be of
// different colours like Google Calendar" -- Google Calendar gives each of
// a user's calendars one consistent colour used everywhere that calendar's
// events appear. The equivalent unit of meaning here is `category_id`
// (a plan's subject/category -- "SQL Fundamentals", "System Design", ...),
// not `priority`, so category is the dominant colour signal; priority stays
// visible as secondary badge text (see BlockDetailPopover / EventChip).
//
// plan_categories (schema.md) has no `color` column and this deliberately
// does not add one via migration -- out of scope per the brief ("do not
// touch supabase/migrations"), and a derived colour needs no persistence:
// the same category_id always hashes to the same palette slot, so it's
// "stable" without being "stored".
//
// Palette: exactly the four accent tokens this route already uses
// (signal-deck.css's --ultra/--acid/--coral/--aqua, defined once on
// .a02-shell) -- no new arbitrary colour system. A plan with more than four
// categories will see two categories share a slot; documented, not silently
// hidden, since Google Calendar's own limited palette makes the identical
// tradeoff once a user has enough calendars.

export const CATEGORY_COLOR_TOKENS = ["ultra", "acid", "coral", "aqua"] as const;
export type CategoryColorToken = (typeof CATEGORY_COLOR_TOKENS)[number];

/**
 * djb2 string hash -- simple, deterministic, well-distributed enough for a
 * palette of 4 slots over UUID-shaped category_id strings. Not
 * cryptographic, doesn't need to be: the only requirement is "the same
 * input always produces the same output" and "different inputs spread
 * roughly evenly across the palette", both of which djb2 satisfies for this
 * input shape.
 */
function djb2Hash(value: string): number {
  let hash = 5381;
  for (let i = 0; i < value.length; i++) {
    hash = (hash * 33) ^ value.charCodeAt(i);
  }
  return hash >>> 0; // unsigned
}

export function categoryColorToken(categoryId: string): CategoryColorToken {
  const index = djb2Hash(categoryId) % CATEGORY_COLOR_TOKENS.length;
  // index is always < CATEGORY_COLOR_TOKENS.length (a non-negative modulo
  // of that exact length) -- the `?? "ultra"` fallback exists only to
  // satisfy noUncheckedIndexedAccess, it is not a reachable branch.
  return CATEGORY_COLOR_TOKENS[index] ?? "ultra";
}
