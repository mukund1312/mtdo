"""Content library behind the Learning Coach panel: the universal learning framework,
topic-specific "ask yourself" / "interview check" question banks, and the rotating expert
tips -- all sourced from the MTDO Learning Coach spec. build_coaching_content() is the one
entry point app.py needs: it merges a task's own rich metadata (see goals_template.json's
rule_9) with these generic fallbacks so every task, annotated or not, gets useful coaching
content.
"""
import random
import re

# ---- Universal framework (used when a task has no topic_type match / no own metadata) --

GENERIC_FOCUS_ON = [
    "What problem does this solve?",
    "Why does it exist?",
    "What assumptions does it make?",
    "What are the tradeoffs?",
    "What are the edge cases?",
]

GENERIC_ASK_YOURSELF = [
    "What is it?",
    "Why is it needed?",
    "How does it work?",
    "When should I use it?",
    "When should I NOT use it?",
]

GENERIC_INTERVIEW_CHECK = [
    "Explain it verbally.",
    "Draw it.",
    "Implement it.",
    "Compare alternatives.",
    "Explain tradeoffs.",
    "Give real-world examples.",
]

GENERIC_MISTAKES = [
    "Skipping edge cases.",
    "Memorizing the answer instead of the reasoning.",
]

GENERIC_MENTAL_MODELS = [
    "Can you draw this before you code it?",
]

MASTERY_LEVELS = [
    "1 = Heard of it", "2 = Understand it", "3 = Can implement it",
    "4 = Can optimize it", "5 = Can teach it",
]

# ---- Topic-specific frameworks -------------------------------------------------------
# Keyed by a category's optional "topic_type" (see goals_template.json rule_9).

TOPIC_FRAMEWORKS = {
    "dsa": {
        "ask_yourself": [
            "What is the brute-force solution?",
            "Why is it slow?",
            "What observation improves it?",
            "What data structure helps?",
            "Time Complexity?",
            "Space Complexity?",
            "Edge Cases?",
        ],
        "interview_check": [
            "Solve from scratch.",
            "Explain intuition.",
            "Explain complexity.",
            "Optimize further.",
            "Re-derive tomorrow.",
        ],
    },
    "backend": {
        "ask_yourself": [
            "What problem does this solve?",
            "What are the tradeoffs?",
            "What breaks first?",
            "What are bottlenecks?",
            "How does it scale?",
            "What happens at 10x traffic?",
            "What happens at 100x traffic?",
        ],
        "interview_check": [
            "Draw architecture.",
            "Explain request flow.",
            "Explain database interactions.",
            "Explain failure scenarios.",
            "Explain scaling strategy.",
        ],
    },
    "database": {
        "ask_yourself": [
            "Why does this query work?",
            "What indexes help?",
            "What is the execution plan?",
            "Can it be optimized?",
            "What happens on large datasets?",
        ],
        "interview_check": [
            "Write query from memory.",
            "Compare JOIN vs SUBQUERY.",
            "Explain execution order.",
            "Explain indexing impact.",
        ],
    },
    "system_design": {
        "ask_yourself": [
            "Requirements?", "Scale?", "APIs?", "Database?", "Cache?",
            "Load Balancer?", "Bottlenecks?", "Monitoring?", "Failure Modes?", "Tradeoffs?",
        ],
        "interview_check": [
            "If you cannot explain WHY you chose something, you do not understand it.",
        ],
    },
}

EXPERT_TIPS = [
    "Don't memorize solutions. Memorize reasoning.",
    "Understanding > Memorization.",
    "Implementation > Reading.",
    "Always ask WHY.",
    "Tradeoffs matter.",
    "Interviewers hire reasoning, not memorization.",
    "Draw diagrams before coding.",
    "Teach the concept aloud.",
    "If you cannot teach it, you do not understand it.",
]


# ---- DSA problem generation (Focus Mode only, see app.LearningCoachPanel) -----------
# For a "dsa" topic_type field, Focus Mode shows an AI-generated LeetCode-style problem
# statement for the active task instead of the coaching content above, so the person
# reasons through it themselves before the "Focus On/Ask Yourself/..." material (which
# already assumes familiarity) unlocks on completion. The two section markers below are
# instructed exactly so parse_dsa_problem_response can split them reliably regardless
# of which backend answers -- free-form prose would make that split unreliable.

_HINT_LINE_RE = re.compile(r"^\d+[.)]\s+(.*)")


def build_dsa_problem_prompt(task_text):
    return (
        f'Write a LeetCode-style problem statement for a DSA practice problem titled '
        f'"{task_text}".\n\n'
        "Do NOT reveal the algorithm, approach, or solution -- only the problem "
        "statement itself, exactly like a real interview platform shows BEFORE someone "
        "starts solving it.\n\n"
        "Format exactly like this, with these two section markers on their own lines "
        "and nothing else outside them (no preamble, no \"Here's the problem\", no code):\n\n"
        "===PROBLEM===\n"
        "<Title>\n"
        "Difficulty: <Easy/Medium/Hard -- your best guess>\n"
        "\n"
        "<Full problem description in 2-4 sentences>\n"
        "\n"
        "Example 1\n"
        "Input: <input>\n"
        "Output: <output>\n"
        "Explanation: <explanation>\n"
        "\n"
        "Example 2\n"
        "Input: <input>\n"
        "Output: <output>\n"
        "Explanation: <explanation>\n"
        "\n"
        "Constraints\n"
        "<bullet list of constraints>\n"
        "\n"
        "===HINTS===\n"
        "1. <a very small nudge -- points at the right general idea, no specifics>\n"
        "2. <a bit more specific -- names the right data structure or technique>\n"
        "3. <fairly specific -- describes the approach in words, but not code>\n"
        "4. <almost the full approach in words, still no code>\n"
    )


def parse_dsa_problem_response(text):
    """Splits the AI's raw response into (statement, hints_list). Falls back to
    treating the whole response as the statement with no hints if the expected
    ===PROBLEM===/===HINTS=== markers aren't there -- a differently-formatted
    response is still worth showing rather than discarding outright."""
    if "===HINTS===" in text:
        problem_part, hints_part = text.split("===HINTS===", 1)
    else:
        problem_part, hints_part = text, ""
    statement = problem_part.replace("===PROBLEM===", "").strip()
    hints = []
    for line in hints_part.splitlines():
        m = _HINT_LINE_RE.match(line.strip())
        if m:
            hints.append(m.group(1).strip())
    return statement, hints


def is_dsa_task(category_meta):
    """Whether a field's topic_type is "dsa" -- the gate for the Focus-Mode-only
    generated-problem behavior in app.LearningCoachPanel. Every other topic_type
    (backend/database/system_design/none) keeps the regular coaching content."""
    return bool((category_meta or {}).get("topic_type") == "dsa")


# ---- AI panel context priming (Focus Mode, any topic) --------------------------------
# The embedded AI panel (app.ClaudePanel/claude_panel.py) is just a live pty session --
# whatever backend the user picked (Claude Code, a local Ollama model, or an API chat)
# has zero awareness of what's on the board. TodoApp._prime_ai_context_if_needed sends
# the message below into that pty as if typed, once per active task, so the assistant
# starts from the right context instead of a cold, generic chat. Kept as ONE line (no
# embedded newlines) -- see PtyPanel.send_text for why a pty in canonical mode makes
# multi-line paste unsafe for a plain readline-based REPL like Ollama's.

TUTOR_FRAMEWORK = (
    "You are acting as my personal tutor for this focus session, not a solution generator -- "
    "please follow this teaching framework for everything I ask about the task below (and "
    "anything related I bring up) until I say otherwise. "
    "MISSION: my success is whether I can solve a similar problem alone afterward, not whether "
    "I get today's answer -- optimize for my independent ability, not today's answer. "
    "CORE RULES: "
    "1) Never give the final answer, code, query, or architecture immediately when I ask a "
    "question or get stuck -- first understand my current thinking, find my exact point of "
    "confusion, and guide me with questions, revealing the minimum needed, gradually. "
    "2) Discover before explain: before teaching a concept, ask questions that help me discover "
    "it myself (e.g. instead of 'use a hashmap', ask 'what would help you avoid searching again?'). "
    "3) Teach from Problem -> Need -> Solution, never Technology -> Definition -> Memorization -- "
    "I should understand WHY before HOW. "
    "4) Force me to explicitly state what the problem is asking, my assumptions, my brute-force "
    "approach, my reasoning, the trade-offs -- don't accept passive agreement, make me explain "
    "actively. "
    "5) Use progressive hinting, one level at a time, only advancing when I'm still stuck: "
    "(a) a guiding question, (b) narrow the focus, (c) suggest a direction, (d) mention a "
    "technique, (e) only then, the solution. "
    "Personality: patient, curious, encouraging, challenging, Socratic -- not a solution dump, "
    "not a lecturer, not a passive assistant. "
    "If what I ask about is DSA: restate the problem, find the brute force, analyze its "
    "complexity, find the bottleneck, discover the optimization, generalize the pattern -- ask "
    "what's the brute force, what's expensive, what info would help, what pattern this resembles. "
    "If it's SQL: have me visualize the table, restate the question in plain English, solve it "
    "manually first, then convert to SQL, then handle edge cases -- start with logic, not syntax. "
    "If it's backend/systems work: understand the business problem, inputs, outputs, data flow, "
    "API contract, security, and scale before code -- ask who uses this, what data enters/leaves, "
    "where it's stored, what can go wrong. "
    "If it's system design: clarify requirements and scale first, then data model, APIs, "
    "architecture, bottlenecks, trade-offs -- ask what we're building, how many users, "
    "read/write ratio, what breaks first. "
    "After a topic feels done, check I can actually explain it in my own words, why it works, "
    "when to use it, when NOT to, and the alternatives/trade-offs -- if I can't, keep teaching, "
    "don't move on."
)


def build_focus_context_message(task_text, category_label, dsa_problem=None):
    """The one-line message sent into the AI panel when priming it -- see TUTOR_FRAMEWORK
    above for why it has to stay single-line. Includes the already-generated DSA problem
    statement verbatim when there is one (see app.LearningCoachPanel), so the assistant
    doesn't improvise a different version of the same problem the student is looking at."""
    parts = [
        TUTOR_FRAMEWORK,
        f"Right now, in my Focus Mode session, I'm working on this task: \"{task_text}\" (field: {category_label}).",
    ]
    if dsa_problem and dsa_problem.get("statement"):
        parts.append(
            "Here's the exact problem statement already shown to me for this task -- use "
            "this one, don't restate or change it: " + dsa_problem["statement"]
        )
    parts.append("Please apply the framework above to whatever I ask from here about this task, or related topics.")
    return " ".join(part.replace("\n", " ") for part in parts)


def build_code_review_message(language_label, code):
    """The message sent into the AI panel when the student presses Ctrl+A in the
    Practice Lab (see practice_lab_panel.PracticeLabPanel.action_evaluate_code) --
    asks for a Socratic review of their current code instead of a verdict or a fix.
    Unlike TUTOR_FRAMEWORK/build_focus_context_message, real newlines are kept here:
    flattening code into one line would silently break it (Python indentation,
    e.g.) -- see PtyPanel.send_text's flatten parameter."""
    return (
        f"Here's the {language_label} code I've written so far for this problem. "
        "Please review it the way the tutor framework above asks: don't give me the "
        "correct solution or rewrite my code for me, and don't just say right or "
        "wrong -- look at where my current approach or reasoning is likely going "
        "wrong, or about to hit a wall, and ask me questions or give the smallest "
        "possible nudge that helps me see it myself and think in the right "
        "direction.\n\nMy code:\n" + code
    )


def has_coaching_setup(block, category_meta):
    """Whether there's any real coaching content for this task, or only the fully
    generic fallback would apply. A task's own rich metadata, a field-level
    coaching_framework, a topic_type, or field curriculum -- any of these means real
    content exists. A bare fixed_labels checklist or free-text field with none of
    that (e.g. "Gym", "Job Search" in the demo config) has nothing sensible to fall
    back to: "What problem does a gym session solve?" doesn't mean anything, so the
    panel should say plainly that nothing's set up here instead of showing generic
    DSA-shaped boilerplate that doesn't fit the field."""
    category_meta = category_meta or {}
    return bool(
        (block or {}).get("coaching")
        or category_meta.get("coaching_framework")
        or category_meta.get("topic_type")
        or category_meta.get("curriculum")
    )


def build_coaching_content(block, category_meta=None):
    """Three-tier merge, most-specific wins per field:

      1. The TASK's own rich metadata (block["coaching"], see goals_template.json
         rule_9) -- written for this exact task ("SQL Joins"), the most specific
         possible content.
      2. The FIELD's "coaching_framework" (category_meta["coaching_framework"], see
         rule_9c) -- personalized by whoever wrote goals.json for what THIS user is
         actually studying in this field right now (e.g. tuned to "Arrays & Hashmaps"
         specifically, not DSA in general). This is genuine personalization -- it lives
         in goals.json, not this file, precisely so it can be tailored per curriculum
         instead of being one fixed bucket shared by everyone.
      3. The built-in generic TOPIC_FRAMEWORKS bucket keyed by category_meta["topic_type"]
         (dsa/backend/database/system_design), falling back further to the fully generic
         GENERIC_* constants -- the safety net so the panel is never empty for a field
         nobody's gotten around to personalizing yet.

    category_meta is the dict from core.CATEGORY_META[category] (or None). Returns a
    dict with the Learning Coach panel's sections: focus_on, ask_yourself,
    interview_check, mistakes, mental_models, pro_tip, related_topics."""
    meta = (block or {}).get("coaching") or {}
    category_meta = category_meta or {}
    field_framework = category_meta.get("coaching_framework") or {}
    topic_framework = TOPIC_FRAMEWORKS.get(category_meta.get("topic_type"), {})

    focus_on = meta.get("focus_points") or field_framework.get("focus_on") or GENERIC_FOCUS_ON
    ask_yourself = (meta.get("questions") or field_framework.get("ask_yourself")
                    or topic_framework.get("ask_yourself") or GENERIC_ASK_YOURSELF)
    interview_check = (meta.get("interview_questions") or field_framework.get("interview_check")
                        or topic_framework.get("interview_check") or GENERIC_INTERVIEW_CHECK)
    mistakes = meta.get("mistakes") or field_framework.get("mistakes") or GENERIC_MISTAKES
    mental_models = meta.get("mental_models") or field_framework.get("mental_models") or GENERIC_MENTAL_MODELS
    related_topics = meta.get("related_topics") or field_framework.get("related_topics") or []
    tips = meta.get("tips") or field_framework.get("tips")
    pro_tip = tips[0] if tips else random.choice(EXPERT_TIPS)

    return {
        "focus_on": focus_on,
        "ask_yourself": ask_yourself,
        "interview_check": interview_check,
        "mistakes": mistakes,
        "mental_models": mental_models,
        "pro_tip": pro_tip,
        "related_topics": related_topics,
    }
