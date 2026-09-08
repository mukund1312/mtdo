// Shapes for the onboarding plan-generation Route Handler
// (web/app/api/onboarding/plan/route.ts, docs/architecture/api.md §2).
//
// GeneratedPlan/GeneratedCategory/GeneratedTask mirror goals_template.json's schema
// (src/mtdo/goals_template.json) and goals_to_config()'s input shape
// (src/mtdo/config.py) -- this is the same goals.json -> plan mapping the terminal
// app already uses, ported to TS rather than re-derived. See parse.ts for the rules
// this shape encodes (rule_1/rule_5/rule_9/9b/9c from goals_template.json).

export interface OnboardingAnswers {
  /** One sentence describing what the user is working toward. Required, non-blank. */
  goalLine: string;
  /** Defaults to "MTDO" if omitted. */
  appName?: string;
  /**
   * Distinct subjects the user wants tracked SEPARATELY (goals_template.json rule_1 --
   * never comma-split one field into two subjects). 1-6 short labels, e.g.
   * ["System Design", "SQL", "Behavioral Interview Prep"].
   */
  focusAreas: string[];
  experienceLevel: "beginner" | "intermediate" | "advanced";
  /** 0=Monday .. 6=Sunday, the days per week the user can realistically study. */
  weeklyDaysAvailable: number[];
  /** Optional freeform context: prior experience, constraints, target company/role, etc. */
  notes?: string;
}

export interface GeneratedTask {
  task: string;
  focus_points?: string[];
  questions?: string[];
  interview_questions?: string[];
  mistakes?: string[];
  tips?: string[];
  mental_models?: string[];
  related_topics?: string[];
}

/**
 * One inner list = one day's worth of menu items (goals_template.json rule_5): the
 * app does NOT lock these to specific calendar days. Every `category.days.length`
 * consecutive entries in `curriculum` make up one week's pickable menu.
 */
export type GeneratedCurriculumDay = (string | GeneratedTask)[];

export interface GeneratedCoachingFramework {
  ask_yourself?: string[];
  interview_check?: string[];
  focus_on?: string[];
  mistakes?: string[];
  mental_models?: string[];
  tips?: string[];
  related_topics?: string[];
}

export type TopicType = "dsa" | "backend" | "database" | "system_design";

export interface GeneratedCategory {
  /** lowercase, snake_case, stable id -- becomes plan_categories.name */
  name: string;
  label: string;
  /** 0=Monday .. 6=Sunday */
  days: number[];
  min_blocks: number;
  score_weight: number;
  topic_type?: TopicType;
  coaching_framework?: GeneratedCoachingFramework;
  curriculum: GeneratedCurriculumDay[];
}

/** The one versioned wire shape a GeneratedPlan round-trips through --
 * export (persist.ts's inverse) writes it, import validates it via
 * parseGeneratedPlan()'s schema_version check. A missing schema_version on
 * import is treated as "mtdo.plan.v1" (parse.ts) for compatibility with
 * files predating this field (and the terminal app's own goals.json, which
 * has never carried one) -- export always writes it explicitly. */
export const PLAN_SCHEMA_VERSION = "mtdo.plan.v1";

export interface GeneratedPlan {
  app_name: string;
  goal_line: string;
  categories: GeneratedCategory[];
}

export class PlanGenerationError extends Error {}
