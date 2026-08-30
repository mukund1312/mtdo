# Running Parallel Agents on mtdo

**Goal:** Run several coding agents on this repo at once instead of one at a time,
without them fighting over the same working directory.

## The mechanism: git worktrees

Everything below is a front door onto one underlying feature: `git worktree`, which
checks out several branches into several directories at once, all sharing one `.git`
history. That's what actually makes parallel agents possible -- Conductor, Herdr, and
Omnigent don't replace it, they're three different ways of driving it.

| Tool | What it actually is | Interface |
|---|---|---|
| git worktrees | The primitive: N branches checked out into N folders, one shared `.git` | none -- it's git |
| Conductor | Mac app that creates/manages worktrees + launches a Claude Code/Codex session per workspace, shows diffs/checks/PR status | GUI |
| Herdr | Terminal multiplexer built for agents; every agent gets a real PTY pane on a background server, survives detach, reattach over SSH | TUI/terminal |
| Omnigent | Meta-harness for mixing different agent frameworks (Claude Code + Codex + Cursor + custom) in one session, with policy/sandboxing and browser-based live collaboration | GUI + browser + CLI |

All three point at the same worktrees, so nothing is lost by switching tools mid-project
-- start a task in Conductor and reattach to its exact worktree from a Herdr pane later.

## Which tool, when

1. **Default to Herdr** for most solo work: faster to spin up, keyboard-driven, session
   survives closing the laptop, and you can check on agents from your phone over SSH.
2. **Reach for Conductor** when you want to see several agents' progress side-by-side
   (diff view, check status, PR state) without reading terminal scrollback, or when
   reviewing/approving diffs is the main activity.
3. **Reach for Omnigent only when a task specifically needs** (a) a non-Claude agent in
   the mix (Codex/Cursor/custom), or (b) someone else watching or joining your session
   live from a browser. Not a default daily driver -- it's the heaviest of the three for
   no extra benefit in the solo-Claude case.

## Creating a worktree

```bash
scripts/new-agent-worktree.sh feature/mu/UAT-new-thing
# or
scripts/new-agent-worktree.sh fix/gh42-flicker
```

This creates `~/mtdo-worktrees/<slug>/` on a fresh branch and copies over the files a
plain `git worktree add` doesn't bring along -- `.claude/settings.local.json`,
`.claude/skills/`, `.agents/`, `skills-lock.json` -- all untracked, so a fresh worktree
would otherwise silently lose its skills and local settings. Copied, not symlinked, so
two agents never share the same underlying settings/skills files.

`~/.claude/agents/mtdo-dev.md` lives outside the repo entirely, so it's already global --
every worktree/agent sees it with no extra step.

Point Conductor or Herdr at the printed path. If Conductor creates its own worktree
instead of using one made by the script, run the same copy step manually against
Conductor's generated path afterward -- the untracked-file gap is the same either way.

## Gotchas specific to this repo

- **`.claude/PROGRESS.md` is a single large append-only log, git-tracked.** Two parallel
  agents both appending to it and committing will conflict often. Keep the conflict
  window small: append your session's PROGRESS.md entry only as the *last* commit right
  before opening a PR, not throughout the session.
- **Branch naming and bug-linking still apply per-worktree.** Keep using
  `feature/mu/UAT-<slug>` / `fix/gh<NN>-<slug>`, and `gh<issue-number>` (not a bare
  `#<number>`) to link a branch/commit to a `mukund1312/mtdo-bugs` issue -- see
  `CLAUDE.md`. The dashboard's "Related git activity" section depends on this regardless
  of which worktree the commit was made in.
- **Nothing changes about the push/PR flow.** Each worktree still pushes its own branch
  and goes through a normal PR into `main` (see `GITHUB_SYNC_WORKFLOW.md`) -- worktrees
  just mean this now happens on N branches in parallel instead of one at a time.

## Cleaning up

Once a worktree's branch is merged:

```bash
git worktree remove ~/mtdo-worktrees/<slug>
git worktree list   # confirm no orphans left behind
```
