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
STATUS_PREFIX = "status:"
POSTPONED_LABEL = f"{STATUS_PREFIX}postponed"

# Web-dev work items (mtdo-web-dev-split-plan.md §7) live in the same tracker repo, as
# issues carrying this label instead of LABEL -- same board, same PEOPLE/assignment/
# status machinery, just a different "kind" of row so a bug filter never picks one up
# by accident and vice versa. WAVE_PREFIX plays the role PRIORITY_PREFIX plays for bugs
# (a single-value label read by task_wave()), not a priority -- a task's wave doesn't
# mean "how urgent," it means "which phase of docs/designs/mtdo-web-v1-plan.md it's in."
WEB_LABEL = "web-task"
WAVE_PREFIX = "wave:"

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
    try:
        result = subprocess.run(args, capture_output=True, text=True)
    except FileNotFoundError as e:
        # gh72: a missing `gh` binary raised a raw, uncaught FileNotFoundError
        # in every bug/status-sync code path that funnels through here --
        # catch it once, in this one place, and turn it into the same kind of
        # clear, actionable RuntimeError every other failure in this module
        # already gets, instead of a confusing traceback.
        raise RuntimeError(
            "`gh` (GitHub CLI) not found -- install it from https://cli.github.com/ "
            f"and run `gh auth login`, then try again. (command: {' '.join(args)})"
        ) from e
    if result.returncode != 0:
        raise RuntimeError(f"{' '.join(args)} failed: {result.stderr.strip()}")
    return result.stdout.strip()


def _issue_body(bug):
    """The full body text for a bug's GitHub issue -- the actual bug text first (GitHub
    issue bodies support far more than the 200-char title cap, unlike the title itself),
    then the found-at metadata. Fixed 2026-08-25: this used to be a generic "Found while
    testing instance X" template with no bug text at all -- since the title is
    `[:200]`-truncated (titles are conventionally short/scannable), anything past 200
    characters was silently unrecoverable from GitHub entirely, only ever visible by
    reading the local bug_log.json (not truncated there) by hand. See
    backfill_full_text_bodies() for repairing already-synced issues filed before this fix."""
    label = bug.get("instance", "unsaved session")
    return (
        f"{bug['text']}\n\n"
        f"---\n"
        f"Found while testing instance **{label}**. Logged at {bug['found_at']} "
        f"(local bug #{bug['id']})."
    )


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
        url = _run([
            "gh", "issue", "create", "--repo", TRACKER_REPO,
            "--title", title, "--body", _issue_body(b), "--label", LABEL,
        ])
        issue_number = int(url.rsplit("/", 1)[-1])
        bug_log.set_github_issue(b["id"], issue_number)
        filed += 1
    return filed


def backfill_full_text_bodies():
    """One-time repair for issues filed before the 2026-08-25 fix above: rewrites every
    already-synced issue's body to include the full bug text (previously just a generic
    "Found while testing instance X" template, so anything past the title's 200-char cap
    was invisible on GitHub/the dashboard entirely). Safe to re-run -- idempotent, just
    overwrites with the same content if a body's already correct. Returns how many issues
    were updated (skips any local bug whose text already matches what's on GitHub, so a
    second run does nothing)."""
    issues_by_number = {i["number"]: i for i in list_all()}
    updated = 0
    for b in bug_log.list_bugs():
        number = b.get("github_issue")
        if not number or number not in issues_by_number:
            continue
        new_body = _issue_body(b)
        if issues_by_number[number].get("body") == new_body:
            continue
        _run(["gh", "issue", "edit", str(number), "--repo", TRACKER_REPO, "--body", new_body])
        updated += 1
    return updated


def sync_and_triage(instance=None):
    """`sync_pending()` + `auto_triage_pending()` in one call -- the single entry point for
    anything that wants the full "file it, then triage it" step without going through the
    CLI. Used by `mtdo-sandbox bugs sync` and by the in-app background sync fired right
    after pressing 'B' to log a bug (see app.py's action_report_bug, 2026-08-24) -- neither
    needs to know the two steps are separate calls. Returns (filed_count, triage_changes)."""
    filed = sync_pending(instance=instance)
    triaged = auto_triage_pending()
    return filed, triaged


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


def list_all(label=LABEL):
    """Every synced issue carrying `label` (bugs by default; pass `WEB_LABEL` for web-dev
    tasks -- see file_task() below), full detail -- used by the dashboard for per-person
    found/fixed attribution (author = found by; assignee on a closed issue = fixed by,
    set by mark_fixed_and_close) and for assignment tracking (labels). Includes
    `comments` (full author/body/createdAt per comment, not just a count -- confirmed
    `gh issue list --json comments` returns the whole thing in this one bulk call) so
    the dashboard's "Conversation" thread can read real, durable notes without an extra
    per-issue `gh issue view` round trip for every bug on the board."""
    out = _run([
        "gh", "issue", "list", "--repo", TRACKER_REPO, "--label", label,
        "--state", "all",
        "--json", "number,title,body,author,assignees,state,createdAt,closedAt,updatedAt,labels,comments",
        "--limit", "1000",
    ])
    return json.loads(out)


def list_web_tasks():
    """Every web-dev task issue -- list_all() scoped to WEB_LABEL. Kept as a named
    function (not just callers spelling out list_all(label=WEB_LABEL) everywhere) so the
    "tasks live under a different label" detail has exactly one place to change."""
    return list_all(label=WEB_LABEL)


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


def task_wave(issue):
    """A `wave:<name>` label on a web-task issue (e.g. "w1"), or None if unset -- the
    task-board equivalent of bug_priority() above."""
    for label in issue.get("labels", []):
        name = label["name"] if isinstance(label, dict) else label
        if name.startswith(WAVE_PREFIX):
            return name[len(WAVE_PREFIX):]
    return None


def _ensure_web_label():
    """Creates the WEB_LABEL itself on demand -- `gh issue create --label <name>`
    fails outright if the label doesn't already exist in the repo (confirmed live:
    "could not add label: 'web-task' not found"), so this must run before the first
    ever web task is filed, the same way _ensure_priority_labels/_ensure_assignment_labels
    already do for their own labels."""
    existing = set(_run([
        "gh", "label", "list", "--repo", TRACKER_REPO, "--json", "name", "-q", ".[].name",
    ]).splitlines())
    if WEB_LABEL not in existing:
        subprocess.run(
            ["gh", "label", "create", WEB_LABEL, "--repo", TRACKER_REPO,
             "--color", "1d76db", "--description", "Web-dev work item -- see docs/designs/mtdo-web-dev-split-plan.md"],
            capture_output=True,
        )


def _ensure_wave_label(wave):
    """Creates the `wave:<wave>` label on demand if it doesn't exist yet -- waves aren't a
    fixed enum like PRIORITIES, so (unlike _ensure_priority_labels) this checks/creates
    one label at a time rather than the whole set up front."""
    label = f"{WAVE_PREFIX}{wave}"
    existing = set(_run([
        "gh", "label", "list", "--repo", TRACKER_REPO, "--json", "name", "-q", ".[].name",
    ]).splitlines())
    if label not in existing:
        subprocess.run(
            ["gh", "label", "create", label, "--repo", TRACKER_REPO,
             "--color", "0e8a16", "--description", f"Web-dev work item, {wave}"],
            capture_output=True,
        )


def file_task(title, body, wave, assigned_to=None):
    """Files one web-dev work item as a `WEB_LABEL`-tagged issue in the same tracker repo
    bugs use (mtdo-web-dev-split-plan.md §7) -- so M/J see their assignments on the same
    board they already check for bugs, via the same assign/status controls. Returns the
    new issue number. `assigned_to` must be a login in PEOPLE or None (unassigned, to be
    picked up by hand -- there's no auto-triage equivalent for tasks, since balancing
    "how many tasks" is far less meaningful than balancing bugs by priority)."""
    _ensure_web_label()
    _ensure_wave_label(wave)
    args = [
        "gh", "issue", "create", "--repo", TRACKER_REPO,
        "--title", title[:200], "--body", body,
        "--label", WEB_LABEL, "--label", f"{WAVE_PREFIX}{wave}",
    ]
    if assigned_to is not None:
        if assigned_to not in PEOPLE:
            raise ValueError(f"assigned_to must be one of {PEOPLE!r}, got {assigned_to!r}")
        _ensure_assignment_labels()
        args += ["--label", f"{ASSIGN_PREFIX}{assigned_to}"]
    url = _run(args)
    return int(url.rsplit("/", 1)[-1])


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


def bug_status(issue):
    """The dashboard's 3-way status (gh: dashboard status picker + durable notes) --
    "fixed" if the issue is actually closed, "postponed" if it's open but carrying
    POSTPONED_LABEL, else "open". Deliberately a label on top of GitHub's own open/
    closed rather than a fourth GitHub state (there isn't one) -- postponed is real
    open work that's just not being actively worked on right now, so it stays open
    (counts toward the same Found/Fixed/Open split as before) and is only a visual/
    filterable distinction layered on top."""
    if issue["state"] == "CLOSED":
        return "fixed"
    for label in issue.get("labels", []):
        name = label["name"] if isinstance(label, dict) else label
        if name == POSTPONED_LABEL:
            return "postponed"
    return "open"


def _ensure_status_labels():
    existing = set(_run([
        "gh", "label", "list", "--repo", TRACKER_REPO, "--json", "name", "-q", ".[].name",
    ]).splitlines())
    if POSTPONED_LABEL not in existing:
        subprocess.run(
            ["gh", "label", "create", POSTPONED_LABEL, "--repo", TRACKER_REPO,
             "--color", "6f42c1", "--description", "Real work, deliberately not being worked on right now"],
            capture_output=True,
        )


def set_status(number, status):
    """Applies a status change from the dashboard's status picker to the real
    issue. "fixed" closes it (same GitHub effect as mark_fixed_and_close, minus
    the local bug_log side -- the dashboard only ever knows GitHub issue numbers,
    not local bug ids, so callers that also need the local bug_log entry updated
    should use mark_fixed_and_close instead of this directly) and clears
    POSTPONED_LABEL if present, since a closed issue being also "postponed"
    doesn't mean anything. "postponed"/"open" both reopen if the issue was
    closed, then add or remove POSTPONED_LABEL to match."""
    if status not in ("open", "fixed", "postponed"):
        raise ValueError(f"unknown status: {status!r}")
    _ensure_status_labels()
    if status == "fixed":
        _run(["gh", "issue", "close", str(number), "--repo", TRACKER_REPO])
        _run(["gh", "issue", "edit", str(number), "--repo", TRACKER_REPO, "--remove-label", POSTPONED_LABEL])
        return
    _run(["gh", "issue", "reopen", str(number), "--repo", TRACKER_REPO])
    if status == "postponed":
        _run(["gh", "issue", "edit", str(number), "--repo", TRACKER_REPO, "--add-label", POSTPONED_LABEL])
    else:
        _run(["gh", "issue", "edit", str(number), "--repo", TRACKER_REPO, "--remove-label", POSTPONED_LABEL])


def sync_dashboard_overrides(overrides):
    """Pushes whatever changed live on the dashboard page since the last
    generate() back to the real tracker, given the overrides dict read from the
    currently-published page (dashboard.py's own docstring: `{issue_number:
    {"assigned_to":..., "status":..., "notes": [{"author":str,"text":str}, ...]}}`).
    Call this before re-fetching fresh issue state for the next generation.

    Why this exists (a real bug, not a hypothetical): posting a note on the
    dashboard was a pure live-doc DOM edit with nowhere durable to live --
    correctly synced in real time between simultaneous viewers (confirmed: it
    uses the same api.edit() pattern as reassignment, which the assign-control's
    own docstring confirms keeps every copy in sync), but a dashboard republish
    replaces the WHOLE page from scratch, silently destroying every note ever
    left, for anyone, the moment ANY session republishes without first reading
    back and re-threading the current page's state. That happened for real --
    multiple republishes from other sessions in short succession, no overrides
    preserved. Posting synced notes as real GitHub issue comments here (instead
    of only ever carrying them forward as a Python dict some future generate()
    call might or might not remember to pass) makes them durable regardless of
    whether the NEXT republish remembers to extract overrides at all: once
    synced, a note lives on the issue itself, read back fresh by
    dashboard.render_html() from list_all()'s own bundled `comments` field every
    time, forever.

    Best-effort per issue and per field -- one failure (a bad issue number, a
    transient gh error) shouldn't block syncing everything else."""
    if not overrides:
        return
    # Overrides can reference either a bug or a web-task issue -- both share one number
    # space in the same repo, so a single merged lookup covers whichever kind a given
    # override key turns out to be without the caller needing to know which.
    issues_by_number = {i["number"]: i for i in list_all() + list_web_tasks()}
    for key, ov in overrides.items():
        try:
            number = int(key)
        except (TypeError, ValueError):
            continue
        issue = issues_by_number.get(number)
        if issue is None:
            continue

        if "status" in ov and ov["status"] != bug_status(issue):
            try:
                set_status(number, ov["status"])
            except Exception:
                pass

        if "assigned_to" in ov:
            target = ov["assigned_to"] or None
            current = assigned_person(issue)
            if target != current:
                try:
                    _ensure_assignment_labels()
                    if current:
                        _run(["gh", "issue", "edit", str(number), "--repo", TRACKER_REPO,
                              "--remove-label", f"{ASSIGN_PREFIX}{current}"])
                    if target:
                        _run(["gh", "issue", "edit", str(number), "--repo", TRACKER_REPO,
                              "--add-label", f"{ASSIGN_PREFIX}{target}"])
                except Exception:
                    pass

        if ov.get("notes"):
            already = {c["body"] for c in issue.get("comments", [])}
            for note in ov["notes"]:
                body = f"{note.get('author', '?')}: {note.get('text', '')}"
                if body not in already:
                    try:
                        _run(["gh", "issue", "comment", str(number), "--repo", TRACKER_REPO, "--body", body])
                    except Exception:
                        pass
