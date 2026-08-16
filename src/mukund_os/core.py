"""Shared logic: category/block model, carry-over, streaks, reports.

Category definitions (labels, schedule, curriculum) come from the user's config --
see config.py and configure() below -- rather than being hardcoded here, so this
module works for anyone's categories, not just one person's plan.

Each day has a fixed set of CATEGORIES (which ones depend on weekday). Each category
holds a variable-length list of BLOCKS: {"text": str, "status": str, "notes": str},
where status is one of STATUS_TODO / STATUS_IN_PROGRESS / STATUS_DONE. A category is
"complete" for a day once it has at least its minimum block count and every block in
it is done. Unfinished blocks carry forward into the next days' view
(BACKLOG_LOOKBACK_DAYS) -- they still live under the day they originated on; moving
one from a later day's carried-forward view mutates that original day's record.
"""
import datetime
import json
import os

from . import config as appconfig

DAY_NAMES = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"]

DEFAULT_POMODORO_MINUTES = 25
DEFAULT_BREAK_MINUTES = 5
POMODORO_KEY = "_pomodoro"
COMPANIES_KEY = "_companies"
NOTES_KEY = "_notes"
NON_DAY_KEYS = ("_meta", POMODORO_KEY, COMPANIES_KEY, NOTES_KEY)

STATUS_TODO = "todo"
STATUS_IN_PROGRESS = "in_progress"
STATUS_DONE = "done"
STATUS_ORDER = [STATUS_TODO, STATUS_IN_PROGRESS, STATUS_DONE]

CAREER_STATUSES = ["applied", "oa", "interview", "offer", "rejected", "ghosted"]
CAREER_STATUS_LABELS = {
    "applied": "Applied", "oa": "OA", "interview": "Interview",
    "offer": "Offer", "rejected": "Rejected", "ghosted": "Ghosted",
}

# ---- Populated by configure() from the user's config.yaml -------------------
CATEGORY_ORDER = []
STREAK_CATEGORIES = []
CATEGORY_META = {}
SCORE_WEIGHTS = {}
GOAL_LINE = ""
APP_NAME = "TASK OS"
PLAN_START = None    # None = auto-lock to the first day this user's state file is created
PLAN_END = None       # None = no phase-end reminder
BACKLOG_LOOKBACK_DAYS = 3
STREAK_WARNING = 3


def configure(cfg):
    """Loads a config dict (as parsed from config.yaml) into this module's globals.
    Must be called once before any other function in this module is used."""
    global CATEGORY_ORDER, STREAK_CATEGORIES, CATEGORY_META, SCORE_WEIGHTS, GOAL_LINE
    global APP_NAME, PLAN_START, PLAN_END, BACKLOG_LOOKBACK_DAYS, STREAK_WARNING

    CATEGORY_ORDER = list(cfg["category_order"])
    STREAK_CATEGORIES = list(cfg.get("streak_categories", CATEGORY_ORDER))
    GOAL_LINE = cfg.get("goal_line", "")
    APP_NAME = cfg.get("app_name", "TASK OS")
    BACKLOG_LOOKBACK_DAYS = cfg.get("backlog_lookback_days", 3)
    STREAK_WARNING = cfg.get("streak_warning", 3)
    PLAN_START = datetime.date.fromisoformat(cfg["plan_start"]) if cfg.get("plan_start") else None
    PLAN_END = datetime.date.fromisoformat(cfg["plan_end"]) if cfg.get("plan_end") else None

    CATEGORY_META = {}
    SCORE_WEIGHTS = {}
    for name, meta in cfg["categories"].items():
        CATEGORY_META[name] = {
            "label": meta["label"],
            "days": set(meta["days"]),
            "min_blocks": meta.get("min_blocks", 0),
            "addable": meta.get("addable", True),
            "deletable": meta.get("deletable", True),
            "notes": meta.get("notes", True),
            "fixed_labels": meta.get("fixed_labels"),
            "curriculum": meta.get("curriculum") or [],
        }
        SCORE_WEIGHTS[name] = meta.get("score_weight", 10)


def categories_for_day(d):
    wd = d.weekday()
    return [c for c in CATEGORY_ORDER if wd in CATEGORY_META[c]["days"]]


def get_today():
    override = os.environ.get("TODO_FAKE_DATE")
    if override:
        return datetime.date.fromisoformat(override)
    return datetime.date.today()


def _resolve_plan_start(state):
    """A fixed plan_start from config wins; otherwise this user's plan_start auto-locks
    to the first day their state file was ever created, so everyone's curriculum
    sequencing starts from THEIR day one."""
    if PLAN_START is not None:
        return PLAN_START
    meta = state.setdefault("_meta", {})
    if "plan_start" not in meta:
        meta["plan_start"] = get_today().isoformat()
    return datetime.date.fromisoformat(meta["plan_start"])


def _make_block(text="", status=STATUS_TODO, notes=""):
    return {"text": text, "status": status, "notes": notes}


def is_done(block):
    return block.get("status") == STATUS_DONE


def _prefill_blocks(category, cursor_idx):
    """Returns (blocks, consumed). consumed=True only if a real curriculum item was used
    for this day -- the caller advances the per-category cursor only in that case, so a
    day where curriculum has run out never permanently skips an entry you add later."""
    meta = CATEGORY_META[category]
    if meta["fixed_labels"] is not None:
        return [_make_block(text=label) for label in meta["fixed_labels"]], False

    curriculum = meta["curriculum"]
    if curriculum and cursor_idx < len(curriculum):
        blocks = [_make_block(text=t) for t in curriculum[cursor_idx]]
        while len(blocks) < meta["min_blocks"]:
            blocks.append(_make_block())
        return blocks, True

    return [_make_block() for _ in range(meta["min_blocks"])], False


# ---- State I/O --------------------------------------------------------------

def _migrate_legacy_block(blk):
    """Old blocks stored a binary "done" bool instead of a "status" string."""
    if "status" not in blk:
        blk["status"] = STATUS_DONE if blk.pop("done", False) else STATUS_TODO
    blk.pop("done", None)
    return blk


def load_state():
    if not os.path.exists(appconfig.STATE_PATH):
        return {"_meta": {}}
    with open(appconfig.STATE_PATH) as f:
        state = json.load(f)
    for key, day in state.items():
        if key in NON_DAY_KEYS:
            continue
        for blocks in day.values():
            for blk in blocks:
                _migrate_legacy_block(blk)
    return state


def save_state(state):
    os.makedirs(os.path.dirname(appconfig.STATE_PATH), exist_ok=True)
    with open(appconfig.STATE_PATH, "w") as f:
        json.dump(state, f, indent=2)


def ensure_day_registered(state, d):
    plan_start = _resolve_plan_start(state)
    key = d.isoformat()
    day = state.setdefault(key, {})
    cursor = state.setdefault("_meta", {}).setdefault("curriculum_cursor", {})
    for category in categories_for_day(d):
        if category in day:
            continue
        if d < plan_start:
            day[category] = [_make_block() for _ in range(CATEGORY_META[category]["min_blocks"])]
            continue
        idx = cursor.get(category, 0)
        blocks, consumed = _prefill_blocks(category, idx)
        if consumed:
            cursor[category] = idx + 1
        day[category] = blocks
    return state


# ---- Block mutations (all addressed by date_key + category + index) --------

def _seconds_since(iso_ts):
    if not iso_ts:
        return 0.0
    try:
        started = datetime.datetime.fromisoformat(iso_ts)
    except ValueError:
        return 0.0
    return max((datetime.datetime.now() - started).total_seconds(), 0.0)


def advance_status(state, date_key, category, idx):
    """Moves a block one step toward done: todo -> in_progress -> done.
    Starts/stops the block's focus-time clock on the in_progress transitions."""
    blk = state[date_key][category][idx]
    cur = blk.get("status", STATUS_TODO)
    pos = STATUS_ORDER.index(cur) if cur in STATUS_ORDER else 0
    new_status = STATUS_ORDER[min(pos + 1, len(STATUS_ORDER) - 1)]
    if new_status == STATUS_IN_PROGRESS and cur != STATUS_IN_PROGRESS:
        blk["started_at"] = datetime.datetime.now().isoformat()
    elif new_status == STATUS_DONE and cur == STATUS_IN_PROGRESS:
        blk["elapsed_seconds"] = blk.get("elapsed_seconds", 0) + _seconds_since(blk.get("started_at"))
        blk["started_at"] = None
    blk["status"] = new_status
    if new_status == STATUS_DONE and category == "jobs":
        _maybe_link_job_to_crm(state, blk)
    return new_status


def mark_done(state, date_key, category, idx):
    """Jumps a block straight to done regardless of its current status, via advance_status
    so focus-time bookkeeping and the Jobs -> Career CRM link still fire correctly."""
    blk = state[date_key][category][idx]
    guard = 0
    while blk.get("status") != STATUS_DONE and guard < len(STATUS_ORDER):
        advance_status(state, date_key, category, idx)
        guard += 1
    return blk["status"]


def _maybe_link_job_to_crm(state, blk):
    """Convention: "<Company> <Role/JobID...>", e.g. "Razorpay SDE1 12345".
    First word is the company name, the rest is the role -- stored as the CRM note.
    Only creates a new entry (never overwrites a company you're already tracking).
    Only fires if a "jobs" category actually exists in this user's config."""
    if "jobs" not in CATEGORY_META:
        return
    tokens = (blk.get("text") or "").split()
    if not tokens:
        return
    company, role = tokens[0], " ".join(tokens[1:])
    if any(c["name"].strip().lower() == company.lower() for c in list_companies(state)):
        return
    add_company(state, company, status="applied")
    if role:
        list_companies(state)[-1]["notes"] = role


def regress_status(state, date_key, category, idx):
    """Moves a block one step back: done -> in_progress -> todo."""
    blk = state[date_key][category][idx]
    cur = blk.get("status", STATUS_TODO)
    pos = STATUS_ORDER.index(cur) if cur in STATUS_ORDER else 0
    new_status = STATUS_ORDER[max(pos - 1, 0)]
    if cur == STATUS_IN_PROGRESS and new_status == STATUS_TODO:
        blk["started_at"] = None
    elif cur == STATUS_DONE and new_status == STATUS_IN_PROGRESS:
        blk["started_at"] = datetime.datetime.now().isoformat()
    blk["status"] = new_status
    return new_status


def current_active_task(state, today):
    """First in_progress block for today, across categories -- the one Focus Mode centers on."""
    key = today.isoformat()
    day = state.get(key, {})
    for category in categories_for_day(today):
        for idx, blk in enumerate(day.get(category, [])):
            if blk.get("status") == STATUS_IN_PROGRESS:
                return {"date_key": key, "category": category, "idx": idx, "block": blk}
    return None


def task_elapsed_seconds(block):
    """Total focus time banked on this block, including any currently-running session."""
    return (block.get("elapsed_seconds", 0) or 0) + _seconds_since(block.get("started_at"))


def total_focus_seconds_today(state, today):
    key = today.isoformat()
    total = 0.0
    for blocks in state.get(key, {}).values():
        for blk in blocks:
            total += task_elapsed_seconds(blk)
    return total


def compute_daily_score(state, today):
    """(total_points, [(label, points, weight), ...]) for today's scheduled categories."""
    key = today.isoformat()
    day = state.get(key, {})
    breakdown = []
    total = 0
    for category in categories_for_day(today):
        blocks = day.get(category, [])
        if not blocks:
            continue
        weight = SCORE_WEIGHTS.get(category, 10)
        frac = sum(1 for b in blocks if is_done(b)) / len(blocks)
        points = round(weight * frac)
        total += points
        breakdown.append((CATEGORY_META[category]["label"], points, weight))
    return total, breakdown


def set_block_text(state, date_key, category, idx, text):
    state[date_key][category][idx]["text"] = text


def set_block_notes(state, date_key, category, idx, notes):
    state[date_key][category][idx]["notes"] = notes


def add_block(state, date_key, category, text=""):
    blocks = state.setdefault(date_key, {}).setdefault(category, [])
    blocks.append(_make_block(text=text))


def delete_block(state, date_key, category, idx):
    del state[date_key][category][idx]


# ---- Backlog / carry-over ----------------------------------------------------

def blocks_for_category(state, category, today, lookback=None):
    """Rows for display: unfinished blocks from the last `lookback` days first
    (tagged carried), then today's own blocks (tagged not-carried), in order."""
    lookback = BACKLOG_LOOKBACK_DAYS if lookback is None else lookback
    rows = []
    for i in range(lookback, 0, -1):
        d = today - datetime.timedelta(days=i)
        key = d.isoformat()
        for idx, blk in enumerate(state.get(key, {}).get(category, [])):
            if not is_done(blk):
                rows.append({"date": d, "date_key": key, "category": category, "idx": idx, "block": blk, "carried": True})
    key = today.isoformat()
    for idx, blk in enumerate(state.get(key, {}).get(category, [])):
        rows.append({"date": today, "date_key": key, "category": category, "idx": idx, "block": blk, "carried": False})
    return rows


def category_progress(state, category, today):
    """(done, total) across carried-forward + today's own blocks -- what's actionable right now."""
    rows = blocks_for_category(state, category, today)
    total = len(rows)
    done = sum(1 for r in rows if is_done(r["block"]))
    return done, total


def category_own_complete(state, category, d):
    """Was THIS day's own assignment (not counting carry-in from other days) fully done?"""
    key = d.isoformat()
    blocks = state.get(key, {}).get(category, [])
    meta = CATEGORY_META[category]
    if len(blocks) < max(meta["min_blocks"], 1):
        return False
    return all(is_done(b) for b in blocks)


# ---- Day / streak / heatmap --------------------------------------------------

def day_completion(state, d):
    """(done_blocks, total_blocks) using only blocks that originated on this day."""
    key = d.isoformat()
    if key not in state:
        return None, None
    total, done = 0, 0
    for category in categories_for_day(d):
        blocks = state[key].get(category, [])
        total += len(blocks)
        done += sum(1 for b in blocks if is_done(b))
    return done, total


def compute_category_streak(state, category, today):
    """Consecutive days going backward where this category was NOT own-complete."""
    plan_start = _resolve_plan_start(state)
    streak = 0
    d = today - datetime.timedelta(days=1)
    for _ in range(60):
        if d < plan_start:
            break
        if category not in categories_for_day(d):
            d -= datetime.timedelta(days=1)
            continue
        key = d.isoformat()
        if key not in state:
            break
        if category_own_complete(state, category, d):
            break
        streak += 1
        d -= datetime.timedelta(days=1)
    return streak


def compute_all_streaks(state, today):
    streaks = {}
    for category in STREAK_CATEGORIES:
        s = compute_category_streak(state, category, today)
        if s > 0:
            streaks[category] = s
    return streaks


def compute_day_streaks(state, today):
    """Current & longest streak of FULLY completed days (100% of that day's own blocks)."""
    current = 0
    d = today - datetime.timedelta(days=1)
    while True:
        done, total = day_completion(state, d)
        if done is None or total == 0 or done < total:
            break
        current += 1
        d -= datetime.timedelta(days=1)
        if (today - d).days > 120:
            break

    longest = 0
    running = 0
    d = today - datetime.timedelta(days=120)
    while d < today:
        done, total = day_completion(state, d)
        if done is not None and total > 0 and done == total:
            running += 1
            longest = max(longest, running)
        else:
            running = 0
        d += datetime.timedelta(days=1)
    longest = max(longest, current)
    return current, longest


def compute_week_activity(state, today):
    monday = today - datetime.timedelta(days=today.weekday())
    rows = []
    for i in range(7):
        d = monday + datetime.timedelta(days=i)
        done, total = day_completion(state, d)
        rows.append((DAY_NAMES[i][:2], done, total, d == today, d))
    return rows


def compute_month_heatmap(state, year, month):
    import calendar
    cal = calendar.Calendar(firstweekday=0)
    weeks = cal.monthdayscalendar(year, month)
    grid = []
    for week in weeks:
        row = []
        for day_num in week:
            if day_num == 0:
                row.append((None, None, None))
            else:
                d = datetime.date(year, month, day_num)
                done, total = day_completion(state, d)
                row.append((day_num, done, total))
        grid.append(row)
    return grid


def day_status(state, d, today):
    if d > today:
        return "future"
    plan_start = _resolve_plan_start(state)
    if d < plan_start:
        return "pre_plan"
    done, total = day_completion(state, d)
    if done is None or total == 0 or done == 0:
        return "none"
    if done == total:
        return "complete"
    return "partial"


def compute_alltime_totals(state):
    total_done, total_tasks, tracked_days = 0, 0, 0
    for key, day in state.items():
        if key in NON_DAY_KEYS:
            continue
        tracked_days += 1
        for category, blocks in day.items():
            for b in blocks:
                total_tasks += 1
                if is_done(b):
                    total_done += 1
    return total_done, total_tasks, tracked_days


# ---- Pomodoro (standalone focus timer, not linked to a specific block) -----

def get_pomodoro_count(state, d):
    return state.get(POMODORO_KEY, {}).get(d.isoformat(), 0)


def increment_pomodoro(state, d):
    state.setdefault(POMODORO_KEY, {})
    key = d.isoformat()
    state[POMODORO_KEY][key] = state[POMODORO_KEY].get(key, 0) + 1
    save_state(state)
    return state[POMODORO_KEY][key]


# ---- Career CRM ---------------------------------------------------------------

def list_companies(state):
    return state.get(COMPANIES_KEY, [])


def add_company(state, name, status="applied"):
    state.setdefault(COMPANIES_KEY, []).append({
        "name": name, "status": status, "date_added": get_today().isoformat(), "notes": "",
    })


def set_company_status(state, idx, status):
    state[COMPANIES_KEY][idx]["status"] = status


def set_company_notes(state, idx, notes):
    state[COMPANIES_KEY][idx]["notes"] = notes


def delete_company(state, idx):
    del state[COMPANIES_KEY][idx]


def career_funnel_counts(state):
    counts = {s: 0 for s in CAREER_STATUSES}
    for c in list_companies(state):
        counts[c.get("status", "applied")] = counts.get(c.get("status", "applied"), 0) + 1
    return counts


# ---- Knowledge Vault ------------------------------------------------------------

def list_notes(state):
    return state.get(NOTES_KEY, [])


def add_note(state, title, body=""):
    now = get_today().isoformat()
    state.setdefault(NOTES_KEY, []).append({"title": title, "body": body, "created": now, "updated": now})


def set_note_body(state, idx, body):
    state[NOTES_KEY][idx]["body"] = body
    state[NOTES_KEY][idx]["updated"] = get_today().isoformat()


def delete_note(state, idx):
    del state[NOTES_KEY][idx]


def search_notes(state, query):
    notes = list(enumerate(list_notes(state)))
    q = query.lower().strip()
    if not q:
        return notes
    return [(i, n) for i, n in notes if q in n["title"].lower() or q in n["body"].lower()]


# ---- Reports ------------------------------------------------------------------

def compute_report(state, today, window_days=3):
    total, done = 0, 0
    per_category = {c: [0, 0] for c in CATEGORY_ORDER}
    for i in range(window_days):
        d = today - datetime.timedelta(days=i)
        key = d.isoformat()
        if key not in state:
            continue
        for category in categories_for_day(d):
            blocks = state[key].get(category, [])
            per_category.setdefault(category, [0, 0])
            per_category[category][1] += len(blocks)
            total += len(blocks)
            done_here = sum(1 for b in blocks if is_done(b))
            per_category[category][0] += done_here
            done += done_here
    streaks = compute_all_streaks(state, today)
    return {
        "window_days": window_days, "total": total, "done": done,
        "rate": round(done / total * 100) if total else None,
        "per_category": per_category, "streaks": streaks,
    }


def collect_notes(state, today, window_days=3):
    notes = []
    for i in range(window_days):
        d = today - datetime.timedelta(days=i)
        key = d.isoformat()
        if key not in state:
            continue
        for category, blocks in state[key].items():
            if category in NON_DAY_KEYS:
                continue
            label = CATEGORY_META.get(category, {}).get("label", category)
            for b in blocks:
                if b.get("notes"):
                    notes.append({"date": d, "category": label, "text": b["text"], "note": b["notes"]})
    return notes


def format_report_text(state, today):
    r = compute_report(state, today)
    lines = ["=" * 60, "PROGRESS REPORT",
             f"Generated: {today.strftime('%A, %b %d, %Y')}", f"Goal: {GOAL_LINE}", "=" * 60, ""]
    if r["total"] == 0:
        lines.append("No tracked days yet -- come back after a few sessions.")
        return "\n".join(lines)
    lines.append(f"Overall (last {r['window_days']} days): {r['done']}/{r['total']} blocks done ({r['rate']}%)")
    lines.append("")
    lines.append("By category:")
    for category in CATEGORY_ORDER:
        done, total = r["per_category"].get(category, [0, 0])
        if total == 0:
            continue
        label = CATEGORY_META[category]["label"]
        lines.append(f"  {label:<24} {done}/{total}")
    lines.append("")
    if r["streaks"]:
        lines.append(f"Chronic slippage (pushed {STREAK_WARNING}+ days running):")
        any_flagged = False
        for category, streak in r["streaks"].items():
            if streak >= STREAK_WARNING:
                any_flagged = True
                label = CATEGORY_META[category]["label"]
                lines.append(f"  - {label}: missed {streak} days in a row")
        if not any_flagged:
            lines.append("  None right now.")
    else:
        lines.append("Chronic slippage: none right now.")

    notes = collect_notes(state, today)
    if notes:
        lines.append("")
        lines.append("Notes you left yourself:")
        for n in sorted(notes, key=lambda x: x["date"], reverse=True):
            lines.append(f"  {n['date'].strftime('%a %d')}  {n['category']} ({n['text'][:30]}): {n['note']}")

    lines.append("")
    lines.append("For AI-written suggestions on what to adjust, ask your AI assistant:")
    lines.append('  "read this report and tell me what to change"')
    return "\n".join(lines)


def save_report_txt(state, today):
    os.makedirs(appconfig.REPORTS_DIR, exist_ok=True)
    path = os.path.join(appconfig.REPORTS_DIR, f"report_{today.isoformat()}.txt")
    with open(path, "w") as f:
        f.write(format_report_text(state, today))
    return path


def maybe_autosave_daily_report(state, today):
    """Called on app open. If at least one day has passed since we last saw you,
    auto-saves a report for the day that just ended.
    Honest limit: this fires on next open, not at the literal stroke of midnight."""
    meta = state.setdefault("_meta", {})
    last_seen = meta.get("last_seen_date")
    saved_path = None
    if last_seen:
        last_date = datetime.date.fromisoformat(last_seen)
        if last_date < today:
            saved_path = save_report_txt(state, last_date)
    meta["last_seen_date"] = today.isoformat()
    save_state(state)
    return saved_path
