"""Tests for instance_store.py's saved-instance storage layer (see sandbox_entry.py),
in particular the path-traversal guard added for gh70: _data_path/_meta_path used to
os.path.join a slug straight into a filesystem path with no check for "/" or ".." --
narrow in practice (the CLI's delete command already requires a matching <slug>.meta.json
to exist at the traversed path before it gets anywhere near deletion), but there was no
guard at the actual path-construction layer itself, which is what this module's own
delete_instance() docstring says it exists to prevent in the first place.

INSTANCES_DIR is a module-level constant computed from the real ~/.mtdo-sandbox at
import time, so every test monkeypatches it to a tmp_path -- these must never touch the
user's real sandbox directory.
"""
import pytest

from mtdo import instance_store


@pytest.fixture(autouse=True)
def _sandbox_in_tmp(tmp_path, monkeypatch):
    instances_dir = tmp_path / "instances"
    monkeypatch.setattr(instance_store, "INSTANCES_DIR", str(instances_dir))


@pytest.mark.parametrize("bad_slug", [
    "../outside",
    "..",
    "foo/../../bar",
    "a/b",
    "a\\b",
    "",
])
def test_validate_slug_rejects_traversal_shapes(bad_slug):
    with pytest.raises(ValueError):
        instance_store._validate_slug(bad_slug)


@pytest.mark.parametrize("good_slug", ["my-instance", "job-search-2", "a", "123"])
def test_validate_slug_accepts_normal_slugs(good_slug):
    instance_store._validate_slug(good_slug)  # must not raise


def test_slugify_can_never_produce_a_rejected_slug():
    """The guard must never false-positive against anything _slugify() (the only
    producer of slugs for legitimately-created instances) can actually output --
    it collapses every run of non-alphanumeric characters (including "/" and ".")
    to a single "-", so "/" and ".." can't survive it."""
    tricky_names = ["../../etc/passwd", "a/b/../c", "....", "foo\\bar", "  ..  "]
    for name in tricky_names:
        slug = instance_store._slugify(name)
        instance_store._validate_slug(slug)  # must not raise


def test_data_path_and_meta_path_reject_traversal_slug():
    with pytest.raises(ValueError):
        instance_store._data_path("../escaped")
    with pytest.raises(ValueError):
        instance_store._meta_path("../escaped")


def test_get_instance_meta_rejects_traversal_slug_instead_of_reading_outside_instances_dir():
    with pytest.raises(ValueError):
        instance_store.get_instance_meta("../../real-instance")


def test_delete_instance_rejects_traversal_slug_instead_of_rmtree_outside_instances_dir():
    with pytest.raises(ValueError):
        instance_store.delete_instance("../real-instance")


def test_delete_instance_still_raises_file_not_found_for_a_missing_but_validly_shaped_slug():
    """Confirms the new guard didn't change delete_instance's existing behavior for
    a normal, safely-shaped slug that just doesn't exist."""
    with pytest.raises(FileNotFoundError):
        instance_store.delete_instance("never-existed")


def test_save_get_and_delete_round_trip_still_works_for_a_normal_instance(tmp_path):
    """Regression check: the guard must not break the real, legitimate flow."""
    scratch = str(tmp_path / "scratch")
    import os
    os.makedirs(scratch)
    with open(os.path.join(scratch, "state.json"), "w") as f:
        f.write("{}")

    slug = instance_store.save_scratch(scratch, name="My Test Instance", description="desc")
    assert slug == "my-test-instance"

    meta = instance_store.get_instance_meta(slug)
    assert meta["name"] == "My Test Instance"

    instance_store.delete_instance(slug)
    with pytest.raises(Exception):
        instance_store.get_instance_meta(slug)


def test_cli_delete_command_rejects_traversal_slug_without_crashing(monkeypatch, capsys):
    """End-to-end through the real CLI entry point the audit flagged --
    `mtdo-sandbox instance delete <slug>` -- confirming a crafted slug is turned away
    with a clean message, not a traceback, and (implicitly, since get_instance_meta
    raises before any deletion code runs) never reaches shutil.rmtree at all."""
    from mtdo import sandbox_entry

    sandbox_entry._instance_command(["delete", "../../outside"])
    out = capsys.readouterr().out
    assert "No saved instance" in out
