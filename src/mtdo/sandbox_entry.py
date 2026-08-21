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


def main():
    if len(sys.argv) > 1:
        os.environ.setdefault("MTDO_HOME", _SANDBOX_ROOT)
        from .cli import main as real_main
        real_main()
        return
    _run_interactive()
