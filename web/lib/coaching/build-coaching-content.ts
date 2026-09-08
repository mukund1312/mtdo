// Port of src/mtdo/coaching.py's build_coaching_content() and its static
// content library (Phase 1 of the operating-engine plan: "Session coach
// rail"). Ported verbatim, not reinterpreted -- the merge order and the
// generic/topic-framework fallback text are the terminal app's own Learning
// Coach spec, and the web session screen owes the same coaching a terminal
// user already gets for the same task.

// Task-level shape (blocks.coaching, copied from curriculum_items.meta --
// goals_template.json rule_9). Note the key names differ from
// CoachingFramework below by design, not oversight -- this is the terminal
// app's own two vocabularies, ported as-is rather than unified, since
// unifying them would mean this port no longer matches goals.json files
// real users already have.
export type CoachingFields = {
  focus_points?: string[];
  interview_questions?: string[];
  mental_models?: string[];
  mistakes?: string[];
  questions?: string[];
  related_topics?: string[];
  tips?: string[];
};

// Field-level shape (plan_categories.coaching_framework -- rule_9c). Same
// seven concepts as CoachingFields, different key names for the first two
// (ask_yourself/focus_on instead of questions/focus_points) -- matches
// goals_template.json's own coaching_framework object exactly.
export type CoachingFramework = {
  ask_yourself?: string[];
  focus_on?: string[];
  interview_check?: string[];
  mental_models?: string[];
  mistakes?: string[];
  related_topics?: string[];
  tips?: string[];
};

export type CategoryMeta = {
  coaching_framework?: CoachingFramework | null;
  topic_type?: string | null;
};

export type CoachingContent = {
  ask_yourself: string[];
  focus_on: string[];
  interview_check: string[];
  mental_models: string[];
  mistakes: string[];
  pro_tip: string;
  related_topics: string[];
};

// ---- Universal framework (used when a task has no topic_type match / no own metadata) --

const GENERIC_FOCUS_ON = [
  "What problem does this solve?",
  "Why does it exist?",
  "What assumptions does it make?",
  "What are the tradeoffs?",
  "What are the edge cases?",
];

const GENERIC_ASK_YOURSELF = [
  "What is it?",
  "Why is it needed?",
  "How does it work?",
  "When should I use it?",
  "When should I NOT use it?",
];

const GENERIC_INTERVIEW_CHECK = [
  "Explain it verbally.",
  "Draw it.",
  "Implement it.",
  "Compare alternatives.",
  "Explain tradeoffs.",
  "Give real-world examples.",
];

const GENERIC_MISTAKES = ["Skipping edge cases.", "Memorizing the answer instead of the reasoning."];

const GENERIC_MENTAL_MODELS = ["Can you draw this before you code it?"];

// ---- Topic-specific frameworks -------------------------------------------------------
// Keyed by a category's optional "topic_type" (see goals_template.json rule_9).

const TOPIC_FRAMEWORKS: Record<string, { ask_yourself: string[]; interview_check: string[] }> = {
  dsa: {
    ask_yourself: [
      "What is the brute-force solution?",
      "Why is it slow?",
      "What observation improves it?",
      "What data structure helps?",
      "Time Complexity?",
      "Space Complexity?",
      "Edge Cases?",
    ],
    interview_check: ["Solve from scratch.", "Explain intuition.", "Explain complexity.", "Optimize further.", "Re-derive tomorrow."],
  },
  backend: {
    ask_yourself: [
      "What problem does this solve?",
      "What are the tradeoffs?",
      "What breaks first?",
      "What are bottlenecks?",
      "How does it scale?",
      "What happens at 10x traffic?",
      "What happens at 100x traffic?",
    ],
    interview_check: [
      "Draw architecture.",
      "Explain request flow.",
      "Explain database interactions.",
      "Explain failure scenarios.",
      "Explain scaling strategy.",
    ],
  },
  database: {
    ask_yourself: [
      "Why does this query work?",
      "What indexes help?",
      "What is the execution plan?",
      "Can it be optimized?",
      "What happens on large datasets?",
    ],
    interview_check: ["Write query from memory.", "Compare JOIN vs SUBQUERY.", "Explain execution order.", "Explain indexing impact."],
  },
  system_design: {
    ask_yourself: [
      "Requirements?",
      "Scale?",
      "APIs?",
      "Database?",
      "Cache?",
      "Load Balancer?",
      "Bottlenecks?",
      "Monitoring?",
      "Failure Modes?",
      "Tradeoffs?",
    ],
    interview_check: ["If you cannot explain WHY you chose something, you do not understand it."],
  },
};

const EXPERT_TIPS = [
  "Don't memorize solutions. Memorize reasoning.",
  "Understanding > Memorization.",
  "Implementation > Reading.",
  "Always ask WHY.",
  "Tradeoffs matter.",
  "Interviewers hire reasoning, not memorization.",
  "Draw diagrams before coding.",
  "Teach the concept aloud.",
  "If you cannot teach it, you do not understand it.",
];

function firstNonEmpty(...lists: Array<string[] | undefined>): string[] | undefined {
  return lists.find((list) => list && list.length > 0);
}

/** Whether there's any real coaching content for this task, or only the
 * fully generic fallback would apply -- ports coaching.py's
 * has_coaching_setup(). A bare field with none of these has nothing
 * sensible to fall back to; callers use this to decide whether to show the
 * panel at all versus an honest "nothing set up here yet" state. */
export function hasCoachingSetup(coaching: CoachingFields | null | undefined, categoryMeta: CategoryMeta | null | undefined): boolean {
  return Boolean(
    (coaching && Object.keys(coaching).length > 0) || categoryMeta?.coaching_framework || categoryMeta?.topic_type,
  );
}

/** Three-tier merge, most-specific wins per field -- ports coaching.py's
 * build_coaching_content() exactly:
 *
 *   1. The TASK's own rich metadata (blocks.coaching, copied from
 *      curriculum_items.meta by pick_curriculum_item() -- see
 *      goals_template.json rule_9) -- written for this exact task, the most
 *      specific possible content.
 *   2. The FIELD's coaching_framework (plan_categories.coaching_framework,
 *      rule_9c) -- personalized for what this user is actually studying in
 *      this field right now, not one fixed bucket shared by everyone.
 *   3. The built-in generic TOPIC_FRAMEWORKS bucket keyed by topic_type
 *      (dsa/backend/database/system_design), falling back further to the
 *      fully generic GENERIC_* constants -- the safety net so the panel is
 *      never empty for a field nobody's personalized yet.
 */
export function buildCoachingContent(
  coaching: CoachingFields | null | undefined,
  categoryMeta: CategoryMeta | null | undefined,
): CoachingContent {
  const meta = coaching ?? {};
  const fieldFramework = categoryMeta?.coaching_framework ?? {};
  const topicFramework = (categoryMeta?.topic_type && TOPIC_FRAMEWORKS[categoryMeta.topic_type]) || undefined;

  const focus_on = firstNonEmpty(meta.focus_points, fieldFramework.focus_on) ?? GENERIC_FOCUS_ON;
  const ask_yourself =
    firstNonEmpty(meta.questions, fieldFramework.ask_yourself, topicFramework?.ask_yourself) ?? GENERIC_ASK_YOURSELF;
  const interview_check =
    firstNonEmpty(meta.interview_questions, fieldFramework.interview_check, topicFramework?.interview_check) ??
    GENERIC_INTERVIEW_CHECK;
  const mistakes = firstNonEmpty(meta.mistakes, fieldFramework.mistakes) ?? GENERIC_MISTAKES;
  const mental_models = firstNonEmpty(meta.mental_models, fieldFramework.mental_models) ?? GENERIC_MENTAL_MODELS;
  const related_topics = firstNonEmpty(meta.related_topics, fieldFramework.related_topics) ?? [];
  const tips = firstNonEmpty(meta.tips, fieldFramework.tips);
  const pro_tip = tips?.[0] ?? EXPERT_TIPS[Math.floor(Math.random() * EXPERT_TIPS.length)]!;

  return { ask_yourself, focus_on, interview_check, mental_models, mistakes, pro_tip, related_topics };
}
