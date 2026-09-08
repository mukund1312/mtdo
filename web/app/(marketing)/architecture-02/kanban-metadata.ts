import type { TodayBlock } from "./today-deck";

/**
 * The current `blocks` contract deliberately has no priority or
 * `estimated_minutes` column. Keep the temporary presentation data here,
 * rather than smuggling invented fields into Supabase reads or writes. When
 * the task contract grows, this adapter is the single replacement point.
 */
export type TaskPriority = "high" | "medium" | "low";

export type KanbanMetadata = {
  estimatedMinutes: number;
  priority: TaskPriority;
};

const PRIORITIES: TaskPriority[] = ["high", "medium", "low"];
const ESTIMATES = [25, 45, 60] as const;

function stableIndex(value: string): number {
  let hash = 0;
  for (let index = 0; index < value.length; index += 1) {
    hash = (hash * 31 + value.charCodeAt(index)) | 0;
  }
  return Math.abs(hash);
}

export function kanbanMetadataFor(block: Pick<TodayBlock, "id">): KanbanMetadata {
  const index = stableIndex(block.id);
  return {
    priority: PRIORITIES[index % PRIORITIES.length]!,
    estimatedMinutes: ESTIMATES[index % ESTIMATES.length]!,
  };
}

export function priorityLabel(priority: TaskPriority): string {
  return priority.charAt(0).toUpperCase() + priority.slice(1);
}
