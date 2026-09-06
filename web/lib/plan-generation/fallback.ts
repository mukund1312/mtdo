// Static fallback plan, used when the Anthropic call or its response fails
// (api.md §2's failure contract: "coaching must degrade to static content,
// never block the core loop" -- onboarding is the one place that contract
// extends to plan GENERATION, not just coaching content, because a broken
// AI call must never leave a new user with no plan at all).
//
// Two categories, one week of curriculum each, loosely modeled on
// src/mtdo/demo_config.yaml's shipped example plan -- enough for a user to
// start using the app immediately and edit/regenerate later.

import type { GeneratedPlan } from "./types";

export function buildFallbackPlan(answers: { goalLine: string; appName?: string }): GeneratedPlan {
  return {
    app_name: answers.appName?.trim() || "MTDO",
    goal_line: answers.goalLine.trim() || "Build a consistent daily practice habit.",
    categories: [
      {
        name: "core_practice",
        label: "Core Practice",
        days: [0, 1, 2, 3, 4],
        min_blocks: 1,
        score_weight: 60,
        topic_type: undefined,
        coaching_framework: {
          ask_yourself: [
            "What am I trying to get better at this week?",
            "What's the smallest real thing I can practice today?",
          ],
          interview_check: ["Explain what you did today, out loud, in one minute."],
          related_topics: [],
        },
        curriculum: [
          ["Pick your first real task and work it for one focused block."],
          ["Review yesterday's work -- what would you do differently?"],
          ["Work another real task from your goal area."],
          ["Review day -- redo your weakest item from this week."],
          ["Extended practice -- pick anything from your goal area you haven't tried yet."],
        ],
      },
      {
        name: "reflection",
        label: "Weekly Reflection",
        days: [5],
        min_blocks: 1,
        score_weight: 10,
        topic_type: undefined,
        curriculum: [["Write down what you learned this week and what's still unclear."]],
      },
    ],
  };
}
