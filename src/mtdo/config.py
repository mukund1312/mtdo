"""Per-user config: where it lives, how it's loaded, and the first-run setup flow."""
import json
import os
import shutil
from datetime import datetime

import yaml

# APP_DIR is the one thing every other module in this package should derive its own
# ~/.mtdo-rooted paths from (import this module and use appconfig.APP_DIR) rather than
# calling os.path.expanduser("~/.mtdo") themselves -- that's what makes MTDO_HOME below
# actually relocate the WHOLE app's data, not just goals/state. Defaults to the real
# ~/.mtdo untouched (existing behavior for every current install), but honors MTDO_HOME
# when set, so a completely separate, disposable install can run alongside it without
# ever touching real data -- see sandbox_entry.py (the `mtdo-sandbox` command) for the
# intended way to use this rather than setting the env var by hand.
APP_DIR = os.environ.get("MTDO_HOME") or os.path.expanduser("~/.mtdo")
GOALS_PATH = os.path.join(APP_DIR, "goals.json")
GOALS_SNAPSHOTS_DIR = os.path.join(APP_DIR, "goals_snapshots")
CONFIG_PATH = os.path.join(APP_DIR, "config.yaml")
STATE_PATH = os.path.join(APP_DIR, "state.json")
REPORTS_DIR = os.path.join(APP_DIR, "reports")
ONBOARDED_PATH = os.path.join(APP_DIR, "onboarded")
USER_NAME_PATH = os.path.join(APP_DIR, "user_name")


def get_user_name():
    """The name given at first-run setup (see cli._run_first_run_wizard), or None if
    never set. A plain marker file, same pattern as has_onboarded()/practice_terminal_
    enabled() below -- deliberately NOT in config.yaml, which gets regenerated from
    goals.json in Option A mode and would silently lose this on the next import."""
    if not os.path.exists(USER_NAME_PATH):
        return None
    with open(USER_NAME_PATH) as f:
        name = f.read().strip()
    return name or None


def set_user_name(name):
    os.makedirs(APP_DIR, exist_ok=True)
    with open(USER_NAME_PATH, "w") as f:
        f.write(name)


def has_onboarded():
    """Whether the first-launch walkthrough (app.OnboardingScreen) has already been
    shown -- a plain marker file rather than anything in state.json/config.yaml, since
    it's not really app data, just "have we said hello yet"."""
    return os.path.exists(ONBOARDED_PATH)


def mark_onboarded():
    os.makedirs(APP_DIR, exist_ok=True)
    with open(ONBOARDED_PATH, "w") as f:
        f.write("")


PLAN_CONFIGURED_PATH = os.path.join(APP_DIR, "plan_configured")


def has_configured_plan():
    """Whether the user has already been through the "how do you want to build your
    plan" step (Manual vs Guided setup) at least once. Replaces the old auto-launch
    signal (`get_user_name() is None`) after the 2026-08-24 wizard rework (gh47) dropped
    the separate name-asking step -- profiles already carry identity (ClockHeader's
    greeting already prefers the active profile's name over get_user_name(), so nothing
    else needed that question either). Same semantics as before: marked as soon as a
    choice is made, not only once guided setup is fully completed -- gates whether
    _begin_setup_flow() auto-launches on startup, not whether 'g' can re-run it."""
    return os.path.exists(PLAN_CONFIGURED_PATH)


def mark_plan_configured():
    os.makedirs(APP_DIR, exist_ok=True)
    with open(PLAN_CONFIGURED_PATH, "w") as f:
        f.write("")


PRACTICE_TERMINAL_FLAG_PATH = os.path.join(APP_DIR, "practice_terminal_enabled")


def practice_terminal_enabled():
    """Whether the optional third column in Focus Mode's second row (the Practice
    Lab -- language picker, editor, run, AI time/space complexity, see
    practice_lab_panel.py -- alongside the Learning Coach and the AI panel) is turned
    on -- off by default, since not everyone wants a third column; toggled with
    Shift+T (TodoApp.action_toggle_practice_terminal), a plain marker file same as
    has_onboarded() above since it's a UI preference, not tracked app data."""
    return os.path.exists(PRACTICE_TERMINAL_FLAG_PATH)


def set_practice_terminal_enabled(enabled):
    os.makedirs(APP_DIR, exist_ok=True)
    if enabled:
        with open(PRACTICE_TERMINAL_FLAG_PATH, "w") as f:
            f.write("")
    else:
        try:
            os.remove(PRACTICE_TERMINAL_FLAG_PATH)
        except OSError:
            pass


_PACKAGE_DIR = os.path.dirname(os.path.abspath(__file__))
DEMO_CONFIG_PATH = os.path.join(_PACKAGE_DIR, "demo_config.yaml")
FRESH_CONFIG_PATH = os.path.join(_PACKAGE_DIR, "fresh_config.yaml")
GOALS_TEMPLATE_PATH = os.path.join(_PACKAGE_DIR, "goals_template.json")

_EMPTY_CONFIG = {
    "app_name": "TASK OS", "goal_line": "", "plan_start": None, "plan_end": None,
    "backlog_lookback_days": 3, "streak_warning": 3,
    "category_order": [], "streak_categories": [], "categories": {},
}


def config_exists():
    return os.path.exists(CONFIG_PATH)


def init_config(fresh=False):
    """Creates ~/.mtdo/config.yaml from the demo (default) or fresh template.
    Refuses to overwrite an existing config -- caller should confirm with the user first."""
    os.makedirs(APP_DIR, exist_ok=True)
    source = FRESH_CONFIG_PATH if fresh else DEMO_CONFIG_PATH
    shutil.copy(source, CONFIG_PATH)
    return CONFIG_PATH


def load_config():
    if not config_exists():
        raise FileNotFoundError(
            f"No config at {CONFIG_PATH}. Run `mtdo init` first."
        )
    with open(CONFIG_PATH) as f:
        return yaml.safe_load(f)


def _save_config(cfg):
    os.makedirs(APP_DIR, exist_ok=True)
    with open(CONFIG_PATH, "w") as f:
        yaml.safe_dump(cfg, f, sort_keys=False, allow_unicode=True)


def _strip_meta_keys(d):
    """Drops the "_note"/"_instructions"-style documentation keys the template ships with."""
    if isinstance(d, dict):
        result = {}
        for k, v in d.items():
            if not k.startswith("_"):
                result[k] = _strip_meta_keys(v) if isinstance(v, (dict, list)) else v
        return result
    elif isinstance(d, list):
        return [_strip_meta_keys(item) if isinstance(item, (dict, list)) else item for item in d]
    return d


def load_goals():
    """Load goals.json directly (the single source of truth in Option A mode)."""
    if not os.path.exists(GOALS_PATH):
        raise FileNotFoundError(
            f"No goals.json at {GOALS_PATH}. Run `mtdo template goals.json` to create one, "
            f"then `mtdo import goals.json` to set it up."
        )
    with open(GOALS_PATH) as f:
        return _strip_meta_keys(json.load(f))


def create_snapshot():
    """Create a timestamped snapshot of goals.json in goals_snapshots/ directory.
    Returns the snapshot filename if created, None if no changes since last snapshot."""
    if not os.path.exists(GOALS_PATH):
        return None

    os.makedirs(GOALS_SNAPSHOTS_DIR, exist_ok=True)

    with open(GOALS_PATH) as f:
        current_goals = json.load(f)

    timestamp = datetime.now().strftime("%Y-%m-%d_%H-%M-%S")
    snapshot_path = os.path.join(GOALS_SNAPSHOTS_DIR, f"goals_{timestamp}.json")

    with open(snapshot_path, "w") as f:
        json.dump(current_goals, f, indent=2, sort_keys=False)

    return os.path.basename(snapshot_path)


def get_snapshot_manifest():
    """Get list of all snapshots with metadata."""
    if not os.path.exists(GOALS_SNAPSHOTS_DIR):
        return []

    snapshots = []
    for filename in sorted(os.listdir(GOALS_SNAPSHOTS_DIR)):
        if filename.startswith("goals_") and filename.endswith(".json"):
            filepath = os.path.join(GOALS_SNAPSHOTS_DIR, filename)
            stat = os.stat(filepath)
            snapshots.append({
                "filename": filename,
                "timestamp": filename.replace("goals_", "").replace(".json", ""),
                "size": stat.st_size,
                "path": filepath,
            })
    return sorted(snapshots, key=lambda x: x["timestamp"], reverse=True)


def goals_to_config(goals, existing_cfg=None):
    """Convert goals.json to config dict format (merges with existing config if provided).

    When existing_cfg is provided:
    - New categories get added
    - Existing categories get curriculum APPENDED (safe for week 1 -> week 2 progression)
    - Other settings (label, days, weights) get updated

    When existing_cfg is None, builds from scratch.
    """
    if existing_cfg is None:
        cfg = dict(_EMPTY_CONFIG)
    else:
        cfg = dict(existing_cfg)

    cfg.setdefault("categories", {})
    cfg.setdefault("category_order", [])
    cfg.setdefault("streak_categories", [])

    if "app_name" in goals:
        cfg["app_name"] = goals["app_name"]
    if "goal_line" in goals:
        cfg["goal_line"] = goals["goal_line"]
    if "plan_start" in goals:
        cfg["plan_start"] = goals["plan_start"]
    if "plan_end" in goals:
        cfg["plan_end"] = goals.get("plan_end")

    added, updated = [], []
    for cat_def in goals.get("categories", []):
        name = cat_def["name"]
        existing = cfg["categories"].get(name)

        cat_config = {k: v for k, v in cat_def.items() if k != "name"}

        if existing is None:
            cfg["categories"][name] = cat_config
            cfg["category_order"].append(name)
            if cat_def.get("fixed_labels") is None:
                cfg["streak_categories"].append(name)
            added.append(name)
        else:
            new_curriculum = cat_def.get("curriculum")
            for key in ("label", "days", "min_blocks", "addable", "deletable", "notes",
                        "score_weight", "fixed_labels", "topic_type", "coaching_framework"):
                if key in cat_def:
                    existing[key] = cat_def[key]
            if new_curriculum:
                existing_curriculum = existing.setdefault("curriculum", [])
                # goals.json is the file you keep editing in place -- "week 2" usually means
                # appending new day-lists onto the SAME curriculum array and re-importing,
                # so new_curriculum typically already contains week 1 again too. Skip the
                # common prefix so only genuinely new entries get appended; re-importing
                # identical content is then a true no-op instead of duplicating everything.
                overlap = 0
                for old, new in zip(existing_curriculum, new_curriculum):
                    if old != new:
                        break
                    overlap += 1
                existing_curriculum.extend(new_curriculum[overlap:])
            updated.append(name)

    return cfg, added, updated


def add_category_to_goals(new_category):
    """Appends one new category dict (as produced by the app's in-app 'Add Field' flow)
    to goals.json and writes it back. goals.json remains the single source of truth --
    the running app re-reads it (see app.py's file-watch reload) rather than this function
    mutating the live app state directly.

    Bootstraps a fresh goals.json (just {"categories": []}) if none exists yet --
    a profile with no goals.json is a normal, valid state (a brand-new profile,
    or one whose active profile has no goals set -- see TodoApp._switch_profile),
    and "Add Field" is often the first thing you'd do to start populating one, so
    it shouldn't be a dead end. Raises ValueError if the name is taken.
    """
    if os.path.exists(GOALS_PATH):
        with open(GOALS_PATH) as f:
            goals = json.load(f)
    else:
        goals = {}
    goals.setdefault("categories", [])
    if any(c.get("name") == new_category["name"] for c in goals["categories"]):
        raise ValueError(f"Category '{new_category['name']}' already exists.")
    goals["categories"].append(new_category)
    with open(GOALS_PATH, "w") as f:
        json.dump(goals, f, indent=2, sort_keys=False)


def append_extra_task(category, text):
    """Records a card you added by hand in the app (not from the curriculum) back into
    goals.json, under that category's 'extra_tasks' list -- so goals.json stays a living
    record of everything you've actually worked on, including stuff you added yourself,
    for whoever (you or an AI) reads it later to plan the next week. Deliberately kept
    separate from 'curriculum': it doesn't touch the cursor/week-batch mechanism, it's
    just a log. No-op if goals.json or the category doesn't exist (e.g. state.json-only
    setups, or a category that's since been renamed)."""
    if not os.path.exists(GOALS_PATH):
        return
    with open(GOALS_PATH) as f:
        goals = json.load(f)
    for cat in goals.get("categories", []):
        if cat.get("name") == category:
            cat.setdefault("extra_tasks", []).append(text)
            break
    else:
        return
    with open(GOALS_PATH, "w") as f:
        json.dump(goals, f, indent=2, sort_keys=False)


def import_goals(json_path):
    """Builds or updates goals.json from a user-provided JSON file.

    Safe to run repeatedly and safe to run after you've already been using the app:
    - New categories get added.
    - An existing category's curriculum is APPENDED to, never replaced or reordered --
      this is how you hand it "week 2" once week 1's curriculum runs out, without
      disturbing the days you've already tracked.
    - Other settings on an existing category (label, schedule, weight, ...) get updated
      to whatever the JSON says.
    - This function never opens state.json. Your tracked history is never touched by
      importing or editing goals -- only future, not-yet-registered days are affected.

    Also creates a timestamped snapshot of the old goals.json (if it exists) before updating.

    Returns (added_category_names, updated_category_names).
    """
    os.makedirs(APP_DIR, exist_ok=True)

    # Create snapshot of old goals if they exist
    if os.path.exists(GOALS_PATH):
        create_snapshot()

    # Load new goals from provided JSON
    with open(json_path) as f:
        new_goals = _strip_meta_keys(json.load(f))

    # Copy to goals.json (becomes the new source of truth)
    with open(GOALS_PATH, "w") as f:
        json.dump(new_goals, f, indent=2, sort_keys=False)

    # Also update config.yaml for backward compatibility
    existing_cfg = load_config() if config_exists() else None
    cfg, added, updated = goals_to_config(new_goals, existing_cfg)
    _save_config(cfg)

    return added, updated
