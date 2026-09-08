export const PLANNING_MODES = ["dynamic_weekly", "overall"] as const;

export type PlanningMode = (typeof PLANNING_MODES)[number];

export const PLANNING_MODE_STORAGE_KEY = "mtdo-planning-mode";

export const PLANNING_MODE_DETAILS: Record<PlanningMode, { description: string; label: string; note: string }> = {
  dynamic_weekly: {
    label: "Dynamic Weekly",
    description: "Refresh your route around the week you actually have.",
    note: "Best when availability changes week to week.",
  },
  overall: {
    label: "Overall",
    description: "Keep one steady route in view from the larger goal down.",
    note: "Best for a stable, long-horizon plan.",
  },
};

export function isPlanningMode(value: string | null): value is PlanningMode {
  return value === "dynamic_weekly" || value === "overall";
}
