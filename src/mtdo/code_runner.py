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
import subprocess
import time

PRACTICE_DIR = os.path.expanduser("~/.mtdo/practice")

LANGUAGES = ["python", "java", "c", "cpp"]

LANGUAGE_LABELS = {
    "python": "Python", "java": "Java", "c": "C", "cpp": "C++",
}

# Textual's TextArea only ships built-in tree-sitter grammars for a fixed set of
# languages -- python and java are in it, c/cpp are not (registering a custom
# grammar needs a matching highlight-query file per language, real effort for a
# purely cosmetic feature). C/C++ still fully edit and run, just without syntax
# color. See TextArea.available_languages.
TEXTAREA_LANGUAGE = {
    "python": "python", "java": "java", "c": None, "cpp": None,
}

FILE_NAMES = {
    "python": "solution.py", "java": "Solution.java",
    "c": "solution.c", "cpp": "solution.cpp",
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
}


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
