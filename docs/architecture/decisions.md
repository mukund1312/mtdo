# mtdo web — architecture decisions log

**Status:** ACTIVE. **Created:** 2026-09-04.

Durable record of engineering-layer decisions that don't fit `DESIGN.md` (visual) or the product
plan docs (`docs/designs/*.md`). Each entry: the call, and the reason.

| Date | Decision | Reason |
|---|---|---|
| 2026-09-04 | **Monorepo** — web app lives at `web/` inside `~/mtdo`, not a separate repo | `DESIGN.md` and both product-plan docs already live here; Phase W5's `mtdo serve --bridge` couples web to the Python app |
| 2026-09-04 | **Shared seam designed now, room-only tables deferred** (`schema.md` §1-2) | D12-D14 force the ledger/session shape regardless of when rooms ship; room-only tables' shapes depend on real ledger data per D17 |
| 2026-09-04 | **Supabase anonymous auth from first visit**, upgraded in place | Every `activity_events` row needs a real `user_id` from event #1 for RLS to work uniformly and for the product's "delayed signup" goal (only prompt when there's a streak worth losing) to not create a data gap in exactly the window activation data matters most |
| 2026-09-04 | **Sessions are server-authoritative** (D12) | Synchronized group sessions are a core ritual; client-led timers are too fragile under phone sleep, reconnects, and clock drift. Building this into the solo path from day one means the room version later is the same code path, not a rewrite |
| 2026-09-04 | **AI Tutor scope upgraded to real cross-session memory**, not prompt polish | `coaching.py` is stateless; a flagship-marketed AI tutor needs to remember what a user struggled with. Requires new schema (`schema.md` §3) and a deliberate retrieval strategy (rolling summary, not full-history replay) to keep cost bounded |
| 2026-09-04 | **Soft free-tier tutor-message cap**, enforced via ledger counts, ahead of Stripe (W6) | A stateful, per-message-cost AI feature running unmetered against free users for months is a real bill. Cheap now (a `WHERE` clause over an existing table); expensive to discover the need for later |
| 2026-09-04 | **EmberMorph built as a standalone, importable component**, not inlined in the session route | The marketing site's web↔terminal showcase reuses this exact component rather than a second bespoke build — one animation, two contexts, no drift between "what marketing shows" and "what the product does" |
| 2026-09-04 | **Design is per-wave, drafted as a Claude Design canvas from `DESIGN.md`**, not one upfront design phase | Approving a design in the abstract (spec text) vs. a real clickable draft is the actual blocker for someone new to design; a canvas per wave means never approving screens for work that's months out, and never building a screen twice |
| 2026-09-04 | **Codex (CLI, confirmed installed) takes isolated, already-contracted screen builds; Claude keeps schema/RLS/ledger/session-authority/AI backend** | A wrong decision in the Claude-owned surfaces cascades into every feature built on top; a wrong decision in an isolated screen is local and cheap to redo. See the delivery plan for the full per-surface model assignment (`claude-opus-5` / `claude-sonnet-5` / `claude-haiku-4-5-20251001` / Codex's `gpt-5.6-terra` / `gpt-5.4-mini`) |
| 2026-09-04 | **`ci.yml` split with path filters**, new `ci-web.yml` added | `ci.yml` ran the full ~4-minute pytest suite on every PR regardless of what changed; `web/` PRs now run `ci-web.yml` (typecheck+lint+build) instead |
| 2026-09-04 | **`typescript` pinned to `6.0.3`, not the latest `7.0.2`** | TypeScript 7 is a real, current stable release (the native-compiler rewrite), but `typescript-eslint@8.69.0` (bundled by `eslint-config-next@16.3.4`) hard-fails on it (`typescript-eslint does not support TS 7.0`) — not a warning, a crash. 6.0.3 is the highest version the actual installed toolchain supports (`typescript-eslint`'s declared peer range is `>=4.8.4 <6.1.0`). Revisit once `eslint-config-next` ships a `typescript-eslint` version that supports TS 7 |
| 2026-09-04 | **`eslint` pinned to `9.39.5`, not the latest `10.x`** | ESLint 10 breaks `eslint-config-next@16.3.4`'s bundled `eslint-plugin-react` two different ways: `FlatCompat` produces a circular-JSON crash, and after switching to the config's native flat-config exports (`eslint-config-next/core-web-vitals` + `/typescript`, no `FlatCompat` needed), `eslint-plugin-react`'s `react/display-name` rule still crashes on every file (`contextOrFilename.getFilename is not a function` — ESLint 10 removed `context.getFilename()`). 9.39.5 is EOL (no more security patches) but is what this config package's bundled plugins were actually built against, and the config is now native-flat (no `@eslint/eslintrc`/`FlatCompat` dependency). Revisit once `eslint-config-next` updates for ESLint 10's API |
| 2026-09-04 | **`next lint` removed from scripts**, calls `eslint .` directly | Next.js 16 removed the `next lint` subcommand entirely (`next --help` no longer lists it) |
| 2026-09-04 | **`middleware.ts` written as `proxy.ts`** | Next.js 16 renamed the file convention (function export also renamed `middleware` → `proxy`); functionality is unchanged, only the name |
| 2026-09-04 | **Server-authoritative writes are `security definer` RPCs, not RLS policies** (sessions, ledger); client tables carry explicit `REVOKE`s, not just missing policies | Full writeup below — an adversarial audit found D12/D13/D14/D17/D21 were unenforced and the ledger forgeable |
| 2026-09-04 | **Every pinned version and config choice above was verified**, not assumed | `npm view <pkg> version`/`versions` for real current releases, then a full `rm -rf node_modules && npm ci` + `tsc --noEmit` + `eslint .` + `next build` pass before committing — three real, current ecosystem incompatibilities (TS7, FlatCompat, `getFilename`) were caught this way and would otherwise have shipped broken |

---

## 2026-09-04 — Adversarial schema/RLS audit, and the rewrite it forced

An Opus adversarial audit was run against `0001_seam.sql` / `0002_tutor_memory.sql` before
anything was deployed (no Supabase project existed yet, so both files were corrected in place
rather than patched by an `0003`). The question it asked of every policy was not "does this look
right" but **"what can a malicious authenticated client actually do, given exactly the policy as
written"**. The answer was: quite a lot. Four findings were blocking.

**What it found**

1. **`focus_sessions` was fully client-writable, so D12 was a comment, not a rule.** The policy
   was `for all using (auth.uid() = user_id)`, and `started_at` was only a `default now()` —
   which is not a stamp. A client could insert a fabricated multi-hour `completed` session, or
   `UPDATE` a running session's start time. Every "server-authoritative" claim downstream rested
   on this and was false.
2. **The ledger was forgeable.** `activity_events`' insert policy validated only
   `auth.uid() = user_id`; the client chose `occurred_at`, `kind` and `payload` freely. Since
   UPDATE/DELETE are (correctly) denied, a forged row was *permanent*. This broke D13 (derived
   rollups), D17/D21 (rank must be ledger-derived and unfarmable), and the tutor cap at once.
3. **`tutor_messages` let clients write `role='assistant'`,** and the free-tier cap was
   unenforceable. Forged assistant turns get folded into the rolling summary and fed back to the
   model as its own prior words — prompt injection laundered through memory. The cap depended on
   the client honestly emitting `tutor_message_sent` alongside its own insert; not emitting it
   was the entire bypass.
4. **`daily_rollups`' `(user_id, date)` primary key could not absorb a nullable `room_id`** — the
   seam had simply not been applied to the derived table, and that gets structurally harder to
   fix once the table holds data.

Plus a long tail: `on delete cascade` from `plans` meant retiring a goal would wipe all
historical `blocks` (against the free tier's "30 days of history" promise); ownership was checked
only via `user_id` while every *other* FK on `blocks`/`focus_sessions`/`proofs` went unvalidated;
nothing prevented two simultaneous `running` sessions; and a dozen invariants documented in prose
had no constraint behind them.

**What changed**

| Area | Change |
|---|---|
| Session writes | `focus_sessions` is **SELECT-only** to clients. Writes go through `security definer` RPCs `start_session` / `complete_session` / `abandon_session`, which derive `user_id` from `auth.uid()` and stamp `started_at`/`completed_at` from the server clock — none of the four is a parameter. Owner and `state = 'running'` are re-checked inside each function. A partial unique index enforces one running session per user. |
| Ledger writes | `activity_events` is **SELECT-only** to clients. `record_event(p_kind, p_payload)` is the only append path: it sets `user_id` and `occurred_at` internally, validates `kind` against a client-appendable whitelist, and caps payloads at 4 KB. `session_*` and `tutor_message_sent` are deliberately **outside** that whitelist — they are minted by the session RPCs and by the tutor backend, which is what makes focus time and metered AI usage unfarmable and the cap enforceable. |
| Tutor | `tutor_messages` is revoked entirely from clients (reads included); `tutor_context()` is the sanctioned read path, returning summary + a bounded recent window in one call. `source_message_count` → `summarized_through timestamptz`, because a count cannot identify *which* messages a summary covered. |
| `daily_rollups` | Surrogate `id` PK, nullable `room_id`, `computed_at`, and `unique nulls not distinct (user_id, date, room_id)`. |
| Ownership | Composite FKs throughout: a block's plan and category, a session's block, a proof's session and block must all belong to the same user. Not exploitable while ids are unguessable UUIDs — exploitable the moment room members can see each other's ids (W4a), which is exactly when it would be hardest to retrofit. |
| History | No DELETE policy on `plans`/`plan_categories`; `blocks` references them `on delete restrict`. Retiring a goal is `is_active = false`. |
| Constraints/indexes | Duration bounds, `state`↔`completed_at` agreement, non-negative counters, non-blank proof bodies, a `kind` whitelist, one active plan per user, a deferrable slot key so drag-and-drop reorders work, and indexes on every FK and hot path. |

**Two decisions worth their own note.**

*Grants, not just policies.* Supabase's default privileges grant `all` on tables *and functions*
to `anon`/`authenticated`, so "no policy for that command" is an incidental denial that a future
`for all` policy added by copy-paste habit would silently undo. Every server-authoritative table
now carries an explicit `REVOKE`. Two consequences fell out that the audit had not listed:
`revoke execute … from public` is **not** enough to hide an internal function (the roles hold
their own grants and must be named), and `grant all on tables` includes **TRUNCATE**, which is
not subject to RLS — one `TRUNCATE` would have emptied the append-only ledger for every user.
Both are now revoked, and TRUNCATE/REFERENCES/TRIGGER are removed from the default privileges for
future tables.

*Verified by execution, not by reading.* The audit's own instruction was to verify by careful
manual reading, since no Supabase project exists. A local PostgreSQL 18 cluster was used instead:
both migrations were run against a stubbed `auth` schema and Supabase's real default-privilege
configuration, then attacked from `authenticated`, `anon` and `service_role` sessions — roughly
sixty assertions covering every finding above. Two things this caught that reading would not
have. First, the audit specified `for select, insert, update` as one policy; Postgres allows only
one command per policy, so it is three. Second, `on delete restrict` on `blocks.plan_id` looked
like it would break GDPR account deletion (the `auth.users` cascade deletes plans, whose blocks
restrict the delete) — it does not, because the cascade removes plans and blocks inside one
statement and RI checks drain at the end of it. That was worth proving rather than reasoning
about, since being wrong would have meant an undeletable account.

**Explicitly not fixed, and why.** `profiles.is_anonymous` remains client-updatable — it is
informational, nothing depends on it as an auth signal, and reworking it to derive from
`auth.jwt()` is scope creep with no current security consequence. It carries a comment saying so.
The anonymous-user-cleanup vs. activation-funnel tension (`on delete cascade` from `auth.users`
would delete exactly the never-signed-up visitors that D1/D7 retention is measured over) is a
product decision, not a schema one; it is flagged in a prominent comment on `activity_events` and
`daily_rollups` rather than pre-empted.

---

## Open, not yet decided

- Exact `EmberMorph` prop API (owner: whoever implements the W1 Session screen).
- Whether the founder-facing analytics need anything beyond PostHog (deferred until W2 has real
  users — don't build speculatively).
- Realtime infrastructure choice for room presence (Supabase Realtime is the working assumption
  from the product plan; not re-validated at the engineering level since rooms are still W4a+).
