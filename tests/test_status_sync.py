"""Regression tests for gh68: set_status() must retry on a conflicting concurrent
write (a stale sha rejected by GitHub's Contents API) rather than crashing --
this is a genuine two-writer file (you + the other person), with no lock.

subprocess.run is mocked throughout -- no real gh CLI/network calls.
"""
import base64
import json
from unittest.mock import MagicMock, patch

from mtdo import status_sync


def _fake_result(returncode=0, stdout="", stderr=""):
    r = MagicMock()
    r.returncode = returncode
    r.stdout = stdout
    r.stderr = stderr
    return r


def _get_file_response(statuses, sha):
    content = base64.b64encode(json.dumps(statuses).encode()).decode()
    return _fake_result(0, stdout=json.dumps({"content": content, "sha": sha}))


def test_set_status_succeeds_on_first_try_with_no_conflict():
    responses = [
        _get_file_response({}, "sha1"),  # GET (_get_file)
        _fake_result(0),  # PUT succeeds
    ]
    with patch("mtdo.status_sync.whoami", return_value="mukund1312"), \
         patch("mtdo.status_sync.subprocess.run", side_effect=responses) as mock_run:
        who = status_sync.set_status("working on gh68")
    assert who == "mukund1312"
    assert mock_run.call_count == 2


def test_set_status_retries_once_on_a_conflicting_write_then_succeeds():
    responses = [
        _get_file_response({"janhwirai": {"status": "x", "updated_at": "t"}}, "sha1"),  # GET #1
        _fake_result(1, stderr="409 Conflict: sha does not match"),  # PUT #1 -- stale sha
        _get_file_response({"janhwirai": {"status": "y", "updated_at": "t2"}}, "sha2"),  # GET #2 (fresh)
        _fake_result(0),  # PUT #2 succeeds
    ]
    with patch("mtdo.status_sync.whoami", return_value="mukund1312"), \
         patch("mtdo.status_sync.subprocess.run", side_effect=responses) as mock_run:
        who = status_sync.set_status("working on gh68")
    assert who == "mukund1312"
    assert mock_run.call_count == 4  # GET, failed PUT, re-GET, successful PUT


def test_set_status_re_reads_fresh_content_before_retrying_not_the_stale_copy():
    """The retry must reflect whatever changed in between, not blindly resubmit
    the same (now-stale) content it started with."""
    responses = [
        _get_file_response({}, "sha1"),
        _fake_result(1, stderr="409 Conflict"),
        _get_file_response({"janhwirai": {"status": "already here", "updated_at": "t2"}}, "sha2"),
        _fake_result(0),
    ]
    with patch("mtdo.status_sync.whoami", return_value="mukund1312"), \
         patch("mtdo.status_sync.subprocess.run", side_effect=responses) as mock_run:
        status_sync.set_status("working on gh68")

    final_put_args = mock_run.call_args_list[3].args[0]
    content_arg = next(a for a in final_put_args if a.startswith("content="))
    decoded = json.loads(base64.b64decode(content_arg.split("=", 1)[1]).decode())
    assert "janhwirai" in decoded, "the other person's status from the fresh re-read must survive the retry"
    assert decoded["mukund1312"]["status"] == "working on gh68"


def test_set_status_raises_the_last_error_after_exhausting_retries():
    get_ok = _get_file_response({}, "sha1")
    fail = _fake_result(1, stderr="500 Internal Server Error")
    responses = [get_ok, fail, get_ok, fail, get_ok, fail]
    with patch("mtdo.status_sync.whoami", return_value="mukund1312"), \
         patch("mtdo.status_sync.subprocess.run", side_effect=responses):
        try:
            status_sync.set_status("working on gh68", max_attempts=3)
            assert False, "expected RuntimeError"
        except RuntimeError as e:
            assert "500 Internal Server Error" in str(e)
