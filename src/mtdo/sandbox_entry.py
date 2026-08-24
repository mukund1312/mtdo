"""Console-script entry point for `mtdo-sandbox`: a disposable place to test mtdo without
any risk to real ~/.mtdo data.

Bare `mtdo-sandbox` (no subcommand) shows a picker of named, saved instances -- pick one to
resume it, or start fresh. Either way the session runs against a *scratch* copy
(instance_store.py); on quit (see app.py's SaveInstanceScreen / SANDBOX_INSTANCE_MODE)
you're asked to save it under a name+description, discard it, or cancel back into the app.
If the terminal closes or the process gets killed before that prompt can show, a SIGHUP/
SIGTERM handler below autosaves the scratch copy instead of silently losing it.

`mtdo-sandbox <subcommand> ...` (reset, profile, status, done, import, ...) bypasses the
picker entirely and runs directly against the flat sandbox root (~/.mtdo-sandbox), exactly
as before instances existed -- those commands aren't instance-scoped.

`mtdo-sandbox bugs` prints every bug ever logged with 'B' (while SANDBOX_INSTANCE_MODE is
on), or `mtdo-sandbox bugs <instance-name>` to filter to one. Bugs live in a single fixed
file (see bug_log.py) written the instant 'B' is pressed -- deliberately NOT tied to any
instance's scratch/save lifecycle, after a real session freeze forced a hard-kill of the
terminal and every bug logged that session was lost (nothing had been written anywhere
durable, since the old design only persisted bugs when the *instance* got saved).
`mtdo-sandbox bugs sync [instance-name]` files any not-yet-synced bugs to the private
mukund1312/mtdo-bugs repo (see bug_sync.py) so they're visible/trackable from any machine
with `gh auth login` done; `mtdo-sandbox bugs board` prints the found/fixed scoreboard
across everything synced there. `mtdo-sandbox bugs distribute` assigns every unassigned
open bug to whoever currently has fewer (a `assigned:<login>` label, separate from who
actually fixes it); `mtdo-sandbox bugs assignments` prints the current split. Finishing
your assigned queue first automatically pulls a few of the other person's over
(bug_sync.rebalance, called from mark_fixed_and_close) so nobody runs dry.

Every `bugs sync` (and `dashboard`, as a safety net) also calls
`bug_sync.auto_triage_pending()` -- fully automatic, no Claude Code session needed: any bug
still missing a priority gets one guessed from its title's wording (crash/security/data-loss
language -> high, README/positioning/docs language -> low, else medium), and any still
unassigned gets whoever currently has fewer bugs at THAT priority level (so both devs keep
getting a mix of urgent and non-urgent work, not just an even raw count). It's a heuristic,
not judgment -- it will get some wrong; re-triage any of those by hand with
`bug_sync.apply_triage({number: {"priority": "high"}})`, and it leaves anything already
triaged alone on every later run (2026-08-24, replacing the earlier one-off manual pass).

`mtdo-sandbox working-on "..."` posts a one-line status for whoever's `gh` identity is
running it (see status_sync.py) -- named "working-on", not "status", because `mtdo status`
is already a real subcommand (prints today's board) and would otherwise be shadowed.
`mtdo-sandbox dashboard` (see dashboard.py) renders both people's status + the full bug
scoreboard as a static HTML snapshot for a Claude Code session to publish/update as a
shared Artifact -- it can't be a live-updating page itself (the Artifact sandbox blocks a
published page from ever calling GitHub's API directly), so "refresh" means regenerating
and republishing, not something that happens automatically.

`mtdo-sandbox instance list` / `mtdo-sandbox instance delete <slug>` (see
_instance_command below) is the one sanctioned way to permanently delete a saved
instance -- requires typing the slug back to confirm. Added after a real incident where
an agent's raw `rm -rf` on instances/ during test cleanup deleted a real user instance
along with its own test data. Never delete under ~/.mtdo-sandbox/instances/ by hand.

Sets MTDO_HOME before importing anything else from the package -- every module's
~/.mtdo-rooted path constants (config.APP_DIR and everything built from it) are computed
once, at first import, so setting the env var later would be too late.
"""
import atexit
import os
import signal
import sys

_SANDBOX_ROOT = os.path.expanduser("~/.mtdo-sandbox")


def _run_picker(instances):
    from textual.app import App, ComposeResult
    from textual.containers import Center, Middle, Vertical
    from textual.widgets import OptionList, Static
    from textual.widgets.option_list import Option

    class InstancePicker(App):
        CSS = """
        Screen { align: center middle; }
        #picker-box { width: 76; height: auto; max-height: 24; border: round magenta; padding: 1 2; }
        #picker-title { text-style: bold; padding-bottom: 1; }
        #picker-hint { color: grey; padding-top: 1; }
        """

        def __init__(self):
            super().__init__()
            self.result = None

        def compose(self) -> ComposeResult:
            with Center():
                with Middle():
                    with Vertical(id="picker-box"):
                        yield Static("mtdo-sandbox -- choose an instance", id="picker-title")
                        options = [Option("+ New instance", id="__new__")]
                        for inst in instances:
                            label = f"{inst['name']} -- {inst.get('description') or 'no description'}  (last used {inst.get('updated_at', '?')})"
                            options.append(Option(label, id=inst["slug"]))
                        yield OptionList(*options, id="picker-list")
                        yield Static("Enter to select, Escape to cancel", id="picker-hint")

        def on_mount(self):
            self.query_one(OptionList).focus()

        def on_option_list_option_selected(self, event):
            if event.option.id == "__new__":
                self.result = ("new", None)
            else:
                self.result = ("enter", event.option.id)
            self.exit()

        def on_key(self, event):
            if event.key == "escape":
                self.result = None
                self.exit()

    picker = InstancePicker()
    picker.run()
    return picker.result


def _run_interactive():
    from . import instance_store

    result = _run_picker(instance_store.list_instances())
    if result is None:
        return  # cancelled at the picker -- nothing launched, nothing to clean up

    action, slug = result
    if action == "new":
        scratch = instance_store.new_scratch_dir()
        os.environ["MTDO_HOME"] = scratch
        os.environ["MTDO_INSTANCE_MODE"] = "1"
        os.environ["MTDO_INSTANCE_SCRATCH"] = scratch
    else:
        scratch = instance_store.load_instance_into_scratch(slug)
        meta = instance_store.get_instance_meta(slug)
        os.environ["MTDO_HOME"] = scratch
        os.environ["MTDO_INSTANCE_MODE"] = "1"
        os.environ["MTDO_INSTANCE_SCRATCH"] = scratch
        os.environ["MTDO_INSTANCE_SLUG"] = slug
        os.environ["MTDO_INSTANCE_NAME"] = meta["name"]
        os.environ["MTDO_INSTANCE_DESCRIPTION"] = meta.get("description", "")

    autosave_slug = slug if action == "enter" else None

    def _autosave_fallback(signum=None, frame=None):
        # Only fires if the scratch dir still exists -- an explicit Save/Discard from the
        # in-app quit prompt already deletes it, so this is purely a safety net for the
        # terminal closing (SIGHUP) or the process being killed (SIGTERM) before that
        # prompt ever had a chance to show.
        if os.path.isdir(scratch):
            try:
                instance_store.autosave_scratch(scratch, slug=autosave_slug)
            except Exception:
                pass
        if signum is not None:
            # os._exit, not sys.exit -- we're in a signal handler that may be firing
            # mid-await inside Textual's asyncio event loop; raising SystemExit through
            # that unwinds messily (a harmless but noisy traceback from timer cleanup).
            # The autosave above already ran synchronously, so there's nothing left to
            # clean up -- just stop the process immediately.
            os._exit(0)

    atexit.register(_autosave_fallback)
    signal.signal(signal.SIGTERM, _autosave_fallback)
    signal.signal(signal.SIGHUP, _autosave_fallback)

    from .cli import main as real_main
    real_main()


def _bugs_command(args):
    from . import bug_log

    if args and args[0] == "board":
        from . import bug_sync
        open_count, closed_count = bug_sync.board()
        print(f"mtdo-sandbox bug scoreboard ({bug_sync.TRACKER_REPO}):")
        print(f"  Found: {open_count + closed_count}   Fixed: {closed_count}   Open: {open_count}")
        return

    if args and args[0] == "sync":
        from . import bug_sync
        instance = args[1] if len(args) > 1 else None
        filed = bug_sync.sync_pending(instance=instance)
        print(f"Filed {filed} new issue(s) to {bug_sync.TRACKER_REPO}." if filed else "Nothing new to sync.")
        # Every freshly-filed (or previously untriaged) bug gets a priority + an assignee
        # automatically -- no separate ask needed, see bug_sync.auto_triage_pending().
        triaged = bug_sync.auto_triage_pending()
        if triaged:
            print(f"Auto-triaged {len(triaged)} bug(s):")
            for number, changed in sorted(triaged.items()):
                bits = []
                if changed.get("priority"):
                    bits.append("priority")
                if changed.get("assigned_to"):
                    bits.append("assigned")
                print(f"  #{number}: {' + '.join(bits)}")
        return

    if args and args[0] == "distribute":
        from . import bug_sync
        result = bug_sync.distribute_pending()
        total = sum(result.values())
        if not total:
            print("Nothing unassigned to distribute.")
            return
        print(f"Distributed {total} bug(s):")
        for person, count in result.items():
            if count:
                print(f"  {bug_sync.DISPLAY_NAMES.get(person, person)}: +{count}")
        return

    if args and args[0] == "assignments":
        from . import bug_sync
        summary = bug_sync.assignment_summary()
        for person in bug_sync.PEOPLE:
            s = summary[person]
            name = bug_sync.DISPLAY_NAMES.get(person, person)
            print(f"{name}: {s['assigned_open']} open, {s['assigned_fixed']} fixed")
        return

    # bugs.json is one durable, sandbox-wide file now -- not tied to any instance's
    # save/discard lifecycle (see bug_log.py) -- so no MTDO_HOME juggling is needed here.
    instance_filter = args[0] if args else None
    bugs = bug_log.list_bugs(instance=instance_filter)
    if not bugs:
        print(f"No bugs logged for '{instance_filter}'." if instance_filter else "No bugs logged yet.")
        return
    for b in bugs:
        marker = "x" if b["status"] == "fixed" else "-"
        gh = f" (gh#{b['github_issue']})" if b.get("github_issue") else ""
        print(f"[{marker}] #{b['id']} ({b['status']}){gh} [{b.get('instance', '?')}] {b['text']}  -- found {b['found_at']}")
        if b["status"] == "fixed" and b.get("fix_note"):
            print(f"      fix: {b['fix_note']}")


def _working_on_command(args):
    from . import status_sync
    if not args:
        print("Usage: mtdo-sandbox working-on \"what you're working on\"")
        return
    who = status_sync.set_status(" ".join(args))
    print(f"Status updated for {who}.")


def _dashboard_command():
    from . import bug_sync, dashboard
    # Safety net: covers a bug that got created some other way, or `dashboard` run without
    # `bugs sync` first. No-ops instantly if everything's already triaged (see
    # bug_sync.auto_triage_pending()'s own docstring on why re-running is always safe).
    bug_sync.auto_triage_pending()
    path = dashboard.generate()
    print(f"Dashboard written to {path}")
    print("Ask this Claude Code session to publish/update it as a shared Artifact.")


def _instance_command(args):
    """`mtdo-sandbox instance list|delete <slug>` -- the one supported way to permanently
    remove a saved instance, requiring you to type its exact slug back to confirm (same
    pattern as `mtdo-sandbox reset` requiring the word "reset").

    Exists specifically because a raw `rm -rf` on ~/.mtdo-sandbox/instances/ during an
    agent's test cleanup once deleted a real, user-named saved instance along with the
    agent's own test data -- there was no dedicated deletion command, only ever a blanket
    shell command with no way to tell "obviously mine" apart from "somebody's real saved
    work". Claude Code sessions working on this project should use this command (or ask
    the user first) for any instance that isn't unambiguously one they created themselves
    in the same cleanup pass -- never a bare `rm -rf` against this directory again."""
    from . import instance_store

    if not args or args[0] == "list":
        instances = instance_store.list_instances()
        if not instances:
            print("No saved instances.")
            return
        for inst in instances:
            print(f"{inst['slug']}  ({inst['name']}) -- {inst.get('description') or 'no description'}  (last used {inst.get('updated_at', '?')})")
        return

    if args[0] == "delete":
        if len(args) < 2:
            print("Usage: mtdo-sandbox instance delete <slug>")
            return
        slug = args[1]
        try:
            meta = instance_store.get_instance_meta(slug)
        except Exception:
            print(f"No saved instance '{slug}' -- see `mtdo-sandbox instance list`.")
            return
        print(f"About to permanently delete '{meta['name']}' ({slug}) -- {meta.get('description') or 'no description'}.")
        confirm = input(f"Type the slug ({slug}) to confirm: ").strip()
        if confirm != slug:
            print("Not confirmed -- nothing deleted.")
            return
        instance_store.delete_instance(slug)
        print(f"Deleted '{slug}'.")
        return

    print("Usage: mtdo-sandbox instance list | delete <slug>")


def main():
    if len(sys.argv) > 1:
        if sys.argv[1] == "bugs":
            _bugs_command(sys.argv[2:])
            return
        if sys.argv[1] == "working-on":
            _working_on_command(sys.argv[2:])
            return
        if sys.argv[1] == "dashboard":
            _dashboard_command()
            return
        if sys.argv[1] == "instance":
            _instance_command(sys.argv[2:])
            return
        os.environ.setdefault("MTDO_HOME", _SANDBOX_ROOT)
        from .cli import main as real_main
        real_main()
        return
    _run_interactive()
