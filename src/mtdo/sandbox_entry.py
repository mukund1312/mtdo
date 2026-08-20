"""Console-script entry point for `mtdo-sandbox`: runs the exact same app as `mtdo`,
just pointed at a separate, disposable data directory (~/.mtdo-sandbox) instead of the
real ~/.mtdo -- so you can test features, generate throwaway tasks, try a fresh
onboarding flow, etc, without any risk of touching real plan/progress data. Nothing
mtdo-specific is shared between the two: separate goals.json, state.json, profiles/,
error.log, memory.md, secrets.json, practice/, transcripts/ -- see config.APP_DIR and
every other module's path constants, which all derive from it.

Sets MTDO_HOME *before* importing anything else from this package -- every module's
~/.mtdo-rooted path constants (config.APP_DIR and everything built from it elsewhere)
are computed once, at first import, so setting the env var from inside an
already-imported cli.py would be too late. Uses setdefault, not a hard assignment, so
`MTDO_HOME=/somewhere/else mtdo-sandbox` still lets you point the sandbox somewhere
other than the default if you want to.

Reset it to genuinely fresh any time with `mtdo-sandbox reset` (see cli.cmd_reset --
it refuses to run at all if MTDO_HOME ever resolves to the real ~/.mtdo, so this can't
accidentally wipe real data even if invoked wrong).
"""
import os

os.environ.setdefault("MTDO_HOME", os.path.expanduser("~/.mtdo-sandbox"))


def main():
    from .cli import main as real_main
    real_main()
