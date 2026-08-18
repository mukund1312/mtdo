"""Content library behind the Learning Coach panel: the universal learning framework,
topic-specific "ask yourself" / "interview check" question banks, and the rotating expert
tips -- all sourced from the MTDO Learning Coach spec. build_coaching_content() is the one
entry point app.py needs: it merges a task's own rich metadata (see goals_template.json's
rule_9) with these generic fallbacks so every task, annotated or not, gets useful coaching
content.
"""
import random

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
