// Prompt builder for the curriculum check-in flow (Phase 3, operating-engine
// plan; app/api/plan/extend/route.ts). Distinct from prompt.ts's
// buildPlanPrompt: this asks for MORE content in EXISTING categories, not a
// new plan -- category metadata (label, topic_type, days) already exists in
// the database and is passed in, not re-derived from a fresh questionnaire.

export type ExtensionSignal = {
  categoryId: string;
  label: string;
  topicType?: string;
  daysPerWeek: number;
  /** Real counts from blocks/curriculum_items for this category -- not
   * fabricated. Gives the model a sense of pace and what's already been
   * worked, per decisions.md 2026-09-08's "feeding picked/skipped/completed
   * signal into extend_plan()'s prompt." */
  completedCount: number;
  inProgressOrBacklogCount: number;
  stillUnpickedCount: number;
};

export function buildExtensionPrompt(goalLine: string, categories: ExtensionSignal[]): string {
  const categoryBlocks = categories
    .map(
      (c) =>
        `- category_id "${c.categoryId}", "${c.label}"${c.topicType ? ` (topic_type: ${c.topicType})` : ""}: ` +
        `${c.daysPerWeek} tasks/week. So far: ${c.completedCount} completed, ${c.inProgressOrBacklogCount} picked but not yet done, ` +
        `${c.stillUnpickedCount} still waiting on the menu. Generate exactly ${c.daysPerWeek * 2} new tasks (2 more weeks) for this category.`,
    )
    .join("\n");

  return (
    "A user's study/practice plan has run low on upcoming content in some subjects and asked to " +
    `extend it. Their overall goal: "${goalLine}". Generate MORE tasks for these EXISTING subjects ` +
    "-- do not invent new subjects, do not repeat a task that sounds like one already completed, " +
    "and continue at a similar or slightly increasing difficulty given how much is already done:\n\n" +
    categoryBlocks +
    "\n\n" +
    "Return ONLY a single JSON object (no markdown fences, no prose before or after) matching " +
    "exactly this shape:\n\n" +
    "{\n" +
    '  "categories": [\n' +
    "    {\n" +
    '      "category_id": string,     // exactly one of the category_id values given above\n' +
    '      "items": [                 // exactly the requested count for that category, in order\n' +
    "        {\n" +
    '          "task": string,\n' +
    '          "focus_points": string[], "questions": string[], "interview_questions": string[],\n' +
    '          "mistakes": string[], "tips": string[], "mental_models": string[], "related_topics": string[]\n' +
    "        }\n" +
    "      ]\n" +
    "    }\n" +
    "  ]\n" +
    "}\n\n" +
    "PREFER the rich object form (all fields above) for every item -- 3-5 focus_points, 2-3 " +
    "questions, 1-2 interview_questions, 1-2 mistakes, 1 tip, 1 mental_model, same bar as generating " +
    "a plan from scratch. Output must be valid JSON with no trailing commas, no comments, and no " +
    "text outside the single JSON object."
  );
}
