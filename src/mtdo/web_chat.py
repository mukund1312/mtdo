"""Minimal terminal chat REPL against the Anthropic or OpenAI API -- the last-resort
AI backend (see ai_backend.py), used only when neither Claude Code nor a local Ollama
model is available but the user has an API key set. Deliberately bare-bones: one
conversation, no tools, no file access. Its only job is "give the user a real model to
talk to without ever leaving the terminal," not to reimplement Claude Code.

Run directly as `python3 -m mtdo.web_chat anthropic` or `python3 -m mtdo.web_chat
openai` (this is exactly what ai_backend.detect() spawns inside the pty). Model can be
overridden with MTDO_ANTHROPIC_MODEL / MTDO_OPENAI_MODEL; otherwise defaults to a
current Claude or GPT model.
"""
import os
import sys


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
    model = os.environ.get("MTDO_ANTHROPIC_MODEL", "claude-sonnet-5")
    client = anthropic.Anthropic()
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
    model = os.environ.get("MTDO_OPENAI_MODEL", "gpt-4o")
    client = openai.OpenAI()
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


def main():
    provider = sys.argv[1] if len(sys.argv) > 1 else "anthropic"
    try:
        if provider == "anthropic":
            run_anthropic()
        else:
            run_openai()
    except KeyboardInterrupt:
        print()


if __name__ == "__main__":
    main()
