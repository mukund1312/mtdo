"""Regression tests for gh38: code_runner.run() used to execute submitted code with
mtdo's own full permissions, no isolation at all. These cover the real protections
added -- Seatbelt sandboxing on macOS (network denial, write confinement) and POSIX
resource limits everywhere -- against the actual toolchains, not just the profile
string in isolation. CI runs on ubuntu-latest (see .github/workflows/ci.yml), so the
macOS-only assertions are skipped there by design, matching that gh38's filesystem/
network isolation is itself macOS-only; language-execution checks skip individually
if a given toolchain isn't installed on whatever machine runs this, rather than
failing on an environment difference this suite doesn't control.

Every one of these was run by hand against a real subprocess before being written
here, including two real bugs an early version of the fix introduced and that only
showed up this way: an overly broad write grant that silently let a "denied" write
actually succeed, and a CPU resource limit that could mathematically never fire
before the wall-clock timeout it was supposed to independently back up.
"""
import shutil
import sys
import time

import pytest

from mtdo import code_runner as cr

_MACOS_ONLY = pytest.mark.skipif(sys.platform != "darwin", reason="Seatbelt sandboxing is macOS-only")


def _skip_if_missing(*binaries):
    missing = [b for b in binaries if shutil.which(b) is None]
    if missing:
        pytest.skip(f"not installed on this machine: {', '.join(missing)}")


def test_python_runs_correctly_under_the_sandbox():
    _skip_if_missing("python3")
    result = cr.run("python", "print(1 + 1)")
    assert result.ok
    assert "2" in result.output


def test_java_runs_correctly_under_the_sandbox():
    _skip_if_missing("javac", "java")
    code = 'public class Solution { public static void main(String[] a) { System.out.println("hi java"); } }'
    result = cr.run("java", code)
    assert result.ok, result.output
    assert "hi java" in result.output


def test_c_runs_correctly_under_the_sandbox():
    _skip_if_missing("gcc")
    result = cr.run("c", '#include <stdio.h>\nint main(){printf("hi c\\n");return 0;}')
    assert result.ok, result.output
    assert "hi c" in result.output


def test_cpp_runs_correctly_under_the_sandbox():
    _skip_if_missing("g++")
    code = '#include <iostream>\nint main(){std::cout<<"hi cpp"<<std::endl;return 0;}'
    result = cr.run("cpp", code)
    assert result.ok, result.output
    assert "hi cpp" in result.output


def test_sql_runs_correctly_under_the_sandbox():
    _skip_if_missing("sqlite3")
    result = cr.run("sql", "select 1+1 as result;")
    assert result.ok, result.output
    assert "result" in result.output


@_MACOS_ONLY
def test_sandboxed_code_cannot_reach_the_network():
    _skip_if_missing("python3")
    result = cr.run("python", """
import socket
s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
s.settimeout(3)
try:
    s.connect(("8.8.8.8", 53))
    print("NETWORK SUCCEEDED")
except Exception as e:
    print("blocked")
""")
    assert "NETWORK SUCCEEDED" not in result.output
    assert "blocked" in result.output


@_MACOS_ONLY
def test_sandboxed_code_cannot_write_outside_the_practice_dir():
    """Regression for the real bug found while building this: an earlier profile
    granted write access to all of /tmp and /var/folders (generalizing beyond what
    was actually tested), which silently let this exact scenario succeed instead
    of being denied. Deliberately NOT pytest's own tmp_path fixture -- that lives
    under the same per-session $TMPDIR the sandbox legitimately grants to
    javac/gcc for their own scratch files, so it would pass for the wrong reason
    (being inside an allowed path, not because confinement was actually tested).
    /tmp itself, the literal top-level path rather than the per-session
    subdirectory under it, is not on the allow list."""
    _skip_if_missing("python3")
    import os
    target = f"/tmp/mtdo_gh38_pytest_escape_{os.getpid()}.txt"
    if os.path.exists(target):
        os.remove(target)
    try:
        result = cr.run("python", f"""
try:
    open({target!r}, "w").write("x")
    print("WRITE SUCCEEDED")
except Exception as e:
    print("blocked")
""")
        assert "WRITE SUCCEEDED" not in result.output
        assert "blocked" in result.output
        assert not os.path.exists(target)
    finally:
        if os.path.exists(target):
            os.remove(target)


def test_cpu_resource_limit_kills_a_busy_loop_independent_of_wall_clock_timeout():
    """Regression for the second real bug found while building this: the CPU
    limit used to be derived from the caller's own wall-clock timeout
    (`timeout + 2`), which by construction can never fire before that timeout --
    dead code for every call, not just the default one. Uses a deliberately
    loosened 30s wall-clock timeout specifically so the fixed, timeout-
    independent CPU limit (_CPU_TIME_LIMIT_SECONDS, currently 15s) has to be
    the one that actually kills it, to prove it's a real independent backstop
    and not just coincidentally faster than a 10s default."""
    _skip_if_missing("python3")
    start = time.monotonic()
    result = cr.run("python", "x = 0\nwhile True: x += 1", timeout=30)
    elapsed = time.monotonic() - start
    assert not result.ok
    assert elapsed < 25, (
        f"expected the CPU rlimit backstop (~{cr._CPU_TIME_LIMIT_SECONDS}s) to kill this "
        f"well before the 30s wall clock, took {elapsed:.1f}s -- did it stop firing again?"
    )


def test_sandbox_status_never_overclaims():
    """sandbox_status()'s whole purpose is being shown to the user every run --
    it must report exactly one of its three honest states, never something
    invented, and must actually match reality on this machine."""
    status = cr.sandbox_status()
    if sys.platform == "darwin" and shutil.which("sandbox-exec"):
        assert status == "sandboxed: no network, writes confined to practice/"
    elif cr._resource is not None:
        assert "resource limits only" in status
    else:
        assert "unsandboxed" in status
