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

Laid out as a single top-to-bottom stack -- TOP BAR / TABS / EDITOR / OUTPUT / TIME
COMPLEXITY / SPACE COMPLEXITY, each full width and separated by a Rule -- rather than
an editor-plus-sidebar split, to read like a real terminal session scrolling downward.
Flat Static text instead of bordered boxes throughout ("no cards"), near-black
background, thin grey Rule dividers standing in for "clean ASCII separators", minimal
button chrome. Unlike the old full-screen version this now shares roughly a third of
the terminal's width with its row siblings, so button labels stay short (language
buttons show 2-4 characters, not full names) and every section keeps its own bounded
scroll area instead of assuming a wide layout.

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
from . import code_runner
from .errorlog import LOG_PATH, log as app_log

_RUN_COMMAND_LABEL = {
    "python": "python3 solution.py", "java": "java Solution",
    "c": "./solution", "cpp": "./solution",
}

_LANG_SHORT_LABEL = {"python": "Py", "java": "Java", "c": "C", "cpp": "C++"}


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


class PracticeLabPanel(Vertical):
    """Embeddable version of the practice lab -- see module docstring."""

    can_focus = False

    BINDINGS = [
        ("ctrl+r", "run_code", "Run"),
        ("ctrl+b", "analyze_complexity", "Analyze Complexity"),  # "B" for Big-O -- ctrl+a is TextArea's own select-all binding and never reaches here while the editor has focus
        ("ctrl+n", "reset_code", "Reset"),
    ]

    DEFAULT_CSS = """
    PracticeLabPanel { border: round grey; background: #0b0b0b; }
    PracticeLabPanel:focus-within { border: round green; }
    #practice-topbar { height: 1; padding: 0 1; align: left middle; background: #0b0b0b; }
    #practice-lang-tag { width: auto; padding: 0 1 0 0; color: #39c26d; text-style: bold; }
    #practice-topbar Button {
        min-width: 4; height: 1; margin: 0 1 0 0; background: #0b0b0b; color: #6a6a6a; border: none;
    }
    #practice-topbar Button.-active-lang { color: #39c26d; text-style: bold; }
    #practice-topbar-spacer { width: 1fr; }
    .practice-icon-btn { min-width: 3; color: #8a8a8a; }
    #practice-run-btn { min-width: 5; color: #39c26d; text-style: bold; }
    #practice-tabs { height: 1; padding: 0 1; background: #0b0b0b; }
    #practice-tab-chip { color: #d0d0d0; }
    PracticeLabPanel Rule { color: #262626; }
    #practice-editor { height: 1fr; background: #0b0b0b; }
    .practice-section-heading { height: 1; padding: 0 1; color: #6a6a6a; text-style: bold; }
    .practice-section-scroll { height: auto; max-height: 5; padding: 0 1 1 1; }
    #practice-help { height: 1; padding: 0 1; background: #0b0b0b; color: #4a4a4a; }
    """

    _LANG_BUTTON_IDS = {"python": "lab-lang-python", "java": "lab-lang-java", "c": "lab-lang-c", "cpp": "lab-lang-cpp"}

    def __init__(self, **kwargs):
        super().__init__(**kwargs)
        self.language = "python"
        self.code_by_language = dict(code_runner.TEMPLATES)
        self.border_title = "Practice Lab"

    def compose(self) -> ComposeResult:
        with Horizontal(id="practice-topbar"):
            self.lang_tag = Static(f"[{code_runner.LANGUAGE_LABELS[self.language]}]", id="practice-lang-tag")
            yield self.lang_tag
            for lang in code_runner.LANGUAGES:
                yield Button(
                    _LANG_SHORT_LABEL[lang],
                    id=self._LANG_BUTTON_IDS[lang],
                    classes="-active-lang" if lang == self.language else "",
                )
            yield Static("", id="practice-topbar-spacer")
            yield Button("📋", id="practice-copy-btn", classes="practice-icon-btn")
            yield Button("↺", id="practice-reset-btn", classes="practice-icon-btn")
            yield Button("🚀", id="practice-run-btn")
        yield Rule()
        with Horizontal(id="practice-tabs"):
            self.tab_chip = Static(f"[{code_runner.FILE_NAMES[self.language]}]", id="practice-tab-chip")
            yield self.tab_chip
        yield Rule()
        self.editor = TextArea(
            self.code_by_language[self.language],
            language=code_runner.TEXTAREA_LANGUAGE[self.language],
            show_line_numbers=True,
            id="practice-editor",
        )
        yield self.editor
        yield Rule()
        yield Static("OUTPUT", classes="practice-section-heading")
        with VerticalScroll(classes="practice-section-scroll"):
            self.output_panel = Static(self._idle_output(), id="practice-output")
            yield self.output_panel
        yield Rule()
        yield Static("TIME COMPLEXITY", classes="practice-section-heading")
        with VerticalScroll(classes="practice-section-scroll"):
            self.time_panel = Static(self._idle_complexity(), id="practice-time")
            yield self.time_panel
        yield Rule()
        yield Static("SPACE COMPLEXITY", classes="practice-section-heading")
        with VerticalScroll(classes="practice-section-scroll"):
            self.space_panel = Static(self._idle_complexity(), id="practice-space")
            yield self.space_panel
        yield Static("^R run  ·  ^B complexity  ·  ^N reset", id="practice-help", classes="dim")

    def action_reset_code(self):
        self.code_by_language[self.language] = code_runner.TEMPLATES[self.language]
        self.editor.text = self.code_by_language[self.language]
        self.editor.focus()

    def action_copy_code(self):
        self.app.copy_to_clipboard(self.editor.text)
        self.app.toast("Copied to clipboard (OSC 52 -- needs a terminal that supports it).", style="dim cyan")

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
        self.lang_tag.update(f"[{code_runner.LANGUAGE_LABELS[lang]}]")
        self.tab_chip.update(f"[{code_runner.FILE_NAMES[lang]}]")
        for l, btn_id in self._LANG_BUTTON_IDS.items():
            self.query_one(f"#{btn_id}", Button).set_class(l == lang, "-active-lang")
        self.editor.focus()

    # -- run ---------------------------------------------------------------

    def _idle_output(self):
        return Text("$ " + _RUN_COMMAND_LABEL[self.language], style="bold #39c26d")

    def action_run_code(self):
        code = self.editor.text
        language = self.language
        self.output_panel.update(Group(
            Text(f"$ {_RUN_COMMAND_LABEL[language]}", style="bold #39c26d"),
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
        status_color = "#39c26d" if result.ok else "#e06c75"
        self.output_panel.update(Group(
            Text(f"$ {_RUN_COMMAND_LABEL[language]}", style="bold #39c26d"),
            Text(""),
            Text(result.output or "(no output)"),
            Text(f"[exit {'0' if result.ok else '1'} in {result.elapsed:.3f}s]", style=f"dim {status_color}"),
        ))

    def _show_run_error(self, message):
        self.output_panel.update(Text(f"Couldn't run that -- see {LOG_PATH}\n{message}", style="bold #e06c75"))

    # -- complexity ----------------------------------------------------------

    def _idle_complexity(self):
        return Text("Ctrl+B to ask the AI for an estimate.", style="dim italic")

    def _complexity_body(self, raw):
        bigo, explanation = _split_bigo(raw)
        return Group(
            Text(bigo, style="bold #39c26d"),
            Text(""),
            Text("Explanation:", style="dim"),
            Text(explanation or "(no explanation given)"),
        )

    def action_analyze_complexity(self):
        code = self.editor.text
        if not code.strip():
            msg = Text("Write some code first.", style="dim italic")
            self.time_panel.update(msg)
            self.space_panel.update(msg)
            return
        language_label = code_runner.LANGUAGE_LABELS[self.language]
        msg = Text("Analyzing...", style="dim italic")
        self.time_panel.update(msg)
        self.space_panel.update(msg)
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
            err = Text(error, style="bold #e06c75")
            self.time_panel.update(err)
            self.space_panel.update(err)
            return
        time_text, space_text = _parse_complexity_response(answer or "")
        self.time_panel.update(self._complexity_body(time_text))
        self.space_panel.update(self._complexity_body(space_text))
