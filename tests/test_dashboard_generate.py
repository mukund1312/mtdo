"""Regression tests for gh67: dashboard.generate() must not crash the caller (and
must not overwrite DASHBOARD_PATH with nothing) if a `gh` call fails partway
through -- every OTHER subprocess call in this file already degrades gracefully
(_commit_counts, _fetch_remotes_quiet, _bug_git_activity); this brings actual
dashboard regeneration in line with that same philosophy.

DASHBOARD_PATH is a real fixed path under ~/.mtdo-sandbox (not MTDO_HOME-scoped,
same situation as bug_log.py's BUGS_PATH -- see test_bug_log.py), so every test
here monkeypatches it to a throwaway tmp_path first. Never touch the real path.
"""
from unittest.mock import patch

import pytest

from mtdo import dashboard


@pytest.fixture(autouse=True)
def _isolated_dashboard_path(monkeypatch, tmp_path):
    monkeypatch.setattr(dashboard, "DASHBOARD_PATH", str(tmp_path / "dashboard.html"))
    yield


def test_generate_returns_none_triaged_and_keeps_the_last_known_good_page_on_gh_failure():
    with open(dashboard.DASHBOARD_PATH, "w") as f:
        f.write("<html>old content</html>")

    with patch("mtdo.dashboard.bug_sync.sync_dashboard_overrides", side_effect=RuntimeError("gh rate limited")), \
         patch("mtdo.dashboard._fetch_remotes_quiet"):
        path, triaged = dashboard.generate()

    assert path == dashboard.DASHBOARD_PATH
    assert triaged is None
    with open(dashboard.DASHBOARD_PATH) as f:
        assert f.read() == "<html>old content</html>"


def test_generate_returns_none_triaged_when_list_all_fails_partway_through():
    """A failure anywhere in the gh-touching sequence -- not just the first
    call -- must be caught the same way."""
    with open(dashboard.DASHBOARD_PATH, "w") as f:
        f.write("<html>still here</html>")

    with patch("mtdo.dashboard.bug_sync.sync_dashboard_overrides"), \
         patch("mtdo.dashboard.bug_sync.auto_triage_pending", return_value={}), \
         patch("mtdo.dashboard.bug_sync.list_all", side_effect=RuntimeError("gh auth expired")), \
         patch("mtdo.dashboard._fetch_remotes_quiet"):
        path, triaged = dashboard.generate()

    assert triaged is None
    with open(dashboard.DASHBOARD_PATH) as f:
        assert f.read() == "<html>still here</html>"


def test_render_html_gives_every_editable_control_a_real_data_id():
    """Regression test: the status/assign/comment-thread edit handlers in the
    dashboard's client-side script address elements via `.dataset.id` (which reads an
    element's data-id attribute) when building `api.edit(ops)` calls -- e.g.
    `target: c.dataset.id`. render_html() never actually set a data-id attribute on
    any of those elements, so every edit's target was undefined; the live-doc edit
    API silently couldn't find a target to patch, which is what made clicking
    Postpone (or Fixed, reassigning, or posting a note -- all four handlers share
    this exact pattern) freeze the dashboard instead of applying the change.

    The status/assign controls are rendered twice per issue (once in the issues
    table row, once on the issue detail page, kept in sync by the same click
    handler) so each copy needs its own distinct id -- checked here too."""
    issue = {
        "number": 42,
        "title": "Sample bug",
        "body": "description",
        "author": {"login": "mukund1312"},
        "assignees": [],
        "state": "OPEN",
        "createdAt": "2026-01-01T00:00:00Z",
        "closedAt": None,
        "updatedAt": "2026-01-01T00:00:00Z",
        "labels": [],
        "comments": [],
    }
    content = dashboard.render_html([issue], {})

    for expected_id in [
        "row-42",
        "status-row-42", "status-row-label-42",
        "status-detail-42", "status-detail-label-42",
        "assign-row-42", "assign-row-label-42",
        "assign-detail-42", "assign-detail-label-42",
        "thread-42",
    ]:
        assert f'data-id="{expected_id}"' in content, f"missing data-id={expected_id!r}"


def test_generate_writes_fresh_content_and_returns_real_triage_dict_on_success():
    with patch("mtdo.dashboard.bug_sync.sync_dashboard_overrides"), \
         patch("mtdo.dashboard.bug_sync.auto_triage_pending", return_value={}), \
         patch("mtdo.dashboard.bug_sync.list_all", return_value=[]), \
         patch("mtdo.dashboard.status_sync.get_all_status", return_value={}), \
         patch("mtdo.dashboard._fetch_remotes_quiet"):
        path, triaged = dashboard.generate()

    assert path == dashboard.DASHBOARD_PATH
    assert triaged == {}
    with open(dashboard.DASHBOARD_PATH) as f:
        content = f.read()
    assert "<title>mtdo Bug Board</title>" in content
