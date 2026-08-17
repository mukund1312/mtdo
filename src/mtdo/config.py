"""Per-user config: where it lives, how it's loaded, and the first-run setup flow."""
import json
import os
import shutil
from datetime import datetime

import yaml

APP_DIR = os.path.expanduser("~/.mtdo")
GOALS_PATH = os.path.join(APP_DIR, "goals.json")
GOALS_SNAPSHOTS_DIR = os.path.join(APP_DIR, "goals_snapshots")
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
                        "score_weight", "fixed_labels"):
                if key in cat_def:
                    existing[key] = cat_def[key]
            if new_curriculum:
                existing.setdefault("curriculum", [])
                existing["curriculum"].extend(new_curriculum)
            updated.append(name)

    return cfg, added, updated


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
