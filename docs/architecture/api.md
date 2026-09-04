# mtdo web — API surface & component contracts

**Status:** ACTIVE. **Created:** 2026-09-04.
**Last revised:** 2026-09-04 (adversarial schema/RLS audit — §3 is new; see `decisions.md`).
**Related:** `schema.md`, `DESIGN.md`.

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
  replays full history; reads the rolling summary plus recent messages only. **This must be a
  Route Handler using the service-role key** — `tutor_messages` is not client-writable, by
  design (see §3 below and `schema.md` §3). It is the only component that may write there, and
  it must check the free-tier cap against `activity_events` *and* write the
  `tutor_message_sent` event itself, in the same transaction as the message rows.
- **AI manager** (rooms, W4b, per group-study D15): **async only** — Vercel Cron or `pg_cron` →
  job row → worker reads `activity_events` → writes a summary row. Never in a request path, never
  a chatbot.

## 3. How the app talks to the database

Most tables are read and written directly with the anon-key client under RLS. **Five are not**
(`focus_sessions`, `activity_events`, `daily_rollups`, `tutor_messages`,
`tutor_memory_summaries`), and this is the part that is easy to get wrong: they are read-only —
or, for `tutor_messages`, no-access — to clients, and their writes go through `security definer`
RPCs or a service-role backend. Calling `.insert()` on them does not fail
silently — it returns a `42501` permission error — but the fix is to use the RPC, never to add a
policy or a grant. `schema.md` §6 has the full privilege table.

| Instead of | Call |
|---|---|
| `from('focus_sessions').insert(...)` | `rpc('start_session', { p_block_id, p_planned_duration_s })` |
| `from('focus_sessions').update({ state: 'completed' })` | `rpc('complete_session', { p_id })` |
| `from('focus_sessions').update({ state: 'abandoned' })` | `rpc('abandon_session', { p_id })` |
| `from('activity_events').insert({ kind, occurred_at, payload })` | `rpc('record_event', { p_kind, p_payload })` |
| `from('tutor_messages').select(...)` | `rpc('tutor_context', { p_conversation_id, p_recent_limit })` |
| `from('tutor_messages').insert(...)` | *not available to clients* — the W3b Route Handler (service role) only |
| `from('daily_rollups').insert/update(...)` | *not available* — derived by a service-role recompute job (D13) |

Reads of `focus_sessions`, `activity_events` and `daily_rollups` are ordinary RLS-filtered
`select`s and need no RPC.

Notes for call sites:

- **Never send `user_id`, `occurred_at`, `started_at` or `completed_at`** to these RPCs. They are
  not parameters; the functions derive them from `auth.uid()` and the server clock. That is the
  whole point of the indirection (D12, D14).
- **`record_event` accepts only client-appendable kinds** (`schema.md` §4). `session_*` and
  `tutor_message_sent` are server-minted and will be rejected with `22023` — the session RPCs
  already emit their own ledger events, so do not emit them yourself. Payloads must be JSON
  objects, ≤ 4 KB.
- **`start_session` returns `55006`** when a session is already running. Branch on it: `select`
  the running session and offer resume-or-discard, then `abandon_session()` before retrying. Do
  not treat it as a generic failure.
- **Upserts on `blocks` cannot use `ON CONFLICT`** against `blocks_slot_key` — it is a deferrable
  constraint, which Postgres will not use for conflict inference. Write update-then-insert.
- **Retiring a goal is `update plans set is_active = false`.** There is no delete path;
  `.delete()` on `plans` or `plan_categories` silently affects zero rows (RLS makes them
  invisible to the DELETE), which is a confusing thing to debug if you expected an error.
- **Generated types** (`web/lib/supabase/`) should be regenerated after any migration change so
  the RPC signatures above are typed rather than stringly-called.

## 4. The EmberMorph component contract

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

## 5. Dual vocabulary — presentation layer only

Full table and rules in `DESIGN.md` §Vocabulary. Enforcement note for the API layer:
**schema, route, and component names stay neutral** (`plans`, `focus_sessions`, `rooms`, `notes`)
regardless of what the UI copy calls them (`mission_compiler`, `mesh_signal`, etc.). The mapping
lives in exactly one file, `web/lib/copy.ts` — no marketing term ever appears in a table name,
column name, or route segment.

## 6. What ships to Codex vs. stays with Claude

See the delivery plan (`~/.claude/plans/compressed-humming-sunrise.md`) for the full per-surface
model table. The boundary that matters for API design: **anything in this file or `schema.md` is
Claude-owned.** A Codex brief should never include a request to add a column, change an RLS
policy, or alter the ledger shape — it should cite this file and build against it as fixed.
