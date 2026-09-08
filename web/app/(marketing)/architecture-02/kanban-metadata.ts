/**
 * curriculum_items/blocks.priority + estimated_minutes (migrations/0018).
 * Real columns now -- this file used to fabricate a deterministic per-block
 * value here as a placeholder ("the current blocks contract deliberately
 * has no priority or estimated_minutes column... this adapter is the
 * single replacement point"); this is that replacement. today-deck.tsx
 * reads block.priority/block.estimated_minutes directly off the row now,
 * not through a generator.
 */
export type TaskPriority = "high" | "medium" | "low";

const TASK_PRIORITIES: readonly TaskPriority[] = ["high", "medium", "low"];

/** blocks.priority/curriculum_items.priority are DB `text` columns (Supabase's
 * generated types don't narrow a CHECK constraint to a literal union) --
 * this is the same is-a-known-value guard pattern today-deck.tsx already
 * uses for BlockStatus (isBlockStatus). The CHECK constraint means a
 * genuinely unexpected value here would indicate a schema/client drift,
 * not normal user input -- callers should treat a `false` as worth logging,
 * not silently coercing to a fallback. */
export function isTaskPriority(value: string): value is TaskPriority {
  return (TASK_PRIORITIES as readonly string[]).includes(value);
}

export function priorityLabel(priority: TaskPriority): string {
  return priority.charAt(0).toUpperCase() + priority.slice(1);
}
