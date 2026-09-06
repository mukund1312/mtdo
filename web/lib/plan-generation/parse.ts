// Parses/validates the AI's raw JSON response into GeneratedPlan. Pure, no
// network calls -- same convention as src/mtdo/coaching.py's
// parse_ai_coaching_response: never trust the model's output shape, validate
// field-by-field, and raise a caller-catchable error (PlanGenerationError,
// this file's analogue of config.py's ConfigError) rather than letting a
// raw TypeError/KeyError-equivalent leak out.

import {
  PlanGenerationError,
  type GeneratedCategory,
  type GeneratedCoachingFramework,
  type GeneratedCurriculumDay,
  type GeneratedPlan,
  type GeneratedTask,
  type TopicType,
} from "./types";

const TOPIC_TYPES: readonly TopicType[] = [
  "dsa",
  "backend",
  "database",
  "system_design",
];

/** Strips ```json ... ``` / ``` ... ``` fences some models wrap JSON in
 * despite being told not to, and trims to the outermost {...} object. */
function extractJsonText(raw: string): string {
  let text = raw.trim();
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced && fenced[1] !== undefined) {
    text = fenced[1].trim();
  }
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end === -1 || end < start) {
    throw new PlanGenerationError("No JSON object found in the model's response.");
  }
  return text.slice(start, end + 1);
}

function isNonBlankString(v: unknown): v is string {
  return typeof v === "string" && v.trim().length > 0;
}

function stringArray(v: unknown, field: string): string[] {
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v) || !v.every((x) => typeof x === "string")) {
    throw new PlanGenerationError(`"${field}" should be an array of strings.`);
  }
  return v;
}

function parseTask(raw: unknown, context: string): string | GeneratedTask {
  if (typeof raw === "string") {
    if (!raw.trim()) {
      throw new PlanGenerationError(`${context}: a curriculum item is blank.`);
    }
    return raw;
  }
  if (typeof raw !== "object" || raw === null) {
    throw new PlanGenerationError(
      `${context}: curriculum items must be a string or an object, got ${typeof raw}.`,
    );
  }
  const obj = raw as Record<string, unknown>;
  if (!isNonBlankString(obj.task)) {
    throw new PlanGenerationError(`${context}: a rich curriculum item is missing "task".`);
  }
  return {
    task: obj.task,
    focus_points: stringArray(obj.focus_points, "focus_points"),
    questions: stringArray(obj.questions, "questions"),
    interview_questions: stringArray(obj.interview_questions, "interview_questions"),
    mistakes: stringArray(obj.mistakes, "mistakes"),
    tips: stringArray(obj.tips, "tips"),
    mental_models: stringArray(obj.mental_models, "mental_models"),
    related_topics: stringArray(obj.related_topics, "related_topics"),
  };
}

function parseCurriculum(raw: unknown, context: string): GeneratedCurriculumDay[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) {
    throw new PlanGenerationError(`${context}: "curriculum" should be an array.`);
  }
  return raw.map((dayList, i) => {
    if (!Array.isArray(dayList)) {
      throw new PlanGenerationError(`${context}: curriculum[${i}] should be an array.`);
    }
    return dayList.map((item) => parseTask(item, `${context}.curriculum[${i}]`));
  });
}

function parseCoachingFramework(raw: unknown, context: string): GeneratedCoachingFramework | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== "object") {
    throw new PlanGenerationError(`${context}: "coaching_framework" should be an object.`);
  }
  const obj = raw as Record<string, unknown>;
  return {
    ask_yourself: stringArray(obj.ask_yourself, "coaching_framework.ask_yourself"),
    interview_check: stringArray(obj.interview_check, "coaching_framework.interview_check"),
    focus_on: stringArray(obj.focus_on, "coaching_framework.focus_on"),
    mistakes: stringArray(obj.mistakes, "coaching_framework.mistakes"),
    mental_models: stringArray(obj.mental_models, "coaching_framework.mental_models"),
    tips: stringArray(obj.tips, "coaching_framework.tips"),
    related_topics: stringArray(obj.related_topics, "coaching_framework.related_topics"),
  };
}

function parseCategory(raw: unknown, index: number): GeneratedCategory {
  if (typeof raw !== "object" || raw === null) {
    throw new PlanGenerationError(`categories[${index}] should be an object.`);
  }
  const obj = raw as Record<string, unknown>;
  const context = `categories[${index}]`;

  if (!isNonBlankString(obj.name)) {
    throw new PlanGenerationError(`${context} is missing a non-blank "name".`);
  }
  if (!/^[a-z0-9_]+$/.test(obj.name)) {
    throw new PlanGenerationError(
      `${context}.name "${obj.name}" must be lowercase snake_case (letters, digits, underscores only).`,
    );
  }
  if (!isNonBlankString(obj.label)) {
    throw new PlanGenerationError(`${context} is missing a non-blank "label".`);
  }
  if (
    !Array.isArray(obj.days) ||
    obj.days.length === 0 ||
    !obj.days.every((d) => typeof d === "number" && Number.isInteger(d) && d >= 0 && d <= 6)
  ) {
    throw new PlanGenerationError(`${context}.days must be a non-empty array of integers 0-6.`);
  }
  const minBlocks = obj.min_blocks;
  if (typeof minBlocks !== "number" || !Number.isFinite(minBlocks) || minBlocks < 0) {
    throw new PlanGenerationError(`${context}.min_blocks must be a non-negative number.`);
  }
  const scoreWeight = obj.score_weight;
  if (typeof scoreWeight !== "number" || !Number.isFinite(scoreWeight) || scoreWeight < 0) {
    throw new PlanGenerationError(`${context}.score_weight must be a non-negative number.`);
  }
  let topicType: TopicType | undefined;
  if (obj.topic_type !== undefined && obj.topic_type !== null) {
    if (typeof obj.topic_type !== "string" || !TOPIC_TYPES.includes(obj.topic_type as TopicType)) {
      throw new PlanGenerationError(
        `${context}.topic_type must be one of ${TOPIC_TYPES.join(", ")}, or omitted.`,
      );
    }
    topicType = obj.topic_type as TopicType;
  }

  return {
    name: obj.name,
    label: obj.label,
    days: obj.days as number[],
    min_blocks: minBlocks,
    score_weight: scoreWeight,
    topic_type: topicType,
    coaching_framework: parseCoachingFramework(obj.coaching_framework, context),
    curriculum: parseCurriculum(obj.curriculum, context),
  };
}

/** Throws PlanGenerationError on any malformed field -- callers (the Route
 * Handler) are expected to catch this specifically and fall back to the
 * static default plan (fallback.ts), same failure contract as coaching.py's
 * "degrade to static content, never block the core loop." */
export function parseGeneratedPlan(rawText: string): GeneratedPlan {
  const jsonText = extractJsonText(rawText);
  let data: unknown;
  try {
    data = JSON.parse(jsonText);
  } catch (e) {
    throw new PlanGenerationError(`Model response wasn't valid JSON: ${(e as Error).message}`);
  }
  if (typeof data !== "object" || data === null) {
    throw new PlanGenerationError("Model response's top level must be a JSON object.");
  }
  const obj = data as Record<string, unknown>;
  if (!isNonBlankString(obj.goal_line)) {
    throw new PlanGenerationError('Model response is missing a non-blank "goal_line".');
  }
  if (!Array.isArray(obj.categories) || obj.categories.length === 0) {
    throw new PlanGenerationError('Model response\'s "categories" must be a non-empty array.');
  }

  const categories = obj.categories.map((c, i) => parseCategory(c, i));
  const names = new Set<string>();
  for (const c of categories) {
    if (names.has(c.name)) {
      throw new PlanGenerationError(`Duplicate category name "${c.name}".`);
    }
    names.add(c.name);
  }

  return {
    app_name: isNonBlankString(obj.app_name) ? obj.app_name : "MTDO",
    goal_line: obj.goal_line,
    categories,
  };
}
