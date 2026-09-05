# mtdo web — splitting work between Dev M (backend/Claude Code) and Dev J (frontend/Codex)

**Status:** ACTIVE
**Created:** 2026-09-05
**Related:** `docs/designs/mtdo-web-v1-plan.md` (product/phases), `docs/architecture/{schema,api,decisions}.md`
(engineering contracts), `PARALLEL_AGENTS.md` (worktree tooling), `DESIGN.md`.

## Context

mtdo web now has two human developers instead of one founder driving both AI tools personally.
Dev M does backend work with Claude Code; Dev J does frontend work with Codex. The problem isn't
"what's left to build" — that's already answered by `docs/designs/mtdo-web-v1-plan.md`
(product/phases) and `docs/architecture/{schema,api,decisions}.md` (engineering contracts). The
problem is **assigning that work to two specific people without them stepping on each other or
burning tokens re-deriving decisions the other person already made**.

There's an earlier solo-founder delivery plan (kept as an ephemeral Claude Code plan file, not
committed here) that split work along exactly the right axis — "Claude keeps anything where a
wrong decision propagates (schema/RLS/ledger/session-authority/AI backend); Codex takes isolated,
already-contracted screen builds" — just written for one person driving both tools. This doc
translates that into a two-person org chart: M = the Claude-owned surfaces, J = the Codex-owned
surfaces, with real handoff and review rules since two independent humans (not one person
context-switching) are now involved.

**Where the project actually is right now** (verified against the repo, not assumed): W0
(foundations) is done and merged — PR #84 (DESIGN.md → Ember Graphite), #85 (architecture docs),
#86 (Next.js/Supabase scaffold, seam migrations, split CI). `supabase/migrations/0001_seam.sql`
and `0002_tutor_memory.sql` already contain the **audited, RPC-based** schema (`start_session`,
`complete_session`, `abandon_session`, `record_event`, `tutor_context` — not raw table writes).
`web/app/(onboarding)/` and `web/app/(app)/` are empty placeholder directories — nothing built
yet. **Wave 1 ("the engine") is wide open and is where both devs start.**

---

## 1. Ownership split — the never-cross lines

This is the actual assignment. Anything not listed, default to: if it's in `docs/architecture/`
or `supabase/`, it's M's; if it's UI the user looks at, it's J's.

| Surface | Owner | Tool | Notes |
|---|---|---|---|
| `supabase/migrations/**`, RLS policies, RPCs | **M** | Claude Code | Never edited by J, ever |
| `docs/architecture/{schema,api,decisions}.md` | **M** | Claude Code | The contract J builds against. M updates these *before* announcing a wave's contract is locked |
| `web/lib/supabase/server.ts` (service-role client), any Route Handler holding a service-role key or an Anthropic API key (AI plan generation, future tutor chat backend) | **M** | Claude Code | Anything that can't be exposed to the browser |
| Generated Supabase types | **M** | Claude Code | Regenerated after every migration change (already the rule in `api.md`) |
| `web/app/layout.tsx` | **M** (sole owner) | Claude Code | Global/foundational; J requests changes rather than editing directly — same "one owner" rule the old plan already used to prevent worktree conflicts |
| Terminal-app logic ports (`coaching.py`, `config.py`'s `goals_to_config()`, analytics/ledger patterns) | **M** | Claude Code | Backend logic, not UI |
| `web/app/(marketing)/`, `(onboarding)/`, `(app)/` — page components, screen logic, layout | **J** | Codex | Built against M's locked contract only — never invents an RPC or reads a table directly that `api.md` says is RPC-only |
| `web/components/**` | **J** | Codex | Built from `DESIGN.md` + the per-wave canvas draft |
| `web/app/styles/tokens.css`, all visual/DESIGN.md-driven work | **J** | Codex | |
| `web/lib/copy.ts` (web↔terminal vocabulary dictionary) | **J** | Codex | Presentation-layer only, per `api.md` §5 — safe for J since it never touches schema/route names |
| EmberMorph component (`web/components/`) | **J** builds it, **M** defines the trigger contract | Codex (build) / Claude (contract) | It's a visual component but wraps session state — M specifies what props/state it needs (session id, elapsed, planned duration) before J builds it, so it doesn't reach into `focus_sessions` directly |
| Design canvas drafts (per wave, before either dev builds) | User + Claude (`design` skill) | Claude Code | Not M's backend work — a separate, short step. See §3 |

**If J ever needs a schema/RLS/RPC change:** J files it as a request to M (an issue on the
`web-task` board — see §7 — or a message) — J does not write a migration, even a trivial one.
This is the same rule the old plan already had for parallel Claude agents; it applies doubly here
because J is on a different tool with zero visibility into M's Claude Code context.

---

## 2. Workspace & git setup

Shared clone at `~/mtdo`, git worktrees per dev — reuses what's already built
(`scripts/new-agent-worktree.sh`, Conductor/Herdr, per `PARALLEL_AGENTS.md`) instead of standing
up new infra.

**Branch naming** — the existing convention (`feature/mu/UAT-<desc>`) is single-user-branded
("mu"). Split it by dev initial instead:
- M: `feature/m/<wave>-<desc>` (e.g. `feature/m/w1-session-rpc-wiring`)
- J: `feature/j/<wave>-<desc>` (e.g. `feature/j/w1-today-screen`)

Everything else about the convention is unchanged: still opens a PR into `main` (never straight
to main, per the existing project rule), still uses `gh<issue-number>` — not bare `#<number>` —
to link a branch/commit to a tracker bug (`CLAUDE.md`'s linking convention), regardless of the
`m`/`j` prefix.

**`.claude/PROGRESS.md` conflict risk is now doubled**, not just theoretical — two real people,
each potentially running their own Claude Code / Codex sessions, both appending to one file.
Keep doing what `PARALLEL_AGENTS.md` already says: append your session's entry only as the *last*
commit before opening the PR, never mid-session.

**First action for M:** create `~/.claude/agents/mtdo-web.md`. `mtdo-dev.md` is scoped to the
Python TUI — without a web-specific agent doc, every one of M's Claude Code sessions re-derives
the schema/RLS/RPC context from `docs/architecture/` at the start of every session instead of
having it baked in once. This pays for itself within the first couple of sessions.

---

## 3. Handoff protocol — contract lock, then design canvas, then build

Per wave, in this order:

1. **M locks the backend contract**: migration merged to `main`, `docs/architecture/schema.md`
   and `api.md` updated to match, generated types regenerated. M announces the wave is
   "contract locked" (mark the corresponding `web-task` board item done — see §7).
2. **Design canvas**: for any wave with a screen in it, draft it (Claude's `design` skill, from
   `DESIGN.md`) and the user tunes it visually. This is a separate short step, not part of M's or
   J's normal work — it's what turns "J doesn't know where to start" into "J is building a
   specific approved draft." Wave 1's canvas: "mtdo W1 Solo Engine".
3. **J builds** against the locked contract (`api.md`'s RPC table + generated types) and the
   approved canvas. J does not start on a wave's screens before step 1 finishes for that wave —
   building against a contract that's still moving is exactly the rework the schema audit history
   (`docs/architecture/decisions.md`) shows this project already paid for once.

**This does not mean J is idle while M works.** Waves pipeline: while J is building Wave N's
screens, M can already be doing Wave N+1's backend contract (session-authority patterns, ledger
additions, RLS). The serialization is *per wave*, not global.

---

## 4. Review & merge authority

Owner-reviews-own-domain: **M reviews and merges backend PRs** (migrations, RLS, RPCs, Route
Handlers with secrets). **J reviews and merges frontend PRs** (screens, components, styling). The
user spot-checks rather than gating every PR — the entire point of splitting work by blast radius
(a schema mistake propagates everywhere; a screen mistake is local and cheap to redo) is
undermined if everything still funnels through one reviewer.

Run `/code-review` (low/medium effort) on **both** tools' diffs before merge — not just M's. A
Codex diff touching a file M also touches shouldn't happen per the ownership table in §1, but
`/code-review` is the cheap check that catches it if it ever does, and it's the one review step
that doesn't depend on M reading J's Codex output line-by-line (which defeats the point of
splitting the work in the first place).

---

## 5. Token/AI-usage discipline, per tool

**M (Claude Code):**
- Opus only for schema, RLS, ledger, session-authority design, and the AI Tutor Memory retrieval
  strategy (W3b) — the surfaces where a wrong decision cascades. Sonnet for everything else M
  builds (Route Handlers, coaching.py port, RPC implementation against an already-decided shape).
  Haiku for genuinely mechanical work.
- Cap Claude Code sessions at **3 parallel** — the constraint is review bandwidth, not machine
  capacity.
- Never re-derive a decision from chat history — every session should read `docs/architecture/`
  and `DESIGN.md` off disk, not ask "what did we decide about X."

**J (Codex):**
- `gpt-5.6-terra` for real state/logic screens (Today, Session, onboarding flow). `gpt-5.4-mini`
  for CRUD-shaped or mechanical UI (Kanban, Vault, marketing copy sections).
- **Every Codex brief is closed-form**: "here is the approved canvas, here is `api.md`'s contract
  for this screen, build exactly this." Never "explore the repo and figure out what to do" — J
  can't get a clarifying answer back from Codex the way a Claude sub-agent implicitly allows for;
  an ambiguous brief just produces the wrong thing, silently, on a quota that's harder to audit
  after the fact.
- If a `gpt-5.4-mini` screen comes back wrong twice, move that screen's brief up to `terra` rather
  than re-prompting the small model repeatedly.

---

## 6. J's Codex onboarding (do this before assigning a real wave)

Since J hasn't driven Codex against this repo before, don't hand over Wave 1's Session screen
(the highest-craft piece) as the first task. Sequence:

1. **Read-only pass**: `DESIGN.md` (full), `docs/architecture/api.md` (full — especially §6 "what
   ships to Codex vs. stays with Claude"), `web/lib/copy.ts`, and `PARALLEL_AGENTS.md`'s worktree
   section. J should come away able to state, in their own words, which files they're never
   allowed to touch (§1 above) and why.
2. **Trial task, small and mechanical**: one Wave-1 screen with the least state (the Progress
   heatmap, or a marketing-site static section), written as a fully closed-form brief. The goal
   is validating that the worktree → PR → `/code-review` → merge loop works end to end — not
   testing Codex's ceiling.
3. **Then hand over Wave 1's real screens** per the assignment in §7.

---

## 7. Web-dev task board (dashboard)

The private bug dashboard (`mtdo-sandbox dashboard`, `mukund1312/mtdo-bugs`) now also carries
web-dev work items, not just bugs — a **"Web Tasks"** view alongside Issues/Team, using the same
GitHub-issue-as-source-of-truth mechanism (see `src/mtdo/dashboard.py` / `bug_sync.py`). Each task
is a `mukund1312/mtdo-bugs` issue labeled `web-task` (instead of `sandbox-bug`), carries a
`wave:<name>` label instead of a priority, and reuses the existing `assigned:<login>` /
Open-Postponed-Fixed status controls — so M and J see their assignments in the same place they
already check for bugs, and "Fixed" on a task means "PR merged to main," not "bug closed."

Wave 1's concrete items (already filed, see the board):

**M:**
1. Write `~/.claude/agents/mtdo-web.md`.
2. Confirm a real Supabase project is linked and migrations are applied.
3. Build the onboarding plan-generation Route Handler (`api.md` §2).
4. Define the EmberMorph trigger contract (props/state shape).

**J** (once M's step 3 and the Wave 1 design canvas are both ready):
1. Onboarding screen UI, wired to M's Route Handler.
2. Today screen.
3. Session screen (highest-craft piece — triggers EmberMorph per M's contract).
4. Progress heatmap + Record Card export.

---

## Verification

- **Ownership held**: `git log --stat` on any merged PR from either dev shows changes confined to
  their column in §1's table — no cross-boundary edits.
- **Contract-lock protocol worked**: J's Wave 1 branches were created *after* M's onboarding
  Route Handler / RPC wiring PR merged, not before.
- **Onboarding trial succeeded**: J's first Codex task went through worktree → PR →
  `/code-review` → merge with no scope surprises before Wave 1's real screens were assigned.
- **Wave 1 done-when** (unchanged from the product plan): you can run a real goal through
  onboarding → Today → Session → Done → Progress for a week without opening the TUI, and the
  EmberMorph transition is the part you want to show people.
- **No token surprises**: spot-check that M's sessions used Sonnet (not defaulted to Opus) for
  screen/Route-Handler work, and that J's Codex briefs read as closed-form specs, not open-ended
  exploration, in the first few PRs from each dev.
