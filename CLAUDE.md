# mtdo

Full project context lives in `.claude/PROGRESS.md` (session-by-session log, read before
starting work) and `~/.claude/agents/mtdo-dev.md` (architecture/onboarding doc for the
`mtdo-dev` agent). Read those before making changes here.

## Design System (mtdo **web** only)

Always read `DESIGN.md` before making any visual or UI decision in the web product.
Font choices, colors, spacing, radius, motion, and the aesthetic direction ("Graphite") are
defined there. Do not deviate without explicit user approval. In QA mode, flag any code that
doesn't match `DESIGN.md`.

`DESIGN.md` governs the **web** product only. The terminal app (`src/mtdo/`) keeps its own
green-on-black identity and is deliberately not covered by it. Product plan and phase
breakdown for the web product: `docs/designs/mtdo-web-v1-plan.md`.

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

## Skill routing

When the user's request matches an available skill, invoke it via the Skill tool. When in doubt, invoke the skill.

Key routing rules:
- Product ideas/brainstorming → invoke /office-hours
- Strategy/scope → invoke /plan-ceo-review
- Architecture → invoke /plan-eng-review
- Design system/plan review → invoke /design-consultation or /plan-design-review
- Full review pipeline → invoke /autoplan
- Bugs/errors → invoke /investigate
- QA/testing site behavior → invoke /qa or /qa-only
- Code review/diff check → invoke /review
- Visual polish → invoke /design-review
- Ship/deploy/PR → invoke /ship or /land-and-deploy
- Save progress → invoke /context-save
- Resume context → invoke /context-restore
- Author a backlog-ready spec/issue → invoke /spec
