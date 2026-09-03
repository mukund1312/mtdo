# mtdo

Full project context lives in `.claude/PROGRESS.md` (session-by-session log, read before
starting work) and `~/.claude/agents/mtdo-dev.md` (architecture/onboarding doc for the
`mtdo-dev` agent). Read those before making changes here. Work that's been deliberately
scoped out (not a bug list, not a backlog of ideas) lives in `TODOS.md`.

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

## Product Contract

This contract governs the terminal app (`src/mtdo/`) only; the web product follows
`docs/designs/mtdo-web-v1-plan.md` and `DESIGN.md`.

**Core loop:** A user opens a terminal, sees today's study/practice tasks, works one task
in a focused view that shows live coaching for that exact task, and closes the session
having practiced something real (code that ran, not just a checked box).

**Anti-goals (never add, even if it seems natural):**
- No video/animation panel, ever -- every panel exists to help the user learn and retain,
  not to entertain.
- No mouse dependency -- keyboard-driven, for users who already live in a terminal.
- No hardcoded curriculum -- content is config, not code, or the app gets forked every time
  the user's goals change.

**Data/code boundary:** curriculum and categories live in a user-edited config file, never
in application logic. The app is a generic engine over a config schema.

**Screens, by decision not widget:**
- Kanban board -- what am I studying right now?
- Pomodoro/streaks -- am I actually showing up consistently?
- Learning Coach panel -- for the active task, what should I focus on and what mistakes do
  people make here (real coaching, not "study X")? Can generate a DSA/SQL problem on
  demand.
- AI assistant panel -- task context is already loaded; no re-explaining yourself.
- Practice Lab -- did the code I just wrote actually run, against a real database?

**Tech + reason:** Terminal UI (Textual/Python), because the target user already lives in a
terminal and switching to a browser is the friction being removed.

**Failure contract:** if the AI backend isn't configured or errors, fall back to static
content -- never block the core loop on an external call.

**Build order (historical -- already shipped, this is why it was sequenced this way):**
1. Kanban + config loading -- usable day one, no AI required.
2. Pomodoro/streaks -- retention loop.
3. Coaching panel -- static content first, AI-generated as fallback-fill later; MVP never
   required AI wiring.
4. Practice Lab / real code execution -- highest technical risk, built last.
5. Profiles/multi-user -- only once single-user worked end to end. (Still incremental --
   CLI-only today, no in-app switcher yet.)

Source: `/office-hours` design session, `docs/designs/agent-contract-template.md`. If this
section grows past ~150 total lines in this file, or a second contributor calls the file
too long to skim, split "Screens" and "Build order" out into `docs/agent-contract.md` and
leave a pointer here -- keep Anti-goals and Failure contract inline regardless, they're
what an agent most needs on its first read.

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
