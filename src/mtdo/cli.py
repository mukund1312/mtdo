"""CLI entry point for the `mtdo` command: run the TUI, or manage config/tasks from
the shell (handy for scripting or wiring into an AI assistant's tool-use, the way the
original build wired into Claude Code's /todo skill)."""
import argparse
import datetime
import json
import os

from . import config as appconfig


def cmd_init(args):
    if appconfig.config_exists() and not args.force:
        print(f"Config already exists at {appconfig.CONFIG_PATH} -- pass --force to overwrite.")
        return
    path = appconfig.init_config(fresh=args.fresh)
    kind = "empty template" if args.fresh else "demo plan (a real working example, not empty)"
    print(f"Created {path} from the {kind}.")
    print("Edit that file to make it yours, then run `mtdo` to start.")


def cmd_template(args):
    import shutil
    dest = args.output or "goals.json"
    shutil.copy(appconfig.GOALS_TEMPLATE_PATH, dest)
    print(f"Wrote {dest}.")
    print("Fill it in yourself, or hand it to an AI assistant along with your goals and let it fill it in.")
    print(f"Then run: mtdo import {dest}")


def cmd_import(args):
    added, updated = appconfig.import_goals(args.json_path)
    if added:
        print(f"Added categories: {', '.join(added)}")
    if updated:
        print(f"Updated categories (curriculum appended, not replaced): {', '.join(updated)}")
    if not added and not updated:
        print("Nothing to import -- the JSON had no categories.")
    print(f"\nConfig written to {appconfig.CONFIG_PATH}. Your tracked progress in state.json was not touched.")


def cmd_run(_args):
    # Try to load goals.json first (Option A: JSON-driven mode)
    try:
        goals = appconfig.load_goals()
        cfg, _, _ = appconfig.goals_to_config(goals)
    except FileNotFoundError:
        # Fallback: use config.yaml or demo if neither exists
        if not appconfig.config_exists():
            print("First time here -- setting you up with a demo config so you can see it working.")
            appconfig.init_config(fresh=False)
            print(f"Created {appconfig.CONFIG_PATH} (a real example plan).")
            print("Edit that file anytime to make it yours, or run `mtdo init --fresh` to start over empty.\n")
        cfg = appconfig.load_config()

    from . import app as todo_app
    todo_app.run_app(cfg)


def cmd_status(_args):
    cfg = appconfig.load_config()
    from . import core as tc
    tc.configure(cfg)
    today = tc.get_today()
    state = tc.load_state()
    state = tc.ensure_day_registered(state, today)

    out = [f"## Today's Basket -- {tc.DAY_NAMES[today.weekday()]}, {today.strftime('%b %d, %Y')}", ""]
    backlog_lines, today_lines, task_ids = [], [], []
    for category in tc.categories_for_day(today):
        meta = tc.CATEGORY_META[category]
        for row in tc.blocks_for_category(state, category, today):
            blk = row["block"]
            if tc.is_done(blk):
                continue
            text = blk["text"] or "(empty)"
            tid = f"{category}_{row['idx']}"
            task_ids.append(tid)
            if row["carried"]:
                backlog_lines.append(f"| {tid} | {row['date'].strftime('%a %b %d')} | {meta['label']} | {text} |")
            else:
                today_lines.append(f"| {tid} | {meta['label']} | {text} |")

    if backlog_lines:
        out.append(f"### Backlog (last {tc.BACKLOG_LOOKBACK_DAYS} days, not ticked)")
        out.append("| ID | From | Category | What's left |")
        out.append("|---|---|---|---|")
        out.extend(backlog_lines)
        out.append("")

    out.append("### Today")
    out.append("| ID | Category | What's left |")
    out.append("|---|---|---|")
    out.extend(today_lines or ["| -- | -- | Nothing left -- everything scheduled today is done. |"])

    out.append("")
    if task_ids:
        out.append(f"Task IDs for ticking: {', '.join(task_ids)}")
        out.append("Run `mtdo done <id>` to mark one done (add a date for a backlog item from an earlier day).")

    if tc.PLAN_END and today > tc.PLAN_END:
        out.append("")
        out.append(f"**Note:** this plan was built through {tc.PLAN_END.strftime('%b %d')}. Time for a check-in.")

    tc.save_state(state)
    print("\n".join(out))


def cmd_done(args):
    cfg = appconfig.load_config()
    from . import core as tc
    tc.configure(cfg)
    today = tc.get_today()
    state = tc.load_state()
    state = tc.ensure_day_registered(state, today)
    d = datetime.date.fromisoformat(args.date) if args.date else today
    key = d.isoformat()
    if key not in state:
        print(f"No tracked day for {key}.")
        return
    try:
        category, idx_s = args.task_id.rsplit("_", 1)
        idx = int(idx_s)
    except ValueError:
        print(f"Unknown task id '{args.task_id}'.")
        return
    if category not in state[key] or idx >= len(state[key][category]):
        print(f"Unknown task id '{args.task_id}' for {key}.")
        return
    tc.mark_done(state, key, category, idx)
    tc.save_state(state)
    print(f"Marked '{args.task_id}' done for {key}.")


def cmd_snapshots(_args):
    """List all curriculum snapshots (week 1, week 2, etc)."""
    snapshots = appconfig.get_snapshot_manifest()
    if not snapshots:
        print("No snapshots yet. Edit goals.json and run `mtdo import goals.json` to create one.")
        return

    print(f"\n## Curriculum Snapshots\n")
    for i, snap in enumerate(snapshots, 1):
        print(f"{i}. {snap['timestamp']} ({snap['size']} bytes)")
        print(f"   Path: {snap['path']}\n")

    current_path = appconfig.GOALS_PATH
    if os.path.exists(current_path):
        stat = os.stat(current_path)
        print(f"Current: goals.json ({stat.st_size} bytes)")


def cmd_snapshot_diff(args):
    """Show the diff between two snapshots or current goals vs a snapshot."""
    snapshots = appconfig.get_snapshot_manifest()
    if not snapshots:
        print("No snapshots to compare.")
        return

    if not args.snapshot:
        # Compare current goals.json with most recent snapshot
        if not os.path.exists(appconfig.GOALS_PATH):
            print("No current goals.json to compare.")
            return
        with open(appconfig.GOALS_PATH) as f:
            current = json.load(f)
        snap_path = snapshots[0]["path"]
        with open(snap_path) as f:
            snapshot = json.load(f)
        print(f"\nDiff: Current goals.json vs {snapshots[0]['timestamp']}\n")
    else:
        # Compare two specific snapshots
        try:
            snap_idx = int(args.snapshot) - 1
            snap = snapshots[snap_idx]
            with open(snap["path"]) as f:
                snapshot = json.load(f)
            print(f"\nSnapshot #{args.snapshot}: {snap['timestamp']}\n")
        except (ValueError, IndexError):
            print(f"Invalid snapshot number. Run `mtdo snapshots` to see available snapshots.")
            return

    import json
    print(json.dumps(snapshot, indent=2))


def main():
    parser = argparse.ArgumentParser(prog="mtdo", description="A config-driven terminal task/focus/career board.")
    sub = parser.add_subparsers(dest="command")

    p_init = sub.add_parser("init", help="Create ~/.mtdo/config.yaml")
    p_init.add_argument("--fresh", action="store_true", help="Start from an empty template instead of the demo plan")
    p_init.add_argument("--force", action="store_true", help="Overwrite an existing config")
    p_init.set_defaults(func=cmd_init)

    p_template = sub.add_parser("template", help="Write a goals.json template to fill in yourself or via an AI assistant")
    p_template.add_argument("output", nargs="?", default=None, help="Output path (default: ./goals.json)")
    p_template.set_defaults(func=cmd_template)

    p_import = sub.add_parser("import", help="Build/update config.yaml from a filled-in goals JSON")
    p_import.add_argument("json_path")
    p_import.set_defaults(func=cmd_import)

    p_status = sub.add_parser("status", help="Print today's basket as markdown (for scripting/AI assistants)")
    p_status.set_defaults(func=cmd_status)

    p_done = sub.add_parser("done", help="Mark a task done by ID")
    p_done.add_argument("task_id")
    p_done.add_argument("date", nargs="?", default=None)
    p_done.set_defaults(func=cmd_done)

    p_snapshots = sub.add_parser("snapshots", help="List all curriculum snapshots (week 1, 2, 3, etc)")
    p_snapshots.set_defaults(func=cmd_snapshots)

    p_snapshot_diff = sub.add_parser("snapshot-diff", help="View a snapshot or diff with current goals")
    p_snapshot_diff.add_argument("snapshot", nargs="?", default=None, help="Snapshot number (from `mtdo snapshots`)")
    p_snapshot_diff.set_defaults(func=cmd_snapshot_diff)

    args = parser.parse_args()
    if args.command is None:
        cmd_run(args)
    else:
        args.func(args)


if __name__ == "__main__":
    main()
