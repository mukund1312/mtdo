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


def set_status(text):
    """Sets the current gh-authenticated user's status line. Returns their username."""
    who = whoami()
    statuses, sha = _get_file()
    statuses[who] = {"status": text, "updated_at": _now()}
    encoded = base64.b64encode(json.dumps(statuses, indent=2).encode()).decode()
    args = [
        "gh", "api", f"repos/{TRACKER_REPO}/contents/{STATUS_PATH}", "-X", "PUT",
        "-f", f"message=Update status for {who}", "-f", f"content={encoded}",
    ]
    if sha:
        args += ["-f", f"sha={sha}"]
    _run(args)
    return who


def get_all_status():
    statuses, _ = _get_file()
    return statuses
