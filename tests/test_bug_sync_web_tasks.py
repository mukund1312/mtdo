"""Tests for the web-dev task board (docs/designs/mtdo-web-dev-split-plan.md §7):
web-dev work items share the same tracker repo/board as bugs, filed under WEB_LABEL
instead of LABEL and tagged with a wave:<name> label in place of a priority.
subprocess is mocked throughout -- no real gh CLI/network calls.
"""
from unittest.mock import patch

import pytest

from mtdo import bug_sync


def _run_side_effect(existing_labels=()):
    """Fakes `_run`'s two call shapes file_task() makes: `gh label list` returns a
    newline-joined label list, `gh issue create` returns a fake issue URL."""
    def _side_effect(args):
        if args[:3] == ["gh", "label", "list"]:
            return "\n".join(existing_labels)
        if args[:3] == ["gh", "issue", "create"]:
            return "https://github.com/mukund1312/mtdo-bugs/issues/501"
        raise AssertionError(f"unexpected _run call: {args}")
    return _side_effect


def test_list_all_passes_the_given_label_through():
    with patch("mtdo.bug_sync._run", return_value="[]") as mock_run:
        bug_sync.list_all(label=bug_sync.WEB_LABEL)
    args = mock_run.call_args[0][0]
    assert args[args.index("--label") + 1] == bug_sync.WEB_LABEL


def test_list_all_defaults_to_the_bug_label():
    with patch("mtdo.bug_sync._run", return_value="[]") as mock_run:
        bug_sync.list_all()
    args = mock_run.call_args[0][0]
    assert args[args.index("--label") + 1] == bug_sync.LABEL


def test_list_web_tasks_uses_web_label():
    with patch("mtdo.bug_sync._run", return_value="[]") as mock_run:
        bug_sync.list_web_tasks()
    args = mock_run.call_args[0][0]
    assert args[args.index("--label") + 1] == bug_sync.WEB_LABEL


def test_task_wave_reads_the_wave_prefix_label():
    issue = {"labels": [{"name": "web-task"}, {"name": "wave:w1"}]}
    assert bug_sync.task_wave(issue) == "w1"


def test_task_wave_none_when_no_wave_label():
    assert bug_sync.task_wave({"labels": [{"name": "web-task"}]}) is None


def test_file_task_creates_the_missing_wave_label_and_returns_the_issue_number():
    with patch("mtdo.bug_sync._run", side_effect=_run_side_effect()), \
         patch("mtdo.bug_sync.subprocess.run") as mock_subrun:
        number = bug_sync.file_task("Build the Today screen", "body text", wave="w1")
    assert number == 501
    mock_subrun.assert_called_once()
    assert "wave:w1" in mock_subrun.call_args[0][0]


def test_file_task_does_not_recreate_an_existing_wave_label():
    with patch("mtdo.bug_sync._run", side_effect=_run_side_effect(existing_labels=["wave:w1"])), \
         patch("mtdo.bug_sync.subprocess.run") as mock_subrun:
        bug_sync.file_task("Build the Today screen", "body text", wave="w1")
    mock_subrun.assert_not_called()


def test_file_task_tags_the_created_issue_with_the_web_and_wave_labels():
    with patch("mtdo.bug_sync._run", side_effect=_run_side_effect()) as mock_run, \
         patch("mtdo.bug_sync.subprocess.run"):
        bug_sync.file_task("Build the Today screen", "body text", wave="w1")
    create_call = next(c for c in mock_run.call_args_list if c[0][0][:3] == ["gh", "issue", "create"])
    args = create_call[0][0]
    assert bug_sync.WEB_LABEL in args
    assert "wave:w1" in args


def test_file_task_assigns_when_given_a_known_person():
    with patch("mtdo.bug_sync._run", side_effect=_run_side_effect()) as mock_run, \
         patch("mtdo.bug_sync.subprocess.run"):
        bug_sync.file_task("Build the Today screen", "body text", wave="w1", assigned_to="janhwirai")
    create_call = next(c for c in mock_run.call_args_list if c[0][0][:3] == ["gh", "issue", "create"])
    assert "assigned:janhwirai" in create_call[0][0]


def test_file_task_rejects_an_unknown_assignee():
    with patch("mtdo.bug_sync._run", side_effect=_run_side_effect()), \
         patch("mtdo.bug_sync.subprocess.run"):
        with pytest.raises(ValueError):
            bug_sync.file_task("x", "y", wave="w1", assigned_to="not-a-real-person")
