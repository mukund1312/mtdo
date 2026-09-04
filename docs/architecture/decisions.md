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
| 2026-09-04 | **`ci.yml` needs path filters** (`src/**`+`tests/**` vs. `web/**`) | Currently runs the full ~4-minute pytest suite on every PR regardless of what changed |

## Open, not yet decided

- Exact `EmberMorph` prop API (owner: whoever implements the W1 Session screen).
- Whether the founder-facing analytics need anything beyond PostHog (deferred until W2 has real
  users — don't build speculatively).
- Realtime infrastructure choice for room presence (Supabase Realtime is the working assumption
  from the product plan; not re-validated at the engineering level since rooms are still W4a+).
