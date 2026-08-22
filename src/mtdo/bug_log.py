"""Bug log, captured live while testing in `mtdo-sandbox` (see app.py's action_report_bug,
bound to 'B' only when SANDBOX_INSTANCE_MODE is on).

Stored at a FIXED path under the sandbox root -- deliberately NOT derived from
config.APP_DIR/MTDO_HOME (which points at the current session's *scratch* copy). Originally
it did live inside the scratch dir, riding along whenever an instance was saved -- but that
meant a bug was only durable if the instance survived to be saved. A real freeze forced a
hard-kill of the terminal before the save prompt (or even the SIGHUP fallback) could ever
run, and every bug logged in that session was lost -- nothing had been written anywhere
durable yet. Now `add_bug` writes to this fixed file synchronously, the instant B is
pressed, completely independent of whether the current instance ever gets saved, discarded,
or killed. Each bug records which instance it was found in (from MTDO_INSTANCE_NAME/SLUG)
so that context isn't lost, but that's just a field now, not a storage location.
"""
import datetime
import json
import os

BUGS_PATH = os.path.join(os.path.expanduser("~/.mtdo-sandbox"), "bugs.json")


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
    instance = os.environ.get("MTDO_INSTANCE_NAME") or os.environ.get("MTDO_INSTANCE_SLUG") or "unsaved session"
    bugs.append({
        "id": next_id,
        "text": text,
        "instance": instance,
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


def list_bugs(instance=None):
    bugs = _load()
    if instance is None:
        return bugs
    return [b for b in bugs if b.get("instance") == instance]


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
