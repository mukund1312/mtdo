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

from . import analytics
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
    """Loads a config dict (as parsed from config.yaml, or derived from goals.json via
    config.goals_to_config) into this module's globals. Must be called once before any
    other function in this module is used.

    Raises config.ConfigError -- not a raw KeyError/TypeError/ValueError -- if cfg is
    missing something this needs, or has a category/date field in the wrong shape
    (gh39: a hand-edited goals.json/config.yaml with a typo used to surface as
    whatever raw exception came out of this dict-walking code, at whatever field
    happened to be accessed first, with no indication of what was actually wrong).

    Builds everything into locals first and only assigns the globals at the very end,
    all at once -- previously CATEGORY_META was reset to {} and populated one category
    at a time in the loop below, so a validation failure partway through (or the old
    unguarded KeyError) left it half-populated: some categories present, others
    silently missing, for the rest of the running session. A bad edit failing to
    reload should leave the app exactly as it was, not almost as it was."""
    global CATEGORY_ORDER, STREAK_CATEGORIES, CATEGORY_META, SCORE_WEIGHTS, GOAL_LINE
    global APP_NAME, PLAN_START, PLAN_END, BACKLOG_LOOKBACK_DAYS, STREAK_WARNING

    try:
        category_order = list(cfg["category_order"])
        streak_categories = list(cfg.get("streak_categories", category_order))
        goal_line = cfg.get("goal_line", "")
        app_name = cfg.get("app_name", "TASK OS")
        backlog_lookback_days = cfg.get("backlog_lookback_days", 3)
        streak_warning = cfg.get("streak_warning", 3)
        plan_start = datetime.date.fromisoformat(cfg["plan_start"]) if cfg.get("plan_start") else None
        plan_end = datetime.date.fromisoformat(cfg["plan_end"]) if cfg.get("plan_end") else None

        categories = cfg["categories"]
        if not isinstance(categories, dict):
            raise appconfig.ConfigError(
                f'"categories" should be a set of fields, got {type(categories).__name__} instead.'
            )
        category_meta = {}
        score_weights = {}
        for name, meta in categories.items():
            if not isinstance(meta, dict):
                raise appconfig.ConfigError(
                    f'field "{name}" should be an object, got {type(meta).__name__} instead.'
                )
            if "label" not in meta:
                raise appconfig.ConfigError(f'field "{name}" is missing its "label".')
            if "days" not in meta:
                raise appconfig.ConfigError(f'field "{name}" is missing its "days".')
            category_meta[name] = {
                "label": meta["label"],
                "days": set(meta["days"]),
                "min_blocks": meta.get("min_blocks", 0),
                "addable": meta.get("addable", True),
                "deletable": meta.get("deletable", True),
                "notes": meta.get("notes", True),
                "fixed_labels": meta.get("fixed_labels"),
                "curriculum": meta.get("curriculum") or [],
                "topic_type": meta.get("topic_type"),
                "coaching_framework": meta.get("coaching_framework"),
            }
            score_weights[name] = meta.get("score_weight", 10)
    except KeyError as e:
        raise appconfig.ConfigError(f"config is missing {e}.") from e
    except (TypeError, ValueError) as e:
        raise appconfig.ConfigError(f"config has an invalid value: {e}") from e

    CATEGORY_ORDER = category_order
    STREAK_CATEGORIES = streak_categories
    GOAL_LINE = goal_line
    APP_NAME = app_name
    BACKLOG_LOOKBACK_DAYS = backlog_lookback_days
    STREAK_WARNING = streak_warning
    PLAN_START = plan_start
    PLAN_END = plan_end
    CATEGORY_META = category_meta
    SCORE_WEIGHTS = score_weights


def categories_for_day(d):
    """Which category columns show up on the board today. Fixed-labels categories (Gym,
    a daily check-in, ...) still respect their 'days' schedule -- those are genuine
    recurring daily items. Curriculum categories are always shown every day regardless of
    'days': curriculum content is no longer tied to specific calendar days at all (see the
    weekly menu below) -- 'days' for those only sets how many items make up one week's
    menu, not which days they're visible."""
    wd = d.weekday()
    result = []
    for c in CATEGORY_ORDER:
        meta = CATEGORY_META[c]
        if meta["fixed_labels"] is not None:
            if wd in meta["days"]:
                result.append(c)
        else:
            result.append(c)
    return result


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


def _make_block(text="", status=STATUS_TODO, notes="", coaching=None):
    blk = {"text": text, "status": status, "notes": notes}
    if coaching:
        blk["coaching"] = coaching
    return blk


def _task_text_and_coaching(item):
    """A curriculum entry is either a plain string (simple task, no extra metadata) or a
    rich object -- {"task": "...", "focus_points": [...], "questions": [...], ...} (see
    goals_template.json rule_9) -- powering the Learning Coach panel. Returns
    (display_text, coaching_dict_or_None) either way, so callers never need to care which
    form a given task was written in."""
    if isinstance(item, dict):
        return item.get("task", "(untitled)"), item
    return item, None


def is_done(block):
    return block.get("status") == STATUS_DONE


def _iso_week_key(d):
    year, week, _ = d.isocalendar()
    return f"{year}-W{week:02d}"


def _prefill_fixed_daily(category):
    """Fixed-labels categories (Gym, a daily check-in, ...) still auto-fill every
    scheduled day exactly as before -- these are genuine daily recurring items, not
    curriculum content, so the weekly-menu/pick model below doesn't apply to them."""
    meta = CATEGORY_META[category]
    return [_make_block(text=label) for label in meta["fixed_labels"]]


def _ensure_weekly_menu(state, category, this_week):
    """Populates (once per ISO week, idempotent after that) this category's weekly menu:
    however many curriculum day-lists make up one week (len(meta['days']), or 7 if unset)
    pulled from wherever the cursor left off, flattened into a flat list of pickable
    items. This does NOT put anything onto the board -- see pick_menu_item for that.
    Categories with no curriculum at all get an empty, permanently-this-week menu (nothing
    to pick; addable lets you type your own cards directly instead)."""
    menu = state.setdefault("_meta", {}).setdefault("weekly_menu", {})
    entry = menu.get(category)
    if entry and entry.get("week") == this_week:
        return entry

    meta = CATEGORY_META[category]
    curriculum = meta["curriculum"]
    items = []
    if curriculum:
        cursor = state["_meta"].setdefault("curriculum_cursor", {})
        idx = cursor.get(category, 0)
        days_per_week = max(1, len(meta["days"])) if meta["days"] else 7
        chunk = curriculum[idx:idx + days_per_week]
        if chunk:
            items = []
            for day_list in chunk:
                for raw in day_list:
                    text, coaching = _task_text_and_coaching(raw)
                    items.append({"text": text, "picked": False, "coaching": coaching})
            cursor[category] = idx + len(chunk)

    entry = {"week": this_week, "items": items}
    menu[category] = entry
    return entry


def get_weekly_menu(state, today, category):
    """The current week's menu for a category: every curriculum item due this week,
    picked or not (picked ones stay in the list so the menu screen can show them
    grayed-out rather than just disappearing). Empty for fixed-labels or no-curriculum
    categories -- there's nothing to pick there."""
    meta = CATEGORY_META.get(category)
    if meta is None or meta["fixed_labels"] is not None or not meta["curriculum"]:
        return []
    entry = _ensure_weekly_menu(state, category, _iso_week_key(today))
    return entry["items"]


def pick_menu_item(state, today, category, item_index):
    """Moves one weekly-menu item onto today's board as a real, workable card. Returns
    False (no-op) if it's already been picked -- callers should already be filtering
    those out of what's selectable, this is just a safety net."""
    entry = _ensure_weekly_menu(state, category, _iso_week_key(today))
    item = entry["items"][item_index]
    if item["picked"]:
        return False
    item["picked"] = True
    add_block(state, today.isoformat(), category, item["text"], coaching=item.get("coaching"))
    return True


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
    """Registers today's (or a backfilled day's) blocks per category.

    Fixed-labels categories (Gym, a daily check-in, ...) still auto-fill every scheduled
    day exactly as before -- those are genuine daily recurring items.

    Curriculum categories start the day BLANK -- nothing gets auto-added to the board.
    Instead, this week's curriculum populates a separate weekly menu (see
    _ensure_weekly_menu / get_weekly_menu) that you pick from explicitly (the app's 'a'
    add-card flow); picking a menu item is what actually puts a card on the board (see
    pick_menu_item). Whatever you don't finish still carries forward into the backlog on
    later days exactly as any other card would -- picking from the menu is the only thing
    that's new here, carry-forward is unchanged."""
    plan_start = _resolve_plan_start(state)
    key = d.isoformat()
    day = state.setdefault(key, {})
    this_week = _iso_week_key(d)
    for category in categories_for_day(d):
        if category in day:
            continue
        meta = CATEGORY_META[category]
        if d < plan_start:
            day[category] = [_make_block() for _ in range(meta["min_blocks"])]
            continue
        if meta["fixed_labels"] is not None:
            day[category] = _prefill_fixed_daily(category)
            continue
        if meta["curriculum"]:
            _ensure_weekly_menu(state, category, this_week)
        day[category] = []
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


def claim_backlog_card(state, date_key, category, idx):
    """The first "space" press on a card currently displaying in Backlog: claims it
    into today's Todo column WITHOUT advancing its actual status (a second press,
    now that it's showing as Todo, genuinely advances todo -> in_progress like any
    other card -- see app.kanban_column() and app.KanbanBoard.on_list_view_selected).

    The block stays under its original date_key -- nothing gets relocated, so any
    report or CLI reference to that day+index stays valid -- so the existing
    origin-date badge (app.CardItem, driven purely by date comparison) keeps showing
    in Todo and In Progress too, not just Backlog. "claimed" never resets once set,
    which is also why regressing back from In Progress lands on Todo, not Backlog
    again: kanban_column()'s backlog check is "carried and not claimed", and this
    stays claimed forever once it's been picked up."""
    state[date_key][category][idx]["claimed"] = True


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
    if new_status == STATUS_DONE:
        blk["completed_at"] = datetime.datetime.now().isoformat()
    blk["status"] = new_status
    if new_status == STATUS_DONE and category == "jobs":
        _maybe_link_job_to_crm(state, blk)
    if new_status != cur:
        ref = analytics.task_ref(date_key, category, idx)
        if new_status == STATUS_DONE:
            analytics.record(
                "task_completed", task_ref=ref,
                elapsed_seconds=blk.get("elapsed_seconds", 0),
                was_carried_from_backlog=bool(blk.get("claimed")),
            )
        else:
            analytics.record(
                "task_advanced", task_ref=ref, from_status=cur, to_status=new_status,
                carried=bool(blk.get("claimed")),
            )
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
        blk["completed_at"] = None
    blk["status"] = new_status
    if new_status != cur:
        analytics.record(
            "task_regressed", task_ref=analytics.task_ref(date_key, category, idx),
            from_status=cur, to_status=new_status,
        )
    return new_status


def current_active_task(state, today):
    """First in_progress block, across categories -- the one Focus Mode and the
    Learning Coach center on. Has to check backlog-carried blocks too (the same
    lookback range blocks_for_category shows on the board), not just state[today]:
    advance_status() mutates a block in place under its ORIGINAL date_key, it doesn't
    move it to today when you advance a backlog card, so a card promoted straight
    from Backlog to In Progress stayed invisible here -- Focus Mode and the Coach
    would both claim nothing was active even with one clearly running on the board."""
    for category in categories_for_day(today):
        for row in blocks_for_category(state, category, today):
            if row["block"].get("status") == STATUS_IN_PROGRESS:
                return {"date_key": row["date_key"], "category": category,
                        "idx": row["idx"], "block": row["block"]}
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


def add_block(state, date_key, category, text="", coaching=None):
    blocks = state.setdefault(date_key, {}).setdefault(category, [])
    blocks.append(_make_block(text=text, coaching=coaching))


def delete_block(state, date_key, category, idx):
    del state[date_key][category][idx]


# ---- Backlog / carry-over ----------------------------------------------------

def blocks_for_category(state, category, today, lookback=None):
    """Rows for display: unfinished blocks from the last `lookback` days first
    (tagged carried), then today's own blocks (tagged not-carried), in order.

    Default lookback is week-aware, not a fixed day count: it reaches back to Monday of
    the current week (today.weekday() days back) so a whole week's curriculum pool (see
    ensure_day_registered) stays visible and workable any day you get to it, right up to
    Saturday's completion check. It resets to 0 on Monday -- last week's leftovers don't
    bleed into a new week's board; anything chronically missed is what the streak/slippage
    tracking and weekly report are for instead. Pass an explicit lookback to override this
    (e.g. BACKLOG_LOOKBACK_DAYS) for callers that want a fixed window regardless of weekday."""
    lookback = today.weekday() if lookback is None else lookback
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


def compute_week_progress(state, today, through_today=True):
    """{category: (done, total)} across the current week -- Monday through today by
    default, or the full Monday-Sunday week if through_today=False (used for the Saturday
    completion check, which should count everything claimed for the week even if today
    is earlier than Sunday). This is the single source of truth behind the Stats panel's
    weekly bars and the Saturday check -- both read the same numbers.

    total counts the FULL weekly menu from day one, not just what's been picked onto the
    board so far -- still-unpicked items count toward total (not done) so e.g. "DSA 0/12"
    is accurate Monday morning, not just once you start picking. Picked items are already
    counted via their board blocks below; this only adds the ones NOT yet picked, so
    nothing is double-counted."""
    monday = today - datetime.timedelta(days=today.weekday())
    end = today if through_today else monday + datetime.timedelta(days=6)
    per_category = {}
    d = monday
    while d <= end:
        for category, blocks in state.get(d.isoformat(), {}).items():
            if category in NON_DAY_KEYS:
                continue
            entry = per_category.setdefault(category, [0, 0])
            entry[1] += len(blocks)
            entry[0] += sum(1 for b in blocks if is_done(b))
        d += datetime.timedelta(days=1)

    this_week = _iso_week_key(today)
    for category, menu_entry in state.get("_meta", {}).get("weekly_menu", {}).items():
        if menu_entry.get("week") != this_week:
            continue
        unpicked = sum(1 for item in menu_entry["items"] if not item["picked"])
        if unpicked:
            entry = per_category.setdefault(category, [0, 0])
            entry[1] += unpicked

    return per_category


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


def add_note(state, title, body="", tags=None):
    now = get_today().isoformat()
    state.setdefault(NOTES_KEY, []).append(
        {"title": title, "body": body, "tags": list(tags or []), "created": now, "updated": now}
    )


def set_note_body(state, idx, body):
    state[NOTES_KEY][idx]["body"] = body
    state[NOTES_KEY][idx]["updated"] = get_today().isoformat()


def set_note_tags(state, idx, tags):
    """tags: a list of plain strings, whatever casing/spacing the caller already
    normalized -- this just stores them and bumps updated, same as set_note_body."""
    state[NOTES_KEY][idx]["tags"] = list(tags)
    state[NOTES_KEY][idx]["updated"] = get_today().isoformat()


def delete_note(state, idx):
    del state[NOTES_KEY][idx]


def search_notes(state, query):
    """Matches title, body, or tags -- .get("tags", []) rather than n["tags"]
    since notes created before tags existed don't have the key at all."""
    notes = list(enumerate(list_notes(state)))
    q = query.lower().strip()
    if not q:
        return notes
    return [
        (i, n) for i, n in notes
        if q in n["title"].lower()
        or q in n["body"].lower()
        or any(q in t.lower() for t in n.get("tags", []))
    ]


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


def compute_weekly_report_data(state, today):
    """Everything a weekly report (or an AI reading one) needs: per category, every task
    assigned this week with when it was assigned, when (if) it was actually completed,
    time spent, and notes -- plus which distinct days anything got completed on (for
    pacing), and how many of this week's menu items were never even picked."""
    monday = today - datetime.timedelta(days=today.weekday())
    per_category = {}
    for i in range(7):
        d = monday + datetime.timedelta(days=i)
        key = d.isoformat()
        for category, blocks in state.get(key, {}).items():
            if category in NON_DAY_KEYS:
                continue
            entry = per_category.setdefault(category, {"tasks": [], "done_days": set(), "unpicked": 0})
            for blk in blocks:
                completed_date = None
                if is_done(blk) and blk.get("completed_at"):
                    completed_date = blk["completed_at"][:10]
                    entry["done_days"].add(completed_date)
                entry["tasks"].append({
                    "text": blk["text"] or "(untitled)",
                    "status": blk.get("status", STATUS_TODO),
                    "assigned_day": d.strftime("%a %b %d"),
                    "completed_day": completed_date,
                    "elapsed_seconds": blk.get("elapsed_seconds", 0),
                    "notes": blk.get("notes", ""),
                })

    this_week = _iso_week_key(today)
    for category, menu_entry in state.get("_meta", {}).get("weekly_menu", {}).items():
        if menu_entry.get("week") != this_week:
            continue
        unpicked = sum(1 for item in menu_entry["items"] if not item["picked"])
        if unpicked:
            per_category.setdefault(category, {"tasks": [], "done_days": set(), "unpicked": 0})
            per_category[category]["unpicked"] = unpicked

    return per_category, monday


def _fmt_hm(seconds):
    h, rem = divmod(int(seconds), 3600)
    m = rem // 60
    return f"{h}h {m}m" if h else f"{m}m"


def format_weekly_report_text(state, today):
    """The Saturday checkpoint report: per field, done/total, time spent, a plain-language
    pacing read (spread across the week vs done in one sitting), and every task with its
    assigned/completed day -- detailed enough for an AI to read and actually assess
    consistency, not just tally a percentage."""
    per_category, monday = compute_weekly_report_data(state, today)
    week_end = monday + datetime.timedelta(days=6)
    lines = ["=" * 60, "WEEKLY REPORT",
             f"Week of {monday.strftime('%b %d')} - {week_end.strftime('%b %d, %Y')}",
             f"Goal: {GOAL_LINE}", "=" * 60, ""]
    if not per_category:
        lines.append("Nothing tracked this week yet.")
        return "\n".join(lines)

    total_done, total_all = 0, 0
    for category in CATEGORY_ORDER:
        data = per_category.get(category)
        unpicked = data["unpicked"] if data else 0
        if not data or (not data["tasks"] and not unpicked):
            continue
        label = CATEGORY_META[category]["label"]
        tasks = data["tasks"]
        done_count = sum(1 for t in tasks if t["status"] == STATUS_DONE)
        week_total = len(tasks) + unpicked
        total_done += done_count
        total_all += week_total
        total_seconds = sum(t["elapsed_seconds"] for t in tasks)

        lines.append(f"## {label} -- {done_count}/{week_total} done, {_fmt_hm(total_seconds)} spent")
        n_days = len(data["done_days"])
        if done_count == 0:
            pacing = "Nothing completed yet."
        elif n_days <= 1:
            only_day = next(iter(data["done_days"]))
            pacing = f"All {done_count} done in a single sitting ({only_day}) -- not spread across the week."
        elif n_days >= 5:
            pacing = f"Spread across {n_days} different days -- consistent, not crammed."
        else:
            pacing = f"Completed across {n_days} different days."
        lines.append(f"  {pacing}")
        if unpicked:
            lines.append(f"  {unpicked} item(s) still sitting unpicked in this week's menu.")
        for t in tasks:
            mark = "x" if t["status"] == STATUS_DONE else " "
            when = f"done {t['completed_day']}" if t["completed_day"] else f"assigned {t['assigned_day']}, not done"
            time_str = f", {_fmt_hm(t['elapsed_seconds'])}" if t["elapsed_seconds"] else ""
            note_str = f" -- note: {t['notes']}" if t["notes"] else ""
            lines.append(f"  [{mark}] {t['text']} ({when}{time_str}){note_str}")
        lines.append("")

    rate = round(total_done / total_all * 100) if total_all else 0
    lines.append(f"Week total: {total_done}/{total_all} ({rate}%)")
    lines.append("")
    lines.append("For an AI reading this: assess consistency (spread across the week vs")
    lines.append("crammed into one day), time spent vs. what was planned, and anything")
    lines.append("that slipped -- then suggest concrete adjustments for next week.")
    return "\n".join(lines)


def save_weekly_report_txt(state, today):
    os.makedirs(appconfig.REPORTS_DIR, exist_ok=True)
    monday = today - datetime.timedelta(days=today.weekday())
    path = os.path.join(appconfig.REPORTS_DIR, f"weekly_report_{monday.isoformat()}.txt")
    with open(path, "w") as f:
        f.write(format_weekly_report_text(state, today))
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
