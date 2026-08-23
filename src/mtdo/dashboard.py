"""Generates the shared bug/status dashboard HTML from the private mukund1312/mtdo-bugs
tracker (bug_sync.py + status_sync.py). This is a *snapshot*, not a live page -- the
Artifact viewer's CSP blocks a published page from ever fetching GitHub's API itself (and
embedding a token that could would leak private-repo access to anyone with the link), so
refreshing means re-running this and republishing, not auto-updating. See PROGRESS.md for
why that tradeoff was chosen over other options.

Structured as a small client-side SPA (sidebar nav + hash routing: Dashboard/Issues/Team,
plus a real per-issue detail page and Cmd+K search) over one embedded JSON blob of the
current issues -- all still generated once, server-side, at snapshot time; nothing here
fetches anything live. Deliberately does NOT attempt Linear's Cycles/Sprints, Projects,
Roadmap, or Inbox concepts (2026-08-24 request) -- none of those map onto anything that
actually exists in this tracker yet (no priority/project/sprint scheduling data), and
building empty decorative UI for them would be worse than not having them. If those get
real backing data later (e.g. a `priority:*` label, a cycle/milestone convention), it's a
natural follow-up.

`mtdo-sandbox dashboard` writes the result to DASHBOARD_PATH; a Claude Code session then
publishes/updates it as a Claude Artifact from that file so both machines can open the
same link.
"""
import datetime
import html
import json
import os
import subprocess

from . import bug_sync, status_sync
from .bug_sync import DISPLAY_NAMES, PEOPLE, PERSON_COLOR_VAR

DASHBOARD_PATH = os.path.expanduser("~/.mtdo-sandbox/dashboard.html")

# The repo root, derived from this file's own location (src/mtdo/dashboard.py -> repo
# root is two levels up) -- works on whichever machine this runs on via the editable
# install, so commit counts always reflect that machine's local checkout after a pull.
_REPO_ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))


def _display_name(login):
    return DISPLAY_NAMES.get(login, login)


def _age(iso_ts):
    then = datetime.datetime.fromisoformat(iso_ts.replace("Z", "+00:00"))
    now = datetime.datetime.now(then.tzinfo)
    days = (now - then).days
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


def _issue_payload(issue):
    """One issue's data shaped for embedding as JSON and driving the client-side issue
    detail view/search -- the only place the raw GitHub issue body is actually used."""
    found_login = issue["author"]["login"] if issue.get("author") else "unknown"
    assigned = bug_sync.assigned_person(issue)
    return {
        "number": issue["number"],
        "title": issue["title"],
        "body": issue.get("body") or "",
        "state": issue["state"],
        "found_by": found_login,
        "found_by_name": _display_name(found_login),
        "assigned_to": assigned,
        "assigned_to_name": _display_name(assigned) if assigned else None,
        "found_age": _age(issue["createdAt"]),
        "updated_age": _age(issue["updatedAt"]) if issue.get("updatedAt") else None,
        "closed_age": _age(issue["closedAt"]) if issue.get("closedAt") else None,
    }


_SCRIPT = """
<script>
(function () {
  var ISSUES = __ISSUES_JSON__;
  var DISPLAY_NAMES = __DISPLAY_NAMES_JSON__;
  var WHOAMI_KEY = "mtdo_dashboard_whoami";

  function escapeHtml(s) {
    var d = document.createElement("div");
    d.textContent = s === null || s === undefined ? "" : String(s);
    return d.innerHTML;
  }

  function whoami() { return localStorage.getItem(WHOAMI_KEY) || ""; }

  function pill(state) {
    return state === "OPEN"
      ? '<span class="pill pill-open">OPEN</span>'
      : '<span class="pill pill-fixed">FIXED</span>';
  }

  // ---------- routing ----------
  function route() {
    var hash = (location.hash || "").replace(/^#\\/?/, "");
    var parts = hash.split("/");
    document.querySelectorAll(".view").forEach(function (v) { v.style.display = "none"; });
    document.querySelectorAll(".nav-item[data-route]").forEach(function (b) { b.classList.remove("active"); });

    if (parts[0] === "issue" && parts[1]) {
      showIssueDetail(parseInt(parts[1], 10));
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
    var mine = ISSUES.filter(function (i) { return i.state === "OPEN" && i.assigned_to === me; });
    if (!mine.length) {
      list.innerHTML = '<li class="dim">Nothing assigned to you right now.</li>';
      return;
    }
    mine.forEach(function (i) {
      var li = document.createElement("li");
      li.innerHTML = '<a href="#/issue/' + i.number + '">#' + i.number + " " + escapeHtml(i.title) + "</a>";
      list.appendChild(li);
    });
  }

  var whoSelect = document.getElementById("whoami-select");
  whoSelect.value = whoami();
  whoSelect.addEventListener("change", function () {
    localStorage.setItem(WHOAMI_KEY, whoSelect.value);
    renderDashboard();
  });

  // ---------- issue detail view ----------
  function showIssueDetail(number) {
    document.getElementById("view-issue").style.display = "";
    var issue = ISSUES.filter(function (i) { return i.number === number; })[0];
    var el = document.getElementById("issue-detail-content");
    if (!issue) {
      el.innerHTML = '<p class="dim">Issue not found in this snapshot -- it may be newer than the last refresh.</p>';
      return;
    }
    el.innerHTML =
      "<h1>#" + issue.number + " " + escapeHtml(issue.title) + "</h1>" +
      '<div class="issue-meta">' +
        '<div><span class="meta-label">Status</span>' + pill(issue.state) + "</div>" +
        '<div><span class="meta-label">Found by</span>' + escapeHtml(issue.found_by_name) + "</div>" +
        '<div><span class="meta-label">Assigned to</span>' +
          (issue.assigned_to_name ? escapeHtml(issue.assigned_to_name) : '<span class="dim">unassigned</span>') +
        "</div>" +
        '<div><span class="meta-label">Found</span>' + escapeHtml(issue.found_age) + "</div>" +
        (issue.closed_age ? '<div><span class="meta-label">Fixed</span>' + escapeHtml(issue.closed_age) + "</div>" : "") +
      "</div>" +
      '<p class="section-label">Description</p>' +
      '<pre class="issue-body">' + escapeHtml(issue.body || "(no description)") + "</pre>";
  }
  document.getElementById("back-to-issues").addEventListener("click", function () {
    location.hash = "#/issues";
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
    var results = ISSUES;
    if (q === "assigned:me") {
      var me = whoami();
      results = ISSUES.filter(function (i) { return i.assigned_to === me; });
    } else if (q) {
      results = ISSUES.filter(function (i) { return i.title.toLowerCase().indexOf(q) !== -1; });
    }
    results = results.slice(0, 20);
    var container = document.getElementById("search-results");
    container.innerHTML = "";
    if (!results.length) {
      container.innerHTML = '<p class="dim" style="padding:12px">No matches. Try a word from the title, or "assigned:me".</p>';
      return;
    }
    results.forEach(function (i) {
      var row = document.createElement("a");
      row.href = "#/issue/" + i.number;
      row.className = "search-result";
      row.innerHTML = pill(i.state) + " #" + i.number + " " + escapeHtml(i.title);
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

  // ---------- issues table filters (found by / assigned to) ----------
  var foundSel = document.getElementById("filter-found");
  var assignedSel = document.getElementById("filter-assigned");
  var clearBtn = document.getElementById("filter-clear");
  var rows = Array.prototype.slice.call(document.querySelectorAll("#bug-table tbody tr[data-found-by]"));
  var emptyMsg = document.getElementById("filter-empty");

  function applyFilters() {
    var wantFound = foundSel.value;
    var wantAssigned = assignedSel.value;
    var visible = 0;
    rows.forEach(function (row) {
      var matchesFound = !wantFound || row.getAttribute("data-found-by") === wantFound;
      var assignedTo = row.getAttribute("data-assigned-to") || "";
      var matchesAssigned = !wantAssigned ||
        (wantAssigned === "__unassigned__" ? assignedTo === "" : assignedTo === wantAssigned);
      var show = matchesFound && matchesAssigned;
      row.style.display = show ? "" : "none";
      if (show) visible++;
    });
    emptyMsg.style.display = visible === 0 ? "" : "none";
  }
  foundSel.addEventListener("change", applyFilters);
  assignedSel.addEventListener("change", applyFilters);
  clearBtn.addEventListener("click", function () {
    foundSel.value = "";
    assignedSel.value = "";
    applyFilters();
  });

  route();
})();
</script>
"""


def render_html(issues, statuses):
    open_count = sum(1 for i in issues if i["state"] == "OPEN")
    closed_count = sum(1 for i in issues if i["state"] == "CLOSED")
    found_by, fixed_by = _tally(issues)
    commits = _commit_counts()
    assignments = {p: {"assigned_open": 0, "assigned_fixed": 0} for p in PEOPLE}
    for issue in issues:
        who = bug_sync.assigned_person(issue)
        if who in assignments:
            key = "assigned_open" if issue["state"] == "OPEN" else "assigned_fixed"
            assignments[who][key] += 1

    # Always show both known people, even with zero activity so far (e.g. before anyone
    # has synced from their own machine) -- previously this list only included whoever
    # already had data, so a person who'd never used the tracker yet didn't appear at all.
    people = sorted(set(PEOPLE) | set(found_by) | set(fixed_by) | set(statuses), key=_display_name)
    max_commits = max([commits.get(p, 0) for p in people] + [1])

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

    rows = ""
    issue_payloads = []
    for issue in sorted(issues, key=lambda i: (i["state"] != "OPEN", i["number"] * -1)):
        payload = _issue_payload(issue)
        issue_payloads.append(payload)
        state = issue["state"]
        pill_class = "pill-open" if state == "OPEN" else "pill-fixed"
        pill_text = "OPEN" if state == "OPEN" else "FIXED"
        title = html.escape(issue["title"])
        author = html.escape(payload["found_by_name"])
        age = payload["closed_age"] or payload["found_age"]
        assignee = payload["assigned_to"]
        assignee_cell = html.escape(payload["assigned_to_name"]) if assignee else '<span class="dim">unassigned</span>'
        rows += f"""
        <tr data-found-by="{html.escape(payload['found_by'])}" data-assigned-to="{html.escape(assignee or '')}">
          <td><span class="pill {pill_class}">{pill_text}</span></td>
          <td class="bug-title"><a href="#/issue/{issue['number']}">{title}</a></td>
          <td>{author}</td>
          <td>{assignee_cell}</td>
          <td class="dim">{age}</td>
        </tr>"""

    filter_options = "".join(
        f'<option value="{login}">{html.escape(_display_name(login))}</option>' for login in PEOPLE
    )
    whoami_options = "".join(
        f'<option value="{login}">{html.escape(_display_name(login))}</option>' for login in PEOPLE
    )

    refreshed = datetime.datetime.now().strftime("%b %-d, %Y at %-I:%M %p")

    def _json_for_script(obj):
        # A bug title/body containing a literal "</script>" would otherwise close the
        # tag early and truncate the page -- escape the slash so it round-trips as data.
        return json.dumps(obj).replace("</", "<\\/")

    script = (
        _SCRIPT
        .replace("__ISSUES_JSON__", _json_for_script(issue_payloads))
        .replace("__DISPLAY_NAMES_JSON__", _json_for_script(DISPLAY_NAMES))
    )

    return f"""<title>mtdo Bug Board</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500;600;700&family=IBM+Plex+Sans:wght@500;600;700&display=swap" rel="stylesheet">
<style>
  :root {{
    --bg: #faf9f5; --surface: #ffffff; --surface-2: #f1efe8; --border: #e4e0d4;
    --text: #171a18; --text-dim: #5b6660; --good: #1f8f52; --warn: #a6721f;
    --mukund: #2f7fa8; --janhwi: #7c5cc4;
    --font-display: "IBM Plex Sans", ui-sans-serif, system-ui, sans-serif;
    --font-mono: "IBM Plex Mono", ui-monospace, "SF Mono", Menlo, monospace;
  }}
  @media (prefers-color-scheme: dark) {{
    :root:not([data-theme="light"]) {{
      --bg: #060807; --surface: #0c0f0d; --surface-2: #0a0c0b; --border: #1c2622;
      --text: #d8ded9; --text-dim: #7c8c83; --good: #39ff88; --warn: #e0b34d;
      --mukund: #5fb3d9; --janhwi: #a684e8;
    }}
  }}
  :root[data-theme="dark"] {{
    --bg: #060807; --surface: #0c0f0d; --surface-2: #0a0c0b; --border: #1c2622;
    --text: #d8ded9; --text-dim: #7c8c83; --good: #39ff88; --warn: #e0b34d;
    --mukund: #5fb3d9; --janhwi: #a684e8;
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
  .bug-title {{ max-width: 320px; }}
  .bug-title a {{ text-decoration: none; }}
  .bug-title a:hover {{ text-decoration: underline; }}
  .dim {{ color: var(--text-dim); }}

  .pill {{
    display: inline-block; font-family: var(--font-display); font-size: 0.65rem;
    font-weight: 700; letter-spacing: 0.05em; padding: 2px 8px; border-radius: 999px;
  }}
  .pill-open {{ color: var(--warn); background: color-mix(in srgb, var(--warn) 16%, transparent); }}
  .pill-fixed {{ color: var(--good); background: color-mix(in srgb, var(--good) 16%, transparent); }}

  .velocity-cell {{ display: flex; align-items: center; gap: 10px; min-width: 160px; }}
  .velocity-bar {{ flex: 1; height: 8px; background: var(--surface-2); border-radius: 4px; overflow: hidden; }}
  .velocity-fill {{ height: 100%; border-radius: 4px; }}

  #back-to-issues {{
    font-family: var(--font-display); font-size: 0.8rem; color: var(--text-dim); background: none;
    border: none; cursor: pointer; padding: 0 0 16px; display: block;
  }}
  #back-to-issues:hover {{ color: var(--text); }}
  .issue-meta {{ display: flex; gap: 24px; flex-wrap: wrap; margin-bottom: 18px; }}
  .meta-label {{
    display: block; font-family: var(--font-display); font-size: 0.65rem; text-transform: uppercase;
    letter-spacing: 0.06em; color: var(--text-dim); margin-bottom: 4px;
  }}
  .issue-body {{
    white-space: pre-wrap; word-wrap: break-word; font-family: var(--font-mono); font-size: 0.85rem;
    background: var(--surface); border: 1px solid var(--border); border-radius: 8px; padding: 14px; margin: 0;
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
    <section id="view-dashboard" class="view">
      <h1 id="greeting">Good day</h1>
      <p id="whoami-hint" class="dim"></p>
      <div class="stat-row">
        <div class="stat-card"><p class="stat-label">Found</p><p class="stat-num">{open_count + closed_count}</p></div>
        <div class="stat-card fixed"><p class="stat-label">Fixed</p><p class="stat-num">{closed_count}</p></div>
        <div class="stat-card open"><p class="stat-label">Open</p><p class="stat-num">{open_count}</p></div>
      </div>
      <p class="section-label">Assigned to me</p>
      <ul id="assigned-to-me-list" class="issue-mini-list"></ul>
      <p class="section-label">Team</p>
      <div class="person-row">{person_cards}</div>
    </section>

    <section id="view-issues" class="view" style="display:none">
      <h1>Issues</h1>
      <div class="filter-row">
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
          <thead><tr><th>State</th><th>Bug</th><th>Found by</th><th>Assigned to</th><th>Age</th></tr></thead>
          <tbody>
            {rows if rows else '<tr><td colspan="5" class="empty">No bugs synced yet -- run `mtdo-sandbox bugs sync &lt;instance&gt;`.</td></tr>'}
          </tbody>
        </table>
        <p id="filter-empty" class="empty" style="display:none">No bugs match this filter.</p>
      </div>
    </section>

    <section id="view-issue" class="view" style="display:none">
      <button id="back-to-issues">&larr; Back to Issues</button>
      <div id="issue-detail-content"></div>
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

    <p class="footer">Static snapshot, not live -- ask Claude to run `mtdo-sandbox dashboard` again and republish to refresh.
    Distribution: `mtdo-sandbox bugs distribute` assigns unassigned open bugs to whoever has fewer; finishing your queue first
    automatically pulls a few of the other person's over (see bug_sync.rebalance).</p>
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


def generate():
    issues = bug_sync.list_all()
    statuses = status_sync.get_all_status()
    content = render_html(issues, statuses)
    os.makedirs(os.path.dirname(DASHBOARD_PATH), exist_ok=True)
    with open(DASHBOARD_PATH, "w") as f:
        f.write(content)
    return DASHBOARD_PATH
