"""CLI entry point for the `mtdo` command: run the TUI, or manage config/tasks from
the shell (handy for scripting or wiring into an AI assistant's tool-use, the way the
original build wired into Claude Code's /todo skill)."""
import argparse
import datetime
import getpass
import json
import os
import shutil
import sys

from . import config as appconfig
from . import profiles as pf

# Whichever of the two installed commands actually launched this process ("mtdo" or
# "mtdo-sandbox", see sandbox_entry.py) -- used in messages that tell the user to run
# the app again, so a sandbox session doesn't tell them to run plain `mtdo` (which
# would silently switch them back to real prod data instead of the sandbox they're in).
_PROG = os.path.basename(sys.argv[0]) if sys.argv else "mtdo"


def cmd_init(args):
    if appconfig.config_exists() and not args.force:
        print(f"Config already exists at {appconfig.CONFIG_PATH} -- pass --force to overwrite.")
        return
    path = appconfig.init_config(fresh=args.fresh)
    kind = "empty template" if args.fresh else "demo plan (a real working example, not empty)"
    print(f"Created {path} from the {kind}.")
    print(f"Edit that file to make it yours, then run `{_PROG}` to start.")


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
        # Fallback: use config.yaml or demo if neither exists. Always starts genuinely
        # empty (never the demo) -- the app itself asks name/persona/how-to-populate
        # in-app, right after the feature walkthrough, once it's actually running (see
        # app.py's TodoApp._begin_setup_flow). This used to run as CLI-level input()
        # prompts *before* the app started, specifically to avoid hot-reloading a
        # running app's category structure -- moved in-app on explicit user request
        # instead (asking after the walkthrough, not before the app even boots, was
        # worth more than avoiding that complexity), so TodoApp now boots with a
        # genuinely empty board first and stays that way until the in-app wizard (or a
        # manual `import`) fills it in.
        if not appconfig.config_exists():
            appconfig.init_config(fresh=True)
        try:
            cfg = appconfig.load_config()
        except appconfig.ConfigError as e:
            print(f"Can't start mtdo: {e}")
            sys.exit(1)
    except appconfig.ConfigError as e:
        # gh39: a hand-edited goals.json with bad JSON, or a category missing a
        # required field, used to surface as a raw traceback right here -- this is
        # the very first thing that runs on `mtdo`, before the TUI (and its own
        # crash screen/error.log) even starts. Nothing has been touched by this
        # failing -- it's a read of an already-broken file, not a write.
        print(f"Can't start mtdo: {e}")
        print(f"Nothing has been touched -- fix {appconfig.GOALS_PATH} and run `{_PROG}` again.")
        sys.exit(1)

    from . import app as todo_app
    try:
        todo_app.run_app(cfg)
    except appconfig.ConfigError as e:
        # core.configure() (called by run_app) can still reject a goals.json-derived
        # cfg that goals_to_config's own, narrower validation didn't catch (e.g. a
        # category missing "label"/"days") -- same treatment.
        print(f"Can't start mtdo: {e}")
        sys.exit(1)


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
        out.append("### Backlog (rest of this week, not ticked)")
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


def cmd_analytics_on(_args):
    appconfig.set_analytics_local_enabled(True)
    print("Local analytics turned on -- stays on this machine. See PRIVACY.md for exactly what's collected.")
    print(f"Run `{_PROG} analytics status` any time to check, `{_PROG} analytics show` to see it, `{_PROG} analytics off` to stop.")


def cmd_analytics_off(_args):
    appconfig.set_analytics_local_enabled(False)
    print("Local analytics turned off. Previously recorded events are untouched -- run "
          f"`{_PROG} analytics purge` to delete them too.")


def cmd_analytics_status(_args):
    from . import analytics
    settings = appconfig.load_analytics_settings()
    print(f"Local analytics: {'on' if settings['local_enabled'] else 'off'}")
    if settings["decided_at"]:
        print(f"Decided at: {settings['decided_at']}")
    if settings["local_enabled"]:
        s = analytics.summary()
        print(f"Events stored: {s['count']}")
        if s["count"]:
            print(f"Date range: {s['oldest']} .. {s['newest']}")
            print(f"Sessions: {s['sessions']}")
        install_id = appconfig.get_install_id()
        print(f"Install ID: {install_id[:8]}... (random, not tied to your name or profiles)")
    print("Remote sync: not built yet -- planned for once mtdo has a real external install base.")
    print(f"\nRun `{_PROG} analytics show` to see everything stored, or `{_PROG} analytics purge` to delete it.")


def cmd_analytics_show(args):
    from . import analytics
    events = analytics.query_events(limit=args.limit)
    print(json.dumps(events, indent=2))


def cmd_analytics_purge(args):
    from . import analytics
    s = analytics.summary()
    if s["count"] == 0:
        print("Nothing stored -- nothing to purge.")
        return
    if not args.force:
        confirm = input(f"Delete all {s['count']} stored events? Type 'purge' to confirm: ")
        if confirm.strip() != "purge":
            print("Not purging.")
            return
    analytics.purge_all()
    print("All locally stored analytics events deleted.")


def cmd_analytics_help(_args):
    print(f"Usage: {_PROG} analytics <on|off|status|show|purge> ...")
    print(f"Run `{_PROG} analytics <subcommand> --help` for details.")


def cmd_insights(_args):
    from . import analytics
    settings = appconfig.load_analytics_settings()
    if not settings["local_enabled"]:
        print(f"Analytics is off -- nothing to show. Run `{_PROG} analytics on` to start collecting locally.")
        return
    s = analytics.summary()
    if s["count"] == 0:
        print("No events recorded yet -- use mtdo a bit, then check back.")
        return

    print("## mtdo usage insights (local only -- never leaves this machine)\n")
    print(f"Sessions tracked: {s['sessions']}")
    print(f"Events recorded: {s['count']} (since {s['oldest']})")
    print(f"Help opened: {analytics.count_events(event_name='help_opened')} times total")
    print(f"Focus Mode toggles: {analytics.count_events(event_name='focus_mode_toggled')}")
    print(f"Practice Lab runs: {analytics.count_events(event_name='practice_lab_run')}")
    print(f"AI backend switches: {analytics.count_events(event_name='ai_panel_backend_switch')}")

    print("\n### Friction signals")
    signals = [
        ("Sessions with 3+ Help opens within 15 minutes", analytics.friction_repeated_help()),
        ("Sessions with rapid task status flapping", analytics.friction_task_flapping()),
        ("Sessions with a 20+ minute mid-session gap", analytics.friction_long_inactivity()),
        ("Sessions with AI backend-switch churn", analytics.friction_backend_churn()),
        ("Sessions with repeated failed Practice Lab runs", analytics.friction_failed_practice_runs()),
        ("Onboarding walkthroughs abandoned", analytics.friction_abandoned_onboarding()),
    ]
    found_any = False
    for label, rows in signals:
        if rows:
            found_any = True
            print(f"  - {label}: {len(rows)}")
    if not found_any:
        print("  (none detected)")


class _AuthFailed(Exception):
    pass


# The live goals/state paths, displayed with the home directory collapsed to "~" --
# reads as "~/.mtdo/goals.json" for a normal install, or "~/.mtdo-sandbox/goals.json"
# under `mtdo-sandbox` (see sandbox_entry.py/config.APP_DIR), so these messages never
# claim to be touching real data when they're actually operating on the sandbox.
_GOALS_DISPLAY = appconfig.GOALS_PATH.replace(os.path.expanduser("~"), "~", 1)
_STATE_DISPLAY = appconfig.STATE_PATH.replace(os.path.expanduser("~"), "~", 1)


def _resolve_profile(name):
    """Matches a profile by slug or by display name (case-insensitive) -- so `mtdo
    profile switch "DSA Track"` and `mtdo profile switch dsa_track` both work."""
    name_l = name.strip().lower()
    for p in pf.list_profiles():
        if p["slug"] == name or p["slug"].lower() == name_l or p["name"].lower() == name_l:
            return p
    return None


def _get_password_for(slug, name, action_desc, max_attempts=3):
    """None if the profile isn't password-protected. Otherwise prompts (hidden input)
    up to max_attempts times, raising _AuthFailed once exhausted -- never returns a
    password that didn't check out, so callers can pass the result straight to
    profiles.read_goals/write_goals without re-checking."""
    profile = pf.get_profile(slug)
    if not profile.get("protected"):
        return None
    for attempt in range(max_attempts):
        password = getpass.getpass(f"Password for profile '{name}' ({action_desc}): ")
        if pf.check_password(slug, password):
            return password
        remaining = max_attempts - attempt - 1
        if remaining:
            print(f"Wrong password. {remaining} attempt(s) left.")
    raise _AuthFailed(f"Too many failed attempts for profile '{name}' -- not switching.")


def cmd_profile_list(_args):
    profiles = pf.list_profiles()
    if not profiles:
        print(f"No profiles yet. Run `{_PROG} profile create <name>` to make one.")
        return
    active = pf.get_active_slug()
    print("\nProfiles:")
    for p in profiles:
        marker = "*" if p["slug"] == active else " "
        lock = "  [password-protected]" if p.get("protected") else ""
        print(f"  {marker} {p['name']}  ({p['slug']}){lock}")
    print("\n(* = active)\n" if active else "")


def cmd_profile_current(_args):
    active = pf.get_active_slug()
    if not active:
        print(
            f"No active profile -- your {_GOALS_DISPLAY} and state.json are unmanaged "
            f"(not tied to any profile). Run `{_PROG} profile create <name> --from-current` "
            "to adopt them as your first profile."
        )
        return
    profile = pf.get_profile(active)
    lock = "  [password-protected]" if profile.get("protected") else ""
    print(f"Active profile: {profile['name']} ({profile['slug']}){lock}")


def _offer_local_recovery_code_save(slug, recovery_code):
    """CLI counterpart to RecoveryCodeScreen's local-save choice (gh53) -- same
    three-way choice (save protected / save plain / don't save), for parity with
    the TUI. `input()` here is fine even though the rest of this function uses
    getpass elsewhere -- these are plain yes/no prompts, not secrets."""
    answer = input("Also save a local copy of this code? [y/N] ").strip().lower()
    if answer not in ("y", "yes"):
        return
    protect = input("Protect this local copy with its own password? [y/N] ").strip().lower()
    password = None
    if protect in ("y", "yes"):
        password = getpass.getpass("Password for this saved copy: ")
        confirm = getpass.getpass("Confirm password: ")
        if password != confirm:
            print("Passwords didn't match -- not saved locally (the code is still printed above).")
            return
    pf.save_recovery_code_locally(slug, recovery_code, password=password)
    print("Local copy of the recovery code saved.")


def cmd_profile_create(args):
    password = None
    if args.password:
        password = getpass.getpass("New password for this profile: ")
        confirm = getpass.getpass("Confirm password: ")
        if password != confirm:
            print("Passwords didn't match -- not created.")
            return

    was_first = not pf.list_profiles()
    try:
        slug, recovery_code = pf.create_profile(args.name, password=password)
    except pf.ProfileError as e:
        print(str(e))
        return
    print(f"Created profile '{args.name}' ({slug}).")
    if recovery_code:
        print(
            f"\nRECOVERY CODE (save this now -- shown once):\n\n    {recovery_code}\n\n"
            "If you forget your password, this code is the ONLY way back into this "
            f"profile's data. mtdo does not store it and cannot recover it for you.\n"
            f"To reset a forgotten password: `{_PROG} profile recover {args.name}`\n"
        )
        _offer_local_recovery_code_save(slug, recovery_code)
    else:
        print(
            f"No password set -- '{args.name}'s goals/state files are stored as plain, "
            f"readable JSON. Re-run with --password to encrypt them (gh44/gh49)."
        )

    adopted = False
    if args.from_current:
        # Same gh62 fix as cmd_profile_switch below: read both first, commit both
        # via one atomic call rather than two separate write_goals()/write_state()
        # calls that could leave this brand-new profile with only one of the two
        # adopted if the process died in between.
        goals_data = None
        if os.path.exists(appconfig.GOALS_PATH):
            with open(appconfig.GOALS_PATH) as f:
                goals_data = json.load(f)
        state_data = None
        if os.path.exists(appconfig.STATE_PATH):
            with open(appconfig.STATE_PATH) as f:
                state_data = json.load(f)
        if goals_data is not None and state_data is not None:
            pf.write_goals_and_state(slug, goals_data, state_data, password)
        elif goals_data is not None:
            pf.write_goals(slug, goals_data, password)
        elif state_data is not None:
            pf.write_state(slug, state_data, password)
        adopted = goals_data is not None or state_data is not None
        if adopted:
            print(f"Copied your current {_GOALS_DISPLAY}/state.json into '{args.name}'.")
        else:
            print(f"Nothing at {_GOALS_DISPLAY} or state.json to adopt -- profile created empty.")

    has_legacy_data = os.path.exists(appconfig.GOALS_PATH) or os.path.exists(appconfig.STATE_PATH)
    if was_first and not args.from_current and has_legacy_data:
        print(
            f"Note: '{args.name}' is now marked active, but your existing {_GOALS_DISPLAY}/"
            "state.json were NOT copied into it (you didn't pass --from-current) -- it's "
            "empty. Re-run with --from-current to adopt your existing data instead, or keep "
            f"running `{_PROG}` as normal to use it unmanaged."
        )
    elif was_first:
        print(f"'{args.name}' is now the active profile -- run `{_PROG}` to start using it.")
    elif adopted:
        print(f"Run `{_PROG} profile switch {args.name}` to make it active.")
    else:
        print(f"Run `{_PROG} profile switch {args.name}` once you're ready to use it.")


def cmd_profile_switch(args):
    target = _resolve_profile(args.name)
    if target is None:
        print(f"No profile named '{args.name}'. Run `{_PROG} profile list` to see what exists.")
        return

    current_slug = pf.get_active_slug()
    if current_slug == target["slug"]:
        print(f"'{target['name']}' is already the active profile.")
        return

    # Save the currently active profile's live data back into its own storage first --
    # otherwise anything done since the last switch would be silently lost when we
    # overwrite ~/.mtdo/goals.json and state.json below.
    if current_slug is not None:
        current = pf.get_profile(current_slug)
        try:
            current_password = _get_password_for(
                current_slug, current["name"], "saving its progress before switching away"
            )
        except _AuthFailed as e:
            print(str(e))
            return
        # Read both first, then commit both via one call -- gh62: two separate
        # write_goals()/write_state() calls left a real window where the process
        # dying (or the second call raising) between them left the profile with
        # its goals updated but state stale, a genuine inconsistent split state.
        goals_data = None
        if os.path.exists(appconfig.GOALS_PATH):
            with open(appconfig.GOALS_PATH) as f:
                goals_data = json.load(f)
        state_data = None
        if os.path.exists(appconfig.STATE_PATH):
            with open(appconfig.STATE_PATH) as f:
                state_data = json.load(f)
        if goals_data is not None and state_data is not None:
            pf.write_goals_and_state(current_slug, goals_data, state_data, current_password)
        elif goals_data is not None:
            pf.write_goals(current_slug, goals_data, current_password)
        elif state_data is not None:
            pf.write_state(current_slug, state_data, current_password)
    elif os.path.exists(appconfig.GOALS_PATH) or os.path.exists(appconfig.STATE_PATH):
        print(
            f"You have an existing {_GOALS_DISPLAY}/state.json that isn't tied to any "
            f"profile. Switching now would overwrite it with '{target['name']}'s data and "
            f"lose it. Run `{_PROG} profile create <name> --from-current` first to adopt it, "
            "then switch."
        )
        return

    try:
        target_password = _get_password_for(target["slug"], target["name"], "unlocking it")
    except _AuthFailed as e:
        print(str(e))
        return

    goals = pf.read_goals(target["slug"], target_password)
    state = pf.read_state(target["slug"], target_password)

    # gh62: these used to be two separate, direct open(..., "w") calls -- neither
    # individually crash-safe (a mid-write death left a truncated file), and with a
    # real window between them where a crash (or the second call raising) left the
    # incoming profile's goals landed but state stale (or vice versa), same half-
    # updated-profile risk as the outgoing-profile write this fix's sibling
    # (write_goals_and_state, see profiles.py) already closed. Both are now written
    # via their module's own atomic (temp file + os.replace()) writer, back-to-back
    # with no other I/O in between -- config.save_goals/core.save_state rather than
    # profiles.write_goals_and_state itself, since these are the live, unencrypted
    # ~/.mtdo files, not per-profile storage.
    from . import core as tc

    os.makedirs(appconfig.APP_DIR, exist_ok=True)
    if goals is not None:
        appconfig.save_goals(goals)
    elif os.path.exists(appconfig.GOALS_PATH):
        os.remove(appconfig.GOALS_PATH)
    tc.save_state(state)

    pf.set_active(target["slug"])
    print(f"Switched to profile '{target['name']}'. Run `{_PROG}` to start.")


def cmd_profile_delete(args):
    target = _resolve_profile(args.name)
    if target is None:
        print(f"No profile named '{args.name}'.")
        return
    if pf.get_active_slug() == target["slug"] and not args.force:
        print(
            f"'{target['name']}' is the active profile -- switch to another one first, or "
            "pass --force to delete it anyway (its live ~/.mtdo files are left as-is, just "
            "orphaned from any profile)."
        )
        return
    confirm = input(
        f"Delete profile '{target['name']}' ({target['slug']}) and all its data? This "
        "cannot be undone. Type the profile name to confirm: "
    )
    if confirm.strip() != target["name"]:
        print("Names didn't match -- not deleting.")
        return
    pf.delete_profile(target["slug"])
    print(f"Deleted profile '{target['name']}'.")


def cmd_profile_import(args):
    target = _resolve_profile(args.name)
    if target is None:
        print(f"No profile named '{args.name}'.")
        return
    try:
        password = _get_password_for(target["slug"], target["name"], "importing into it")
    except _AuthFailed as e:
        print(str(e))
        return
    try:
        goals = pf.import_goals_file(target["slug"], args.json_path, password)
    except pf.ProfileError as e:
        print(str(e))
        return
    print(f"Imported {args.json_path} into profile '{target['name']}'.")
    if pf.get_active_slug() == target["slug"]:
        with open(appconfig.GOALS_PATH, "w") as f:
            json.dump(goals, f, indent=2, sort_keys=False)
        print(f"This is the active profile -- {_GOALS_DISPLAY} was updated too.")


def cmd_profile_recover(args):
    """Resets a protected profile's password using its recovery code -- the gh40
    fix. Doesn't need (or change) the old password, and doesn't touch goals.json/
    state.json; only the wrapped-key envelope is rewrapped.

    The code is checked as soon as it's entered, before asking for a new password
    at all (gh51) -- it used to only get caught at the very end, after the user had
    already typed and confirmed a brand-new password, which read like the CLI let a
    wrong code through even though the actual reset was always correctly rejected."""
    target = _resolve_profile(args.name)
    if target is None:
        print(f"No profile named '{args.name}'.")
        return
    if not target.get("protected"):
        print(f"'{target['name']}' has no password set -- nothing to recover.")
        return
    recovery_code = getpass.getpass("Recovery code (shown once at profile creation): ")
    if not pf.check_recovery_code(target["slug"], recovery_code):
        print(f"Wrong recovery code for '{target['name']}'.")
        return
    new_password = getpass.getpass("New password: ")
    confirm = getpass.getpass("Confirm new password: ")
    if new_password != confirm:
        print("Passwords didn't match -- not reset.")
        return
    try:
        pf.recover_profile(target["slug"], recovery_code, new_password)
    except pf.InvalidRecoveryCode as e:
        print(str(e))
        return
    except pf.ProfileError as e:
        print(str(e))
        return
    print(f"Password reset for '{target['name']}'. The recovery code still works if you need it again.")


def cmd_profile_view_recovery_code(args):
    """Shows a recovery code that was saved locally at creation time (gh53) -- the
    read-back counterpart to _offer_local_recovery_code_save. Nothing to show if
    that offer was declined; mtdo never generates or stores one after the fact."""
    target = _resolve_profile(args.name)
    if target is None:
        print(f"No profile named '{args.name}'.")
        return
    if not pf.has_local_recovery_code(target["slug"]):
        print(f"No recovery code was saved locally for '{target['name']}'.")
        return
    password = None
    if pf.local_recovery_code_protected(target["slug"]):
        password = getpass.getpass("Password for this saved copy: ")
    try:
        code = pf.read_local_recovery_code(target["slug"], password)
    except pf.WrongPassword as e:
        print(str(e))
        return
    print(f"\nRECOVERY CODE for '{target['name']}':\n\n    {code}\n")


def cmd_profile_help(args):
    print(f"Usage: {_PROG} profile <list|current|create|switch|delete|import|recover|view-recovery-code> ...")
    print(f"Run `{_PROG} profile <subcommand> --help` for details.")


_REAL_APP_DIR = os.path.abspath(os.path.expanduser("~/.mtdo"))


def cmd_reset(_args):
    """Wipes everything under the CURRENT app dir (appconfig.APP_DIR) and starts that
    install fresh -- meant for `mtdo-sandbox reset` (see sandbox_entry.py), not for
    prod. Refuses outright if APP_DIR resolves to the real ~/.mtdo, regardless of how
    it was invoked, so this can never wipe real data even if run by mistake or with a
    misconfigured MTDO_HOME."""
    current = os.path.abspath(appconfig.APP_DIR)
    if current == _REAL_APP_DIR:
        print(
            f"Refusing -- {current} is your real ~/.mtdo (prod data), not a sandbox.\n"
            "`reset` only runs when MTDO_HOME points somewhere else -- use `mtdo-sandbox reset`."
        )
        return
    if not os.path.isdir(current):
        print(f"Nothing to reset -- {current} doesn't exist yet. It'll be created fresh on next run.")
        return
    confirm = input(f"Delete EVERYTHING under {current} and start fresh? Type 'reset' to confirm: ")
    if confirm.strip() != "reset":
        print("Not resetting.")
        return
    shutil.rmtree(current)
    print(f"Wiped {current}. Run `{_PROG}` again to start fresh.")


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

    p_profile = sub.add_parser("profile", help="Manage named profiles (separate goals/state/streaks per track)")
    p_profile.set_defaults(func=cmd_profile_help)
    profile_sub = p_profile.add_subparsers(dest="profile_command")

    p_profile_list = profile_sub.add_parser("list", help="List all profiles")
    p_profile_list.set_defaults(func=cmd_profile_list)

    p_profile_current = profile_sub.add_parser("current", help="Show the active profile")
    p_profile_current.set_defaults(func=cmd_profile_current)

    p_profile_create = profile_sub.add_parser("create", help="Create a new profile")
    p_profile_create.add_argument("name")
    p_profile_create.add_argument("--password", action="store_true", help="Encrypt this profile's data at rest")
    p_profile_create.add_argument(
        "--from-current", action="store_true",
        help="Seed it from your current ~/.mtdo/goals.json and state.json",
    )
    p_profile_create.set_defaults(func=cmd_profile_create)

    p_profile_switch = profile_sub.add_parser("switch", help="Make a profile active (syncs it into ~/.mtdo)")
    p_profile_switch.add_argument("name")
    p_profile_switch.set_defaults(func=cmd_profile_switch)

    p_profile_delete = profile_sub.add_parser("delete", help="Permanently delete a profile")
    p_profile_delete.add_argument("name")
    p_profile_delete.add_argument("--force", action="store_true", help="Allow deleting the active profile")
    p_profile_delete.set_defaults(func=cmd_profile_delete)

    p_profile_import = profile_sub.add_parser("import", help="Import a goals JSON file into an existing profile")
    p_profile_import.add_argument("name")
    p_profile_import.add_argument("json_path")
    p_profile_import.set_defaults(func=cmd_profile_import)

    p_profile_recover = profile_sub.add_parser(
        "recover", help="Reset a forgotten password using the profile's recovery code",
    )
    p_profile_recover.add_argument("name")
    p_profile_recover.set_defaults(func=cmd_profile_recover)

    p_profile_view_recovery = profile_sub.add_parser(
        "view-recovery-code", help="Show a recovery code saved locally at creation time (gh53)",
    )
    p_profile_view_recovery.add_argument("name")
    p_profile_view_recovery.set_defaults(func=cmd_profile_view_recovery_code)

    p_analytics = sub.add_parser("analytics", help="Manage local usage analytics (opt-in, stays on this machine)")
    p_analytics.set_defaults(func=cmd_analytics_help)
    analytics_sub = p_analytics.add_subparsers(dest="analytics_command")

    p_analytics_on = analytics_sub.add_parser("on", help="Turn on local analytics")
    p_analytics_on.set_defaults(func=cmd_analytics_on)

    p_analytics_off = analytics_sub.add_parser("off", help="Turn off local analytics")
    p_analytics_off.set_defaults(func=cmd_analytics_off)

    p_analytics_status = analytics_sub.add_parser("status", help="Show on/off state and a summary of what's stored")
    p_analytics_status.set_defaults(func=cmd_analytics_status)

    p_analytics_show = analytics_sub.add_parser("show", help="Dump every stored event as JSON")
    p_analytics_show.add_argument("--limit", type=int, default=None)
    p_analytics_show.set_defaults(func=cmd_analytics_show)

    p_analytics_purge = analytics_sub.add_parser("purge", help="Permanently delete all stored events")
    p_analytics_purge.add_argument("--force", action="store_true", help="Skip the type-to-confirm prompt")
    p_analytics_purge.set_defaults(func=cmd_analytics_purge)

    p_insights = sub.add_parser("insights", help="Local usage-insights report (requires `mtdo analytics on`)")
    p_insights.set_defaults(func=cmd_insights)

    p_reset = sub.add_parser(
        "reset",
        help="Wipe the current app dir and start fresh (refuses on real ~/.mtdo -- for `mtdo-sandbox reset`)",
    )
    p_reset.set_defaults(func=cmd_reset)

    args = parser.parse_args()
    if args.command is None:
        cmd_run(args)
    else:
        args.func(args)


if __name__ == "__main__":
    main()
