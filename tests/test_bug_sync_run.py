"""Regression test for gh72: bug_sync._run() must turn a missing `gh` binary
(FileNotFoundError from subprocess.run) into a clear, actionable RuntimeError,
matching every other failure mode in this module, instead of letting a raw,
confusing traceback escape.
"""
from unittest.mock import patch

import pytest

from mtdo import bug_sync


def test_run_raises_a_clear_runtime_error_when_gh_binary_is_missing():
    with patch("mtdo.bug_sync.subprocess.run", side_effect=FileNotFoundError("no such file: gh")):
        with pytest.raises(RuntimeError) as excinfo:
            bug_sync._run(["gh", "issue", "list"])

    message = str(excinfo.value)
    assert "gh" in message.lower()
    assert "install" in message.lower()
    assert "https://cli.github.com/" in message


def test_run_still_raises_normally_on_a_real_gh_failure():
    """The gh72 fix must not swallow or change any other existing failure
    mode -- only FileNotFoundError gets special handling."""
    from unittest.mock import MagicMock

    result = MagicMock()
    result.returncode = 1
    result.stderr = "some real gh error"
    with patch("mtdo.bug_sync.subprocess.run", return_value=result):
        with pytest.raises(RuntimeError) as excinfo:
            bug_sync._run(["gh", "issue", "list"])

    assert "some real gh error" in str(excinfo.value)


def test_run_returns_stdout_on_success():
    from unittest.mock import MagicMock

    result = MagicMock()
    result.returncode = 0
    result.stdout = "  42\n"
    with patch("mtdo.bug_sync.subprocess.run", return_value=result):
        assert bug_sync._run(["gh", "issue", "list"]) == "42"
