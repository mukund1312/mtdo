"""Generates the shared bug/status dashboard HTML from the private mukund1312/mtdo-bugs
tracker (bug_sync.py + status_sync.py).

This page declares the `artifact` runtime capability (see the artifact-capabilities skill)
and uses its live-doc mode: reassigning a bug, editing a bug's description, and posting a
note in a bug's conversation thread all write directly into the published page itself --
both viewers see each other's edits live, with no republish needed. Assignment/found-by
attribution/commit counts/state (open vs fixed) are still computed fresh from GitHub each
time this module runs -- only the three human-editable surfaces (assigned-to, description,
conversation) live on the page.

That creates one real tradeoff: since publishing new HTML replaces the whole page, a plain
`mtdo-sandbox dashboard` + republish would blow away any assignment/description/note edits
made on the page since the last publish. `generate(overrides=...)` exists for exactly this:
pass in `{issue_number: {"assigned_to": login_or_None, "description": str, "notes": [{"author":
str, "text": str}, ...]}}` read back from the currently-live page (e.g. via WebFetch from a
Claude Code session) and those values seed the new snapshot instead of GitHub's. A bare CLI
run with no overrides is fine when nobody's used the live editing yet, or when you're OK
resetting it back to GitHub's state.

Also NOT synced back to GitHub: reassigning on the dashboard does not change the
`assigned:<login>` label bug_sync.distribute_pending()/rebalance() use, so the two can drift
until someone reconciles them by hand (edit the GitHub label to match, or vice versa).

Related git activity per bug is read straight from this checkout's git history (branch names
and commit messages containing "gh<issue-number>" as a whole token, e.g. "gh42") -- a naming
convention, not an enforced link: name a branch or commit that way and it shows up
automatically. NOT a bare "#<number>" -- that collided in practice with GitHub's own PR
numbers and an old pre-tracker "(bug #N)" convention in this repo's history (see
_bug_git_activity's docstring, caught 2026-08-24).

Deliberately does NOT attempt Linear's Cycles/Sprints, Projects, Roadmap, or Inbox concepts
(2026-08-24 request) -- none of those map onto anything that actually exists in this tracker
yet (no priority/project/sprint scheduling data), and building empty decorative UI for them
would be worse than not having them.

`mtdo-sandbox dashboard` writes the result to DASHBOARD_PATH; a Claude Code session then
publishes/updates it as a Claude Artifact from that file so both machines can open the
same link.
"""
import datetime
import html
import json
import os
import re
import subprocess

from . import bug_sync, errorlog, status_sync
from .bug_sync import DISPLAY_NAMES, PEOPLE, PERSON_COLOR_VAR

DASHBOARD_PATH = os.path.expanduser("~/.mtdo-sandbox/dashboard.html")

# The repo root, derived from this file's own location (src/mtdo/dashboard.py -> repo
# root is two levels up) -- works on whichever machine this runs on via the editable
# install, so commit counts always reflect that machine's local checkout after a pull.
_REPO_ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))


def _display_name(login):
    return DISPLAY_NAMES.get(login, login)


_DASHBOARD_NOTE_PREFIXES = tuple(f"{name}: " for name in DISPLAY_NAMES.values())


def _render_comment_notes(issue):
    """Real, durable GitHub comments on this issue, in the {"author", "text"} shape
    _render_issue_detail expects -- the dashboard's "Conversation" thread reads
    these instead of anything living only in the live-doc page state (see
    bug_sync.sync_dashboard_overrides's docstring for the real incident that made
    this change necessary).

    A comment sync'd here from a dashboard note was posted under whoever's own
    `gh` CLI ran the sync (always the same machine identity, regardless of which
    of the two people actually typed the note in the browser) -- the note's real
    author is baked into the comment body text itself instead ("Mukund: ...",
    see sync_dashboard_overrides), which is why that case renders as-is rather
    than re-prefixing with the syncing account's name. Anything else on the
    issue (a fix-note left by mark_fixed_and_close, a plain `gh issue comment`)
    has no such prefix and gets one derived from its real GitHub comment author
    instead, so it still reads naturally in the thread."""
    notes = []
    for c in issue.get("comments", []):
        body = c.get("body") or ""
        if body.startswith(_DASHBOARD_NOTE_PREFIXES):
            notes.append({"author": "", "text": body})
        else:
            login = c["author"]["login"] if c.get("author") else None
            notes.append({"author": _display_name(login) if login else "GitHub", "text": body})
    return notes


def _age_days(iso_ts):
    then = datetime.datetime.fromisoformat(iso_ts.replace("Z", "+00:00"))
    now = datetime.datetime.now(then.tzinfo)
    return (now - then).days


def _age(iso_ts):
    days = _age_days(iso_ts)
    if days < 1:
        return "today"
    if days == 1:
        return "1 day ago"
    return f"{days} days ago"


def _tally(issues):
    found_by, fixed_by = {}, {}
    for issue in issues:
        author = issue["author"]["login"] if issue.get("author") else "unknown"
        found_by[author] = found_by.get(author, 0) + 1
        if issue["state"] == "CLOSED" and issue.get("assignees"):
            fixer = issue["assignees"][0]["login"]
            fixed_by[fixer] = fixed_by.get(fixer, 0) + 1
    return found_by, fixed_by


def _commit_counts():
    """Commits per person, matched by git identity email (see bug_sync.GIT_EMAILS --
    each person has more than one across machines/accounts). Counts every branch
    (--all), not just main, so in-progress feature-branch work counts too -- this is an
    activity signal, not a "what's shipped" metric. Returns {} if git isn't available or
    this isn't actually a checkout (shouldn't happen via the normal install, but this
    must never crash the whole dashboard over it)."""
    try:
        result = subprocess.run(
            ["git", "-C", _REPO_ROOT, "log", "--all", "--pretty=%ae"],
            capture_output=True, text=True, timeout=10,
        )
    except (OSError, subprocess.SubprocessError):
        return {}
    if result.returncode != 0:
        return {}
    counts = {p: 0 for p in PEOPLE}
    for email in result.stdout.splitlines():
        email = email.strip()
        for person, emails in bug_sync.GIT_EMAILS.items():
            if email in emails:
                counts[person] += 1
                break
    return counts


def _fetch_remotes_quiet():
    """Best-effort `git fetch --all` so a branch the other dev pushed (and named after a
    bug, see _bug_git_activity) shows up here too, on whichever machine regenerates the
    dashboard. Silently does nothing if offline or this isn't a real checkout -- this must
    never be the reason dashboard generation fails."""
    try:
        subprocess.run(
            ["git", "-C", _REPO_ROOT, "fetch", "--all", "--quiet"],
            capture_output=True, timeout=15,
        )
    except (OSError, subprocess.SubprocessError):
        pass


def _bug_git_activity(issue_number):
    """Branches and commits that reference this bug, by convention: a branch name or
    commit message containing "gh<issue_number>" as a whole token (case-insensitive) --
    e.g. branch `fix/gh42-flicker`, commit `Fixes gh42`.

    Deliberately NOT a bare "#<number>" (the original 2026-08-24 design) -- that produced
    real, actively wrong matches once the tracker grew past 10: GitHub's own
    auto-generated "Merge pull request #N" messages (this repo's own PR numbers, a
    completely different numbering space from the mtdo-bugs tracker's issue numbers) and
    an old pre-tracker "(bug #N)" convention used in this repo's commit history before
    mtdo-bugs existed both collided with real tracker issue numbers -- e.g. issue #10
    ("AI-config walkthrough steps") was showing "Merge pull request #10" and an unrelated
    "(bug #10)" commit about fresh_config.yaml on its dashboard page. `gh<number>` doesn't
    collide with either. Merge commits are excluded outright (`--no-merges`) as a second
    line of defense. Nothing here is an enforced link, just a naming convention devs opt
    into; best-effort and never fatal if git isn't available."""
    token = f"gh{issue_number}"
    number_pat = re.compile(rf"(?<![a-zA-Z0-9]){re.escape(token)}(?![a-zA-Z0-9])", re.IGNORECASE)
    try:
        branch_out = subprocess.run(
            ["git", "-C", _REPO_ROOT, "branch", "-a", "--format=%(refname:short)"],
            capture_output=True, text=True, timeout=10,
        )
        commit_out = subprocess.run(
            ["git", "-C", _REPO_ROOT, "log", "--all", "--no-merges",
             "--pretty=%h|%an|%ad|%s", "--date=short"],
            capture_output=True, text=True, timeout=10,
        )
    except (OSError, subprocess.SubprocessError):
        return {"branches": [], "commits": []}

    branches = []
    if branch_out.returncode == 0:
        for name in branch_out.stdout.splitlines():
            name = name.strip()
            if name.startswith("origin/HEAD"):
                continue
            name = name.replace("origin/", "", 1) if name.startswith("origin/") else name
            if name and number_pat.search(name) and name not in branches:
                branches.append(name)

    commits = []
    if commit_out.returncode == 0:
        for line in commit_out.stdout.splitlines():
            parts = line.split("|", 3)
            if len(parts) == 4:
                sha, author, date, subject = parts
                if number_pat.search(subject):
                    commits.append({"sha": sha, "author": author, "date": date, "subject": subject})
    return {"branches": branches, "commits": commits}


def _render_assign_control(issue_number, current_login, variant):
    """One editable "assigned to" control -- reused for both the issues table row and the
    issue detail page for the same bug. Clicking a name in the dropdown fires an explicit
    `artifact.edit()` call (see the script) that updates every copy of this control for
    this issue at once, so the table and the detail page never disagree.

    `variant` ("row" or "detail") keeps the two copies' data-id values distinct -- the
    live-doc edit API addresses elements by data-id (see the frame runtime's own
    patch-application code, which looks elements up via `[data-id="..."]`), so each
    copy needs its own id even though both share the same data-issue."""
    current_name = _display_name(current_login) if current_login else "Unassigned"
    options = "".join(
        f'<button type="button" class="assign-option" data-login="{login}">{html.escape(_display_name(login))}</button>'
        for login in PEOPLE
    )
    control_id = f"assign-{variant}-{issue_number}"
    label_id = f"assign-{variant}-label-{issue_number}"
    return f"""<div class="assign-control edit-affordance" data-id="{control_id}" data-issue="{issue_number}" data-assigned-to="{html.escape(current_login or '')}">
      <button type="button" class="assign-current" data-id="{label_id}">{html.escape(current_name)}</button>
      <div class="assign-menu">
        {options}
        <button type="button" class="assign-option" data-login="">Unassign</button>
      </div>
    </div>"""


_STATUS_LABELS = {"open": "Open", "postponed": "Postponed", "fixed": "Fixed"}
_STATUS_PILL_CLASS = {"open": "pill-open", "postponed": "pill-postponed", "fixed": "pill-fixed"}


def _render_status_control(issue_number, status, variant):
    """One editable status control (Open / Postponed / Fixed), same live-doc pattern
    as _render_assign_control -- reused for both the issues table row and the issue
    detail page. Clicking an option here only changes what's shown live on the page
    immediately (see the script); the real GitHub state (close/reopen the issue,
    add/remove the postponed label) is applied the next time someone runs
    dashboard.generate() with this page's current overrides -- see
    bug_sync.sync_dashboard_overrides.

    `variant` ("row" or "detail") keeps the two copies' data-id values distinct --
    see _render_assign_control's docstring for why data-id is required at all."""
    options = "".join(
        f'<button type="button" class="status-option" data-status="{key}">{label}</button>'
        for key, label in _STATUS_LABELS.items()
    )
    control_id = f"status-{variant}-{issue_number}"
    label_id = f"status-{variant}-label-{issue_number}"
    return f"""<div class="status-control edit-affordance" data-id="{control_id}" data-issue="{issue_number}" data-status="{status}">
      <button type="button" class="status-current pill {_STATUS_PILL_CLASS[status]}" data-id="{label_id}">{_STATUS_LABELS[status].upper()}</button>
      <div class="status-menu">
        {options}
      </div>
    </div>"""


def _render_issue_detail(issue, assigned_to, description, notes, priority=None, status="open"):
    number = issue["number"]
    title = html.escape(issue["title"])
    found_login = issue["author"]["login"] if issue.get("author") else "unknown"
    found_name = html.escape(_display_name(found_login))
    found_age = _age(issue["createdAt"])
    closed_age = _age(issue["closedAt"]) if issue.get("closedAt") else None
    priority_html = (
        f'<span class="pill pill-priority-{priority}">{priority.upper()}</span>'
        if priority else '<span class="dim">not triaged</span>'
    )

    activity = _bug_git_activity(number)
    if activity["branches"] or activity["commits"]:
        branch_items = "".join(f"<li>branch <code>{html.escape(b)}</code></li>" for b in activity["branches"])
        commit_items = "".join(
            f"<li><code>{html.escape(c['sha'])}</code> {html.escape(c['subject'])} "
            f"<span class=\"dim\">-- {html.escape(c['author'])}, {c['date']}</span></li>"
            for c in activity["commits"]
        )
        git_section = f'<ul class="git-list">{branch_items}{commit_items}</ul>'
    else:
        git_section = (
            f'<p class="dim">None yet -- name a branch or commit message with '
            f'"gh{number}" to link it here.</p>'
        )

    comment_items = "".join(
        f'<p class="comment">'
        f'{(html.escape(n["author"]) + ": ") if n.get("author") else ""}'
        f'{html.escape(n.get("text", ""))}</p>'
        for n in notes
    )

    return f"""
    <section class="view issue-detail-view" id="issue-detail-{number}" style="display:none">
      <button type="button" class="back-to-issues">&larr; Back to Issues</button>
      <h1>#{number} {title}</h1>
      <div class="issue-meta">
        <div><span class="meta-label">Status</span>{_render_status_control(number, status, "detail")}</div>
        <div><span class="meta-label">Priority</span>{priority_html}</div>
        <div><span class="meta-label">Found by</span>{found_name}</div>
        <div><span class="meta-label">Assigned to</span>{_render_assign_control(number, assigned_to, "detail")}</div>
        <div><span class="meta-label">Found</span>{found_age}</div>
        {f'<div><span class="meta-label">Fixed</span>{closed_age}</div>' if closed_age else ''}
      </div>
      <p class="section-label">Description</p>
      <div class="issue-body edit-affordance" contenteditable="true" spellcheck="false">{html.escape(description)}</div>
      <p class="section-label">Related git activity</p>
      {git_section}
      <p class="section-label">Conversation</p>
      <div class="thread" id="thread-{number}" data-id="thread-{number}">{comment_items}</div>
      <div class="thread-compose edit-affordance" artifact-local>
        <input type="text" class="thread-input" data-issue="{number}" placeholder="Write a note for the other dev...">
        <button type="button" class="thread-post" data-issue="{number}">Post</button>
      </div>
    </section>"""


_SCRIPT = """
<script>
(function () {
  var DISPLAY_NAMES = __DISPLAY_NAMES_JSON__;
  var WHOAMI_KEY = "mtdo_dashboard_whoami";

  function whoami() { return localStorage.getItem(WHOAMI_KEY) || ""; }

  // ---------- writer access (artifact live-doc capability) ----------
  var artifactApi = null;
  var artifactChecked = false;
  var readOnly = false;

  function showReadOnlyBanner() {
    if (readOnly) return;
    readOnly = true;
    document.querySelectorAll(".edit-affordance").forEach(function (el) { el.classList.add("is-readonly"); });
    document.querySelectorAll('[contenteditable="true"]').forEach(function (el) { el.contentEditable = "false"; });
    var banner = document.getElementById("readonly-banner");
    if (banner) banner.style.display = "";
  }
  document.addEventListener("claude:sync-off", showReadOnlyBanner);
  document.addEventListener("claude:sync-lost", showReadOnlyBanner);

  function getArtifact() {
    if (artifactChecked) return Promise.resolve(artifactApi);
    artifactChecked = true;
    if (!window.claude || typeof window.claude.use !== "function") {
      showReadOnlyBanner();
      return Promise.resolve(null);
    }
    return window.claude.use("artifact").then(function (api) {
      artifactApi = api;
      if (!api) showReadOnlyBanner();
      return api;
    }).catch(function () {
      showReadOnlyBanner();
      return null;
    });
  }

  function withWriter(fn) {
    return getArtifact().then(function (api) {
      if (!api) return false;
      return fn(api).then(function () { return true; }).catch(function (err) {
        var code = err && err.code;
        if (code === "not_writer" || code === "not_granted" || code === "not_declared" || code === "capability_disabled") {
          showReadOnlyBanner();
        }
        return false;
      });
    });
  }

  // ---------- routing ----------
  function route() {
    var hash = (location.hash || "").replace(/^#\\/?/, "");
    var parts = hash.split("/");
    document.querySelectorAll(".view").forEach(function (v) { v.style.display = "none"; });
    document.querySelectorAll(".nav-item[data-route]").forEach(function (b) { b.classList.remove("active"); });

    if (parts[0] === "issue" && parts[1]) {
      var section = document.getElementById("issue-detail-" + parts[1]);
      if (section) { section.style.display = ""; return; }
      document.getElementById("view-issues").style.display = "";
      return;
    }
    var name = (parts[0] === "issues" || parts[0] === "team") ? parts[0] : "dashboard";
    document.getElementById("view-" + name).style.display = "";
    var navBtn = document.querySelector('.nav-item[data-route="' + name + '"]');
    if (navBtn) navBtn.classList.add("active");
    if (name === "dashboard") renderDashboard();
  }
  window.addEventListener("hashchange", route);
  document.querySelectorAll(".nav-item[data-route]").forEach(function (b) {
    b.addEventListener("click", function () { location.hash = "#/" + b.dataset.route; });
  });
  document.addEventListener("click", function (e) {
    if (e.target.classList.contains("back-to-issues")) location.hash = "#/issues";
  });

  // ---------- read current row/assignment state straight from the DOM (always live,
  // since assignment lives on the page itself now, not a static snapshot blob) ----------
  function getRowsData() {
    return Array.prototype.map.call(document.querySelectorAll("#bug-table tbody tr[data-found-by]"), function (row) {
      var link = row.querySelector(".bug-title a");
      var control = row.querySelector(".assign-control");
      return {
        number: link ? parseInt(link.getAttribute("href").split("/").pop(), 10) : null,
        title: link ? link.textContent : "",
        state: row.getAttribute("data-state") || "OPEN",
        status: row.getAttribute("data-status") || "open",
        foundBy: row.getAttribute("data-found-by"),
        assignedTo: control ? (control.getAttribute("data-assigned-to") || "") : "",
      };
    });
  }

  // ---------- dashboard view ----------
  function renderDashboard() {
    var me = whoami();
    var name = DISPLAY_NAMES[me];
    document.getElementById("greeting").textContent = name ? ("Good day, " + name) : "Good day";
    document.getElementById("whoami-hint").style.display = name ? "none" : "";

    var list = document.getElementById("assigned-to-me-list");
    list.innerHTML = "";
    if (!me) {
      list.innerHTML = '<li class="dim">Pick "Viewing as" in the sidebar to see your assigned bugs here.</li>';
      return;
    }
    // Postponed is deliberately excluded here -- that's the whole point of postponing
    // something, it shouldn't keep nagging your own "assigned to me" active queue.
    var mine = getRowsData().filter(function (r) { return r.status === "open" && r.assignedTo === me; });
    if (!mine.length) {
      list.innerHTML = '<li class="dim">Nothing assigned to you right now.</li>';
      return;
    }
    mine.forEach(function (r) {
      var li = document.createElement("li");
      var a = document.createElement("a");
      a.href = "#/issue/" + r.number;
      a.textContent = "#" + r.number + " " + r.title;
      li.appendChild(a);
      list.appendChild(li);
    });
  }

  var whoSelect = document.getElementById("whoami-select");
  whoSelect.value = whoami();
  whoSelect.addEventListener("change", function () {
    localStorage.setItem(WHOAMI_KEY, whoSelect.value);
    renderDashboard();
  });

  // ---------- editable "assigned to" (table rows + issue detail, kept in sync) ----------
  document.querySelectorAll(".assign-current").forEach(function (btn) {
    btn.addEventListener("click", function (e) {
      e.stopPropagation();
      if (btn.closest(".edit-affordance").classList.contains("is-readonly")) return;
      var control = btn.closest(".assign-control");
      var isOpen = control.getAttribute("data-local-open") === "true";
      document.querySelectorAll(".assign-control").forEach(function (c) { c.removeAttribute("data-local-open"); });
      if (!isOpen) control.setAttribute("data-local-open", "true");
    });
  });
  document.addEventListener("click", function () {
    document.querySelectorAll(".assign-control").forEach(function (c) { c.removeAttribute("data-local-open"); });
  });
  document.querySelectorAll(".assign-option").forEach(function (btn) {
    btn.addEventListener("click", function (e) {
      e.stopPropagation();
      var login = btn.dataset.login;
      var name = login ? (DISPLAY_NAMES[login] || login) : "Unassigned";
      var issueNum = btn.closest(".assign-control").dataset.issue;
      var controls = document.querySelectorAll('.assign-control[data-issue="' + issueNum + '"]');
      var ops = [];
      controls.forEach(function (c) {
        var label = c.querySelector(".assign-current");
        ops.push({ op: "set-attr", target: c.dataset.id, key: "data-assigned-to", val: login });
        ops.push({ op: "set-text", target: label.dataset.id, text: name });
      });
      withWriter(function (api) { return api.edit(ops); }).then(function (ok) {
        if (!ok) return;
        controls.forEach(function (c) {
          c.setAttribute("data-assigned-to", login);
          c.querySelector(".assign-current").textContent = name;
          c.removeAttribute("data-local-open");
        });
        applyFilters();
        renderDashboard();
      });
    });
  });

  // ---------- editable status (Open / Postponed / Fixed) -- table rows + issue detail ----------
  var STATUS_LABELS = { open: "OPEN", postponed: "POSTPONED", fixed: "FIXED" };
  var STATUS_PILL_CLASS = { open: "pill-open", postponed: "pill-postponed", fixed: "pill-fixed" };
  var STATUS_REAL_STATE = { open: "OPEN", postponed: "OPEN", fixed: "CLOSED" };

  document.querySelectorAll(".status-current").forEach(function (btn) {
    btn.addEventListener("click", function (e) {
      e.stopPropagation();
      if (btn.closest(".edit-affordance").classList.contains("is-readonly")) return;
      var control = btn.closest(".status-control");
      var isOpen = control.getAttribute("data-local-open") === "true";
      document.querySelectorAll(".status-control").forEach(function (c) { c.removeAttribute("data-local-open"); });
      if (!isOpen) control.setAttribute("data-local-open", "true");
    });
  });
  document.addEventListener("click", function () {
    document.querySelectorAll(".status-control").forEach(function (c) { c.removeAttribute("data-local-open"); });
  });
  document.querySelectorAll(".status-option").forEach(function (btn) {
    btn.addEventListener("click", function (e) {
      e.stopPropagation();
      var status = btn.dataset.status;
      var issueNum = btn.closest(".status-control").dataset.issue;
      var controls = document.querySelectorAll('.status-control[data-issue="' + issueNum + '"]');
      var ops = [];
      var rows = [];
      controls.forEach(function (c) {
        var label = c.querySelector(".status-current");
        ops.push({ op: "set-attr", target: c.dataset.id, key: "data-status", val: status });
        ops.push({ op: "set-attr", target: label.dataset.id, key: "class", val: "status-current pill " + STATUS_PILL_CLASS[status] });
        ops.push({ op: "set-text", target: label.dataset.id, text: STATUS_LABELS[status] });
        var row = c.closest("tr");
        if (row) {
          rows.push(row);
          ops.push({ op: "set-attr", target: row.dataset.id, key: "data-state", val: STATUS_REAL_STATE[status] });
          ops.push({ op: "set-attr", target: row.dataset.id, key: "data-status", val: status });
        }
      });
      withWriter(function (api) { return api.edit(ops); }).then(function (ok) {
        if (!ok) return;
        controls.forEach(function (c) {
          c.setAttribute("data-status", status);
          var label = c.querySelector(".status-current");
          label.className = "status-current pill " + STATUS_PILL_CLASS[status];
          label.textContent = STATUS_LABELS[status];
          c.removeAttribute("data-local-open");
        });
        rows.forEach(function (row) {
          row.setAttribute("data-state", STATUS_REAL_STATE[status]);
          row.setAttribute("data-status", status);
        });
        applyFilters();
        renderDashboard();
      });
    });
  });

  // ---------- comment-count badges next to each bug's title in the Issues table ----------
  function refreshCommentBadges() {
    document.querySelectorAll(".comment-badge").forEach(function (badge) {
      var thread = document.getElementById("thread-" + badge.dataset.issue);
      var count = thread ? thread.querySelectorAll(".comment").length : 0;
      badge.textContent = count ? ("💬 " + count) : "";
      if (count) badge.removeAttribute("hidden"); else badge.setAttribute("hidden", "");
    });
  }

  // ---------- conversation thread (post a note, either dev, either direction) ----------
  document.querySelectorAll(".thread-post").forEach(function (btn) {
    btn.addEventListener("click", function () {
      var issueNum = btn.dataset.issue;
      var input = document.querySelector('.thread-input[data-issue="' + issueNum + '"]');
      var text = input.value.trim();
      if (!text) return;
      var me = whoami();
      var name = DISPLAY_NAMES[me] || me || "Someone";
      var thread = document.getElementById("thread-" + issueNum);
      withWriter(function (api) {
        return api.edit([{ op: "create-element", target: thread.dataset.id, tag: "p",
                            text: name + ": " + text, attrs: { "class": "comment" } }]);
      }).then(function (ok) {
        if (!ok) return;
        var p = document.createElement("p");
        p.className = "comment";
        p.textContent = name + ": " + text;
        thread.appendChild(p);
        input.value = "";
        refreshCommentBadges();
      });
    });
  });

  // ---------- search (Cmd+K) ----------
  var searchModal = document.getElementById("search-modal");
  var searchInput = document.getElementById("search-input");

  function openSearch() {
    searchModal.style.display = "";
    searchInput.value = "";
    renderSearchResults("");
    searchInput.focus();
  }
  function closeSearch() { searchModal.style.display = "none"; }

  function renderSearchResults(query) {
    var q = query.trim().toLowerCase();
    var results = getRowsData();
    if (q === "assigned:me") {
      var me = whoami();
      results = results.filter(function (r) { return r.assignedTo === me; });
    } else if (q) {
      results = results.filter(function (r) { return r.title.toLowerCase().indexOf(q) !== -1; });
    }
    results = results.slice(0, 20);
    var container = document.getElementById("search-results");
    container.innerHTML = "";
    if (!results.length) {
      container.innerHTML = '<p class="dim" style="padding:12px">No matches. Try a word from the title, or "assigned:me".</p>';
      return;
    }
    results.forEach(function (r) {
      var row = document.createElement("a");
      row.href = "#/issue/" + r.number;
      row.className = "search-result";
      var pillSpan = document.createElement("span");
      pillSpan.className = "pill " + STATUS_PILL_CLASS[r.status];
      pillSpan.textContent = STATUS_LABELS[r.status];
      row.appendChild(pillSpan);
      row.appendChild(document.createTextNode(" #" + r.number + " " + r.title));
      row.addEventListener("click", closeSearch);
      container.appendChild(row);
    });
  }

  document.getElementById("open-search").addEventListener("click", openSearch);
  searchInput.addEventListener("input", function (e) { renderSearchResults(e.target.value); });
  searchModal.addEventListener("click", function (e) { if (e.target === searchModal) closeSearch(); });
  document.addEventListener("keydown", function (e) {
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
      e.preventDefault();
      openSearch();
    } else if (e.key === "Escape") {
      closeSearch();
    }
  });

  // ---------- issues table filters (priority / found by / assigned to) ----------
  var prioritySel = document.getElementById("filter-priority");
  var foundSel = document.getElementById("filter-found");
  var assignedSel = document.getElementById("filter-assigned");
  var clearBtn = document.getElementById("filter-clear");
  var rows = Array.prototype.slice.call(document.querySelectorAll("#bug-table tbody tr[data-found-by]"));
  var emptyMsg = document.getElementById("filter-empty");

  function applyFilters() {
    var wantPriority = prioritySel.value;
    var wantFound = foundSel.value;
    var wantAssigned = assignedSel.value;
    var visible = 0;
    rows.forEach(function (row) {
      var matchesPriority = !wantPriority || row.getAttribute("data-priority") === wantPriority;
      var matchesFound = !wantFound || row.getAttribute("data-found-by") === wantFound;
      var control = row.querySelector(".assign-control");
      var assignedTo = control ? (control.getAttribute("data-assigned-to") || "") : "";
      var matchesAssigned = !wantAssigned ||
        (wantAssigned === "__unassigned__" ? assignedTo === "" : assignedTo === wantAssigned);
      var show = matchesPriority && matchesFound && matchesAssigned;
      row.style.display = show ? "" : "none";
      if (show) visible++;
    });
    emptyMsg.style.display = visible === 0 ? "" : "none";
  }
  prioritySel.addEventListener("change", applyFilters);
  foundSel.addEventListener("change", applyFilters);
  assignedSel.addEventListener("change", applyFilters);
  clearBtn.addEventListener("click", function () {
    prioritySel.value = "";
    foundSel.value = "";
    assignedSel.value = "";
    applyFilters();
  });

  // ---------- sortable columns (priority / age) -- purely a per-viewer preference, never
  // synced: the table body carries `artifact-local` (see the HTML) specifically so
  // reordering rows here -- and the filter's show/hide above -- never pushes onto anyone
  // else's view. ----------
  var PRIORITY_RANK = { high: 0, medium: 1, low: 2, "": 3 };
  var sortState = { column: null, dir: 1 };

  function applySort(column) {
    var tbody = document.querySelector("#bug-table tbody");
    var rowsArr = Array.prototype.slice.call(tbody.querySelectorAll("tr[data-found-by]"));
    if (sortState.column === column) {
      sortState.dir *= -1;
    } else {
      sortState.column = column;
      sortState.dir = 1;
    }
    rowsArr.sort(function (a, b) {
      var av, bv;
      if (column === "priority") {
        av = PRIORITY_RANK[a.getAttribute("data-priority") || ""];
        bv = PRIORITY_RANK[b.getAttribute("data-priority") || ""];
      } else {
        av = parseInt(a.getAttribute("data-age-days"), 10) || 0;
        bv = parseInt(b.getAttribute("data-age-days"), 10) || 0;
      }
      return (av - bv) * sortState.dir;
    });
    rowsArr.forEach(function (row) { tbody.appendChild(row); });
    document.querySelectorAll(".sortable").forEach(function (th) {
      var arrow = th.querySelector(".sort-arrow");
      arrow.textContent = th.dataset.sort === sortState.column ? (sortState.dir === 1 ? "▲" : "▼") : "";
    });
  }
  document.querySelectorAll(".sortable").forEach(function (th) {
    th.addEventListener("click", function () { applySort(th.dataset.sort); });
  });

  getArtifact();
  refreshCommentBadges();
  route();
})();
</script>
"""


def render_html(issues, statuses, overrides=None):
    overrides = overrides or {}
    open_count = sum(1 for i in issues if i["state"] == "OPEN")
    closed_count = sum(1 for i in issues if i["state"] == "CLOSED")
    found_by, fixed_by = _tally(issues)
    commits = _commit_counts()

    people = sorted(set(PEOPLE) | set(found_by) | set(fixed_by) | set(statuses), key=_display_name)
    max_commits = max([commits.get(p, 0) for p in people] + [1])

    rows = ""
    detail_sections = ""
    assignments = {p: {"assigned_open": 0, "assigned_fixed": 0} for p in PEOPLE}

    for issue in sorted(issues, key=lambda i: (i["state"] != "OPEN", i["number"] * -1)):
        number = issue["number"]
        override = overrides.get(number, overrides.get(str(number), {}))
        assigned_to = override.get("assigned_to", bug_sync.assigned_person(issue))
        description = override.get("description", issue.get("body") or "")
        notes = _render_comment_notes(issue)
        priority = bug_sync.bug_priority(issue)
        status = bug_sync.bug_status(issue)

        if assigned_to in assignments:
            key = "assigned_open" if issue["state"] == "OPEN" else "assigned_fixed"
            assignments[assigned_to][key] += 1

        title = html.escape(issue["title"])
        found_login = issue["author"]["login"] if issue.get("author") else "unknown"
        author = html.escape(_display_name(found_login))
        age_source = issue["closedAt"] if issue.get("closedAt") else issue["createdAt"]
        age = _age(age_source)
        age_days = _age_days(age_source)
        priority_cell = (
            f'<span class="pill pill-priority-{priority}">{priority.upper()}</span>'
            if priority else '<span class="dim">--</span>'
        )

        comment_badge = (
            f'<span class="comment-badge" data-issue="{number}">\U0001f4ac {len(notes)}</span>'
            if notes else
            f'<span class="comment-badge" data-issue="{number}" hidden></span>'
        )
        rows += f"""
        <tr data-id="row-{number}" data-found-by="{html.escape(found_login)}" data-priority="{priority or ''}" data-age-days="{age_days}"
            data-state="{issue['state']}" data-status="{status}">
          <td>{_render_status_control(number, status, "row")}</td>
          <td>{priority_cell}</td>
          <td class="bug-title"><a href="#/issue/{number}">{title}</a>{comment_badge}</td>
          <td>{author}</td>
          <td>{_render_assign_control(number, assigned_to, "row")}</td>
          <td class="dim">{age}</td>
        </tr>"""

        detail_sections += _render_issue_detail(issue, assigned_to, description, notes, priority, status)

    person_cards = ""
    team_rows = ""
    for login in people:
        name = html.escape(_display_name(login))
        color_var = PERSON_COLOR_VAR.get(login, "--mukund")
        st = statuses.get(login)
        status_line = html.escape(st["status"]) if st else "no status set"
        status_age = _age(st["updated_at"]) if st else ""
        initial = name[0].upper()
        a = assignments.get(login, {"assigned_open": 0, "assigned_fixed": 0})
        person_cards += f"""
        <div class="person-card">
          <div class="person-head">
            <span class="avatar" style="background:var({color_var})">{initial}</span>
            <span class="person-name">{name}</span>
          </div>
          <p class="status-line">{status_line}</p>
          {f'<p class="status-age">{status_age}</p>' if status_age else ''}
          <div class="person-tally">
            <span><b class="num">{found_by.get(login, 0)}</b> found</span>
            <span><b class="num">{fixed_by.get(login, 0)}</b> fixed</span>
            <span><b class="num">{commits.get(login, 0)}</b> commits</span>
          </div>
          <div class="person-tally assign-tally">
            <span><b class="num">{a['assigned_open']}</b> assigned to them</span>
          </div>
        </div>"""

        bar_pct = round(100 * commits.get(login, 0) / max_commits)
        team_rows += f"""
        <tr>
          <td><span class="avatar avatar-sm" style="background:var({color_var})">{initial}</span> {name}</td>
          <td>{a['assigned_open']} open</td>
          <td>{fixed_by.get(login, 0)} fixed</td>
          <td class="velocity-cell">
            <div class="velocity-bar"><div class="velocity-fill" style="width:{bar_pct}%;background:var({color_var})"></div></div>
            <span class="dim">{commits.get(login, 0)} commits</span>
          </td>
        </tr>"""

    filter_options = "".join(
        f'<option value="{login}">{html.escape(_display_name(login))}</option>' for login in PEOPLE
    )
    whoami_options = filter_options

    refreshed = datetime.datetime.now().strftime("%b %-d, %Y at %-I:%M %p")

    def _json_for_script(obj):
        # Defensive: a display name containing a literal "</script>" would otherwise
        # close the tag early and truncate the page -- escape the slash so it round-trips.
        return json.dumps(obj).replace("</", "<\\/")

    script = _SCRIPT.replace("__DISPLAY_NAMES_JSON__", _json_for_script(DISPLAY_NAMES))

    return f"""<title>mtdo Bug Board</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500;600;700&family=IBM+Plex+Sans:wght@500;600;700&display=swap" rel="stylesheet">
<style>
  :root {{
    --bg: #faf9f5; --surface: #ffffff; --surface-2: #f1efe8; --border: #e4e0d4;
    --text: #171a18; --text-dim: #5b6660; --good: #1f8f52; --warn: #a6721f; --danger: #b3261e;
    --postponed: #6f42c1; --mukund: #2f7fa8; --janhwi: #7c5cc4;
    --font-display: "IBM Plex Sans", ui-sans-serif, system-ui, sans-serif;
    --font-mono: "IBM Plex Mono", ui-monospace, "SF Mono", Menlo, monospace;
  }}
  @media (prefers-color-scheme: dark) {{
    :root:not([data-theme="light"]) {{
      --bg: #060807; --surface: #0c0f0d; --surface-2: #0a0c0b; --border: #1c2622;
      --text: #d8ded9; --text-dim: #7c8c83; --good: #39ff88; --warn: #e0b34d; --danger: #ff6b5e;
      --postponed: #b794f6; --mukund: #5fb3d9; --janhwi: #a684e8;
    }}
  }}
  :root[data-theme="dark"] {{
    --bg: #060807; --surface: #0c0f0d; --surface-2: #0a0c0b; --border: #1c2622;
    --text: #d8ded9; --text-dim: #7c8c83; --good: #39ff88; --warn: #e0b34d; --danger: #ff6b5e;
    --postponed: #b794f6; --mukund: #5fb3d9; --janhwi: #a684e8;
  }}
  * {{ box-sizing: border-box; }}
  html, body {{ height: 100%; }}
  body {{
    margin: 0; background: var(--bg); color: var(--text); font-family: var(--font-mono);
  }}
  a {{ color: inherit; }}

  .app {{ display: flex; min-height: 100vh; }}

  .sidebar {{
    width: 200px; flex-shrink: 0; background: var(--surface); border-right: 1px solid var(--border);
    padding: 20px 14px; display: flex; flex-direction: column; position: sticky; top: 0; height: 100vh;
  }}
  .brand {{ font-family: var(--font-display); font-weight: 700; font-size: 1rem; letter-spacing: 0.04em; margin-bottom: 20px; }}
  .nav-item {{
    display: flex; align-items: center; justify-content: space-between; width: 100%; text-align: left;
    background: none; border: none; color: var(--text-dim); font-family: var(--font-display);
    font-size: 0.85rem; font-weight: 500; padding: 8px 10px; border-radius: 6px; cursor: pointer; margin-bottom: 2px;
  }}
  .nav-item:hover {{ background: var(--surface-2); color: var(--text); }}
  .nav-item.active {{ background: var(--surface-2); color: var(--text); font-weight: 600; }}
  .kbd-hint {{
    font-size: 0.65rem; color: var(--text-dim); border: 1px solid var(--border); border-radius: 4px; padding: 0 5px;
  }}
  .sidebar-footer {{ margin-top: auto; padding-top: 12px; border-top: 1px solid var(--border); }}
  .sidebar-footer label {{ display: block; font-size: 0.7rem; color: var(--text-dim); margin-bottom: 4px; }}
  .sidebar-footer select {{
    width: 100%; font-family: var(--font-mono); font-size: 0.8rem; color: var(--text); background: var(--bg);
    border: 1px solid var(--border); border-radius: 6px; padding: 5px 6px; margin-bottom: 10px;
  }}
  .refreshed-note {{ font-size: 0.65rem; color: var(--text-dim); margin: 0; }}

  .content {{ flex: 1; padding: 32px 28px 60px; max-width: 900px; }}
  .view h1 {{
    font-family: var(--font-display); font-weight: 700; font-size: 1.5rem; margin: 0 0 18px; text-wrap: balance;
  }}

  #readonly-banner {{
    display: none; background: color-mix(in srgb, var(--warn) 14%, transparent); color: var(--warn);
    border: 1px solid var(--warn); border-radius: 8px; padding: 8px 14px; font-size: 0.8rem; margin-bottom: 16px;
  }}

  .stat-row {{ display: grid; grid-template-columns: repeat(3, 1fr); gap: 12px; margin-bottom: 28px; }}
  .stat-card {{ background: var(--surface); border: 1px solid var(--border); border-radius: 10px; padding: 16px 18px; }}
  .stat-label {{
    font-family: var(--font-display); font-size: 0.7rem; text-transform: uppercase;
    letter-spacing: 0.08em; color: var(--text-dim); margin: 0 0 6px;
  }}
  .stat-num {{ font-size: 2.1rem; font-weight: 600; font-variant-numeric: tabular-nums; margin: 0; }}
  .stat-card.fixed .stat-num {{ color: var(--good); }}
  .stat-card.open .stat-num {{ color: var(--warn); }}

  .section-label {{
    font-family: var(--font-display); font-size: 0.75rem; text-transform: uppercase;
    letter-spacing: 0.08em; color: var(--text-dim); margin: 24px 0 10px;
  }}
  .section-label:first-of-type {{ margin-top: 0; }}

  .issue-mini-list {{ list-style: none; margin: 0 0 8px; padding: 0; }}
  .issue-mini-list li {{
    padding: 8px 12px; background: var(--surface); border: 1px solid var(--border); border-radius: 8px; margin-bottom: 6px;
    font-size: 0.85rem;
  }}
  .issue-mini-list a {{ text-decoration: none; }}
  .issue-mini-list a:hover {{ text-decoration: underline; }}
  #whoami-hint {{ font-size: 0.8rem; color: var(--text-dim); margin: -8px 0 16px; }}

  .person-row {{ display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 12px; }}
  .person-card {{ background: var(--surface); border: 1px solid var(--border); border-radius: 10px; padding: 16px 18px; }}
  .person-head {{ display: flex; align-items: center; gap: 10px; margin-bottom: 10px; }}
  .avatar {{
    width: 28px; height: 28px; border-radius: 50%; display: flex; align-items: center;
    justify-content: center; font-family: var(--font-display); font-weight: 700;
    font-size: 0.8rem; color: var(--bg); flex-shrink: 0;
  }}
  .avatar-sm {{ width: 20px; height: 20px; font-size: 0.65rem; display: inline-flex; vertical-align: middle; margin-right: 6px; }}
  .person-name {{ font-family: var(--font-display); font-weight: 600; font-size: 0.95rem; }}
  .status-line {{ font-size: 0.85rem; margin: 0 0 2px; line-height: 1.5; }}
  .status-age {{ font-size: 0.75rem; color: var(--text-dim); margin: 0 0 10px; }}
  .person-tally {{ display: flex; gap: 16px; font-size: 0.8rem; color: var(--text-dim); flex-wrap: wrap; }}
  .person-tally .num {{ color: var(--text); font-variant-numeric: tabular-nums; }}
  .assign-tally {{ margin-top: 6px; padding-top: 6px; border-top: 1px dashed var(--border); }}

  .filter-row {{ display: flex; align-items: center; gap: 16px; margin-bottom: 10px; flex-wrap: wrap; }}
  .filter-row label {{ display: flex; align-items: center; gap: 6px; font-size: 0.8rem; color: var(--text-dim); }}
  .filter-row select {{
    font-family: var(--font-mono); font-size: 0.8rem; color: var(--text); background: var(--surface);
    border: 1px solid var(--border); border-radius: 6px; padding: 4px 8px;
  }}
  .filter-row button {{
    font-family: var(--font-display); font-size: 0.75rem; color: var(--text-dim); background: none;
    border: 1px solid var(--border); border-radius: 6px; padding: 4px 10px; cursor: pointer;
  }}
  .filter-row button:hover {{ color: var(--text); border-color: var(--text-dim); }}

  .table-wrap {{ overflow-x: auto; border: 1px solid var(--border); border-radius: 10px; }}
  table {{ width: 100%; border-collapse: collapse; font-size: 0.85rem; background: var(--surface); }}
  th {{
    text-align: left; font-family: var(--font-display); font-weight: 600; font-size: 0.7rem;
    text-transform: uppercase; letter-spacing: 0.06em; color: var(--text-dim);
    padding: 10px 14px; border-bottom: 1px solid var(--border); background: var(--surface-2);
  }}
  td {{ padding: 9px 14px; border-bottom: 1px solid var(--border); vertical-align: middle; }}
  tr:last-child td {{ border-bottom: none; }}
  th.sortable {{ cursor: pointer; user-select: none; white-space: nowrap; }}
  th.sortable:hover {{ color: var(--text); }}
  .sort-arrow {{ font-size: 0.6rem; display: inline-block; width: 8px; }}
  .bug-title {{ max-width: 320px; }}
  .bug-title a {{ text-decoration: none; }}
  .bug-title a:hover {{ text-decoration: underline; }}
  .comment-badge {{ font-size: 0.75rem; color: var(--text-dim); margin-left: 6px; white-space: nowrap; }}
  .dim {{ color: var(--text-dim); }}

  .pill {{
    display: inline-block; font-family: var(--font-display); font-size: 0.65rem;
    font-weight: 700; letter-spacing: 0.05em; padding: 2px 8px; border-radius: 999px;
  }}
  .pill-open {{ color: var(--warn); background: color-mix(in srgb, var(--warn) 16%, transparent); }}
  .pill-fixed {{ color: var(--good); background: color-mix(in srgb, var(--good) 16%, transparent); }}
  .pill-postponed {{ color: var(--postponed); background: color-mix(in srgb, var(--postponed) 16%, transparent); }}
  .pill-priority-high {{ color: var(--danger); background: color-mix(in srgb, var(--danger) 16%, transparent); }}
  .pill-priority-medium {{ color: var(--warn); background: color-mix(in srgb, var(--warn) 16%, transparent); }}
  .pill-priority-low {{ color: var(--text-dim); background: var(--surface-2); }}

  .velocity-cell {{ display: flex; align-items: center; gap: 10px; min-width: 160px; }}
  .velocity-bar {{ flex: 1; height: 8px; background: var(--surface-2); border-radius: 4px; overflow: hidden; }}
  .velocity-fill {{ height: 100%; border-radius: 4px; }}

  .back-to-issues {{
    font-family: var(--font-display); font-size: 0.8rem; color: var(--text-dim); background: none;
    border: none; cursor: pointer; padding: 0 0 16px; display: block;
  }}
  .back-to-issues:hover {{ color: var(--text); }}
  .issue-meta {{ display: flex; gap: 24px; flex-wrap: wrap; margin-bottom: 18px; }}
  .meta-label {{
    display: block; font-family: var(--font-display); font-size: 0.65rem; text-transform: uppercase;
    letter-spacing: 0.06em; color: var(--text-dim); margin-bottom: 4px;
  }}
  .issue-body {{
    white-space: pre-wrap; word-wrap: break-word; font-family: var(--font-mono); font-size: 0.85rem;
    background: var(--surface); border: 1px solid var(--border); border-radius: 8px; padding: 14px; margin: 0 0 4px;
    outline: none;
  }}
  .issue-body[contenteditable="true"]:focus {{ border-color: var(--text-dim); }}
  .issue-body[contenteditable="true"]::after {{ content: ""; }}

  .assign-control {{ position: relative; display: inline-block; }}
  .assign-current {{
    font-family: var(--font-mono); font-size: 0.8rem; color: var(--text); background: var(--surface-2);
    border: 1px solid var(--border); border-radius: 6px; padding: 3px 10px; cursor: pointer;
  }}
  .assign-menu {{
    display: none; position: absolute; top: 100%; left: 0; margin-top: 4px; z-index: 20;
    background: var(--surface); border: 1px solid var(--border); border-radius: 8px;
    box-shadow: 0 8px 24px rgba(0,0,0,0.18); overflow: hidden; min-width: 130px;
  }}
  .assign-control[data-local-open="true"] .assign-menu {{ display: block; }}
  .assign-option {{
    display: block; width: 100%; text-align: left; font-family: var(--font-mono); font-size: 0.8rem;
    color: var(--text); background: none; border: none; padding: 7px 12px; cursor: pointer;
  }}
  .assign-option:hover {{ background: var(--surface-2); }}

  .status-control {{ position: relative; display: inline-block; }}
  .status-current {{ cursor: pointer; border: none; }}
  .status-menu {{
    display: none; position: absolute; top: 100%; left: 0; margin-top: 4px; z-index: 20;
    background: var(--surface); border: 1px solid var(--border); border-radius: 8px;
    box-shadow: 0 8px 24px rgba(0,0,0,0.18); overflow: hidden; min-width: 110px;
  }}
  .status-control[data-local-open="true"] .status-menu {{ display: block; }}
  .status-option {{
    display: block; width: 100%; text-align: left; font-family: var(--font-mono); font-size: 0.8rem;
    color: var(--text); background: none; border: none; padding: 7px 12px; cursor: pointer;
  }}
  .status-option:hover {{ background: var(--surface-2); }}
  .is-readonly {{ opacity: 0.5; pointer-events: none; }}

  .git-list {{ list-style: none; padding: 0; margin: 0 0 4px; font-size: 0.8rem; }}
  .git-list li {{ padding: 5px 0; border-bottom: 1px solid var(--border); }}
  .git-list li:last-child {{ border-bottom: none; }}
  .git-list code {{ font-size: 0.78rem; background: var(--surface-2); padding: 1px 5px; border-radius: 4px; }}

  .thread {{ display: flex; flex-direction: column; gap: 6px; margin-bottom: 10px; }}
  .comment {{
    margin: 0; font-size: 0.85rem; background: var(--surface); border: 1px solid var(--border);
    border-radius: 8px; padding: 8px 12px; white-space: pre-wrap;
  }}
  .thread-compose {{ display: flex; gap: 8px; }}
  .thread-input {{
    flex: 1; font-family: var(--font-mono); font-size: 0.85rem; color: var(--text); background: var(--surface);
    border: 1px solid var(--border); border-radius: 6px; padding: 7px 10px;
  }}
  .thread-post {{
    font-family: var(--font-display); font-size: 0.8rem; font-weight: 600; color: var(--bg); background: var(--text);
    border: none; border-radius: 6px; padding: 0 16px; cursor: pointer;
  }}

  .search-modal {{
    position: fixed; inset: 0; background: rgba(0,0,0,0.4); display: flex; align-items: flex-start;
    justify-content: center; padding-top: 12vh; z-index: 100;
  }}
  .search-box {{
    width: 100%; max-width: 520px; background: var(--surface); border: 1px solid var(--border);
    border-radius: 10px; overflow: hidden; box-shadow: 0 12px 40px rgba(0,0,0,0.25);
  }}
  #search-input {{
    width: 100%; border: none; outline: none; padding: 14px 16px; font-family: var(--font-mono);
    font-size: 0.9rem; color: var(--text); background: var(--surface); border-bottom: 1px solid var(--border);
  }}
  #search-results {{ max-height: 320px; overflow-y: auto; }}
  .search-result {{
    display: block; padding: 10px 16px; font-size: 0.85rem; text-decoration: none; border-bottom: 1px solid var(--border);
  }}
  .search-result:hover {{ background: var(--surface-2); }}

  .footer {{ margin-top: 28px; font-size: 0.75rem; color: var(--text-dim); text-align: center; }}
  .empty {{ color: var(--text-dim); font-size: 0.85rem; padding: 20px; text-align: center; }}
</style>

<div class="app">
  <nav class="sidebar">
    <div class="brand">MTDO</div>
    <button class="nav-item" data-route="dashboard">🏠 Dashboard</button>
    <button class="nav-item" data-route="issues">📝 Issues</button>
    <button class="nav-item" data-route="team">👥 Team</button>
    <button class="nav-item" id="open-search">🔍 Search <span class="kbd-hint">⌘K</span></button>
    <div class="sidebar-footer">
      <label for="whoami-select">Viewing as</label>
      <select id="whoami-select">
        <option value="">-- pick --</option>
        {whoami_options}
      </select>
      <p class="refreshed-note">Refreshed {refreshed}</p>
    </div>
  </nav>

  <main class="content">
    <p id="readonly-banner">Read-only here -- ask to be added as an editor from this artifact's share menu to reassign bugs, edit descriptions, or post notes.</p>

    <section id="view-dashboard" class="view">
      <h1 id="greeting">Good day</h1>
      <p id="whoami-hint" class="dim"></p>
      <div class="stat-row">
        <div class="stat-card"><p class="stat-label">Found</p><p class="stat-num">{open_count + closed_count}</p></div>
        <div class="stat-card fixed"><p class="stat-label">Fixed</p><p class="stat-num">{closed_count}</p></div>
        <div class="stat-card open"><p class="stat-label">Open</p><p class="stat-num">{open_count}</p></div>
      </div>
      <p class="section-label">Assigned to me</p>
      <ul id="assigned-to-me-list" class="issue-mini-list" artifact-local></ul>
      <p class="section-label">Team</p>
      <div class="person-row">{person_cards}</div>
    </section>

    <section id="view-issues" class="view" style="display:none">
      <h1>Issues</h1>
      <div class="filter-row">
        <label>Priority
          <select id="filter-priority">
            <option value="">Any</option>
            <option value="high">High</option>
            <option value="medium">Medium</option>
            <option value="low">Low</option>
          </select>
        </label>
        <label>Found by
          <select id="filter-found">
            <option value="">Anyone</option>
            {filter_options}
          </select>
        </label>
        <label>Assigned to
          <select id="filter-assigned">
            <option value="">Anyone</option>
            <option value="__unassigned__">Unassigned</option>
            {filter_options}
          </select>
        </label>
        <button id="filter-clear" type="button">Clear</button>
      </div>
      <div class="table-wrap">
        <table id="bug-table">
          <thead><tr>
            <th>State</th>
            <th class="sortable" data-sort="priority">Priority <span class="sort-arrow"></span></th>
            <th>Bug</th><th>Found by</th><th>Assigned to</th>
            <th class="sortable" data-sort="age">Age <span class="sort-arrow"></span></th>
          </tr></thead>
          <tbody artifact-local>
            {rows if rows else '<tr><td colspan="6" class="empty">No bugs synced yet -- run `mtdo-sandbox bugs sync &lt;instance&gt;`.</td></tr>'}
          </tbody>
        </table>
        <p id="filter-empty" class="empty" style="display:none">No bugs match this filter.</p>
      </div>
    </section>

    <section id="view-team" class="view" style="display:none">
      <h1>Team</h1>
      <div class="table-wrap">
        <table>
          <thead><tr><th>Person</th><th>Open</th><th>Fixed</th><th>Velocity (commits)</th></tr></thead>
          <tbody>{team_rows}</tbody>
        </table>
      </div>
    </section>
    {detail_sections}

    <p class="footer">Assigning, editing a description, and posting notes save live to this page and are visible to
    both of you immediately. Found-by/fixed/commit stats and new bugs still come from GitHub -- ask Claude to run
    `mtdo-sandbox dashboard` again and republish to pull those in (it preserves your edits when it does).</p>
  </main>

  <div id="search-modal" class="search-modal" style="display:none">
    <div class="search-box">
      <input id="search-input" placeholder="Search issue titles, or type assigned:me" autocomplete="off">
      <div id="search-results"></div>
    </div>
  </div>
</div>
{script}
"""


def generate(overrides=None):
    """Writes the dashboard HTML and returns (path, triaged) -- `triaged` is whatever
    bug_sync.auto_triage_pending() did as this function's own safety net (covers a bug
    filed some other way, or generate() called without a sync step first). Genuinely not
    always empty even right after a sync_and_triage() call: GitHub's issue-list endpoint
    has occasionally shown a beat of lag behind a just-created issue in practice, so this
    second attempt (by which point more time and GitHub calls have elapsed) is often what
    actually catches a brand-new bug -- confirmed live, not just theoretical (2026-08-24).
    Callers that want an accurate "N bugs triaged" message should use this return value,
    not just whatever sync_and_triage() reported on its own.

    Calls bug_sync.sync_dashboard_overrides(overrides) FIRST, before fetching fresh
    issue state -- pushes any status/assignment/note changes made live on the
    currently-published page back to real GitHub, so this generation (and every
    generation after it, even one run with no overrides at all) reflects them
    durably instead of only for as long as nobody republishes without remembering
    to carry the override dict forward by hand. See that function's own docstring
    for the real incident that made this necessary, not just a hypothetical.

    Returns (DASHBOARD_PATH, None) -- instead of raising -- if a `gh` call fails
    partway through (rate limit, auth hiccup, network blip): gh67, every OTHER
    subprocess call in this file (_commit_counts, _fetch_remotes_quiet,
    _bug_git_activity) already degrades gracefully rather than crashing the whole
    dashboard over a transient failure; this brings actual regeneration in line
    with that same philosophy. DASHBOARD_PATH is left untouched in that case (the
    write below never runs), so callers still have the last-known-good page --
    `triaged is None` is how a caller tells "generation was skipped" apart from
    a real "nothing needed triaging" (`{}`)."""
    _fetch_remotes_quiet()
    try:
        bug_sync.sync_dashboard_overrides(overrides)
        triaged = bug_sync.auto_triage_pending()
        issues = bug_sync.list_all()
        statuses = status_sync.get_all_status()
    except RuntimeError:
        errorlog.log.exception("dashboard.generate(): a gh call failed -- keeping the last-known-good page")
        return DASHBOARD_PATH, None
    content = render_html(issues, statuses, overrides=overrides)
    os.makedirs(os.path.dirname(DASHBOARD_PATH), exist_ok=True)
    with open(DASHBOARD_PATH, "w") as f:
        f.write(content)
    return DASHBOARD_PATH, triaged
