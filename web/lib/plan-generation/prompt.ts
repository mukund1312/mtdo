// Pure prompt-builder for onboarding plan generation. No network calls in this
// file -- same convention as src/mtdo/coaching.py's build_*_prompt functions,
// which the AI-tutor-adjacent surfaces of this app already follow.
//
// The rules embedded below (one-subject-per-field, curriculum-as-weekly-menu,
// rich per-task coaching metadata) are ported from the terminal app's
// src/mtdo/goals_template.json ("_read_this_first" rules 1, 5, 9, 9b, 9c) --
// that file is what actually teaches an AI to fill in a good goals.json today,
// so the web onboarding prompt reuses its rules rather than inventing new ones.
// Unlike goals_template.json (handed to whatever AI the user already has open),
// this prompt asks for raw JSON back, not a filled-in template file, since the
// Route Handler parses the response programmatically (see parse.ts).

import type { OnboardingAnswers } from "./types";

const DAY_NAMES = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

function formatDays(days: number[]): string {
  return days
    .filter((d) => d >= 0 && d <= 6)
    .map((d) => DAY_NAMES[d])
    .join(", ");
}

export function buildPlanPrompt(answers: OnboardingAnswers): string {
  const appName = answers.appName?.trim() || "MTDO";
  const focusAreas = answers.focusAreas.map((f) => f.trim()).filter(Boolean);
  const days = formatDays(answers.weeklyDaysAvailable) || "no specific days given";
  const notes = answers.notes?.trim();

  return (
    "You are building a personalized study/practice plan for a new user of MTDO, " +
    "a task board for deliberate, structured practice at ANY subject or skill -- " +
    "school homework, a professional certification, a hobby, fitness, interview prep, " +
    "anything the user names. Do not assume a technical or interview-prep goal unless " +
    "the user's own goal/subjects actually say so. " +
    `Call the app "${appName}" in "app_name". ` +
    `Their goal: "${answers.goalLine.trim()}". Experience level: ${answers.experienceLevel}. ` +
    `They can study on: ${days}. ` +
    `They want these separate subjects tracked: ${focusAreas.join(", ") || "(infer 2-4 sensible ones from their goal)"}.` +
    (notes ? ` Additional context from the user: ${notes}` : "") +
    "\n\n" +
    "Return ONLY a single JSON object (no markdown fences, no prose before or after) " +
    "matching exactly this shape:\n\n" +
    "{\n" +
    '  "app_name": string,\n' +
    '  "goal_line": string,\n' +
    '  "categories": [\n' +
    "    {\n" +
    '      "name": string,            // lowercase, snake_case, short, stable id\n' +
    '      "label": string,           // human-readable name shown in the UI\n' +
    '      "days": number[],          // 0=Mon..6=Sun, which days this subject is scheduled\n' +
    '      "min_blocks": number,      // floor for counting this subject "done" that day, 0-6\n' +
    '      "score_weight": number,    // contribution to a 0-100 daily score; ALL categories\' weights should sum to ~100\n' +
    '      "topic_type": "dsa" | "backend" | "database" | "system_design" | null,\n' +
    '      "coaching_framework": {\n' +
    '        "ask_yourself": string[],\n' +
    '        "interview_check": string[],\n' +
    '        "related_topics": string[]\n' +
    "      } | null,\n" +
    '      "curriculum": [            // array of "day" menus -- see rules below\n' +
    "        [ /* week 1, day 1 items */ ],\n" +
    "        [ /* week 1, day 2 items */ ]\n" +
    "        // ... exactly days.length inner lists per week, for 2 weeks total\n" +
    "      ]\n" +
    "    }\n" +
    "  ]\n" +
    "}\n\n" +
    "Rules, follow them exactly:\n" +
    "1. One subject per category. Never combine two distinct subjects into one category " +
    '(e.g. never one "Python & SQL" category) -- give each its own category, its own ' +
    "curriculum, its own score_weight, so progress on each is visible separately.\n" +
    "2. `curriculum` is a WEEKLY MENU, not a day-by-day schedule. The user picks items " +
    "from the current week's menu whenever they get to them -- it is not locked to a " +
    "specific calendar day. Write exactly `days.length` inner lists per week of content " +
    "(one inner list per scheduled day that week), for 2 weeks, so the array has " +
    "`days.length * 2` inner lists total. Each inner list holds 1-3 items for that day's " +
    "slot in the menu.\n" +
    "3. Each curriculum item is either a plain string, or a rich object " +
    '{ "task": string, "focus_points": string[], "questions": string[], ' +
    '"interview_questions": string[], "mistakes": string[], "tips": string[], ' +
    '"mental_models": string[], "related_topics": string[] }. PREFER the rich object ' +
    "form for every item you can -- 3-5 focus_points, 2-3 questions, 1-2 " +
    "interview_questions, 1-2 mistakes, 1 tip, 1 mental_model. This is the single " +
    "highest-value part of the plan: it is the difference between generic advice and " +
    "something that actually teaches. Tune it to what THIS user is actually studying, " +
    "not generic subject-wide boilerplate. NOTE: the field is named " +
    '"interview_questions"/"interview_check" for historical schema-compatibility reasons ' +
    "only -- treat it as \"questions that check real understanding, the way a strict " +
    "teacher or examiner would probe it\", not literally a job interview, unless the " +
    "user's own goal actually is interview prep. For a school subject, write exam-style " +
    "or teacher-style check questions there instead.\n" +
    "4. `coaching_framework` (optional per category) OVERRIDES the generic topic_type " +
    "bucket -- write ask_yourself/interview_check questions specific to what this " +
    "user's curriculum in that category actually covers, not a generic subject-wide " +
    "list.\n" +
    "5. `topic_type` should be one of the four listed values ONLY when the category is " +
    "genuinely DSA, backend engineering, databases/SQL, or system design -- leave it null " +
    "for every other subject (school subjects, professional certs, hobbies, fitness, " +
    "anything else). Never invent a new value, and never pick the closest-sounding one " +
    "just to fill the field -- null is the correct, common answer.\n" +
    "6. Match the user's actual level and context: age-appropriate, plain language for a " +
    "school subject; technical depth only where the subject calls for it. Don't add " +
    "interview or career framing to a goal that has none.\n" +
    "7. Output must be valid JSON with no trailing commas, no comments, and no text " +
    "outside the single JSON object."
  );
}
