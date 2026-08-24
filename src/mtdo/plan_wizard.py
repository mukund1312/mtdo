"""Guided setup: export the self-documenting goals_template.json, hand it (plus a fixed
prompt) to whatever AI the user already uses, then import the goals.json it hands back.
No questions asked in-app and no AI called by mtdo itself -- see app.py's
GuidedSetupScreen and gh47 (formerly the persona+Q&A wizard covered by bugs #6/#13,
now superseded; see PROGRESS.md 2026-08-24 for why).

Deliberately not automatic: an earlier design (bugs #6/#13, put on hold 2026-08-23) had
mtdo call an AI backend itself non-interactively to write goals.json directly. That
needed either an untested single long structured non-interactive AI call (every other
background AI call in this app is a short one-shot query) or, for "an AI I already use"
(ChatGPT, Gemini, etc.), API access mtdo doesn't have at all. This design needs neither:
goals_template.json is already self-contained (its own "_instructions"/"_read_this_first"
keys are written to be pasted straight into an AI conversation), so mtdo's job shrinks to
exporting that file, offering a short prompt to go with it, and importing whatever comes
back -- reusing appconfig.import_goals(), which already existed for the CLI `mtdo import`.
"""
import os
import shutil
import subprocess

from . import config as appconfig

PROMPT_OUTPUT_PATH = os.path.join(appconfig.APP_DIR, "plan_wizard_prompt.txt")

GUIDED_SETUP_PROMPT = (
    "I'm setting up mtdo, a terminal task board. I'm attaching/pasting its "
    "goals_template.json -- read its \"_instructions\" and \"_read_this_first\" keys "
    "carefully first, they document the exact schema and every rule. Ask me about my "
    "goals, schedule, and what I want to work on, then fill in the template's "
    "\"categories\" (and app_name/goal_line) to build my personalized goals.json. Follow "
    "every rule in the template exactly, especially rule_1 (one subject per field, never "
    "combined), rule_5 (curriculum is a weekly menu, not a day-by-day schedule), and "
    "rule_9/9b/9c (give the Learning Coach real, specific guidance tuned to what I'm "
    "actually studying, not generic boilerplate). Give me back the complete JSON so I can "
    "save it and import it."
)


def export_template():
    """Copies goals_template.json to ~/Downloads (or the home directory if Downloads
    doesn't exist) so there's a real file to hand to an AI. Never overwrites an existing
    file there -- appends a numeric suffix instead, so re-exporting never clobbers a copy
    the user's already mid-edit on. Returns the path written to."""
    downloads = os.path.expanduser("~/Downloads")
    dest_dir = downloads if os.path.isdir(downloads) else os.path.expanduser("~")
    dest = os.path.join(dest_dir, "goals_template.json")
    n = 1
    while os.path.exists(dest):
        dest = os.path.join(dest_dir, f"goals_template ({n}).json")
        n += 1
    shutil.copy(appconfig.GOALS_TEMPLATE_PATH, dest)
    return dest


def save_and_copy(prompt):
    """Saves a prompt to a file and tries to also put it on the clipboard (macOS
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
