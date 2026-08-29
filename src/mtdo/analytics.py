"""Local-only usage analytics -- opt-in, structural-metadata-only event log at
~/.mtdo/events.db. See PRIVACY.md for exactly what is and isn't ever recorded: no
task/goal/note text, no AI conversation content, no Practice Lab code or output, no
file paths, no category/profile names -- only which screen/action, counts, durations,
and classified (never raw-message) error types.

record() is meant to be as low-friction as errorlog.log.exception(...): call sites
never check the opt-in flag or handle exceptions themselves. It's a silent no-op when
analytics is off, and any storage failure is swallowed -- this is convenience data,
same "never something that should block the app" ethos as config.load_radio_state().
"""
import json
import os
import sqlite3
import uuid
from datetime import datetime, timedelta

from . import config as appconfig

EVENTS_DB_PATH = os.path.join(appconfig.APP_DIR, "events.db")

_DDL = """
CREATE TABLE IF NOT EXISTS events (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    ts            TEXT NOT NULL,
    event_name    TEXT NOT NULL,
    session_id    TEXT NOT NULL,
    properties    TEXT,
    synced        INTEGER NOT NULL DEFAULT 0,
    schema_version INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS idx_events_ts ON events(ts);
CREATE INDEX IF NOT EXISTS idx_events_name ON events(event_name);
CREATE INDEX IF NOT EXISTS idx_events_synced ON events(synced);
"""

# One id per process launch, not persisted -- groups events from a single run of
# mtdo for the flap/inactivity/churn friction checks below.
SESSION_ID = uuid.uuid4().hex

_schema_ready = False


def _ensure_schema(conn):
    global _schema_ready
    if _schema_ready:
        return
    conn.executescript(_DDL)
    conn.commit()
    _schema_ready = True


def _connect():
    os.makedirs(appconfig.APP_DIR, exist_ok=True)
    conn = sqlite3.connect(EVENTS_DB_PATH, timeout=5)
    _ensure_schema(conn)
    return conn


def is_local_enabled():
    return appconfig.load_analytics_settings()["local_enabled"]


def record(event_name, **properties):
    """No-op if analytics is off. Never raises -- a storage failure here should
    never be the reason mtdo itself breaks."""
    if not is_local_enabled():
        return
    try:
        conn = _connect()
        conn.execute(
            "INSERT INTO events (ts, event_name, session_id, properties) VALUES (?, ?, ?, ?)",
            (
                datetime.now().isoformat(timespec="seconds"),
                event_name,
                SESSION_ID,
                json.dumps(properties),
            ),
        )
        conn.commit()
        conn.close()
    except Exception:
        pass


def task_ref(date_key, category, idx):
    """A one-way hash of a task's *position* (date + category + index), never its
    text -- lets flap-detection correlate "the same task" across events without
    ever storing what the task actually says or which category it's in."""
    import hashlib
    return hashlib.sha256(f"{date_key}:{category}:{idx}".encode()).hexdigest()[:16]


def classify_ai_backend(label):
    """Buckets a backend's display label (e.g. "Ollama (llama3.2)") into one of the
    taxonomy's three kinds, without ever recording the specific model name chosen."""
    l = (label or "").lower()
    if "claude" in l:
        return "claude_code"
    if "ollama" in l:
        return "ollama"
    return "api_chat"


def query_events(since=None, event_name=None, limit=None):
    try:
        conn = _connect()
        sql = "SELECT id, ts, event_name, session_id, properties, synced FROM events WHERE 1=1"
        args = []
        if since is not None:
            sql += " AND ts >= ?"
            args.append(since)
        if event_name is not None:
            sql += " AND event_name = ?"
            args.append(event_name)
        sql += " ORDER BY ts ASC"
        if limit is not None:
            sql += " LIMIT ?"
            args.append(limit)
        rows = conn.execute(sql, args).fetchall()
        conn.close()
    except Exception:
        return []
    return [
        {
            "id": r[0],
            "ts": r[1],
            "event_name": r[2],
            "session_id": r[3],
            "properties": json.loads(r[4]) if r[4] else {},
            "synced": bool(r[5]),
        }
        for r in rows
    ]


def count_events(event_name=None, since=None):
    return len(query_events(since=since, event_name=event_name))


def prune_older_than(days):
    cutoff = (datetime.now() - timedelta(days=days)).isoformat(timespec="seconds")
    try:
        conn = _connect()
        conn.execute("DELETE FROM events WHERE ts < ?", (cutoff,))
        conn.commit()
        conn.execute("VACUUM")
        conn.close()
    except Exception:
        pass


def purge_all():
    global _schema_ready
    try:
        if os.path.exists(EVENTS_DB_PATH):
            os.remove(EVENTS_DB_PATH)
    except OSError:
        pass
    _schema_ready = False


def summary():
    events = query_events()
    if not events:
        return {"count": 0, "oldest": None, "newest": None, "sessions": 0}
    return {
        "count": len(events),
        "oldest": events[0]["ts"],
        "newest": events[-1]["ts"],
        "sessions": len({e["session_id"] for e in events}),
    }


# ---------------------------------------------------------------------------
# Friction detection -- plain SQL + Python windowing, no ML. Each returns a list
# of small structured findings, consumed by `mtdo insights`.
# ---------------------------------------------------------------------------

def _parse_ts(ts):
    return datetime.fromisoformat(ts)


def _by_session(events):
    sessions = {}
    for e in events:
        sessions.setdefault(e["session_id"], []).append(e)
    return sessions


def friction_repeated_help(window_minutes=15, threshold=3):
    findings = []
    for session_id, rows in _by_session(query_events(event_name="help_opened")).items():
        rows = sorted(rows, key=lambda e: e["ts"])
        for i in range(len(rows)):
            start = _parse_ts(rows[i]["ts"])
            window = [r for r in rows[i:] if _parse_ts(r["ts"]) - start <= timedelta(minutes=window_minutes)]
            if len(window) >= threshold:
                findings.append({"session_id": session_id, "count": len(window), "since": rows[i]["ts"]})
                break
    return findings


def friction_task_flapping(window_minutes=5, threshold=4):
    events = query_events(event_name="task_advanced") + query_events(event_name="task_regressed")
    findings = []
    for session_id, rows in _by_session(events).items():
        by_task = {}
        for r in rows:
            by_task.setdefault(r["properties"].get("task_ref"), []).append(r)
        for ref, task_rows in by_task.items():
            task_rows = sorted(task_rows, key=lambda e: e["ts"])
            for i in range(len(task_rows)):
                start = _parse_ts(task_rows[i]["ts"])
                window = [r for r in task_rows[i:] if _parse_ts(r["ts"]) - start <= timedelta(minutes=window_minutes)]
                if len(window) >= threshold:
                    findings.append({"session_id": session_id, "task_ref": ref, "count": len(window)})
                    break
    return findings


def friction_long_inactivity(gap_minutes=20):
    findings = []
    for session_id, rows in _by_session(query_events()).items():
        rows = sorted(rows, key=lambda e: e["ts"])
        for i in range(1, len(rows) - 1):
            gap = _parse_ts(rows[i]["ts"]) - _parse_ts(rows[i - 1]["ts"])
            if gap >= timedelta(minutes=gap_minutes):
                findings.append({
                    "session_id": session_id,
                    "gap_minutes": round(gap.total_seconds() / 60, 1),
                    "at": rows[i]["ts"],
                })
    return findings


def friction_backend_churn(threshold=2):
    findings = []
    for session_id, rows in _by_session(query_events(event_name="ai_panel_backend_switch")).items():
        if len(rows) >= threshold:
            findings.append({"session_id": session_id, "switches": len(rows)})
    return findings


def friction_failed_practice_runs(threshold=3):
    findings = []
    for session_id, rows in _by_session(query_events(event_name="practice_lab_run")).items():
        rows = sorted(rows, key=lambda e: e["ts"])
        streak = []
        for r in rows:
            if not r["properties"].get("success"):
                streak.append(r)
                if len(streak) >= threshold:
                    findings.append({
                        "session_id": session_id,
                        "language": r["properties"].get("language"),
                        "count": len(streak),
                    })
                    streak = []
            else:
                streak = []
    return findings


def friction_abandoned_onboarding():
    steps = query_events(event_name="onboarding_step_viewed")
    completed = {e["session_id"] for e in query_events(event_name="plan_setup_completed")}
    skipped = {e["session_id"] for e in query_events(event_name="onboarding_skipped")}
    findings = []
    for session_id, rows in _by_session(steps).items():
        if session_id in completed:
            continue
        last = max(rows, key=lambda e: e["properties"].get("step_index", 0))
        total = last["properties"].get("total_steps")
        reached_last = total is not None and last["properties"].get("step_index") == total - 1
        if session_id in skipped or not reached_last:
            findings.append({
                "session_id": session_id,
                "last_step": last["properties"].get("step_index"),
                "total_steps": total,
            })
    return findings
