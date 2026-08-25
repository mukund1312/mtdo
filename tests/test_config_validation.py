"""Regression tests for gh39: a hand-edited goals.json/config.yaml with a mistake
used to surface as a raw JSONDecodeError/YAMLError/KeyError/TypeError straight out of
json.load, yaml.safe_load, or the dict-walking in config.goals_to_config/core.configure
-- correct in that it stopped rather than corrupting anything on disk, but gave no
indication of what was actually wrong, and (worse, for the live-reload path) could
leave core.py's globals half-updated partway through a crash. These tests cover the
CLI-startup path (main()) and the live in-app path (TodoApp.check_goals_file, polled
every 2s) with a real, running app -- not just the raw config.ConfigError call sites --
since the sharpest version of this bug was the live app crashing entirely on a bad
hand-edit made while it was already running.
"""
import json
import os

from mtdo import config as appconfig
from mtdo import core as tc
from mtdo.app import TodoApp, ToastLine


def _write_goals(obj_or_text):
    if isinstance(obj_or_text, str):
        with open(appconfig.GOALS_PATH, "w") as f:
            f.write(obj_or_text)
    else:
        with open(appconfig.GOALS_PATH, "w") as f:
            json.dump(obj_or_text, f)


def test_load_goals_bad_json_syntax_raises_config_error():
    _write_goals("{ this is not valid json ][")
    try:
        appconfig.load_goals()
        assert False, "should have raised"
    except appconfig.ConfigError as e:
        assert "valid JSON" in str(e)


def test_load_goals_wrong_top_level_shape_raises_config_error():
    _write_goals("[1, 2, 3]")
    try:
        appconfig.load_goals()
        assert False, "should have raised"
    except appconfig.ConfigError as e:
        assert "JSON object" in str(e)


def test_goals_to_config_categories_not_a_list_raises_config_error():
    goals = {"categories": {"oops": 1}}
    try:
        appconfig.goals_to_config(goals)
        assert False, "should have raised"
    except appconfig.ConfigError as e:
        assert "list" in str(e)


def test_goals_to_config_category_missing_name_raises_config_error():
    goals = {"categories": [{"label": "DSA"}]}
    try:
        appconfig.goals_to_config(goals)
        assert False, "should have raised"
    except appconfig.ConfigError as e:
        assert "name" in str(e)


def test_core_configure_category_missing_label_raises_config_error_not_keyerror():
    """The exact crash hit live earlier the same day this fix was written:
    KeyError: 'label' straight out of core.configure, from a test profile's
    goals.json that had a name but no label/days."""
    goals = {"categories": [{"name": "dsa"}]}
    cfg, _, _ = appconfig.goals_to_config(goals)
    try:
        tc.configure(cfg)
        assert False, "should have raised"
    except appconfig.ConfigError as e:
        assert "label" in str(e)


async def test_live_app_survives_bad_hand_edit_without_crashing():
    """The sharpest version of gh39: check_goals_file polls every 2s, so a bad
    hand-edit made while the app is already running used to take the whole
    session down almost immediately, wiping whatever unsaved in-app state
    existed. Confirms the running app instead keeps its previous category
    state, shows a clear toast, and automatically recovers once the file is
    fixed -- without ever crashing."""
    _write_goals({"categories": [{"name": "dsa", "label": "DSA", "days": list(range(7))}]})

    app = TodoApp()
    async with app.run_test() as pilot:
        await pilot.pause()
        app.reload_from_goals()
        assert "dsa" in tc.CATEGORY_META

        _write_goals("{ totally broken json ][")
        os.utime(appconfig.GOALS_PATH, None)
        app.check_goals_file()
        await pilot.pause()

        assert app.is_running, "a bad hand-edit must not crash the app"
        assert "dsa" in tc.CATEGORY_META, "previous category state must be preserved"
        toast_text = app.query_one(ToastLine).content.plain
        assert "problem" in toast_text.lower()

        _write_goals({"categories": [{"name": "dsa", "label": "DSA v2", "days": list(range(7))}]})
        os.utime(appconfig.GOALS_PATH, None)
        app.check_goals_file()
        await pilot.pause()
        assert tc.CATEGORY_META["dsa"]["label"] == "DSA v2", "must recover once the file is fixed"


async def test_live_app_survives_bad_edit_with_missing_required_field():
    """Same as above, but the failure mode that core.configure's own validation
    catches (valid JSON, valid category list shape, but missing "label") rather
    than a JSON syntax error caught earlier in the pipeline -- confirms the bad
    category never partially lands in CATEGORY_META either."""
    _write_goals({"categories": [{"name": "dsa", "label": "DSA", "days": list(range(7))}]})

    app = TodoApp()
    async with app.run_test() as pilot:
        await pilot.pause()
        app.reload_from_goals()
        assert "dsa" in tc.CATEGORY_META

        _write_goals({"categories": [{"name": "new_field"}]})
        os.utime(appconfig.GOALS_PATH, None)
        app.check_goals_file()
        await pilot.pause()

        assert app.is_running
        assert "dsa" in tc.CATEGORY_META, "previous state preserved"
        assert "new_field" not in tc.CATEGORY_META, "the invalid category must not partially land"
        toast_text = app.query_one(ToastLine).content.plain
        assert "label" in toast_text.lower()
