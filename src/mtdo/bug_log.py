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
import tempfile
import time

from . import errorlog

BUGS_PATH = os.path.join(os.path.expanduser("~/.mtdo-sandbox"), "bugs.json")


def _now():
    return datetime.datetime.now().isoformat(timespec="seconds")


def _load():
    if not os.path.exists(BUGS_PATH):
        return []
    try:
        with open(BUGS_PATH) as f:
            return json.load(f)
    except json.JSONDecodeError:
        # A truncated/corrupt file (e.g. the process was hard-killed mid-write,
        # before _save() below wrote atomically) used to be silently treated as
        # an EMPTY bug log -- every previously logged bug vanished with no
        # indication anything was lost, which is exactly backwards for a file
        # whose entire purpose is capturing bugs right before a crash -- gh60.
        # Quarantine the unreadable file (never delete it -- it might still be
        # hand-recoverable) instead of pretending nothing was ever logged.
        quarantine_path = f"{BUGS_PATH}.corrupt-{int(time.time())}"
        try:
            os.replace(BUGS_PATH, quarantine_path)
        except OSError:
            quarantine_path = None
        errorlog.log.exception(
            "bugs.json was corrupt/unreadable -- quarantined to %s and starting fresh",
            quarantine_path,
        )
        return []


def _save(bugs):
    """Writes via a temp file + os.replace() rather than a direct open(...,
    "w") -- gh60: a direct write left a truncated/corrupt bugs.json behind if
    the process was hard-killed mid-write (a real occurrence -- this module's
    entire purpose is capturing bugs right before exactly that kind of crash),
    which _load() above then couldn't parse at all. The temp file is created
    in the SAME directory as BUGS_PATH specifically so os.replace() is an
    atomic rename on the same filesystem -- a temp dir elsewhere (e.g. the OS
    tmpdir) could land on a different filesystem, where the same call
    silently falls back to a non-atomic copy+delete."""
    bugs_dir = os.path.dirname(BUGS_PATH)
    os.makedirs(bugs_dir, exist_ok=True)
    fd, tmp_path = tempfile.mkstemp(dir=bugs_dir, prefix=".bugs.json.", suffix=".tmp")
    try:
        with os.fdopen(fd, "w") as f:
            json.dump(bugs, f, indent=2)
        os.replace(tmp_path, BUGS_PATH)
    except BaseException:
        try:
            os.remove(tmp_path)
        except OSError:
            pass
        raise


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
