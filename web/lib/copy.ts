/**
 * Web ↔ terminal vocabulary — DESIGN.md §Vocabulary.
 *
 * The only place marketing/product copy for these concepts should live.
 * Schema, API routes, and component names stay neutral (`plans`,
 * `focus_sessions`, `rooms`, `notes`) regardless of what's in here —
 * never let a term from this file leak into a table, column, or route
 * segment name. See docs/architecture/api.md §4.
 */
export const copy = {
  web: {
    goal: "Goal route",
    focus: "Focus timer",
    rooms: "Study rooms",
    notes: "Vault",
  },
  terminal: {
    goal: "mission_compiler",
    focus: "focus_orbit",
    rooms: "mesh_signal",
    notes: "archive_index",
  },
} as const;
