"""Storage layer for named `mtdo-sandbox` instances (see sandbox_entry.py).

Layout under the sandbox root (~/.mtdo-sandbox, independent of MTDO_HOME -- that env var
gets pointed at a *scratch* copy while a session is open, never at this root directly):

    ~/.mtdo-sandbox/
        instances/
            <slug>/            -- a saved instance's data, same shape as a normal ~/.mtdo
            <slug>.meta.json   -- {slug, name, description, created_at, updated_at}
        .scratch/
            <tmp-dir>/         -- the live working copy for a session that hasn't been
                                   saved (or discarded) yet

A session always runs against a scratch copy, never against instances/<slug> directly, so
"discard changes" and "cancel out of a fresh session" are just "delete the scratch dir" --
the saved copy is untouched until an explicit save promotes the scratch dir over it.
"""
import datetime
import json
import os
import re
import shutil
import tempfile

SANDBOX_ROOT = os.path.expanduser("~/.mtdo-sandbox")
INSTANCES_DIR = os.path.join(SANDBOX_ROOT, "instances")
SCRATCH_ROOT = os.path.join(SANDBOX_ROOT, ".scratch")


def _now():
    return datetime.datetime.now().isoformat(timespec="seconds")


def _slugify(name):
    slug = re.sub(r"[^a-z0-9]+", "-", name.strip().lower()).strip("-")
    return slug or "instance"


def _validate_slug(slug):
    """Rejects any slug that could escape INSTANCES_DIR once path-joined -- a path
    separator or a ".." component. A slug produced by _slugify() can never contain
    either (it collapses any run of non-alphanumeric characters to a single "-"), so
    this only ever fires on untrusted input that bypassed _slugify(), e.g. the raw
    argv[1] `mtdo-sandbox instance delete <slug>` hands to instance_store directly.

    Added after a code audit (gh70) flagged that _data_path/_meta_path path-join a
    slug with no such guard. Not remotely exploitable as shipped -- the delete
    command's confirm-by-retyping-slug step requires a matching <slug>.meta.json to
    already exist at the traversed path -- but that confirm step only guards against
    fat-fingering a slug that resolves to a *real* saved instance, not against a slug
    deliberately crafted to escape instances/ in the first place, which is exactly
    the failure mode this whole module exists to prevent (see delete_instance's
    docstring for the incident that prompted it)."""
    if not slug or "/" in slug or "\\" in slug or ".." in slug:
        raise ValueError(f"Invalid instance slug: {slug!r}")


def _meta_path(slug):
    _validate_slug(slug)
    return os.path.join(INSTANCES_DIR, f"{slug}.meta.json")


def _data_path(slug):
    _validate_slug(slug)
    return os.path.join(INSTANCES_DIR, slug)


def _unique_slug(name):
    base = _slugify(name)
    slug = base
    n = 2
    while os.path.exists(_data_path(slug)):
        slug = f"{base}-{n}"
        n += 1
    return slug


def list_instances():
    """Saved instances, newest-used first. Missing/corrupt meta files are skipped rather
    than raising -- a picker screen showing "9 of 10 instances" beats one that crashes."""
    if not os.path.isdir(INSTANCES_DIR):
        return []
    out = []
    for fname in os.listdir(INSTANCES_DIR):
        if not fname.endswith(".meta.json"):
            continue
        try:
            with open(os.path.join(INSTANCES_DIR, fname)) as f:
                out.append(json.load(f))
        except Exception:
            continue
    out.sort(key=lambda m: m.get("updated_at", ""), reverse=True)
    return out


def get_instance_meta(slug):
    with open(_meta_path(slug)) as f:
        return json.load(f)


def new_scratch_dir():
    os.makedirs(SCRATCH_ROOT, exist_ok=True)
    return tempfile.mkdtemp(dir=SCRATCH_ROOT)


def load_instance_into_scratch(slug):
    """Copies a saved instance's data into a fresh scratch dir and returns its path.
    The live session edits this copy -- the saved instance itself isn't touched again
    until an explicit save."""
    scratch = new_scratch_dir()
    src = _data_path(slug)
    if os.path.isdir(src):
        shutil.copytree(src, scratch, dirs_exist_ok=True)
    return scratch


def save_scratch(scratch_dir, slug=None, name=None, description=None):
    """Promotes a scratch dir's contents into instances/<slug>, creating a new instance
    if slug is None. Always deletes scratch_dir afterward. Returns the slug."""
    if slug is None:
        slug = _unique_slug(name or "untitled")
        created_at = _now()
    else:
        try:
            created_at = get_instance_meta(slug)["created_at"]
        except Exception:
            created_at = _now()

    dest = _data_path(slug)
    if os.path.isdir(dest):
        shutil.rmtree(dest)
    shutil.copytree(scratch_dir, dest, dirs_exist_ok=True)

    meta = {
        "slug": slug,
        "name": name if name else slug,
        "description": description or "",
        "created_at": created_at,
        "updated_at": _now(),
    }
    os.makedirs(INSTANCES_DIR, exist_ok=True)
    with open(_meta_path(slug), "w") as f:
        json.dump(meta, f, indent=2)

    shutil.rmtree(scratch_dir, ignore_errors=True)
    return slug


def discard_scratch(scratch_dir):
    shutil.rmtree(scratch_dir, ignore_errors=True)


def delete_instance(slug):
    """Permanently deletes a SAVED instance (instances/<slug> + its meta.json) -- not a
    scratch dir. Added after a real incident: an agent doing test cleanup ran a raw
    `rm -rf` directly against ~/.mtdo-sandbox/instances/ and deleted a real, user-named
    instance along with its own actual test data, because there was no dedicated,
    confirmable way to delete just one instance -- only ever a blanket shell command with
    no distinction between "obviously mine" and "somebody's real saved work". Raises
    FileNotFoundError if the slug doesn't exist, so callers can't silently no-op a typo
    into looking like a successful delete."""
    if not os.path.isdir(_data_path(slug)):
        raise FileNotFoundError(f"No saved instance '{slug}'")
    shutil.rmtree(_data_path(slug))
    try:
        os.remove(_meta_path(slug))
    except OSError:
        pass


def autosave_scratch(scratch_dir, slug=None):
    """Silent fallback save for when the terminal closed or the process was killed
    before the normal save/discard prompt could ever show. Existing instances keep their
    name; a never-named session gets an auto-generated one so it isn't lost outright."""
    if not os.path.isdir(scratch_dir):
        return
    if slug is not None:
        try:
            meta = get_instance_meta(slug)
            save_scratch(scratch_dir, slug=slug, name=meta["name"], description=meta.get("description", ""))
            return
        except Exception:
            pass
    name = f"Unsaved session {_now()}"
    save_scratch(scratch_dir, name=name, description="Autosaved automatically after the terminal closed unexpectedly.")
