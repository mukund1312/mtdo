"""Compiles/runs a code snippet for the Practice Lab (practice_lab_panel.PracticeLabPanel)
and captures its output plus how long it actually took to run. This automates exactly
the commands you'd otherwise type by hand: `python3 file.py`, `javac X.java && java X`,
`gcc -o a file.c && ./a`, `g++ ...` -- nothing new is invented, this just saves typing
them out every run.

Not a sandbox: this runs with the same permissions as mtdo itself, same as typing the
commands directly into a shell would. A hard wall-clock timeout guards against an
infinite loop hanging the run, which is common enough in DSA practice to be worth
guarding against specifically, but this is not a security boundary against genuinely
malicious code -- don't paste code here you wouldn't otherwise just run.
"""
import os
import shutil
import subprocess
import time

PRACTICE_DIR = os.path.expanduser("~/.mtdo/practice")
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
            classname = FILE_NAMES[language][: -len(".java")]
            compiled = _exec(["javac", path], timeout)
            if not compiled.ok:
                return RunResult(compiled.output, 0.0, False)
            start = time.monotonic()
            result = _exec(["java", "-cp", PRACTICE_DIR, classname], timeout)
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
    proc = subprocess.run(argv, capture_output=True, text=True, cwd=PRACTICE_DIR, timeout=timeout)
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
        ["sqlite3", "-header", "-column", SAMPLE_DB_PATH],
        input=query, capture_output=True, text=True, timeout=timeout,
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
            ["sqlite3", "-header", "-column", SAMPLE_DB_PATH],
            input=f"EXPLAIN QUERY PLAN\n{query}", capture_output=True, text=True, timeout=timeout,
        )
        count_proc = subprocess.run(
            ["sqlite3", SAMPLE_DB_PATH],
            input=f"SELECT COUNT(*) FROM ({query.rstrip().rstrip(';')});",
            capture_output=True, text=True, timeout=timeout,
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
