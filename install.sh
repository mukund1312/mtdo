#!/usr/bin/env bash
# mtdo installer -- checks every prerequisite up front with a specific, actionable
# error before touching anything, instead of letting `pip install -e .` fail deep
# in a build log with no clear next step. That's the actual first support burden
# for an invite-gated launch: a failure here becomes an email saying "it didn't
# work", not a GitHub issue with a stack trace -- so this fails loud and early,
# in plain language, for someone who isn't necessarily comfortable in a terminal.
#
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/mukund1312/mtdo/main/install.sh | bash
#   or, from a clone: ./install.sh
set -uo pipefail

REPO_URL="https://github.com/mukund1312/mtdo.git"
MIN_PYTHON_MINOR=10  # requires-python = ">=3.10" in pyproject.toml

red()   { printf '\033[31m%s\033[0m\n' "$1"; }
green() { printf '\033[32m%s\033[0m\n' "$1"; }
bold()  { printf '\033[1m%s\033[0m\n' "$1"; }

fail() {
  red "✗ $1"
  [ -n "${2:-}" ] && echo "  $2"
  exit 1
}

bold "mtdo installer"
echo

# ---------- 1. git ----------
if ! command -v git >/dev/null 2>&1; then
  if [[ "$(uname)" == "Darwin" ]]; then
    fail "git isn't installed." \
      "Run 'xcode-select --install' (this also installs git), then run this script again."
  else
    fail "git isn't installed." \
      "Install it with your system's package manager (e.g. 'sudo apt install git' on Debian/Ubuntu), then run this script again."
  fi
fi
green "✓ git found"

# ---------- 2. Xcode Command Line Tools (macOS only -- needed to build any
# dependency without a prebuilt wheel for your exact Python version) ----------
if [[ "$(uname)" == "Darwin" ]]; then
  if ! xcode-select -p >/dev/null 2>&1; then
    fail "Xcode Command Line Tools aren't installed." \
      "Run 'xcode-select --install', click through the installer that pops up, then run this script again."
  fi
  green "✓ Xcode Command Line Tools found"
fi

# ---------- 3. python3, and a version new enough ----------
PYTHON_BIN=""
for candidate in python3.13 python3.12 python3.11 python3.10 python3; do
  if command -v "$candidate" >/dev/null 2>&1; then
    PYTHON_BIN="$candidate"
    break
  fi
done
if [ -z "$PYTHON_BIN" ]; then
  fail "python3 isn't installed." \
    "Install Python 3.10 or newer from https://www.python.org/downloads/ (or 'brew install python@3.12' on macOS), then run this script again."
fi

PY_MINOR=$("$PYTHON_BIN" -c 'import sys; print(sys.version_info.minor)')
PY_VERSION=$("$PYTHON_BIN" -c 'import sys; print(".".join(map(str, sys.version_info[:3])))')
if [ "$PY_MINOR" -lt "$MIN_PYTHON_MINOR" ]; then
  fail "Found Python $PY_VERSION, but mtdo needs 3.$MIN_PYTHON_MINOR or newer." \
    "Install a newer Python from https://www.python.org/downloads/ (or 'brew install python@3.12' on macOS), then run this script again."
fi
green "✓ $PYTHON_BIN found (Python $PY_VERSION)"

# ---------- 4. sqlite3 CLI (Practice Lab's SQL mode runs real queries against it) ----------
if ! command -v sqlite3 >/dev/null 2>&1; then
  if [[ "$(uname)" == "Darwin" ]]; then
    fail "sqlite3 isn't installed." \
      "Run 'brew install sqlite3', then run this script again. (Everything except the SQL Practice Lab will still work without it, but this installer wants a clean run.)"
  else
    fail "sqlite3 isn't installed." \
      "Run 'sudo apt install sqlite3' (Debian/Ubuntu) or your distro's equivalent, then run this script again."
  fi
fi
green "✓ sqlite3 found"

# ---------- 5. clone (skip if already inside a clone) ----------
if [ -f "pyproject.toml" ] && grep -q '^name = "mtdo"' pyproject.toml 2>/dev/null; then
  green "✓ already inside an mtdo clone, skipping git clone"
  INSTALL_DIR="$(pwd)"
else
  INSTALL_DIR="$HOME/mtdo"
  if [ -d "$INSTALL_DIR" ]; then
    fail "$INSTALL_DIR already exists." \
      "Remove or rename it, or run this script from inside an existing mtdo clone."
  fi
  echo "Cloning into $INSTALL_DIR ..."
  if ! git clone --quiet "$REPO_URL" "$INSTALL_DIR"; then
    fail "git clone failed." "Check your internet connection and that $REPO_URL is reachable, then try again."
  fi
  green "✓ cloned"
  cd "$INSTALL_DIR"
fi

# ---------- 6. venv + install ----------
echo "Creating a virtual environment (.venv) ..."
if ! "$PYTHON_BIN" -m venv .venv; then
  fail "Couldn't create a virtual environment." \
    "On Debian/Ubuntu this usually means: sudo apt install python3-venv, then run this script again."
fi

echo "Installing mtdo (this can take a minute) ..."
if ! .venv/bin/python3 -m pip install --quiet --upgrade pip; then
  fail "Couldn't upgrade pip inside the virtual environment." "Try running this script again -- if it keeps failing, check your internet connection."
fi
if ! .venv/bin/python3 -m pip install --quiet -e .; then
  fail "pip install failed." \
    "Scroll up for the actual error from pip. If it's about a missing compiler or header file, re-run 'xcode-select --install' (macOS) or install your distro's 'build-essential'/'python3-dev' package, then run this script again."
fi

echo
green "✓ mtdo installed"
echo
bold "To start it:"
echo "  cd $INSTALL_DIR"
echo "  source .venv/bin/activate"
echo "  mtdo"
