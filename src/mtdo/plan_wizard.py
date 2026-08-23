"""The guided plan-setup wizard: a bespoke, per-persona Q&A (mostly multiple-choice,
a few free-text) that ends by handing a crafted prompt to whichever AI backend the user
is already using, so IT designs a personalized goals.json instead of mtdo trying to
template-fill one deterministically. Triggered automatically on first launch, or anytime
via 'g' (TodoApp.action_plan_wizard / _begin_setup_flow).

Deliberately does NOT try to auto-inject the finished prompt into a live pty session:
a freshly-started Claude Code session might still be sitting on its own trust prompt or
other first-run onboarding, and blindly writing text into a pty in an unknown state
risks landing it somewhere wrong (e.g. typed into a menu selection instead of the chat
input). Instead the prompt is copied to the clipboard (pbcopy) and saved to a file, and
the user pastes it into the AI panel themselves -- one paste + enter, still entirely
inside the terminal, just without mtdo guessing at timing it can't actually observe.

Each question is (key, prompt_text, choices) -- choices is None for a free-text answer,
or a list of option strings for a single-select multiple choice (rendered as a picker
list in-app, see app.py's ChoicePickScreen). Unlike the earlier version of this wizard,
there's no shared "core" question set underneath every persona -- each persona (including
"just exploring", which used to skip the Q&A entirely and only load the demo) has its own
complete, bespoke question list, per exact user specification.
"""
import os
import subprocess

from . import config as appconfig

PROMPT_OUTPUT_PATH = os.path.join(appconfig.APP_DIR, "plan_wizard_prompt.txt")

PERSONAS = [
    ("school", "School Student (Class 6-12)"),
    ("college", "College Student"),
    ("exam", "Studying for an Exam or Certification"),
    ("job_switch", "Preparing for a Job Switch"),
    ("just_exploring", "Just Exploring the App"),
]

QUESTIONS = {
    "school": [
        ("goal", "What's your academic goal? (e.g. \"Score 90%+ in Class 10 Boards\", "
                 "\"Improve Maths marks\", \"Crack NTSE\", \"Get into a top college\")", None),
        ("why", "Why is this important to you?", None),
        ("class", "Which class are you currently in?",
         ["Class 6", "Class 7", "Class 8", "Class 9", "Class 10", "Class 11", "Class 12"]),
        ("subjects", "Which subjects do you want the most help with?", None),
        ("level", "What's your current performance level?",
         ["Top performer", "Above average", "Average", "Struggling"]),
        ("hours_per_week", "How many hours per week can you study outside school?", None),
        ("challenge", "What's your biggest challenge right now?",
         ["Staying consistent", "Understanding concepts", "Memorization",
          "Exams & test anxiety", "Time management", "Distractions"]),
        ("learning_style", "How do you learn best?",
         ["Reading", "Videos", "Practice questions", "Projects/Experiments", "Teaching others"]),
    ],
    "college": [
        ("goal", "What's your main goal right now? (e.g. \"Improve GPA\", \"Learn AI/ML\", "
                 "\"Become a Backend Engineer\", \"Build projects\", \"Get internships\", "
                 "\"Prepare for placements\")", None),
        ("year", "Which year are you in?", ["1st Year", "2nd Year", "3rd Year", "Final Year"]),
        ("degree", "What degree are you pursuing?", None),
        ("skills", "What skills are you trying to develop?", None),
        ("level", "What's your current level?", ["Beginner", "Intermediate", "Advanced"]),
        ("deadline", "When would you like to achieve this goal?", None),
        ("hours_per_week", "How many hours per week can you dedicate?", None),
        ("bottleneck", "What's your biggest bottleneck?",
         ["Consistency", "Lack of guidance", "Too many resources", "Time management",
          "Fear of interviews", "Weak fundamentals"]),
        ("learning_style", "How do you learn best?",
         ["Reading", "Videos", "Building projects", "Coding challenges", "Group study"]),
    ],
    "exam": [
        ("exam_name", "Which exam or certification are you preparing for? (e.g. "
                       "\"AWS Solutions Architect\", \"GATE\", \"CAT\", \"IELTS\", \"GRE\", \"PMP\")", None),
        ("exam_date", "When is the exam?", None),
        ("attempt", "Is this your first attempt or a retake?", ["First Attempt", "Retake"]),
        ("retake_notes", "If retaking, what happened last time? (say \"N/A\" if first attempt)", None),
        ("target_score", "What score or result are you aiming for?", None),
        ("weak_topics", "Which topics feel weakest right now?", None),
        ("materials", "What study materials are you using?",
         ["Books", "Online course", "Coaching", "Practice tests", "Not decided"]),
        ("hours_per_week", "How many hours per week can you study?", None),
        ("challenge", "What's your biggest challenge?",
         ["Understanding concepts", "Retention", "Time management", "Practice questions",
          "Exam anxiety", "Consistency"]),
    ],
    "job_switch": [
        ("target_role", "What's your target role? (e.g. \"Backend Engineer\", \"Product Manager\", "
                         "\"Data Scientist\", \"DevOps Engineer\", \"SDE-2\")", None),
        ("experience", "How many years of experience do you have?", None),
        ("current_role", "What's your current role?", None),
        ("company_type", "What's your target company type?",
         ["Startup", "Product Company", "FAANG / Big Tech", "Consulting", "Open to anything"]),
        ("timeline", "What's your target timeline?",
         ["Within 1 month", "Within 3 months", "Within 6 months", "No fixed timeline"]),
        ("help_areas", "What areas do you need help with?",
         ["DSA", "System Design", "Backend Development", "Frontend Development", "Resume",
          "Mock Interviews", "Behavioral Interviews", "Job Applications"]),
        ("obstacle", "What's your biggest obstacle today?",
         ["Not getting interviews", "Failing coding rounds", "Failing system design",
          "Lack of projects", "Resume issues", "Lack of consistency"]),
        ("hours_per_week", "How many hours per week can you realistically dedicate?", None),
    ],
    "just_exploring": [
        ("motivation", "What made you try the app today?", None),
        ("curiosity", "What are you most curious about?",
         ["Learning new skills", "Productivity", "Career growth", "AI assistance",
          "Exam preparation", "General knowledge"]),
        ("has_goal", "Do you currently have any goals you're working toward?", ["Yes", "No", "Not sure"]),
        ("goal_detail", "If yes, what is it? (say \"N/A\" if not)", None),
        ("help_style", "How would you like the app to help you?",
         ["Personalized learning plans", "Daily guidance", "Practice questions",
          "Progress tracking", "Accountability", "Exploring topics"]),
        ("usage_frequency", "How often do you plan to use the app?",
         ["Daily", "Few times a week", "Weekly", "Just trying it out"]),
        ("value", "What would make this app valuable enough for you to keep using it?", None),
    ],
}


def questions_for(persona):
    return QUESTIONS[persona]


def build_prompt(persona, answers):
    persona_label = dict(PERSONAS)[persona]
    prompts_by_key = {key: prompt_text for key, prompt_text, _choices in questions_for(persona)}

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
        "Design a complete plan that directly targets my stated goal and biggest challenge/bottleneck above, "
        "split into sensible fields with real curriculum content for the first 1-2 weeks (not placeholder "
        f"examples). Write the result to {appconfig.GOALS_PATH} if it doesn't already exist, or confirm with "
        f"me before overwriting it if it does -- otherwise write to ./goals.json in the current directory "
        "instead, and tell me to review it and run `mtdo import goals.json`.",
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
