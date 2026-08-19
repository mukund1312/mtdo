"""One-shot, non-interactive AI queries -- used by the Practice Lab's "Analyze
Complexity" action, where a single request/response is what's needed, not a live
embedded terminal session (that's what claude_panel.py is for). Reuses the same
backend priority as the AI panel (ai_backend.detect()) but calls each one in
non-interactive mode instead of spawning an interactive pty:

- `claude -p "<prompt>"` (Claude Code's own print-and-exit mode)
- `ollama run <model> "<prompt>"` (a single positional prompt argument makes this
  single-shot rather than dropping into the REPL -- confirmed by hand, and that
  stdout comes back as clean text with no ANSI/spinner noise when it isn't
  attached to a real tty; that noise goes to stderr instead)
- a direct, non-streaming call through whichever SDK web_chat.py already knows how
  to use, reusing its get_api_key()/_ensure_import() so a saved key or an already
  -installed SDK just works here too

Runs a real subprocess/HTTP call that can take several seconds to tens of seconds,
so callers must not call ask() from the main thread -- see
practice_lab_panel.PracticeLabPanel.action_analyze_complexity for the
background-thread pattern already used throughout this app for exactly this reason.
"""
import subprocess

from . import ai_backend


def ask(prompt, timeout=60):
    """Returns (answer_text_or_None, error_message_or_None)."""
    command, label = ai_backend.detect()
    if command is None:
        return None, label  # detect()'s "nothing configured" explanation

    if command == "claude":
        return _run_subprocess(["claude", "-p", prompt], timeout)

    if command == ai_backend.PROMPT_CUSTOM_OLLAMA_MODEL:
        # detect() skips this sentinel already, but guard anyway -- there's no
        # model name to run without a prompt for one.
        return None, "Pick a specific Ollama model first (via C), then try again."

    if "ollama run" in command:
        model = _extract_ollama_model(command)
        if model is None:
            return None, "Couldn't tell which Ollama model to ask."
        return _run_subprocess(["ollama", "run", model, prompt], timeout)

    if command.startswith("python3 -m mtdo.web_chat"):
        provider = command.rsplit(" ", 1)[-1]
        return _ask_api(provider, prompt, timeout)

    return None, f"Don't know how to ask this backend a one-shot question: {label}"


def _extract_ollama_model(command):
    # command is either "ollama run <model>" or the bash -lc wrapper that ends with
    # "... ollama run <model>" (see ai_backend.ollama_run_command) -- either way,
    # the model name is the token right after the last "ollama run".
    marker = "ollama run "
    idx = command.rfind(marker)
    if idx == -1:
        return None
    rest = command[idx + len(marker):]
    return rest.split()[0].strip("'\"") if rest.strip() else None


def _run_subprocess(argv, timeout):
    try:
        result = subprocess.run(argv, capture_output=True, text=True, timeout=timeout)
    except subprocess.TimeoutExpired:
        return None, f"Timed out after {timeout}s waiting for a response."
    except OSError as e:
        return None, str(e)
    if result.returncode != 0:
        return None, (result.stderr or result.stdout or f"exit code {result.returncode}").strip()
    return result.stdout.strip(), None


def _ask_api(provider, prompt, timeout):
    from . import web_chat

    try:
        if provider == "anthropic":
            anthropic = web_chat._ensure_import("anthropic", "anthropic")
            if anthropic is None:
                return None, "Anthropic SDK not installed."
            key = web_chat.get_api_key("anthropic")
            if not key:
                return None, "No Anthropic API key provided."
            client = anthropic.Anthropic(api_key=key)
            model = __import__("os").environ.get("MTDO_ANTHROPIC_MODEL", "claude-sonnet-5")
            memory = web_chat._read_memory()
            kwargs = {"model": model, "max_tokens": 1024, "messages": [{"role": "user", "content": prompt}]}
            if memory:
                kwargs["system"] = memory
            response = client.messages.create(**kwargs)
            return "".join(block.text for block in response.content if hasattr(block, "text")), None

        if provider == "openai":
            openai = web_chat._ensure_import("openai", "openai")
            if openai is None:
                return None, "OpenAI SDK not installed."
            key = web_chat.get_api_key("openai")
            if not key:
                return None, "No OpenAI API key provided."
            client = openai.OpenAI(api_key=key)
            model = __import__("os").environ.get("MTDO_OPENAI_MODEL", "gpt-4o")
            memory = web_chat._read_memory()
            messages = ([{"role": "system", "content": memory}] if memory else []) + [
                {"role": "user", "content": prompt}
            ]
            response = client.chat.completions.create(model=model, messages=messages)
            return response.choices[0].message.content, None

        if provider == "gemini":
            genai = web_chat._ensure_import("google.generativeai", "google-generativeai")
            if genai is None:
                return None, "google-generativeai SDK not installed."
            key = web_chat.get_api_key("gemini")
            if not key:
                return None, "No Gemini API key provided."
            genai.configure(api_key=key)
            model_name = __import__("os").environ.get("MTDO_GEMINI_MODEL", "gemini-2.0-flash")
            memory = web_chat._read_memory()
            model_kwargs = {"system_instruction": memory} if memory else {}
            model = genai.GenerativeModel(model_name, **model_kwargs)
            response = model.generate_content(prompt)
            return response.text, None
    except Exception as e:
        return None, str(e)

    return None, f"Unknown provider: {provider}"
