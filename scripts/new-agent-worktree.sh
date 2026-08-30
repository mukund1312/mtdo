#!/usr/bin/env bash
# Creates a git worktree for a new agent to work in, alongside the main ~/mtdo
# checkout, and copies over the untracked files a fresh `git worktree add`
# never brings along on its own (see .claude/PROGRESS.md's 2026-08-30 entry on
# the parallel-agent-tooling setup for why each of these is untracked):
#
#   .claude/settings.local.json  -- gitignored globally (~/.config/git/ignore)
#   .claude/skills/               -- untracked; a relative symlink farm into .agents/skills
#   .agents/                      -- untracked; the real skill directories .claude/skills/ points into
#   skills-lock.json              -- untracked
#
# Copied, not symlinked -- symlinking these across worktrees would mean two
# agents editing the same underlying files/settings, which defeats the point
# of giving each agent its own isolated checkout. .claude/skills/'s own
# symlinks (e.g. find-skills -> ../../.agents/skills/find-skills) are relative,
# so a plain recursive copy that preserves symlinks-as-symlinks (cp -a) keeps
# them resolving correctly in the new worktree, since .agents/ is copied to
# the same relative depth alongside it.
#
# Usage: scripts/new-agent-worktree.sh <branch-name>
#   e.g. scripts/new-agent-worktree.sh feature/mu/UAT-new-thing
#        scripts/new-agent-worktree.sh fix/gh42-flicker
set -euo pipefail

if [ $# -ne 1 ]; then
    echo "Usage: $0 <branch-name>" >&2
    echo "  e.g. $0 feature/mu/UAT-new-thing" >&2
    exit 1
fi

branch="$1"
repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
worktrees_root="$(dirname "$repo_root")/mtdo-worktrees"
slug="$(echo "$branch" | tr '/' '-')"
worktree_path="$worktrees_root/$slug"

if [ -e "$worktree_path" ]; then
    echo "error: $worktree_path already exists" >&2
    exit 1
fi

mkdir -p "$worktrees_root"

cd "$repo_root"
if git show-ref --verify --quiet "refs/heads/$branch"; then
    git worktree add "$worktree_path" "$branch"
else
    git worktree add "$worktree_path" -b "$branch"
fi

for item in .claude/settings.local.json .claude/skills .agents skills-lock.json; do
    src="$repo_root/$item"
    if [ -e "$src" ] || [ -L "$src" ]; then
        mkdir -p "$(dirname "$worktree_path/$item")"
        cp -a "$src" "$worktree_path/$item"
    fi
done

echo "Worktree ready: $worktree_path"
