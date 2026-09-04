# mtdo web — API surface & component contracts

**Status:** ACTIVE. **Created:** 2026-09-04. **Related:** `schema.md`, `DESIGN.md`.

## 1. Repo layout

```
mtdo/
├── src/mtdo/              # unchanged Python TUI
├── tests/                 # unchanged pytest
├── web/                   # ← new
│   ├── app/
│   │   ├── (marketing)/   # landing pages
│   │   ├── (onboarding)/  # goal → AI plan
│   │   ├── (app)/         # today, session, progress, vault, kanban
│   │   └── styles/tokens.css
│   ├── components/        # primitives built from DESIGN.md
│   ├── lib/supabase/      # typed client, generated types
│   ├── lib/copy.ts        # the web↔terminal vocabulary dictionary (DESIGN.md §Vocabulary)
│   └── package.json
├── supabase/migrations/   # SQL, source of truth for schema (see schema.md)
└── docs/architecture/     # this directory
```

`ci.yml` currently runs the full pytest suite on every PR with no path filter. Split it:
`paths: ['src/**','tests/**']` for the Python job, `paths: ['web/**']` for a new web job — without
this, a CSS-only PR costs four minutes of unrelated Python CI.

## 2. AI integration

- **Plan generation** (onboarding): Route Handler → Anthropic API, streamed. One-time and
  user-facing, so a loading state is acceptable here.
- **Coaching content**: mostly *not* an AI call. `curriculum_items.meta` and
  `plan_categories.coaching_framework` (schema.md §2) carry real authored content — the terminal
  app already renders full coaching with no AI backend configured at all. Preserve that failure
  contract on web: coaching must degrade to static content, never block the core loop.
- **AI Tutor Memory chat** (W3b): built against the retrieval strategy in `schema.md` §3. Never
  replays full history; reads the rolling summary plus recent messages only.
- **AI manager** (rooms, W4b, per group-study D15): **async only** — Vercel Cron or `pg_cron` →
  job row → worker reads `activity_events` → writes a summary row. Never in a request path, never
  a chatbot.

## 3. The EmberMorph component contract

`DESIGN.md` §Motion specifies the morph itself (`Graphite home → ember bloom → terminal focus
shell`). The engineering contract on top of that:

- **Ships as a standalone component**, not logic inlined into the session route:
  `<EmberMorph trigger={...} />` (exact prop shape decided by the W1 implementer, but it must be
  importable and triggerable from outside the session page).
- **Why this matters beyond W1:** the marketing site (`WM`, see the delivery plan) reuses this
  exact component for its web↔terminal showcase, rather than building a second, separately
  maintained transition. WM's showcase section is blocked until this component exists.
- Respects `prefers-reduced-motion` internally — collapses to an instant state change, never a
  blank screen. Callers should not need to handle this themselves.

## 4. Dual vocabulary — presentation layer only

Full table and rules in `DESIGN.md` §Vocabulary. Enforcement note for the API layer:
**schema, route, and component names stay neutral** (`plans`, `focus_sessions`, `rooms`, `notes`)
regardless of what the UI copy calls them (`mission_compiler`, `mesh_signal`, etc.). The mapping
lives in exactly one file, `web/lib/copy.ts` — no marketing term ever appears in a table name,
column name, or route segment.

## 5. What ships to Codex vs. stays with Claude

See the delivery plan (`~/.claude/plans/compressed-humming-sunrise.md`) for the full per-surface
model table. The boundary that matters for API design: **anything in this file or `schema.md` is
Claude-owned.** A Codex brief should never include a request to add a column, change an RLS
policy, or alter the ledger shape — it should cite this file and build against it as fixed.
