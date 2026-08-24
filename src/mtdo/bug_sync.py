"""Syncs an mtdo-sandbox instance's local bug log (bug_log.py) to a private GitHub repo
used purely as a cross-machine bug tracker -- mukund1312/mtdo-bugs holds only issues, no
code, so bugs found while testing stay private even though mtdo itself is public. This is
what makes the bug scoreboard visible from either Mac: `gh issue list` (or the GitHub web
UI) against that repo, from any machine that's run `gh auth login` once.

Each local bug is filed as exactly one issue, labeled 'sandbox-bug'; the issue number is
stamped back onto the local bug entry (bug_log.set_github_issue) so re-running sync never
double-files it. Fixing a synced bug should go through mark_fixed_and_close() below, not
bug_log.mark_fixed() directly, so the issue actually closes too.

PEOPLE/DISPLAY_NAMES/PERSON_COLOR_VAR live here (not dashboard.py) since assignment
(distribute_pending/rebalance below) needs the roster too -- dashboard.py imports them
rather than keeping its own separate copy.
"""
import json
import subprocess

from . import bug_log

TRACKER_REPO = "mukund1312/mtdo-bugs"
LABEL = "sandbox-bug"
ASSIGN_PREFIX = "assigned:"
PRIORITY_PREFIX = "priority:"
PRIORITIES = ["high", "medium", "low"]

# The known two-person roster. Each maps to a friendly display name/color for the
# dashboard, and to every git identity (name+email pairs are inconsistent across
# machines/accounts -- see PROGRESS.md 2026-08-23) that should count toward their commits.
PEOPLE = ["mukund1312", "janhwirai"]
DISPLAY_NAMES = {"mukund1312": "Mukund", "janhwirai": "Janhwi"}
PERSON_COLOR_VAR = {"mukund1312": "--mukund", "janhwirai": "--janhwi"}
GIT_EMAILS = {
    "mukund1312": {"mukundumashankar@gmail.com", "85414863+mukund1312@users.noreply.github.com"},
    "janhwirai": {"janhwirai5@gmail.com", "104694618+janhwirai@users.noreply.github.com"},
}


def _run(args):
    result = subprocess.run(args, capture_output=True, text=True)
    if result.returncode != 0:
        raise RuntimeError(f"{' '.join(args)} failed: {result.stderr.strip()}")
    return result.stdout.strip()


def sync_pending(instance=None):
    """Files every not-yet-synced bug (no github_issue on it) -- every bug on the machine
    by default, or just one instance's if `instance` is given (matches bug_log's own
    `instance` field, recorded on each bug at capture time -- not tied to where the bug
    happens to be stored anymore, see bug_log.py). Returns how many were newly filed."""
    filed = 0
    for b in bug_log.list_bugs(instance=instance):
        if b.get("github_issue"):
            continue
        label = b.get("instance", "unsaved session")
        title = f"[{label}] {b['text']}"[:200]
        body = (
            f"Found while testing instance **{label}**.\n\n"
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


def whoami():
    return _run(["gh", "api", "user", "--jq", ".login"])


def mark_fixed_and_close(bug_id, fix_note=""):
    """The one function to call when a bug is actually fixed: marks it fixed locally, and
    if it was synced to GitHub, closes the issue too (with the fix note as the closing
    comment) so the scoreboard reflects it immediately.

    Assigns the issue to whoever's `gh` identity is running this *before* closing it --
    `gh issue list --json` has no "closedBy" field, so this is how "fixed by" attribution
    on the dashboard actually works (via the assignee on a closed issue), not a guess.

    Also triggers a rebalance check afterward (see rebalance() below): if this was the
    fixer's last open assigned bug, some of the other person's queue moves over so nobody
    runs dry while the other still has a backlog. Returns the rebalance result dict
    (person -> how many bugs moved to them), empty if nothing moved."""
    bug_log.mark_fixed(bug_id, fix_note)
    bug = next((b for b in bug_log.list_bugs() if b["id"] == bug_id), None)
    if bug and bug.get("github_issue"):
        number = str(bug["github_issue"])
        who = whoami()
        _run(["gh", "issue", "edit", number, "--repo", TRACKER_REPO, "--add-assignee", who])
        args = ["gh", "issue", "close", number, "--repo", TRACKER_REPO]
        if fix_note:
            args += ["--comment", fix_note]
        _run(args)
        if who in PEOPLE:
            return rebalance(who)
    return {}


def board():
    """(open_count, closed_count) across every synced bug -- the found/fixed scoreboard."""
    issues = list_all()
    open_count = sum(1 for i in issues if i["state"] == "OPEN")
    closed_count = sum(1 for i in issues if i["state"] == "CLOSED")
    return open_count, closed_count


def list_all():
    """Every synced bug issue, full detail -- used by the dashboard for per-person
    found/fixed attribution (author = found by; assignee on a closed issue = fixed by,
    set by mark_fixed_and_close) and for assignment tracking (labels)."""
    out = _run([
        "gh", "issue", "list", "--repo", TRACKER_REPO, "--label", LABEL,
        "--state", "all",
        "--json", "number,title,body,author,assignees,state,createdAt,closedAt,updatedAt,labels",
        "--limit", "1000",
    ])
    return json.loads(out)


def assigned_person(issue):
    """Who a bug is currently assigned to work on -- an `assigned:<login>` label, distinct
    from `assignees` (which mark_fixed_and_close only ever sets at *close* time, meaning
    "who fixed it"). None if not yet distributed to anyone."""
    for label in issue.get("labels", []):
        name = label["name"] if isinstance(label, dict) else label
        if name.startswith(ASSIGN_PREFIX):
            return name[len(ASSIGN_PREFIX):]
    return None


def bug_priority(issue):
    """A `priority:<level>` label (one of PRIORITIES), or None if never triaged."""
    for label in issue.get("labels", []):
        name = label["name"] if isinstance(label, dict) else label
        if name.startswith(PRIORITY_PREFIX):
            return name[len(PRIORITY_PREFIX):]
    return None


def _ensure_priority_labels():
    existing = set(_run([
        "gh", "label", "list", "--repo", TRACKER_REPO, "--json", "name", "-q", ".[].name",
    ]).splitlines())
    colors = {"high": "b60205", "medium": "d4a72c", "low": "5c6672"}
    for level in PRIORITIES:
        label = f"{PRIORITY_PREFIX}{level}"
        if label not in existing:
            subprocess.run(
                ["gh", "label", "create", label, "--repo", TRACKER_REPO,
                 "--color", colors[level], "--description", f"{level.title()} priority"],
                capture_output=True,
            )


def apply_triage(plan):
    """Bulk-apply a `{issue_number: {"priority": <level or None>, "assigned_to": <login or
    None>}}` plan in one pass -- the deliberate-judgment counterpart to distribute_pending()
    (which only fills in blanks). Only issues an edit per issue when something in the plan
    actually differs from the issue's current label state, so re-running with the same plan
    is a no-op. Returns {number: {"priority": bool_changed, "assigned_to": bool_changed}}
    for whichever issues had at least one change."""
    _ensure_priority_labels()
    _ensure_assignment_labels()
    issues = {i["number"]: i for i in list_all()}
    changes = {}
    for number, desired in plan.items():
        issue = issues.get(number)
        if issue is None:
            continue
        add_labels, remove_labels = [], []
        changed = {"priority": False, "assigned_to": False}

        if "priority" in desired:
            current = bug_priority(issue)
            wanted = desired["priority"]
            if wanted != current:
                if current:
                    remove_labels.append(f"{PRIORITY_PREFIX}{current}")
                if wanted:
                    add_labels.append(f"{PRIORITY_PREFIX}{wanted}")
                changed["priority"] = True

        if "assigned_to" in desired:
            current = assigned_person(issue)
            wanted = desired["assigned_to"]
            if wanted != current:
                if current:
                    remove_labels.append(f"{ASSIGN_PREFIX}{current}")
                if wanted:
                    add_labels.append(f"{ASSIGN_PREFIX}{wanted}")
                changed["assigned_to"] = True

        if not add_labels and not remove_labels:
            continue

        args = ["gh", "issue", "edit", str(number), "--repo", TRACKER_REPO]
        for label in add_labels:
            args += ["--add-label", label]
        for label in remove_labels:
            args += ["--remove-label", label]
        _run(args)
        changes[number] = changed
    return changes


def _ensure_assignment_labels():
    existing = set(_run([
        "gh", "label", "list", "--repo", TRACKER_REPO, "--json", "name", "-q", ".[].name",
    ]).splitlines())
    colors = ["1d76db", "b60205"]
    for person, color in zip(PEOPLE, colors):
        label = f"{ASSIGN_PREFIX}{person}"
        if label not in existing:
            subprocess.run(
                ["gh", "label", "create", label, "--repo", TRACKER_REPO,
                 "--color", color, "--description", f"Assigned to {person} to fix"],
                capture_output=True,
            )


def distribute_pending():
    """Assigns every open, not-yet-assigned bug to whoever currently has fewer
    open+assigned bugs, one at a time -- keeps it balanced rather than a rigid 50/50
    split, and is safe to re-run any time new bugs come in (already-assigned ones are
    left alone). Returns {person: count_newly_assigned}."""
    _ensure_assignment_labels()
    issues = list_all()
    open_issues = [i for i in issues if i["state"] == "OPEN"]
    counts = {p: 0 for p in PEOPLE}
    for i in open_issues:
        who = assigned_person(i)
        if who in counts:
            counts[who] += 1

    result = {p: 0 for p in PEOPLE}
    for issue in open_issues:
        if assigned_person(issue) is not None:
            continue
        target = min(PEOPLE, key=lambda p: counts[p])
        _run(["gh", "issue", "edit", str(issue["number"]), "--repo", TRACKER_REPO,
              "--add-label", f"{ASSIGN_PREFIX}{target}"])
        counts[target] += 1
        result[target] += 1
    return result


def rebalance(fixer_login):
    """If `fixer_login` has just cleared their entire assigned open queue while someone
    else still has one, moves up to 3 of the other person's open+assigned bugs over --
    so finishing your batch first means picking up some of theirs next, not running out
    of things to do while they're still working through a backlog. Returns
    {person: count_moved_to_them}, empty if fixer still has bugs left or nobody else does."""
    issues = list_all()
    open_issues = [i for i in issues if i["state"] == "OPEN"]
    mine = [i for i in open_issues if assigned_person(i) == fixer_login]
    if mine:
        return {}

    moved = 0
    for other in PEOPLE:
        if other == fixer_login:
            continue
        other_open = [i for i in open_issues if assigned_person(i) == other]
        for issue in other_open[:3]:
            _run(["gh", "issue", "edit", str(issue["number"]), "--repo", TRACKER_REPO,
                  "--remove-label", f"{ASSIGN_PREFIX}{other}",
                  "--add-label", f"{ASSIGN_PREFIX}{fixer_login}"])
            moved += 1
    return {fixer_login: moved} if moved else {}


def assignment_summary():
    """{person: {"assigned_open": n, "assigned_fixed": n}} -- how the current distribution
    stands, for the dashboard."""
    issues = list_all()
    summary = {p: {"assigned_open": 0, "assigned_fixed": 0} for p in PEOPLE}
    for issue in issues:
        who = assigned_person(issue)
        if who not in summary:
            continue
        key = "assigned_open" if issue["state"] == "OPEN" else "assigned_fixed"
        summary[who][key] += 1
    return summary


# Keyword heuristic for _guess_priority() below -- a deterministic stand-in for the
# judgment call a human/Claude Code session made on 2026-08-24's full triage pass (see
# PROGRESS.md), so `auto_triage_pending()` can run unattended from `bugs sync`/`dashboard`.
# It WILL misjudge some bugs -- a title alone often doesn't carry enough signal -- re-triage
# any of them by hand any time via apply_triage({number: {"priority": "..."}}).
_HIGH_KEYWORDS = [
    "crash", "crashes", "crashing", "security", "vulnerab", "plaintext", "password",
    "auth", "sandbox", "data loss", "destroys", "destroy", "no recovery", "exploit",
    "no tests", "no automated tests", "no ci ", "corrupt", "traceback", "error:",
    "doesn't work", "isn't working", "not working", " fails", "broken", "breaks",
]
_LOW_KEYWORDS = [
    "readme", "one-line pitch", "no tags", "no releases", "contributing.md",
    "documentation", "not a bug", "feature i am planning", "nice to have", "cosmetic",
]


def _guess_priority(title, body=""):
    """High if it names a crash/security/data-loss/broken-feature symptom; low if it reads
    as cosmetic/positioning/documentation/a future idea; medium otherwise -- the same three
    buckets the manual pass used, just decided by keyword match instead of judgment."""
    text = f"{title} {body}".lower()
    if any(k in text for k in _HIGH_KEYWORDS):
        return "high"
    if any(k in text for k in _LOW_KEYWORDS):
        return "low"
    return "medium"


def auto_triage_pending():
    """The unattended version of the 2026-08-24 manual triage pass -- give every open bug
    missing one a priority (via _guess_priority) and an assignee, with NO Claude Code
    session in the loop. Meant to run as part of `mtdo-sandbox bugs sync` and
    `mtdo-sandbox dashboard` so triage just happens as a side effect of the normal 3-command
    flow (sync / gh issue list / dashboard), not a separate ask.

    Assignment balances the *mix* of priorities each person carries, not just the raw
    count: a bug guessed "high" goes to whoever currently has fewer open HIGH-priority
    bugs specifically, so one person doesn't end up with every urgent bug just because the
    other happened to get more bugs overall first. This is the automatable half of what the
    manual pass did (balance); the other half (matching bugs to whoever's code they touch)
    needed real reading comprehension and isn't attempted here -- reassign by hand via
    apply_triage() when that context matters.

    Safe to call on every sync/dashboard run: already-triaged bugs (has both a priority and
    an assignee) are left completely alone, so re-running never overrides a human's earlier
    call on a specific bug."""
    _ensure_priority_labels()
    _ensure_assignment_labels()
    issues = list_all()
    open_issues = [i for i in issues if i["state"] == "OPEN"]

    counts = {p: {lvl: 0 for lvl in PRIORITIES} for p in PEOPLE}
    for issue in open_issues:
        who = assigned_person(issue)
        level = bug_priority(issue)
        if who in counts and level in counts[who]:
            counts[who][level] += 1

    plan = {}
    for issue in open_issues:
        level = bug_priority(issue)
        already_assigned = assigned_person(issue) is not None
        desired = {}

        if level is None:
            level = _guess_priority(issue["title"], issue.get("body", ""))
            desired["priority"] = level

        if not already_assigned:
            target = min(PEOPLE, key=lambda p: counts[p][level])
            desired["assigned_to"] = target
            counts[target][level] += 1

        if desired:
            plan[issue["number"]] = desired

    return apply_triage(plan)
