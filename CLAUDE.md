# mtdo

Full project context lives in `.claude/PROGRESS.md` (session-by-session log, read before
starting work) and `~/.claude/agents/mtdo-dev.md` (architecture/onboarding doc for the
`mtdo-dev` agent). Read those before making changes here.

## Linking a commit/branch to a tracker bug

The shared bug dashboard's "Related git activity" section (see `dashboard.py`,
`_bug_git_activity`) picks up branches and commit messages that reference a bug from the
private `mukund1312/mtdo-bugs` tracker, by convention: include `gh<issue-number>` as a
whole word (case-insensitive) -- e.g. branch `fix/gh42-flicker`, commit `Fixes gh42`.

Do **not** use a bare `#<number>` for this -- it's ambiguous and has caused real,
silently-wrong matches on the dashboard (2026-08-24): GitHub auto-generates "Merge pull
request #N" messages using this repo's own PR numbers, and this repo's commit history has
an older, unrelated "(bug #N)" convention that predates the mtdo-bugs tracker. Both
produce plain `#<number>` patterns that collide with real tracker issue numbers once the
tracker grows past single digits. `gh<number>` doesn't collide with either.

This is a naming convention devs opt into, not an enforced link -- nothing breaks if you
don't use it, the section just stays empty for that bug.

## gstack

Use the `/browse` skill from gstack for all web browsing. Never use the
`mcp__claude-in-chrome__*` tools.

Available gstack skills: `/office-hours`, `/plan-ceo-review`, `/plan-eng-review`,
`/plan-design-review`, `/design-consultation`, `/design-shotgun`, `/design-html`,
`/review`, `/ship`, `/land-and-deploy`, `/canary`, `/benchmark`, `/browse`,
`/connect-chrome`, `/qa`, `/qa-only`, `/design-review`, `/setup-browser-cookies`,
`/setup-deploy`, `/setup-gbrain`, `/retro`, `/investigate`, `/document-release`,
`/document-generate`, `/codex`, `/cso`, `/autoplan`, `/plan-devex-review`,
`/devex-review`, `/careful`, `/freeze`, `/guard`, `/unfreeze`, `/gstack-upgrade`,
`/learn`.
