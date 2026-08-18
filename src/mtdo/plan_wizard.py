"""The guided plan-setup wizard: a short, curated Q&A -- not the full 60-question deep
dive some career coaches use (real, but far too long to walk through one field at a
time in a terminal) -- that ends by handing a crafted prompt to whichever AI backend
the user is already using, so IT designs a personalized goals.json instead of mtdo
trying to template-fill one deterministically. Triggered by 'g' (TodoApp.action_plan_wizard).

Deliberately does NOT try to auto-inject the finished prompt into a live pty session:
a freshly-started Claude Code session might still be sitting on its own trust prompt or
other first-run onboarding, and blindly writing text into a pty in an unknown state
risks landing it somewhere wrong (e.g. typed into a menu selection instead of the chat
input). Instead the prompt is copied to the clipboard (pbcopy) and saved to a file, and
the user pastes it into the AI panel themselves -- one paste + enter, still entirely
inside the terminal, just without mtdo guessing at timing it can't actually observe.
"""
import os
import subprocess

from . import config as appconfig

PROMPT_OUTPUT_PATH = os.path.expanduser("~/.mtdo/plan_wizard_prompt.txt")

PERSONAS = [
    ("school", "School student (class 6-12)"),
    ("college", "College student"),
    ("exam", "Studying for an exam or certification"),
    ("job_switch", "Preparing for a job switch"),
]

# Asked to everyone first -- the "Universal Question Set" underneath every good plan
# regardless of stage of life: what you want, why, by when, where you actually are,
# and what's stopped you before. Everything persona-specific builds on top of this.
CORE_QUESTIONS = [
    ("goal", "What's your goal? (e.g. \"backend engineer role\", \"pass AWS SA exam\", \"finish 12th with 90%+\")"),
    ("why", "Why does this goal matter to you?"),
    ("deadline", "By when do you want to get there? (a date, or \"no fixed date\")"),
    ("current_level", "Where are you today -- how would you describe your current skill level here?"),
    ("hours_per_week", "Roughly how many hours a week can you realistically study?"),
    ("bottleneck", "What's stopped you before, or what feels like your biggest bottleneck right now?"),
    ("learning_style", "How do you learn best? (reading / videos / building things / teaching it to someone)"),
]

PERSONA_QUESTIONS = {
    "school": [
        ("grade", "What grade/class are you in, and which board (CBSE/ICSE/State/IB/other)?"),
        ("subjects", "Which subjects are your strongest, and which are weakest?"),
        ("competitive_exams", "Preparing for any competitive exams (Olympiads, NTSE, JEE/NEET Foundation)? Which, or none?"),
        ("career_interest", "Any career direction you're curious about yet, or too early to say?"),
    ],
    "college": [
        ("degree", "Degree, branch, and current year (e.g. \"BTech CS, 3rd year\")?"),
        ("cgpa", "Current CGPA (or \"prefer not to say\")?"),
        ("direction", "Job, higher studies, startup, or government exams -- which direction, or undecided?"),
        ("tech_comfort", "How comfortable are you with DSA, and with actually building things (projects)?"),
        ("experience", "Any internships or projects worth mentioning so far?"),
    ],
    "exam": [
        ("exam_name", "Which exam or certification, and when is it (or when do you plan to take it)?"),
        ("attempt", "First attempt, or a retake? If a retake, what was your score/weak areas last time?"),
        ("weak_topics", "Which syllabus topics feel weakest right now?"),
        ("resources", "What are you studying from -- books, a course, coaching, or not decided yet?"),
    ],
    "job_switch": [
        ("current_role", "Current role, company, and years of experience?"),
        ("target", "Target role, and (if any) dream companies?"),
        ("stack_gap", "Current tech stack vs. the stack you'd need for the target role -- what's the gap?"),
        ("interview_history", "How many interviews have you taken for this kind of role, and what's usually gone wrong?"),
    ],
}


def questions_for(persona):
    return CORE_QUESTIONS + PERSONA_QUESTIONS[persona]


def build_prompt(persona, answers):
    persona_label = dict(PERSONAS)[persona]
    prompts_by_key = dict(questions_for(persona))

    lines = [
        "I want you to design a personalized study/work plan for me as a goals.json file "
        "for mtdo (a terminal task board I use). Here's who I am and what I'm working toward:",
        "",
        f"Stage: {persona_label}",
    ]
    for key, value in answers.items():
        if key == "persona" or not value:
            continue
        lines.append(f"- {prompts_by_key.get(key, key)} -> {value}")

    lines += [
        "",
        f"Read the goals.json template at {appconfig.GOALS_TEMPLATE_PATH} first -- it documents the exact "
        "schema and every rule (fields vs curriculum vs fixed_labels, the weekly-menu system, topic_type, "
        "coaching_framework, score_weight, etc). Follow those rules exactly, especially rule_1 (one subject "
        "per field, never combined), rule_5 (curriculum is a weekly menu, not a day-by-day schedule), and "
        "rule_9/9b/9c (give the Learning Coach real, specific guidance for each field -- rich task metadata "
        "and a coaching_framework tuned to what I'm actually studying, not generic boilerplate).",
        "",
        "Design a complete plan that directly targets my stated goal and bottleneck above, split into "
        "sensible fields with real curriculum content for the first 1-2 weeks (not placeholder examples). "
        f"Write the result to {appconfig.GOALS_PATH} if it doesn't already exist, or confirm with me before "
        f"overwriting it if it does -- otherwise write to ./goals.json in the current directory instead, and "
        "tell me to review it and run `mtdo import goals.json`.",
    ]
    return "\n".join(lines)


def save_and_copy(prompt):
    """Saves the prompt to a file and tries to also put it on the clipboard (macOS
    pbcopy). Returns (path, copied_to_clipboard)."""
    os.makedirs(os.path.dirname(PROMPT_OUTPUT_PATH), exist_ok=True)
    with open(PROMPT_OUTPUT_PATH, "w") as f:
        f.write(prompt)
    try:
        subprocess.run(["pbcopy"], input=prompt.encode(), timeout=3)
        copied = True
    except (OSError, subprocess.SubprocessError):
        copied = False
    return PROMPT_OUTPUT_PATH, copied
