"""Per-user config: where it lives, how it's loaded, and the first-run setup flow."""
import json
import os
import shutil

import yaml

APP_DIR = os.path.expanduser("~/.mukund-os")
CONFIG_PATH = os.path.join(APP_DIR, "config.yaml")
STATE_PATH = os.path.join(APP_DIR, "state.json")
REPORTS_DIR = os.path.join(APP_DIR, "reports")

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
    """Creates ~/.mukund-os/config.yaml from the demo (default) or fresh template.
    Refuses to overwrite an existing config -- caller should confirm with the user first."""
    os.makedirs(APP_DIR, exist_ok=True)
    source = FRESH_CONFIG_PATH if fresh else DEMO_CONFIG_PATH
    shutil.copy(source, CONFIG_PATH)
    return CONFIG_PATH


def load_config():
    if not config_exists():
        raise FileNotFoundError(
            f"No config at {CONFIG_PATH}. Run `mukund-os init` first."
        )
    with open(CONFIG_PATH) as f:
        return yaml.safe_load(f)


def _save_config(cfg):
    os.makedirs(APP_DIR, exist_ok=True)
    with open(CONFIG_PATH, "w") as f:
        yaml.safe_dump(cfg, f, sort_keys=False, allow_unicode=True)


def _strip_meta_keys(d):
    """Drops the "_note"/"_instructions"-style documentation keys the template ships with."""
    return {k: v for k, v in d.items() if not k.startswith("_")}


def import_goals(json_path):
    """Builds or updates config.yaml from a goals JSON (see goals_template.json) --
    written by hand or by an AI assistant from a conversation about the user's goals.

    Safe to run repeatedly and safe to run after you've already been using the app:
    - New categories get added.
    - An existing category's curriculum is APPENDED to, never replaced or reordered --
      this is how you hand it "week 2" once week 1's curriculum runs out, without
      disturbing the days you've already tracked.
    - Other settings on an existing category (label, schedule, weight, ...) get updated
      to whatever the JSON says.
    - This function never opens state.json. Your tracked history is never touched by
      importing or editing goals -- only future, not-yet-registered days are affected.

    Returns (added_category_names, updated_category_names).
    """
    with open(json_path) as f:
        goals = _strip_meta_keys(json.load(f))

    cfg = load_config() if config_exists() else dict(_EMPTY_CONFIG)
    cfg.setdefault("categories", {})
    cfg.setdefault("category_order", [])
    cfg.setdefault("streak_categories", [])

    if "app_name" in goals:
        cfg["app_name"] = goals["app_name"]
    if "goal_line" in goals:
        cfg["goal_line"] = goals["goal_line"]

    added, updated = [], []
    for raw_cat in goals.get("categories", []):
        cat = _strip_meta_keys(raw_cat)
        name = cat["name"]
        existing = cfg["categories"].get(name)
        if existing is None:
            cfg["categories"][name] = {k: v for k, v in cat.items() if k != "name"}
            cfg["category_order"].append(name)
            if cat.get("fixed_labels") is None:
                cfg["streak_categories"].append(name)
            added.append(name)
        else:
            new_curriculum = cat.get("curriculum")
            for key in ("label", "days", "min_blocks", "addable", "deletable", "notes",
                        "score_weight", "fixed_labels"):
                if key in cat:
                    existing[key] = cat[key]
            if new_curriculum:
                existing.setdefault("curriculum", [])
                existing["curriculum"].extend(new_curriculum)
            updated.append(name)

    _save_config(cfg)
    return added, updated
