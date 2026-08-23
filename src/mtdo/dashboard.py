"""Generates the shared bug/status dashboard HTML from the private mukund1312/mtdo-bugs
tracker (bug_sync.py + status_sync.py). This is a *snapshot*, not a live page -- the
Artifact viewer's CSP blocks a published page from ever fetching GitHub's API itself (and
embedding a token that could would leak private-repo access to anyone with the link), so
refreshing means re-running this and republishing, not auto-updating. See PROGRESS.md for
why that tradeoff was chosen over other options.

`mtdo-sandbox dashboard` writes the result to DASHBOARD_PATH; a Claude Code session then
publishes/updates it as a Claude Artifact from that file so both machines can open the
same link.
"""
import datetime
import html
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

    person_cards = ""
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

    rows = ""
    for issue in sorted(issues, key=lambda i: (i["state"] != "OPEN", i["number"] * -1)):
        state = issue["state"]
        pill_class = "pill-open" if state == "OPEN" else "pill-fixed"
        pill_text = "OPEN" if state == "OPEN" else "FIXED"
        title = html.escape(issue["title"])
        author = html.escape(_display_name(issue["author"]["login"] if issue.get("author") else "unknown"))
        age = _age(issue["closedAt"] if state == "CLOSED" and issue.get("closedAt") else issue["createdAt"])
        assignee = bug_sync.assigned_person(issue)
        assignee_cell = html.escape(_display_name(assignee)) if assignee else '<span class="dim">unassigned</span>'
        rows += f"""
        <tr>
          <td><span class="pill {pill_class}">{pill_text}</span></td>
          <td class="bug-title">{title}</td>
          <td>{author}</td>
          <td>{assignee_cell}</td>
          <td class="dim">{age}</td>
        </tr>"""

    refreshed = datetime.datetime.now().strftime("%b %-d, %Y at %-I:%M %p")

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
  body {{
    margin: 0; background: var(--bg); color: var(--text); font-family: var(--font-mono);
    padding: 32px 20px 60px;
  }}
  .wrap {{ max-width: 880px; margin: 0 auto; }}
  h1 {{
    font-family: var(--font-display); font-weight: 700; font-size: 1.7rem; margin: 0 0 4px;
    text-wrap: balance;
  }}
  .subtitle {{ color: var(--text-dim); font-size: 0.85rem; margin: 0 0 28px; }}

  .stat-row {{ display: grid; grid-template-columns: repeat(3, 1fr); gap: 12px; margin-bottom: 28px; }}
  .stat-card {{
    background: var(--surface); border: 1px solid var(--border); border-radius: 10px;
    padding: 16px 18px;
  }}
  .stat-label {{
    font-family: var(--font-display); font-size: 0.7rem; text-transform: uppercase;
    letter-spacing: 0.08em; color: var(--text-dim); margin: 0 0 6px;
  }}
  .stat-num {{
    font-size: 2.1rem; font-weight: 600; font-variant-numeric: tabular-nums; margin: 0;
  }}
  .stat-card.fixed .stat-num {{ color: var(--good); }}
  .stat-card.open .stat-num {{ color: var(--warn); }}

  .section-label {{
    font-family: var(--font-display); font-size: 0.75rem; text-transform: uppercase;
    letter-spacing: 0.08em; color: var(--text-dim); margin: 0 0 10px;
  }}

  .person-row {{ display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 12px; margin-bottom: 28px; }}
  .person-card {{
    background: var(--surface); border: 1px solid var(--border); border-radius: 10px; padding: 16px 18px;
  }}
  .person-head {{ display: flex; align-items: center; gap: 10px; margin-bottom: 10px; }}
  .avatar {{
    width: 28px; height: 28px; border-radius: 50%; display: flex; align-items: center;
    justify-content: center; font-family: var(--font-display); font-weight: 700;
    font-size: 0.8rem; color: var(--bg); flex-shrink: 0;
  }}
  .person-name {{ font-family: var(--font-display); font-weight: 600; font-size: 0.95rem; }}
  .status-line {{ font-size: 0.85rem; margin: 0 0 2px; line-height: 1.5; }}
  .status-age {{ font-size: 0.75rem; color: var(--text-dim); margin: 0 0 10px; }}
  .person-tally {{ display: flex; gap: 16px; font-size: 0.8rem; color: var(--text-dim); flex-wrap: wrap; }}
  .person-tally .num {{ color: var(--text); font-variant-numeric: tabular-nums; }}
  .assign-tally {{ margin-top: 6px; padding-top: 6px; border-top: 1px dashed var(--border); }}

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
  .dim {{ color: var(--text-dim); }}

  .pill {{
    display: inline-block; font-family: var(--font-display); font-size: 0.65rem;
    font-weight: 700; letter-spacing: 0.05em; padding: 2px 8px; border-radius: 999px;
  }}
  .pill-open {{ color: var(--warn); background: color-mix(in srgb, var(--warn) 16%, transparent); }}
  .pill-fixed {{ color: var(--good); background: color-mix(in srgb, var(--good) 16%, transparent); }}

  .footer {{ margin-top: 28px; font-size: 0.75rem; color: var(--text-dim); text-align: center; }}
  .empty {{ color: var(--text-dim); font-size: 0.85rem; padding: 20px; text-align: center; }}
</style>

<div class="wrap">
  <h1>mtdo Bug Board</h1>
  <p class="subtitle">Shared across both machines via the private mukund1312/mtdo-bugs tracker · refreshed {refreshed}</p>

  <div class="stat-row">
    <div class="stat-card"><p class="stat-label">Found</p><p class="stat-num">{open_count + closed_count}</p></div>
    <div class="stat-card fixed"><p class="stat-label">Fixed</p><p class="stat-num">{closed_count}</p></div>
    <div class="stat-card open"><p class="stat-label">Open</p><p class="stat-num">{open_count}</p></div>
  </div>

  <p class="section-label">Working on</p>
  <div class="person-row">
    {person_cards}
  </div>

  <p class="section-label">Bugs (found by, currently assigned to)</p>
  <div class="table-wrap">
    <table>
      <thead><tr><th>State</th><th>Bug</th><th>Found by</th><th>Assigned to</th><th>Age</th></tr></thead>
      <tbody>
        {rows if rows else '<tr><td colspan="5" class="empty">No bugs synced yet -- run `mtdo-sandbox bugs sync &lt;instance&gt;`.</td></tr>'}
      </tbody>
    </table>
  </div>

  <p class="footer">Static snapshot, not live -- ask Claude to run `mtdo-sandbox dashboard` again and republish to refresh.
  Distribution: `mtdo-sandbox bugs distribute` assigns unassigned open bugs to whoever has fewer; finishing your queue first
  automatically pulls a few of the other person's over (see bug_sync.rebalance).</p>
</div>
"""


def generate():
    issues = bug_sync.list_all()
    statuses = status_sync.get_all_status()
    content = render_html(issues, statuses)
    os.makedirs(os.path.dirname(DASHBOARD_PATH), exist_ok=True)
    with open(DASHBOARD_PATH, "w") as f:
        f.write(content)
    return DASHBOARD_PATH
