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
| 2026-09-04 | **Every pinned version and config choice above was verified**, not assumed | `npm view <pkg> version`/`versions` for real current releases, then a full `rm -rf node_modules && npm ci` + `tsc --noEmit` + `eslint .` + `next build` pass before committing — three real, current ecosystem incompatibilities (TS7, FlatCompat, `getFilename`) were caught this way and would otherwise have shipped broken |

## Open, not yet decided

- Exact `EmberMorph` prop API (owner: whoever implements the W1 Session screen).
- Whether the founder-facing analytics need anything beyond PostHog (deferred until W2 has real
  users — don't build speculatively).
- Realtime infrastructure choice for room presence (Supabase Realtime is the working assumption
  from the product plan; not re-validated at the engineering level since rooms are still W4a+).
