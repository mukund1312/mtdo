"""Tests for the Web Tasks section added to the dashboard
(docs/designs/mtdo-web-dev-split-plan.md §7) -- reuses the same assign/status controls
bugs use, with `wave` in place of `priority` and no found-by column. render_html() is
pure (no gh/subprocess calls); only the generate() test mocks bug_sync/status_sync.
"""
from unittest.mock import patch

from mtdo import dashboard


def _task(number=501, title="Build the Today screen", state="OPEN", labels=None, closed_at=None):
    return {
        "number": number,
        "title": title,
        "body": "task body",
        "author": {"login": "mukund1312"},
        "assignees": [],
        "state": state,
        "createdAt": "2026-09-01T00:00:00Z",
        "closedAt": closed_at,
        "updatedAt": "2026-09-01T00:00:00Z",
        "labels": labels if labels is not None else [{"name": "web-task"}, {"name": "wave:w1"}],
        "comments": [],
    }


def test_render_html_renders_a_task_row_with_wave_and_assign_controls():
    task = _task(labels=[{"name": "web-task"}, {"name": "wave:w1"}, {"name": "assigned:janhwirai"}])
    content = dashboard.render_html([], {}, tasks=[task])

    assert "Build the Today screen" in content
    assert "W1" in content  # the wave pill text
    assert 'data-id="task-row-501"' in content
    assert 'data-id="status-row-501"' in content
    assert 'data-id="assign-row-501"' in content
    assert "Janhwi" in content  # assignee display name resolved from assigned:janhwirai


def test_render_html_shows_empty_state_with_no_tasks():
    content = dashboard.render_html([], {}, tasks=[])
    assert "No web tasks filed yet." in content


def test_render_html_task_detail_reuses_git_activity_and_conversation():
    content = dashboard.render_html([], {}, tasks=[_task()])
    assert 'id="issue-detail-501"' in content
    assert 'id="thread-501"' in content
    assert "Back to Web Tasks" in content


def test_render_html_with_no_tasks_kwarg_still_works():
    """Backward compatibility: existing callers that only pass issues/statuses
    (tasks omitted) must not break."""
    content = dashboard.render_html([], {})
    assert "No web tasks filed yet." in content


def test_generate_fetches_and_passes_web_tasks(tmp_path, monkeypatch):
    monkeypatch.setattr(dashboard, "DASHBOARD_PATH", str(tmp_path / "dashboard.html"))
    with patch("mtdo.dashboard.bug_sync.sync_dashboard_overrides"), \
         patch("mtdo.dashboard.bug_sync.auto_triage_pending", return_value={}), \
         patch("mtdo.dashboard.bug_sync.list_all", return_value=[]), \
         patch("mtdo.dashboard.bug_sync.list_web_tasks", return_value=[_task()]), \
         patch("mtdo.dashboard.status_sync.get_all_status", return_value={}), \
         patch("mtdo.dashboard._fetch_remotes_quiet"):
        path, triaged = dashboard.generate()

    assert triaged == {}
    with open(path) as f:
        content = f.read()
    assert "Build the Today screen" in content
