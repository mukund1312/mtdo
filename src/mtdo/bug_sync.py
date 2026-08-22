"""Syncs an mtdo-sandbox instance's local bug log (bug_log.py) to a private GitHub repo
used purely as a cross-machine bug tracker -- mukund1312/mtdo-bugs holds only issues, no
code, so bugs found while testing stay private even though mtdo itself is public. This is
what makes the bug scoreboard visible from either Mac: `gh issue list` (or the GitHub web
UI) against that repo, from any machine that's run `gh auth login` once.

Each local bug is filed as exactly one issue, labeled 'sandbox-bug'; the issue number is
stamped back onto the local bug entry (bug_log.set_github_issue) so re-running sync never
double-files it. Fixing a synced bug should go through mark_fixed_and_close() below, not
bug_log.mark_fixed() directly, so the issue actually closes too.
"""
import json
import subprocess

from . import bug_log

TRACKER_REPO = "mukund1312/mtdo-bugs"
LABEL = "sandbox-bug"


def _run(args):
    result = subprocess.run(args, capture_output=True, text=True)
    if result.returncode != 0:
        raise RuntimeError(f"{' '.join(args)} failed: {result.stderr.strip()}")
    return result.stdout.strip()


def sync_pending(instance_label):
    """Files every bug in the current instance that hasn't been synced yet (no
    github_issue on it). Returns how many were newly filed."""
    filed = 0
    for b in bug_log.list_bugs():
        if b.get("github_issue"):
            continue
        title = f"[{instance_label}] {b['text']}"[:200]
        body = (
            f"Found while testing instance **{instance_label}**.\n\n"
            f"Logged at {b['found_at']} (local bug #{b['id']})."
        )
        url = _run([
            "gh", "issue", "create", "--repo", TRACKER_REPO,
            "--title", title, "--body", body, "--label", LABEL,
        ])
        issue_number = int(url.rsplit("/", 1)[-1])
        bug_log.set_github_issue(b["id"], issue_number)
        filed += 1
    return filed


def mark_fixed_and_close(bug_id, fix_note=""):
    """The one function to call when a bug is actually fixed: marks it fixed locally, and
    if it was synced to GitHub, closes the issue too (with the fix note as the closing
    comment) so the scoreboard reflects it immediately."""
    bug_log.mark_fixed(bug_id, fix_note)
    bug = next((b for b in bug_log.list_bugs() if b["id"] == bug_id), None)
    if bug and bug.get("github_issue"):
        args = ["gh", "issue", "close", str(bug["github_issue"]), "--repo", TRACKER_REPO]
        if fix_note:
            args += ["--comment", fix_note]
        _run(args)


def board():
    """(open_count, closed_count) across every synced bug -- the found/fixed scoreboard."""
    out = _run([
        "gh", "issue", "list", "--repo", TRACKER_REPO, "--label", LABEL,
        "--state", "all", "--json", "state", "--limit", "1000",
    ])
    issues = json.loads(out)
    open_count = sum(1 for i in issues if i["state"] == "OPEN")
    closed_count = sum(1 for i in issues if i["state"] == "CLOSED")
    return open_count, closed_count
