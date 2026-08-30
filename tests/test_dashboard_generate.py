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
