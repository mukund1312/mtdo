// A downloadable, self-documenting starter file -- the web equivalent of
// the terminal app's src/mtdo/goals_template.json, adapted to this app's
// mtdo.plan.v1 schema (types.ts/parse.ts). Fill it in (by hand, or hand the
// whole file to an AI assistant along with your actual goal) and import it
// from the Import tab on this same page.
//
// Deliberately returned as a plain object, not typed as GeneratedPlan: it
// carries "_"-prefixed instructional keys throughout (top-level and inside
// each category) purely for a human/AI reader -- parseGeneratedPlan() never
// reads an unrecognized key, so they're silently ignored on import, exactly
// like goals_template.json's own "_"-prefixed keys are on the terminal app.
//
// Two example categories, deliberately from very different domains (a
// school subject, and a DSA/interview-prep subject) -- the schema is
// identical either way. That's the point: nothing about this file format is
// tied to software/interview prep, that's just one example use among many
// (a school student's daily subjects, a professional certification, a
// hobby, fitness -- anything with tasks worth tracking over weeks).
export function buildBlankPlanTemplate(): Record<string, unknown> {
  return {
    _instructions:
      "Fill this in yourself, or hand this whole file to an AI assistant along with a " +
      "sentence about what you're working toward and let it fill it in for you. Then go " +
      "to Signal Deck -> More -> Import/Export -> Import, and paste or drop this file. " +
      "Every \"_\"-prefixed key (including this one) is ignored on import -- keep them " +
      "anyway if you want, they don't affect anything, they're just notes.",

    _read_this_first: {
      what_is_a_category:
        "A 'category' is a top-level tracked subject or area -- Class 7 Science, SQL, " +
        "Gym, Job Applications, anything. Each one gets its own column on the Kanban " +
        "board and its own line in the weekly progress panel.",
      what_is_a_curriculum_item:
        "A curriculum item is one task INSIDE a category -- e.g. 'Chapter 5: " +
        "Photosynthesis' inside a 'Science' category. Items are what you actually pick " +
        "and check off.",
      rule_1_one_subject_per_category:
        "Give every distinct subject you want tracked SEPARATELY its own category. " +
        "Don't combine two subjects into one (e.g. don't write one 'Science & Maths' " +
        "category) -- if you do, you only ever see one blended completion percentage " +
        "for both mixed together. Make two categories instead, and split score_weight " +
        "between them however you like.",
      rule_2_curriculum_is_a_weekly_menu:
        "Each inner list in 'curriculum' is one day's worth of items, but the app does " +
        "NOT auto-fill your board with them or lock them to a specific calendar day. " +
        "The first time a category comes due in a new week, that week's day-lists " +
        "(however many = that category's 'days' array length) become a pickable menu " +
        "-- you choose exactly which items to work on, whenever you get to them that " +
        "week. So write curriculum in WEEKLY chunks: this category's 'days' length is " +
        "how many inner lists = one week.",
      rule_3_task_metadata_is_what_makes_the_coach_useful:
        "Any curriculum item can be a plain string (fine, gets a generic or topic-type " +
        "coaching framework automatically) OR a rich object for task-specific coaching: " +
        "{\"task\": \"...\", \"focus_points\": [...], \"questions\": [...], " +
        "\"interview_questions\": [...], \"mistakes\": [...], \"tips\": [...], " +
        "\"mental_models\": [...], \"related_topics\": [...]}. Only \"task\" is " +
        "required -- everything else falls back to the category's own coaching_framework, " +
        "or the generic default. Despite the field's name, \"interview_questions\" " +
        "just means \"questions that check you really understand it\" -- for a school " +
        "subject, write exam-style or teacher-style check questions there, nothing to " +
        "do with job interviews unless that's genuinely your subject.",
      rule_4_topic_type_is_optional_and_cs_specific:
        "\"topic_type\" is one of \"dsa\", \"backend\", \"database\", \"system_design\", " +
        "or omitted. Setting it gives every plain-string task in that category a " +
        "built-in generic coaching framework tuned for that CS subject. For anything " +
        "else -- school subjects, certifications, hobbies, fitness -- just omit it " +
        "entirely; you still get a real, useful, subject-neutral coaching framework, " +
        "just not one pre-tuned to a specific CS topic.",
      rule_5_coaching_framework_is_where_real_personalization_happens:
        "A category can carry its own \"coaching_framework\": {\"ask_yourself\": [...], " +
        "\"interview_check\": [...], \"focus_on\": [...], \"mistakes\": [...], " +
        "\"mental_models\": [...], \"tips\": [...], \"related_topics\": [...]}. This is " +
        "what makes coaching genuinely useful for ANY subject, not just the four CS " +
        "topic_types -- write ask_yourself/interview_check questions specific to what " +
        "THIS person is actually studying in this category right now. See the two " +
        "example categories below for what this looks like for a school subject versus " +
        "a technical one.",
    },

    schema_version: "mtdo.plan.v1",
    app_name: "MTDO",
    goal_line: "One sentence describing what you're working toward.",

    categories: [
      {
        _example_note:
          "Example 1: a school subject. No topic_type -- it doesn't need one, the " +
          "coaching_framework below does all the real personalization.",
        name: "science",
        label: "Science",
        days: [0, 1, 2, 3, 4],
        min_blocks: 1,
        score_weight: 40,
        coaching_framework: {
          ask_yourself: [
            "Can I explain this in my own words, without reading it off the page?",
            "What's a real example of this from outside the textbook?",
            "How does this connect to what I learned last chapter?",
          ],
          interview_check: [
            "Explain it out loud like you're teaching a younger student.",
            "Answer the chapter's end-of-lesson questions from memory, then check.",
          ],
          related_topics: [],
        },
        curriculum: [
          ["Chapter 5: Photosynthesis -- read and take notes"],
          ["Chapter 5: Photosynthesis -- do the end-of-chapter questions"],
          ["Chapter 5: Photosynthesis -- diagram the process from memory"],
          ["Revise chapters 1-4, pick your weakest topic to redo"],
          ["Practice test on Chapter 5"],
        ],
      },
      {
        _example_note:
          "Example 2: a technical subject, same file, same shape. topic_type \"database\" " +
          "gives every plain-string task here a built-in SQL-flavored coaching floor; " +
          "the rich task object below overrides it with something more specific still.",
        name: "sql",
        label: "SQL",
        days: [0, 2, 4],
        min_blocks: 1,
        score_weight: 30,
        topic_type: "database",
        curriculum: [
          [
            {
              task: "SQL Joins",
              focus_points: ["INNER JOIN", "LEFT JOIN", "RIGHT JOIN"],
              questions: ["When does LEFT JOIN return NULL?", "Why use JOIN instead of a subquery?"],
              interview_questions: ["Explain all joins with examples.", "Compare JOIN vs UNION."],
              mistakes: ["Confusing LEFT and RIGHT joins."],
              tips: ["Always sketch the result table before you run the query."],
              mental_models: ["Think of joins as set intersections."],
              related_topics: ["Set theory", "Query execution plans"],
            },
          ],
          ["Practice writing 3 JOIN queries from a sample schema"],
          ["Window functions -- ROW_NUMBER, RANK, LAG/LEAD"],
        ],
      },
    ],
  };
}
