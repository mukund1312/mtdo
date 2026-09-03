# mtdo group-study dashboard — CEO-review plan

**Status:** ACTIVE — scope locked, architecture review outstanding
**Created:** 2026-09-03
**Owner:** Mukund Umashankar
**Source:** `/plan-ceo-review` session (24 decisions), branch `mtdo-investor-pitch`
**Supersedes:** the one-line Phase 4 sketch ("Group study rooms") in
`docs/designs/mtdo-web-v1-plan.md` §8 — this doc is the expanded, durable spec for that
feature. The web plan's stack choice (§3: Next.js/Vercel + Supabase) still stands; only the
scope and internal design of the room feature itself is expanded here.
**Related:** `DESIGN.md` (visual system — timing board, presence pill, Record Card already
specified there), `docs/designs/mtdo-web-v1-plan.md` (overall product plan and phase list)

---

## 1. Why this exists

The web plan already identified group study as the growth engine: it's the one feature with
distribution built into the mechanic (you have to invite people to use it), and it's the
strongest known answer to the product's biggest risk — retention, because people abandon
solo goals. This doc is the result of pushing that one line item through a full CEO-mode
scope-expansion review: what should the room actually contain, and what does "collaborative,
not competitive" mean in enough detail to build against.

**North star, unchanged from the original pitch:** *"Study together, even when you're
apart."* The room is a multiplayer commitment system for serious learners, not a study
hangout. Every live session, proof note, streak, and AI summary points back to one question:
*are we actually finishing this goal together?*

## 2. Product shape

**`Today` + `Room` split surface**, chosen over two alternatives:
- *Dashboard-as-remap* (recast `dashboard.py`'s bug-tracker primitives almost directly) —
  cheapest, but keeps a tracker mental model; the first 10 seconds feel administrative, not
  magnetic.
- *Room-first social hub* (room is the homepage) — highest viral upside, but fails the
  empty-room case and weakens solo activation, which has to come first.

`Today` is the solo daily ritual: one next-step card, one start-focus CTA, one personal
progress strip. `Room` is the group growth engine: live presence, shared goal, sessions,
proof, AI manager, identity. Solo works completely on its own; the room is an upgrade, never
a requirement — this constraint shows up again in D9 (ghost squad) and drove several
visibility decisions below (D18-D20).

**Scope mode:** full expansion ("what's the biggest version worth building"), not a
scope-reduction pass — the room is meant to be a second emotional engine (identity) on top
of the first (accountability), not a minimal presence board.

## 3. Locked decisions (D1-D24)

Each entry: the call, and the one-line reason. Full tradeoff writeups (options considered,
completeness scores, effort estimates) live in the `/plan-ceo-review` session transcript this
doc was generated from — reconstruct there if a decision needs to be re-opened.

| # | Decision | Reason |
|---|---|---|
| D1 | Product shape: `Today` + `Room` split | Solves the empty-room problem and the wow problem at once; reuses `dashboard.py`'s status/assignee/filter primitives conceptually without inheriting its tracker feel |
| D2-D3 | Scope mode: full expansion; room owns a real shared-goal model (not just presence) | Differentiates from Focusmate-style presence and generic study-room apps; gives the AI manager something factual to reason about |
| D4 | Real synchronized group focus sessions (not just live presence) | This is the moment users remember and invite friends into — turns "my friends are online" into "we just did this together" |
| D5 | Explicit accountability contracts + participation thresholds | Makes the group system observable instead of vibes-based; retention gets stronger when promises are visible and measurable |
| D6 | AI acts as a real group manager (weekly reviews, pace warnings, lagging-topic detection, suggested challenges), not a chat feature | The moat is coaching/plan intelligence, not the timer — this is the group version of that moat |
| D7 | Required proof-of-progress after sessions (note + optional artifact); milestones mint shareable Record Cards | Rewards real progress instead of attendance; creates the cleanest organic-sharing loop without shallow gamification |
| D8 | "I'm stuck" help lane — **deferred to `TODOS.md`** | Reasonable v1 cut; ship the accountability loop first, add support mechanics after seeing whether groups actually ask each other for help in-product |
| D9 | "Ghost squad" onboarding for solo users (preview lanes, sample pace, invite CTA — explicitly marked as preview, never faked live presence) | "Solve the empty room" was already a hard constraint from the original pitch; this is the honest way to do it |
| D10 | Invite growth + monetization designed in from the start (not retrofitted) | Distribution and pricing are the same decision here — bolting this on later turns the most important business mechanic into retrofit work |
| D11 | Room data model: **hybrid** — room owns the shared goal/deadline/milestones; personal task detail stays personal, links into milestones via lightweight contribution links | Full room-owned graph (all task detail) was more rigorous (10/10) but heavier to model; thin overlay (aggregating personal plans) was faster but let the "shared goal" become cosmetic. Hybrid keeps the goal real without forcing all task detail into room schema |
| D12 | Sessions are **server-authoritative** — backend owns start time, duration, state, membership, completion, grace windows; clients send intents and render server state | Synchronized sessions are a core ritual; rituals break when time is fuzzy. Client-led timers with realtime sync are fragile under mobile sleep, reconnects, and drift |
| D13 | Room progress is **derived** from linked personal completions/proof events — one write path only, never dual-written | Dual-write (completing a task also writing a separate room progress record) creates reconciliation bugs and "why does my task say done while the room still says 62%" support issues |
| D14 | Canonical **append-only activity ledger** (`session_started`, `joined_room_session`, `proof_submitted`, `task_completed`, `milestone_progressed`, ...) as source of truth; counters/streaks/summaries are derived/materialized from it | This product's value depends on trust; mutable counters are fast to build but fragile — one bad update silently poisons streaks and pace warnings with no clean recovery path |
| D15 | AI manager runs **async**, reading from the ledger — never in the request path | The room is a realtime product; the AI layer is analysis on top of it, not something that should hold the UI hostage. Tying generation to live user actions creates slow screens and flaky retries in the core loop |
| D16 | Study Profile + Rank + Radar + Squad Rank becomes a **main product pillar**, not a secondary stats page | Adds a second emotional engine (identity) on top of accountability — but only if grounded in real behavior, not childish gamification |
| D17 | Rank/XP/radar attributes are **fully derived from the same activity ledger** — no separate writable progression system | A separate XP economy gets farmed instead of studied; deriving from the ledger keeps identity honest and re-tunable without corrupting history |
| D18 | Individual rank is **private-first**; squad sees squad-level rank + coarse signals only (streak/consistency bands), never a constant exact peer ranking table | Protects the "collaborative, not competitive" rule from D1 — public exact rank would undermine the exact retention principle (the struggler should feel supported, not ranked against friends) |
| D19 | Sharing is **explicit export / opt-in** (record cards, optional public snapshot) — no default-public profile pages | This is a product about goals people may feel vulnerable about, not throwaway game stats; default-public exposure would make users hesitate to use the identity system honestly |
| D20 | Proof artifacts get **mixed per-artifact visibility controls** (private / squad-visible / shareable-externally), chosen over private-by-default or fully-public | *(User chose C here over the recommended "private by default, squad-visible summary" — accepted the added settings-complexity cost for full per-artifact control)* |
| D21 | Achievements/challenges stay **cosmetic**, never feed into core rank computation (the capped-bonus hybrid was explicitly rejected) | Protects the seriousness of the identity system — if side-systems can move rank, users optimize for badge-farming instead of real progress |
| D22 | Rank formulas are **versioned and explainable**, recomputable when weights change later — never silently retuned in place | A serious performance system has to be auditable; silent score shifts make rank feel arbitrary and erode trust in the whole identity pillar |
| D23 | Free tier: **hard cap of 4 members per room**; the 5th accepted invite triggers an explicit "someone needs to upgrade this room" state | The sharpest, most marketable version of the original pitch's growth mechanic ("the group grows, hits the limit, one person upgrades on behalf of everyone") |
| D24 | Build sequencing: **Phase 1** = ledger + Today + Room core loop (goal, presence, sessions, proof, streak). **Phase 2** = AI manager + accountability contracts + invites/billing. **Phase 3** = identity/rank/radar pillar, deliberately last | Matches the actual data dependency — D17 explicitly derives rank from the ledger, so it structurally can't be built first. Phase 1 alone is enough to test the core "study together" hypothesis before investing in identity |

## 4. What this explicitly is not

- **Not** a ranked leaderboard, anywhere the squad can see it (D1, D18). If a future change
  proposes exposing exact peer rank by default, treat that as reopening D18, not a UI tweak.
- **Not** generic chat. The one social-input surface considered (a "stuck" help lane) was cut
  even in deferred form's alternative — full chat was rejected outright, not deferred.
- **Not** a separate XP economy. Every number on the identity pillar must trace back to a
  ledger event (D17). If an implementation adds a writable score field anywhere outside the
  ledger-derived path, that's a violation of this spec, not a shortcut.
- **Not** built to run its AI layer synchronously. If the AI manager ever ends up in a request
  path (e.g., "generate my weekly review on page load"), that's a regression against D15.

## 5. Known open item

**Architecture review (`/plan-eng-review`) has not run yet.** Before implementation starts,
schema, API surface, and realtime-infra choice (Supabase Realtime vs. alternatives for
presence/sessions) still need a dedicated eng-manager-mode pass. That review already
surfaced one load-bearing scope question worth resolving first: whether to design all three
phases' schemas now, or design Phase 1 completely and treat Phase 2-3 as forward-compatible
but undesigned until real ledger data exists (recommended, since D17's rank formulas are
explicitly meant to be tuned against real behavior, not guessed at up front). Re-run
`/plan-eng-review` against this doc when ready to resolve that and produce the actual schema.

## 6. Deferred (tracked, not rejected)

Add to `TODOS.md` (does not yet exist in this repo — create it alongside this doc, or on
first use):
- **D8:** "I'm stuck" structured help-request lane — visible to squad + optionally AI, with a
  resolved/unresolved state. Revisit after Phase 1 ships and real groups are observed either
  asking each other for help in-product or leaving to solve it elsewhere.

## 7. Decisions log

| Date | Decision | Rationale |
|---|---|---|
| 2026-09-03 | `Today` + `Room` split surface chosen over dashboard-as-remap and room-first-hub | Balances empty-room risk against growth upside; matches existing web plan's activation-first phase ordering |
| 2026-09-03 | Full scope-expansion mode for the room feature | Room is the growth engine per the original pitch; worth building the complete version rather than a minimal presence board |
| 2026-09-03 | Hybrid room-ownership data model (not full room-owned graph, not thin overlay) | Balances shared-goal integrity against modeling cost |
| 2026-09-03 | Server-authoritative sessions | Synchronized sessions are a core ritual; client-led timers are too fragile under real network conditions |
| 2026-09-03 | Canonical append-only activity ledger as source of truth | Every downstream feature (streaks, pace, rank, AI summaries) needs one trustworthy event history |
| 2026-09-03 | Identity pillar (profile/rank/radar/squad rank) promoted to main pillar, fully ledger-derived | Adds an identity-based emotional engine without risking a separate, farmable score economy |
| 2026-09-03 | Mixed per-artifact proof visibility (chosen over the recommended private-by-default) | User prioritized granular per-artifact control over the simpler default; logged as a deliberate divergence from the CEO-review recommendation |
| 2026-09-03 | Hard 4-member free cap, upgrade-unlocks-room-for-everyone billing | Sharpest version of the original "one person upgrades on behalf of everyone" growth mechanic |
| 2026-09-03 | 3-phase build sequencing, identity pillar last | Rank/XP is contractually derived from ledger data that doesn't exist until Phase 1 has run |
