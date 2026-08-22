"""Per-instance bug log, captured live while testing in `mtdo-sandbox` (see app.py's
action_report_bug, bound to 'B' only when SANDBOX_INSTANCE_MODE is on). Stored as
bugs.json right alongside goals.json/state.json/etc, so it's just another file that rides
along when a sandbox instance is saved, discarded, or autosaved (instance_store.py copies
or deletes the whole data dir as a unit -- no special-casing needed here for that).

Meant to close the loop on testing: note a bug the moment you hit it, keep testing, save
the instance when you quit, then later point a Claude Code session at
~/.mtdo-sandbox/instances/<slug>/bugs.json (or `mtdo-sandbox bugs <slug>`) and ask it to
fix the pending ones -- mark_fixed() is how that session records what it did.
"""
import datetime
import json
import os

from . import config as appconfig

BUGS_PATH = os.path.join(appconfig.APP_DIR, "bugs.json")


def _now():
    return datetime.datetime.now().isoformat(timespec="seconds")


def _load():
    if not os.path.exists(BUGS_PATH):
        return []
    try:
        with open(BUGS_PATH) as f:
            return json.load(f)
    except Exception:
        return []


def _save(bugs):
    os.makedirs(os.path.dirname(BUGS_PATH), exist_ok=True)
    with open(BUGS_PATH, "w") as f:
        json.dump(bugs, f, indent=2)


def add_bug(text):
    bugs = _load()
    next_id = max((b["id"] for b in bugs), default=0) + 1
    bugs.append({
        "id": next_id,
        "text": text,
        "status": "pending",
        "found_at": _now(),
        "fixed_at": None,
        "fix_note": "",
        "github_issue": None,  # set by bug_sync.py once filed to the private tracker repo
    })
    _save(bugs)
    return next_id


def set_github_issue(bug_id, issue_number):
    bugs = _load()
    for b in bugs:
        if b["id"] == bug_id:
            b["github_issue"] = issue_number
    _save(bugs)


def list_bugs():
    return _load()


def mark_fixed(bug_id, fix_note=""):
    bugs = _load()
    found = False
    for b in bugs:
        if b["id"] == bug_id:
            b["status"] = "fixed"
            b["fixed_at"] = _now()
            b["fix_note"] = fix_note
            found = True
    if found:
        _save(bugs)
    return found
