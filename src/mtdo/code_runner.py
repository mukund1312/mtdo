"""Compiles/runs a code snippet for the Practice Lab (practice_lab_panel.PracticeLabPanel)
and captures its output plus how long it actually took to run. This automates exactly
the commands you'd otherwise type by hand: `python3 file.py`, `javac X.java && java X`,
`gcc -o a file.c && ./a`, `g++ ...` -- nothing new is invented, this just saves typing
them out every run.

Real, but partial, sandboxing (gh38 -- this used to just say "don't paste code here you
wouldn't otherwise just run" and leave it at that):

  - On macOS: every run is wrapped in sandbox-exec (Apple's built-in Seatbelt profile
    mechanism -- no extra install, no new dependency) with a deny-by-default profile
    that blocks ALL network access and confines writes to this practice directory (plus
    the OS's own ephemeral temp scratch space -- javac/gcc/the JVM all need to write
    there to function at all, confirmed by hand: a first attempt without it broke every
    compiled language). Verified empirically against python3, javac+java, gcc, g++, and
    sqlite3 on a real machine before shipping, not just written and assumed correct --
    including confirming a write outside the allowed dirs and a real network connection
    attempt both actually get denied, not just that the happy path still runs.
  - On every platform (including when sandbox-exec isn't available, e.g. Linux): POSIX
    resource limits cap CPU time and max file size (see _apply_resource_limits -- a
    process-count cap was tried and dropped, see that function's docstring for why) --
    a second, independent backstop against a runaway process or a write filling the
    disk, on top of the wall-clock timeout below.

What this deliberately does NOT claim: file READS aren't restricted (python3/javac/gcc
need broad read access to run at all), so code here could still read something like an
SSH key -- it just can't send it anywhere, since network is blocked and the process's
own output is all that leaves the sandbox. This is OS-level process isolation, not
container/VM-level isolation, and a sandbox-escape exploit targeting Seatbelt itself
specifically isn't defended against. sandbox_status() reports exactly what's active for
a given run (never more than what's actually true) -- shown directly in the Practice
Lab's output panel every run, not just documented here, so the real, current state of
protection is in front of whoever's using it. Given all of that: still don't paste code
here you wouldn't otherwise run, especially on a platform other than macOS.
"""
import functools
import os
import shutil
import subprocess
import sys
import tempfile
import time

from . import config as appconfig

try:
    import resource as _resource  # POSIX only -- None on Windows, guarded everywhere below
except ImportError:
    _resource = None

PRACTICE_DIR = os.path.join(appconfig.APP_DIR, "practice")
SAMPLE_DB_PATH = os.path.join(PRACTICE_DIR, "sample.db")

LANGUAGES = ["python", "java", "c", "cpp", "sql"]

LANGUAGE_LABELS = {
    "python": "Python", "java": "Java", "c": "C", "cpp": "C++", "sql": "SQL",
}

# Textual's TextArea only ships built-in tree-sitter grammars for a fixed set of
# languages -- python, java, and sql are in it, c/cpp are not (registering a custom
# grammar needs a matching highlight-query file per language, real effort for a
# purely cosmetic feature). C/C++ still fully edit and run, just without syntax
# color. See TextArea.available_languages.
TEXTAREA_LANGUAGE = {
    "python": "python", "java": "java", "c": None, "cpp": None, "sql": "sql",
}

FILE_NAMES = {
    "python": "solution.py", "java": "Solution.java",
    "c": "solution.c", "cpp": "solution.cpp", "sql": "query.sql",
}

TEMPLATES = {
    "python": "# Write your solution here\n\n\n",
    "java": (
        "public class Solution {\n"
        "    public static void main(String[] args) {\n"
        "        \n"
        "    }\n"
        "}\n"
    ),
    "c": "#include <stdio.h>\n\nint main() {\n    \n    return 0;\n}\n",
    "cpp": "#include <iostream>\nusing namespace std;\n\nint main() {\n    \n    return 0;\n}\n",
    "sql": "-- Write your query here (sample.db: departments, employees, orders)\n\n",
}

# A single self-contained sqlite3 file -- no server, no setup, works with the exact
# same "type SQL, see real output" loop as any other language here. Seeded with
# deliberate duplicates (equal salaries within a department, employees with zero
# orders, ...) so real interview-style questions ("2nd highest salary per
# department", "employees with no orders") are actually meaningful, not trivial on
# a table with no repeats.
_SAMPLE_SCHEMA_SQL = """
DROP TABLE IF EXISTS orders;
DROP TABLE IF EXISTS employees;
DROP TABLE IF EXISTS departments;

CREATE TABLE departments (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL
);

CREATE TABLE employees (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    department_id INTEGER NOT NULL REFERENCES departments(id),
    salary INTEGER NOT NULL,
    hire_date TEXT NOT NULL
);

CREATE TABLE orders (
    id INTEGER PRIMARY KEY,
    employee_id INTEGER NOT NULL REFERENCES employees(id),
    amount INTEGER NOT NULL,
    order_date TEXT NOT NULL
);

INSERT INTO departments (id, name) VALUES
    (1, 'Engineering'), (2, 'Sales'), (3, 'Marketing'), (4, 'Support');

INSERT INTO employees (id, name, department_id, salary, hire_date) VALUES
    (1, 'Alice Chen', 1, 145000, '2019-03-01'),
    (2, 'Bob Diaz', 1, 132000, '2020-06-15'),
    (3, 'Carla Nunez', 1, 132000, '2021-01-10'),
    (4, 'David Okafor', 1, 118000, '2022-08-01'),
    (5, 'Elena Popov', 2, 98000, '2018-11-20'),
    (6, 'Frank Silva', 2, 91000, '2020-02-14'),
    (7, 'Grace Kim', 2, 91000, '2021-09-05'),
    (8, 'Hana Suzuki', 3, 87000, '2019-07-22'),
    (9, 'Ivan Petrov', 3, 76000, '2022-03-18'),
    (10, 'Jasmine Lee', 4, 71000, '2021-12-01'),
    (11, 'Kevin Brooks', 4, 71000, '2020-10-10'),
    (12, 'Laila Haddad', 4, 65000, '2023-01-05'),
    (13, 'Marco Rossi', 1, 155000, '2017-05-30'),
    (14, 'Nadia Rahman', 2, 105000, '2019-09-09'),
    (15, 'Omar Farouk', 3, 82000, '2020-04-25');

INSERT INTO orders (id, employee_id, amount, order_date) VALUES
    (1, 5, 4200, '2024-01-05'), (2, 5, 3100, '2024-02-11'), (3, 6, 5600, '2024-01-20'),
    (4, 7, 2200, '2024-03-02'), (5, 7, 1800, '2024-03-15'), (6, 14, 9100, '2024-01-30'),
    (7, 14, 4300, '2024-02-22'), (8, 5, 2750, '2024-04-01'), (9, 6, 6100, '2024-04-10'),
    (10, 8, 1200, '2024-01-18'), (11, 9, 900, '2024-02-05'), (12, 15, 3300, '2024-03-11'),
    (13, 10, 1500, '2024-01-25'), (14, 10, 2100, '2024-03-28'), (15, 11, 1750, '2024-02-14'),
    (16, 5, 5200, '2024-05-02'), (17, 6, 3300, '2024-05-14'), (18, 7, 2900, '2024-05-20'),
    (19, 14, 6700, '2024-04-19'), (20, 8, 2100, '2024-05-06');
"""


def ensure_sample_db():
    """Creates+seeds the sample SQLite practice database once, on first use. Safe to
    call every run: only (re)builds the file if it doesn't already exist, so any
    hand-run changes made during practice (INSERT/UPDATE/CREATE TABLE, ...) aren't
    silently clobbered on the next query."""
    if os.path.exists(SAMPLE_DB_PATH):
        return
    os.makedirs(PRACTICE_DIR, exist_ok=True)
    subprocess.run(["sqlite3", SAMPLE_DB_PATH], input=_SAMPLE_SCHEMA_SQL, text=True, capture_output=True)


class RunResult:
    def __init__(self, output, elapsed, ok):
        self.output = output
        self.elapsed = elapsed
        self.ok = ok


def _sandbox_available():
    return sys.platform == "darwin" and shutil.which("sandbox-exec") is not None


@functools.lru_cache(maxsize=1)
def _sandbox_profile():
    """A deny-by-default Seatbelt profile: process fork/exec and file reads stay
    open (interpreters/compilers need broad read access to run at all), but
    writes are confined to this practice directory plus this process's own
    session temp directory (both resolved via os.path.realpath -- Seatbelt
    matches the post-symlink-resolution path, and /tmp and the temp dir macOS
    hands out under /var/folders are themselves symlinks into /private) -- the
    temp-dir grant isn't optional, javac/gcc/g++ all need to write their own
    scratch files under $TMPDIR to function at all, confirmed by hand.

    Deliberately NOT a blanket grant on bare /tmp or /var/folders: an earlier
    version of this profile allowed those whole trees, which happened to also
    still let a test write completely unconfined to /tmp -- i.e. it silently
    defeated the actual write-confinement guarantee this function exists to
    provide. Caught by testing the deny path, not just the allow path (writing
    a file it should refuse, not just confirming a legitimate compile still
    works) -- resolving PRACTICE_DIR/tempfile.gettempdir() to their own real,
    specific paths is what keeps the grant no broader than actually needed."""
    tmp = os.path.realpath(tempfile.gettempdir())
    practice = os.path.realpath(PRACTICE_DIR)
    write_paths = sorted({practice, tmp})
    allow_writes = "\n".join(f'(allow file-write* (subpath "{p}"))' for p in write_paths)
    return f"""(version 1)
(deny default)
(allow process-fork)
(allow process-exec)
(allow file-read*)
{allow_writes}
(allow signal (target self))
(allow sysctl-read)
(allow mach-lookup)
(allow iokit-open)
(allow file-ioctl)
"""


def _sandboxed_argv(argv):
    if not _sandbox_available():
        return argv
    return ["sandbox-exec", "-p", _sandbox_profile()] + argv


# Fixed, not derived from whatever wall-clock timeout a given run() call happens to
# use -- an earlier version computed this as `timeout + 2`, which sounds like a
# reasonable backstop but actually can never fire before the wall-clock timeout by
# construction (it's always looser), making it dead code for any timeout value,
# not just the default. Caught by testing with a deliberately loosened wall-clock
# timeout (30s) specifically to give the CPU limit room to be the one that fires --
# the original design silently never did, running the full 30s instead of being
# independently killed. A fixed value actually acts as an independent backstop
# regardless of what timeout a caller passes.
_CPU_TIME_LIMIT_SECONDS = 15


def _apply_resource_limits():
    """Returns a preexec_fn for subprocess.run -- runs in the freshly-forked child,
    before exec, so these limits apply to the code being run, not to mtdo itself.

    Best-effort on RLIMIT_AS specifically: confirmed by hand that macOS silently
    refuses to lower it from its default of unlimited ("current limit exceeds
    maximum limit", even setting soft and hard to the same value) -- a known
    Darwin/XNU quirk, not a bug in this code, so that one failing is expected
    there and deliberately not treated as fatal.

    RLIMIT_NPROC was tried twice and dropped: first at 100, which broke gcc/g++/
    javac outright on an ordinary dev Mac already running ~400 processes for
    that user across everything else open (it's a per-real-UID limit, not
    scoped to this subprocess's own tree, so a naive small cap collides with
    unrelated background load). Raised to 1000 to fix that -- which then broke
    javac/java a second time, differently, in CI: on Linux, RLIMIT_NPROC also
    counts THREADS (NPTL implements each thread as its own kernel task), and a
    JVM's own internal startup -- GC refinement threads, service threads, JIT
    compiler threads -- can consume a meaningful chunk of whatever number is
    picked, on top of however many "processes" the count already carries from
    outside factors this code has no way to see (a CI container's baseline
    differs from a laptop's). There's no single absolute number confirmed safe
    across both failure modes, so this limit is dropped rather than shipped
    with a third guess. Fork-bomb impact is still bounded by RLIMIT_CPU (every
    descendant process shares the same real CPU budget) and the wall-clock
    subprocess timeout above it, just not as immediately as a hard process cap
    would have been.

    RLIMIT_CPU/FSIZE both set successfully and confirmed to actually do
    something (a CPU-bound busy loop was reliably SIGXCPU-killed around the
    configured limit in testing, independent of the wall-clock timeout -- see
    _CPU_TIME_LIMIT_SECONDS above): CPU time as a second, harder backstop
    alongside the wall-clock subprocess timeout, covering the case a hang isn't
    CPU-bound at all (e.g. blocked on I/O, where only the wall-clock timeout
    would ever catch it) as well as the reverse; a generous file-size cap
    against filling the disk."""
    def limits():
        if _resource is None:
            return
        for rl, value in (
            (_resource.RLIMIT_CPU, _CPU_TIME_LIMIT_SECONDS),
            (_resource.RLIMIT_FSIZE, 50_000_000),
            (_resource.RLIMIT_AS, 1_500_000_000),
        ):
            try:
                _resource.setrlimit(rl, (value, value))
            except (ValueError, OSError):
                pass
    return limits


def _exec_kwargs():
    return {"preexec_fn": _apply_resource_limits()} if _resource is not None else {}


def sandbox_status():
    """A short, honest, first-person-plural-free description of exactly what
    protection is actually active for a run on this machine -- shown directly in
    the Practice Lab's output panel (gh38) so the disclosure is in front of
    whoever's using it every time, not just documented in this module. Never
    reports more than what's actually true above."""
    if _sandbox_available():
        return "sandboxed: no network, writes confined to practice/"
    if _resource is not None:
        return "resource limits only (CPU/file-size) -- no filesystem/network isolation on this platform"
    return "unsandboxed -- no isolation available on this platform"


@functools.lru_cache(maxsize=1)
def _java_home():
    """Resolves JAVA_HOME once via /usr/libexec/java_home, run unsandboxed --
    confirmed by hand that java_home itself fails ("Unable to locate a Java
    Runtime") when invoked from inside the Seatbelt profile above, even with
    every write path it could plausibly need already allowed; whatever specific
    system lookup it does isn't covered by this profile's grants and wasn't
    worth chasing further once the actual workaround was confirmed: resolve it
    once, outside the sandbox, and invoke javac/java by their real binary path
    afterward, which sidesteps java_home's own lookup entirely. None if
    unavailable (not macOS, or java_home itself fails) -- callers fall back to
    the plain "javac"/"java" names on PATH, which is correct there anyway."""
    if sys.platform != "darwin":
        return None
    try:
        result = subprocess.run(["/usr/libexec/java_home"], capture_output=True, text=True, timeout=5)
    except (OSError, subprocess.TimeoutExpired):
        return None
    return result.stdout.strip() if result.returncode == 0 else None


def run(language, code, timeout=10):
    """Writes `code` to the right file for `language` in PRACTICE_DIR, compiles it
    if needed, runs it, and returns a RunResult. `elapsed` is the real run's
    wall-clock time (compile time isn't counted) -- an actual measurement, unlike
    Big-O complexity, which is why that's a separate, AI-estimated field (see
    ai_ask.py) rather than something this module claims to compute."""
    os.makedirs(PRACTICE_DIR, exist_ok=True)
    path = os.path.join(PRACTICE_DIR, FILE_NAMES[language])
    with open(path, "w") as f:
        f.write(code)

    try:
        if language == "python":
            start = time.monotonic()
            result = _exec(["python3", path], timeout)
            elapsed = time.monotonic() - start
        elif language == "java":
            java_home = _java_home()
            javac_bin = os.path.join(java_home, "bin", "javac") if java_home else "javac"
            java_bin = os.path.join(java_home, "bin", "java") if java_home else "java"
            classname = FILE_NAMES[language][: -len(".java")]
            compiled = _exec([javac_bin, path], timeout)
            if not compiled.ok:
                return RunResult(compiled.output, 0.0, False)
            start = time.monotonic()
            result = _exec([java_bin, "-cp", PRACTICE_DIR, classname], timeout)
            elapsed = time.monotonic() - start
        elif language in ("c", "cpp"):
            compiler = "gcc" if language == "c" else "g++"
            binary = os.path.join(PRACTICE_DIR, f"solution_{language}_bin")
            compiled = _exec([compiler, "-o", binary, path], timeout)
            if not compiled.ok:
                return RunResult(compiled.output, 0.0, False)
            start = time.monotonic()
            result = _exec([binary], timeout)
            elapsed = time.monotonic() - start
        elif language == "sql":
            if shutil.which("sqlite3") is None:
                return RunResult(
                    "sqlite3 isn't installed -- `brew install sqlite3` (Mac) or "
                    "`apt install sqlite3` (Linux), then try again.",
                    0.0, False,
                )
            ensure_sample_db()
            start = time.monotonic()
            result = _exec_sql(code, timeout)
            elapsed = time.monotonic() - start
        else:
            return RunResult(f"Unknown language: {language}", 0.0, False)
    except subprocess.TimeoutExpired:
        return RunResult(f"Timed out after {timeout}s -- infinite loop?", float(timeout), False)

    return RunResult(result.output, elapsed, result.ok)


def _exec(argv, timeout):
    proc = subprocess.run(
        _sandboxed_argv(argv), capture_output=True, text=True, cwd=PRACTICE_DIR,
        timeout=timeout, **_exec_kwargs(),
    )
    output = proc.stdout
    if proc.stderr:
        output += ("\n" if output else "") + proc.stderr
    return RunResult(output, 0.0, proc.returncode == 0)


def _exec_sql(query, timeout):
    """Pipes `query` straight into a real sqlite3 process against the sample
    database (-header -column for readable tabular output, exactly what typing it
    into the sqlite3 prompt by hand would show) -- no query parsing or validation of
    our own, sqlite3 IS the engine here."""
    proc = subprocess.run(
        _sandboxed_argv(["sqlite3", "-header", "-column", SAMPLE_DB_PATH]),
        input=query, capture_output=True, text=True, timeout=timeout, **_exec_kwargs(),
    )
    output = proc.stdout
    if proc.stderr:
        output += ("\n" if output else "") + proc.stderr
    return RunResult(output, 0.0, proc.returncode == 0)


def explain_sql(query, timeout=10):
    """Runs the query's REAL `EXPLAIN QUERY PLAN` and a real COUNT(*) of its result
    rows -- actual sqlite3 output, not an AI guess -- used by the Practice Lab's
    Ctrl+B for the sql language in place of code_runner via ai_ask's Big-O estimate
    (which doesn't mean much for a query the way it does for an algorithm; a real
    execution plan is the actual interview-relevant equivalent, see
    coaching.TOPIC_FRAMEWORKS's "database" bucket: "What is the execution plan?").
    Returns (plan_text, row_count_text, ok)."""
    if shutil.which("sqlite3") is None:
        msg = "sqlite3 isn't installed."
        return msg, msg, False
    ensure_sample_db()
    try:
        plan_proc = subprocess.run(
            _sandboxed_argv(["sqlite3", "-header", "-column", SAMPLE_DB_PATH]),
            input=f"EXPLAIN QUERY PLAN\n{query}", capture_output=True, text=True,
            timeout=timeout, **_exec_kwargs(),
        )
        count_proc = subprocess.run(
            _sandboxed_argv(["sqlite3", SAMPLE_DB_PATH]),
            input=f"SELECT COUNT(*) FROM ({query.rstrip().rstrip(';')});",
            capture_output=True, text=True, timeout=timeout, **_exec_kwargs(),
        )
    except subprocess.TimeoutExpired:
        msg = f"Timed out after {timeout}s."
        return msg, msg, False

    plan = (plan_proc.stdout or "").strip()
    if plan_proc.stderr:
        plan = (plan + "\n" if plan else "") + plan_proc.stderr.strip()
    row_count = (count_proc.stdout or "").strip() if count_proc.returncode == 0 else (
        (count_proc.stderr or "couldn't count rows -- query may not be a single SELECT").strip()
    )
    return (plan or "(no plan output)"), (row_count or "0"), plan_proc.returncode == 0
