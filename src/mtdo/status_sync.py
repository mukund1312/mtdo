"""Cross-machine "what I'm working on" status line, one per person, stored as a single
status.json file in the private mukund1312/mtdo-bugs tracker repo (same repo bug_sync.py
uses) -- so `mtdo-sandbox dashboard` can show it from whichever machine it's run on.

Uses the GitHub Contents API directly via `gh api` rather than a local git clone of
mtdo-bugs -- that repo holds only issues/status data, no code, so there's nothing to
actually check out day to day; reading/writing one small JSON file over the API is
simpler than maintaining a second clone alongside the real mtdo checkout.
"""
import base64
import datetime
import json
import subprocess

from .bug_sync import TRACKER_REPO, whoami

STATUS_PATH = "status.json"


def _run(args, check=True):
    result = subprocess.run(args, capture_output=True, text=True)
    if check and result.returncode != 0:
        raise RuntimeError(f"{' '.join(args)} failed: {result.stderr.strip()}")
    return result


def _now():
    return datetime.datetime.now().isoformat(timespec="seconds")


def _get_file():
    """(status_dict, sha). sha is None if status.json doesn't exist in the repo yet."""
    result = _run(["gh", "api", f"repos/{TRACKER_REPO}/contents/{STATUS_PATH}"], check=False)
    if result.returncode != 0:
        return {}, None
    data = json.loads(result.stdout)
    return json.loads(base64.b64decode(data["content"]).decode()), data["sha"]


def set_status(text, max_attempts=3):
    """Sets the current gh-authenticated user's status line. Returns their username.

    Retries on a conflicting concurrent write (gh68): this is a genuine two-writer
    file (you + the other person), doing read-sha/modify/PUT against GitHub's
    Contents API with no lock. If both of you call this within the same short
    window, GitHub rejects the second PUT for a now-stale sha -- previously a
    hard RuntimeError/crash instead of the obvious recovery: re-read the file
    (now reflecting the other person's write), reapply just this person's own
    status on top of it, and retry the PUT. Bounded at `max_attempts` so a
    genuinely broken case (bad auth, no network) still surfaces clearly instead
    of retrying forever."""
    who = whoami()
    last_error = None
    for _attempt in range(max_attempts):
        statuses, sha = _get_file()
        statuses[who] = {"status": text, "updated_at": _now()}
        encoded = base64.b64encode(json.dumps(statuses, indent=2).encode()).decode()
        args = [
            "gh", "api", f"repos/{TRACKER_REPO}/contents/{STATUS_PATH}", "-X", "PUT",
            "-f", f"message=Update status for {who}", "-f", f"content={encoded}",
        ]
        if sha:
            args += ["-f", f"sha={sha}"]
        try:
            _run(args)
            return who
        except RuntimeError as e:
            last_error = e
    raise last_error


def get_all_status():
    statuses, _ = _get_file()
    return statuses
