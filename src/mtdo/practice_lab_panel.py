"""The "LeetCode-style" practice lab, embedded as the optional third column in Focus
Mode's second row (alongside the Learning Coach and the AI panel -- see app.py's
#coach-claude-row), shown only if the user has turned it on with Shift+T
(config.practice_terminal_enabled() / TodoApp.action_toggle_practice_terminal).

Used to be two separate things: Shift+L opened this as its own full screen, and
Shift+T opened a plain pty shell cd'd into ~/.mtdo/practice/ (practice_terminal.py,
now retired). Folded into one so there's a single, more capable "practice" surface
instead of two -- everything Shift+L used to do now lives right here in the row.

A language tag/picker, a real code editor (Textual's TextArea -- syntax-highlighted
for Python/Java, which are the only two of the four with a built-in tree-sitter
grammar shipped with Textual; C/C++ still fully edit and run, just without color, see
code_runner.TEXTAREA_LANGUAGE), an output section formatted like a real terminal
session (a "$ <command>" prompt line, the program's actual output, then a dim
exit-status line), and separate Time Complexity / Space Complexity sections each
showing an AI's Big-O estimate plus a one-line explanation. Output and complexity are
kept visibly separate on purpose: run time is a real measurement, complexity is an
AI's estimate, and blending them would make an estimate look like a fact -- and
time/space get their own sections rather than one shared block so each explanation
stays legible on its own.

Laid out to maximize code visibility over UI chrome: a single-row toolbar (language
buttons + inline filename + copy/reset/run) pinned to the top, a single-line shortcut
footer pinned to the bottom, and everything in between -- editor, output, time/space
complexity -- inside ONE scrollable region with ONE scrollbar, instead of a separate
bounded scroll box per section. The editor gets a fixed height (~18 rows, enough to
see a real solution without scrolling) and is first in that scroll region, so it's
what's in view by default; output and complexity sit right below it and only need
scrolling into view on a short terminal. Flat Static text instead of bordered boxes
("no cards"), near-black background (#050505), thin dark-grey Rule dividers, a single
bright accent green (#00ff66) reserved for the active language/prompt/Big-O values.
Time/Space Complexity are each a two-line block -- a dim caption then one line with
the Big-O value and its explanation together -- not a heading-plus-paragraph card.

Just a normal Textual widget, not a pty-backed one (contrast with the AI panel/old
practice terminal): there's no subprocess to start or stop, so hiding it (display =
False when Shift+T is off, or leaving Focus Mode) is the entire lifecycle -- the
editor's contents and last run/analysis results are simply still there, in this same
mounted widget, whenever it's shown again."""
import threading

from rich.console import Group
from rich.text import Text
from textual.app import ComposeResult
from textual.containers import Horizontal, Vertical, VerticalScroll
from textual.widgets import Static, TextArea, Button, Rule

from . import ai_ask
from . import coaching
from . import code_runner
from .errorlog import LOG_PATH, log as app_log

_RUN_COMMAND_LABEL = {
    "python": "python3 solution.py", "java": "java Solution",
    "c": "./solution", "cpp": "./solution", "sql": "sqlite3 sample.db",
}

_LANG_SHORT_LABEL = {"python": "Py", "java": "Java", "c": "C", "cpp": "C++", "sql": "SQL"}


def _parse_complexity_response(text):
    """Splits the AI's answer into (time_text, space_text) using the ===TIME===/
    ===SPACE=== markers requested in PracticeLabPanel._analyze_worker's prompt. Falls
    back to showing the whole answer in the Time section (and a pointer in Space) if a
    differently-formatted response comes back -- still worth showing, not discarding."""
    if "===SPACE===" in text:
        time_part, space_part = text.split("===SPACE===", 1)
        return time_part.replace("===TIME===", "").strip(), space_part.strip()
    return text.strip(), "(see Time Complexity -- response wasn't split into sections)"


def _split_bigo(raw):
    """Splits one "Big-O: O(...)\\n<justification>" section (see the prompt in
    PracticeLabPanel._analyze_worker) into (bigo, explanation), matching the terminal
    mockup's "O(n)" heading + "Explanation:" body layout. Falls back to showing the
    raw text as the explanation if the AI didn't use the requested "Big-O:" prefix."""
    lines = raw.strip().splitlines()
    if lines and lines[0].lower().startswith("big-o:"):
        bigo = lines[0].split(":", 1)[1].strip()
        explanation = "\n".join(lines[1:]).strip()
        return bigo, explanation
    return "?", raw.strip()


class _EditorTextArea(TextArea):
    """TextArea subclass so Ctrl+A triggers "send this code to the AI panel for a
    review" (PracticeLabPanel.action_evaluate_code) instead of TextArea's own
    built-in cursor-line-start binding. A focused TextArea's own BINDINGS always win
    over an ancestor widget's BINDINGS for the same key (confirmed by hand earlier --
    see the Ctrl+B/Big-O history), so simply adding ctrl+a to PracticeLabPanel's own
    BINDINGS would never be reached while the editor has focus. Intercepting inside
    TextArea's own _on_key, before its normal insert/binding handling runs, is what
    actually works."""

    def __init__(self, *args, on_evaluate=None, **kwargs):
        super().__init__(*args, **kwargs)
        self._on_evaluate = on_evaluate

    async def _on_key(self, event) -> None:
        if event.key == "ctrl+a" and self._on_evaluate:
            event.stop()
            event.prevent_default()
            self._on_evaluate()
            return
        await super()._on_key(event)


class PracticeLabPanel(Vertical):
    """Embeddable version of the practice lab -- see module docstring."""

    can_focus = False

    BINDINGS = [
        ("ctrl+r", "run_code", "Run"),
        ("ctrl+b", "analyze_complexity", "Analyze Complexity"),  # "B" for Big-O
        ("ctrl+n", "reset_code", "Reset"),
        ("ctrl+a", "evaluate_code", "Evaluate Code"),  # actually caught by _EditorTextArea._on_key while the editor has focus -- see that class's docstring
    ]

    DEFAULT_CSS = """
    PracticeLabPanel { border: round #1e1e1e; background: #050505; layout: vertical; }
    PracticeLabPanel:focus-within { border: round #00ff66; }
    #practice-topbar { height: 1; dock: top; padding: 0 1; align: left middle; background: #050505; }
    #practice-topbar Button {
        min-width: 4; height: 1; margin: 0 1 0 0; background: #050505; color: #8a8a8a; border: none;
    }
    #practice-topbar Button.-active-lang { color: #00ff66; text-style: bold; }
    #practice-filename { width: auto; padding: 0 1; color: #5a5a5a; }
    #practice-topbar-spacer { width: 1fr; }
    .practice-icon-btn { min-width: 6; color: #8a8a8a; }
    #practice-run-btn { min-width: 6; color: #00ff66; text-style: bold; }
    PracticeLabPanel Rule { color: #1e1e1e; margin: 0; }
    #practice-scroll { height: 1fr; scrollbar-size-vertical: 1; }
    #practice-editor { height: 18; background: #050505; }
    #practice-output, #practice-time, #practice-space { height: auto; padding: 0 1; }
    #practice-help { height: 1; dock: bottom; padding: 0 1; background: #050505; color: #4a4a4a; }
    """

    _LANG_BUTTON_IDS = {
        "python": "lab-lang-python", "java": "lab-lang-java", "c": "lab-lang-c",
        "cpp": "lab-lang-cpp", "sql": "lab-lang-sql",
    }

    def __init__(self, **kwargs):
        super().__init__(**kwargs)
        self.language = "python"
        self.code_by_language = dict(code_runner.TEMPLATES)
        self.border_title = "Practice Lab"

    def compose(self) -> ComposeResult:
        with Horizontal(id="practice-topbar"):
            for lang in code_runner.LANGUAGES:
                yield Button(
                    _LANG_SHORT_LABEL[lang],
                    id=self._LANG_BUTTON_IDS[lang],
                    classes="-active-lang" if lang == self.language else "",
                )
            self.filename_label = Static(code_runner.FILE_NAMES[self.language], id="practice-filename")
            yield self.filename_label
            yield Static("", id="practice-topbar-spacer")
            yield Button("Copy", id="practice-copy-btn", classes="practice-icon-btn")
            yield Button("Reset", id="practice-reset-btn", classes="practice-icon-btn")
            yield Button("Run 🚀", id="practice-run-btn")
        with VerticalScroll(id="practice-scroll"):
            self.editor = _EditorTextArea(
                self.code_by_language[self.language],
                language=code_runner.TEXTAREA_LANGUAGE[self.language],
                show_line_numbers=True,
                id="practice-editor",
                on_evaluate=self.action_evaluate_code,
            )
            yield self.editor
            yield Rule()
            self.output_panel = Static(self._idle_output(), id="practice-output")
            yield self.output_panel
            yield Rule()
            self.time_panel = Static(self._idle_complexity("TIME COMPLEXITY"), id="practice-time")
            yield self.time_panel
            self.space_panel = Static(self._idle_complexity("SPACE COMPLEXITY"), id="practice-space")
            yield self.space_panel
        yield Static("^R run  ·  ^B complexity  ·  ^A evaluate  ·  ^N reset", id="practice-help", classes="dim")

    def action_reset_code(self):
        self.code_by_language[self.language] = code_runner.TEMPLATES[self.language]
        self.editor.text = self.code_by_language[self.language]
        self.editor.focus()

    def action_copy_code(self):
        self.app.copy_to_clipboard(self.editor.text)
        self.app.toast("Copied to clipboard (OSC 52 -- needs a terminal that supports it).", style="dim cyan")

    def action_evaluate_code(self):
        """Ctrl+A: sends the current code to the AI panel sitting right next to this
        one for a Socratic review -- not a verdict, not a fix, just where the
        student's current approach is likely going wrong and a nudge toward thinking
        it through themselves (see coaching.build_code_review_message). This is a
        live chat message into the running AI session, not a one-shot ai_ask.ask()
        call like Ctrl+B's complexity estimate -- the point is a back-and-forth
        conversation the student can keep going, in the same panel already primed
        with the tutor framework and this task's context (see
        app.TodoApp._prime_ai_context_if_needed)."""
        code = self.editor.text
        if not code.strip():
            self.app.toast("Write some code first.", style="dim italic")
            return
        if not self.app.claude_panel.is_running:
            self.app.toast(
                "Start the AI panel first (press C), then Ctrl+A to have it review your code.",
                style="bold yellow",
            )
            return
        self.app._prime_ai_context_if_needed()  # safety net if it somehow hasn't been primed yet
        language_label = code_runner.LANGUAGE_LABELS[self.language]
        message = coaching.build_code_review_message(language_label, code)
        self.app.claude_panel.send_text_when_idle(message, flatten=False)
        self.app.claude_panel.focus()
        self.app.toast("Sent your code to the AI panel -- it'll point you in a direction, not hand you the answer.",
                        style="bold cyan")

    # -- language picker -------------------------------------------------

    def on_button_pressed(self, event: Button.Pressed) -> None:
        bid = event.button.id
        if bid == "practice-copy-btn":
            self.action_copy_code()
            return
        if bid == "practice-reset-btn":
            self.action_reset_code()
            return
        if bid == "practice-run-btn":
            self.action_run_code()
            return
        for lang, btn_id in self._LANG_BUTTON_IDS.items():
            if bid == btn_id:
                self._switch_language(lang)
                return

    def _switch_language(self, lang):
        if lang == self.language:
            self.editor.focus()
            return
        self.code_by_language[self.language] = self.editor.text
        self.language = lang
        self.editor.language = code_runner.TEXTAREA_LANGUAGE[lang]
        self.editor.text = self.code_by_language[lang]
        self.filename_label.update(code_runner.FILE_NAMES[lang])
        for l, btn_id in self._LANG_BUTTON_IDS.items():
            self.query_one(f"#{btn_id}", Button).set_class(l == lang, "-active-lang")
        self.output_panel.update(self._idle_output())
        cap1, cap2 = self._complexity_captions()
        self.time_panel.update(self._idle_complexity(cap1))
        self.space_panel.update(self._idle_complexity(cap2))
        self.editor.focus()

    # -- run ---------------------------------------------------------------

    def _idle_output(self):
        return Group(
            Text("OUTPUT", style="bold #6a6a6a"),
            Text("$ " + _RUN_COMMAND_LABEL[self.language], style="bold #00ff66"),
            Text(f"[{code_runner.sandbox_status()}]", style="dim"),
        )

    def action_run_code(self):
        code = self.editor.text
        language = self.language
        self.output_panel.update(Group(
            Text("OUTPUT", style="bold #6a6a6a"),
            Text(f"$ {_RUN_COMMAND_LABEL[language]}", style="bold #00ff66"),
            Text(f"[{code_runner.sandbox_status()}]", style="dim"),
            Text("running...", style="dim italic"),
        ))
        threading.Thread(target=self._run_code_worker, args=(language, code), daemon=True).start()

    def _run_code_worker(self, language, code):
        try:
            result = code_runner.run(language, code)
        except Exception as e:
            app_log.exception("PracticeLabPanel run failed")
            self.app.call_from_thread(self._show_run_error, str(e))
            return
        self.app.call_from_thread(self._show_run_result, language, result)

    def _show_run_result(self, language, result):
        status_color = "#00ff66" if result.ok else "#e06c75"
        self.output_panel.update(Group(
            Text("OUTPUT", style="bold #6a6a6a"),
            Text(f"$ {_RUN_COMMAND_LABEL[language]}", style="bold #00ff66"),
            Text(f"[{code_runner.sandbox_status()}]", style="dim"),
            Text(result.output or "(no output)"),
            Text(f"[exit {'0' if result.ok else '1'} in {result.elapsed:.3f}s]", style=f"dim {status_color}"),
        ))

    def _show_run_error(self, message):
        self.output_panel.update(Group(
            Text("OUTPUT", style="bold #6a6a6a"),
            Text(f"Couldn't run that -- see {LOG_PATH}\n{message}", style="bold #e06c75"),
        ))

    # -- complexity / query plan ----------------------------------------------

    def _complexity_captions(self):
        """SQL doesn't have a meaningful Big-O the way an algorithm does -- for it,
        Ctrl+B swaps the AI's time/space estimate for a REAL sqlite3 EXPLAIN QUERY
        PLAN + row count instead (see code_runner.explain_sql), so these two slots
        get relabeled to match whichever is actually showing."""
        return ("QUERY PLAN", "ROW COUNT") if self.language == "sql" else ("TIME COMPLEXITY", "SPACE COMPLEXITY")

    def _complexity_message(self, caption, text, style="dim italic"):
        return Group(Text(caption, style="bold #6a6a6a"), Text(text, style=style))

    def _idle_complexity(self, caption):
        hint = "Ctrl+B for the real EXPLAIN QUERY PLAN + row count." if self.language == "sql" \
            else "Ctrl+B to ask the AI for an estimate."
        return self._complexity_message(caption, hint)

    def _complexity_body(self, caption, raw):
        bigo, explanation = _split_bigo(raw)
        line = Text()
        line.append(bigo, style="bold #00ff66")
        line.append("  •  ", style="dim")
        line.append(explanation or "(no explanation given)")
        return Group(Text(caption, style="bold #6a6a6a"), line)

    def action_analyze_complexity(self):
        code = self.editor.text
        cap1, cap2 = self._complexity_captions()
        if not code.strip():
            empty_msg = "Write a query first." if self.language == "sql" else "Write some code first."
            self.time_panel.update(self._complexity_message(cap1, empty_msg))
            self.space_panel.update(self._complexity_message(cap2, empty_msg))
            return
        if self.language == "sql":
            self.time_panel.update(self._complexity_message(cap1, "Running EXPLAIN QUERY PLAN..."))
            self.space_panel.update(self._complexity_message(cap2, "Counting rows..."))
            threading.Thread(target=self._explain_sql_worker, args=(code,), daemon=True).start()
            return
        language_label = code_runner.LANGUAGE_LABELS[self.language]
        self.time_panel.update(self._complexity_message(cap1, "Analyzing..."))
        self.space_panel.update(self._complexity_message(cap2, "Analyzing..."))
        threading.Thread(target=self._analyze_worker, args=(language_label, code), daemon=True).start()

    def _analyze_worker(self, language_label, code):
        prompt = (
            f"Analyze the time and space complexity of this {language_label} code.\n\n"
            "Format exactly like this, with these two section markers on their own lines "
            "and nothing else outside them (no preamble, no code review):\n\n"
            "===TIME===\n"
            "Big-O: O(...)\n"
            "<one-sentence justification>\n\n"
            "===SPACE===\n"
            "Big-O: O(...)\n"
            "<one-sentence justification>\n\n" + code
        )
        try:
            answer, error = ai_ask.ask(prompt)
        except Exception as e:
            app_log.exception("PracticeLabPanel complexity analysis failed")
            answer, error = None, str(e)
        self.app.call_from_thread(self._show_complexity_result, answer, error)

    def _show_complexity_result(self, answer, error):
        if error and not answer:
            self.time_panel.update(self._complexity_message("TIME COMPLEXITY", error, style="bold #e06c75"))
            self.space_panel.update(self._complexity_message("SPACE COMPLEXITY", error, style="bold #e06c75"))
            return
        time_text, space_text = _parse_complexity_response(answer or "")
        self.time_panel.update(self._complexity_body("TIME COMPLEXITY", time_text))
        self.space_panel.update(self._complexity_body("SPACE COMPLEXITY", space_text))

    def _explain_sql_worker(self, code):
        try:
            plan, row_count, ok = code_runner.explain_sql(code)
        except Exception as e:
            app_log.exception("PracticeLabPanel SQL explain failed")
            plan, row_count, ok = str(e), str(e), False
        self.app.call_from_thread(self._show_sql_explain_result, plan, row_count, ok)

    def _show_sql_explain_result(self, plan, row_count, ok):
        if not ok:
            self.time_panel.update(self._complexity_message("QUERY PLAN", plan, style="bold #e06c75"))
            self.space_panel.update(self._complexity_message("ROW COUNT", row_count, style="bold #e06c75"))
            return
        self.time_panel.update(Group(Text("QUERY PLAN", style="bold #6a6a6a"), Text(plan)))
        self.space_panel.update(Group(
            Text("ROW COUNT", style="bold #6a6a6a"),
            Text(row_count, style="bold #00ff66"),
        ))
