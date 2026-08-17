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


def build_coaching_content(block, topic_type=None):
    """Merges a task's own rich metadata (block.get("coaching"), see goals_template.json
    rule_9) with generic/topic-specific fallbacks. Returns a dict with the Learning Coach
    panel's six sections: focus_on, ask_yourself, interview_check, mistakes,
    mental_models, pro_tip -- each a list of strings (pro_tip is a single string).
    block may be None (nothing active right now) -- callers should handle that themselves,
    this always returns a fully generic framework so the panel never has nothing to show."""
    meta = (block or {}).get("coaching") or {}
    framework = TOPIC_FRAMEWORKS.get(topic_type, {})

    focus_on = meta.get("focus_points") or GENERIC_FOCUS_ON
    ask_yourself = meta.get("questions") or framework.get("ask_yourself") or GENERIC_ASK_YOURSELF
    interview_check = meta.get("interview_questions") or framework.get("interview_check") or GENERIC_INTERVIEW_CHECK
    mistakes = meta.get("mistakes") or GENERIC_MISTAKES
    mental_models = meta.get("mental_models") or GENERIC_MENTAL_MODELS
    tips = meta.get("tips")
    pro_tip = tips[0] if tips else random.choice(EXPERT_TIPS)

    return {
        "focus_on": focus_on,
        "ask_yourself": ask_yourself,
        "interview_check": interview_check,
        "mistakes": mistakes,
        "mental_models": mental_models,
        "pro_tip": pro_tip,
    }
