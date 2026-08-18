"""Minimal terminal chat REPL against the Anthropic, OpenAI, or Google (Gemini) API --
the "browser-free" AI backends (see ai_backend.py): real access to Claude, GPT, or
Gemini without ever opening an actual browser tab, which is the point of keeping the
user inside the terminal. Deliberately bare-bones: one conversation, no tools, no file
access. Its only job is "give the user a real model to talk to," not to reimplement
Claude Code.

Run directly as `python3 -m mtdo.web_chat anthropic|openai|gemini` (this is exactly
what ai_backend.list_available() spawns inside the pty). These are always offered in
the picker regardless of whether a key is already set -- get_api_key() below checks
the usual env var first, then ~/.mtdo/secrets.json, and only then prompts (hidden
input, via getpass) with an offer to remember it for next time. Models can be
overridden with MTDO_ANTHROPIC_MODEL / MTDO_OPENAI_MODEL / MTDO_GEMINI_MODEL.
"""
import getpass
import json
import os
import stat
import sys

SECRETS_PATH = os.path.expanduser("~/.mtdo/secrets.json")

_PROVIDERS = {
    "anthropic": {"env": ("ANTHROPIC_API_KEY",), "secrets_key": "anthropic_api_key", "display": "Anthropic"},
    "openai": {"env": ("OPENAI_API_KEY",), "secrets_key": "openai_api_key", "display": "OpenAI"},
    "gemini": {"env": ("GEMINI_API_KEY", "GOOGLE_API_KEY"), "secrets_key": "gemini_api_key", "display": "Google"},
}


def _load_secrets():
    try:
        with open(SECRETS_PATH) as f:
            return json.load(f)
    except (OSError, ValueError):
        return {}


def _save_secret(key_name, value):
    secrets = _load_secrets()
    secrets[key_name] = value
    os.makedirs(os.path.dirname(SECRETS_PATH), exist_ok=True)
    with open(SECRETS_PATH, "w") as f:
        json.dump(secrets, f)
    os.chmod(SECRETS_PATH, stat.S_IRUSR | stat.S_IWUSR)  # owner read/write only -- it holds API keys


def get_api_key(provider):
    """Resolves an API key for `provider`: env var, then ~/.mtdo/secrets.json, then an
    interactive hidden prompt with an offer to remember it. Returns None if the user
    declines to provide one (e.g. Ctrl+D at the prompt)."""
    cfg = _PROVIDERS[provider]
    for name in cfg["env"]:
        value = os.environ.get(name)
        if value:
            return value

    value = _load_secrets().get(cfg["secrets_key"])
    if value:
        return value

    print(f"No {cfg['display']} API key found (checked {'/'.join(cfg['env'])} and {SECRETS_PATH}).")
    try:
        value = getpass.getpass(f"Paste your {cfg['display']} API key (input hidden): ").strip()
    except EOFError:
        print()
        return None
    if not value:
        return None
    try:
        save = input("Remember it for next time? [y/N] ").strip().lower()
    except EOFError:
        save = ""
    if save == "y":
        _save_secret(cfg["secrets_key"], value)
        print(f"Saved to {SECRETS_PATH} (owner-only permissions).")
    return value


def _read_line(prompt):
    try:
        return input(prompt)
    except EOFError:
        print()
        return None


def run_anthropic():
    try:
        import anthropic
    except ImportError:
        print("Missing dependency -- run: pip install anthropic")
        return
    key = get_api_key("anthropic")
    if not key:
        print("No API key provided -- exiting.")
        return
    model = os.environ.get("MTDO_ANTHROPIC_MODEL", "claude-sonnet-5")
    client = anthropic.Anthropic(api_key=key)
    history = []
    print(f"Chatting with {model} (Anthropic API). Ctrl+D to exit.\n")
    while True:
        user = _read_line("you> ")
        if user is None:
            return
        if not user.strip():
            continue
        history.append({"role": "user", "content": user})
        print("claude> ", end="", flush=True)
        reply = ""
        try:
            with client.messages.stream(model=model, max_tokens=2048, messages=history) as stream:
                for text in stream.text_stream:
                    print(text, end="", flush=True)
                    reply += text
        except Exception as e:
            print(f"\n[error: {e}]")
            history.pop()
            continue
        print("\n")
        history.append({"role": "assistant", "content": reply})


def run_openai():
    try:
        import openai
    except ImportError:
        print("Missing dependency -- run: pip install openai")
        return
    key = get_api_key("openai")
    if not key:
        print("No API key provided -- exiting.")
        return
    model = os.environ.get("MTDO_OPENAI_MODEL", "gpt-4o")
    client = openai.OpenAI(api_key=key)
    history = []
    print(f"Chatting with {model} (OpenAI API). Ctrl+D to exit.\n")
    while True:
        user = _read_line("you> ")
        if user is None:
            return
        if not user.strip():
            continue
        history.append({"role": "user", "content": user})
        print("gpt> ", end="", flush=True)
        reply = ""
        try:
            stream = client.chat.completions.create(model=model, messages=history, stream=True)
            for chunk in stream:
                delta = chunk.choices[0].delta.content or ""
                print(delta, end="", flush=True)
                reply += delta
        except Exception as e:
            print(f"\n[error: {e}]")
            history.pop()
            continue
        print("\n")
        history.append({"role": "assistant", "content": reply})


def run_gemini():
    try:
        import google.generativeai as genai
    except ImportError:
        print("Missing dependency -- run: pip install google-generativeai")
        return
    key = get_api_key("gemini")
    if not key:
        print("No API key provided -- exiting.")
        return
    genai.configure(api_key=key)
    model_name = os.environ.get("MTDO_GEMINI_MODEL", "gemini-2.0-flash")
    chat = genai.GenerativeModel(model_name).start_chat(history=[])
    print(f"Chatting with {model_name} (Gemini API). Ctrl+D to exit.\n")
    while True:
        user = _read_line("you> ")
        if user is None:
            return
        if not user.strip():
            continue
        print("gemini> ", end="", flush=True)
        try:
            for chunk in chat.send_message(user, stream=True):
                if chunk.text:
                    print(chunk.text, end="", flush=True)
        except Exception as e:
            print(f"\n[error: {e}]")
            continue
        print("\n")


_RUNNERS = {"anthropic": run_anthropic, "openai": run_openai, "gemini": run_gemini}


def main():
    provider = sys.argv[1] if len(sys.argv) > 1 else "anthropic"
    try:
        _RUNNERS.get(provider, run_anthropic)()
    except KeyboardInterrupt:
        print()


if __name__ == "__main__":
    main()
