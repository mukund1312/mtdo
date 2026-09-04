# mtdo web — schema

**Status:** ACTIVE — source of truth for the Supabase schema.
**Created:** 2026-09-04
**Related:** `docs/designs/mtdo-web-v1-plan.md` (product plan), `docs/designs/mtdo-group-study-dashboard-plan.md`
(group study decisions D1-D24), `DESIGN.md` (Ember Graphite, the morph).

This is the missing engineering layer the group-study doc's §5 flagged as outstanding
("Architecture review has not run yet"). It designs the seam between the solo webapp and the
group-study room so the room is **additive, not a rewrite** — see §1.

---

## 1. The seam: how the solo webapp and group study join

Two columns do the joining:

```sql
activity_events (..., room_id uuid null)   -- null = solo, set = room activity
focus_sessions  (..., room_id uuid null)   -- same table serves solo and synchronized room sessions
```

This shape is forced by the group-study spec, not chosen freely:

- **D14** — an append-only activity ledger is the source of truth for everything downstream
  (streaks, pace, rank, AI summaries).
- **D13** — room progress is *derived* from personal completions, one write path only, never
  dual-written.
- **D12** — sessions are server-authoritative; client-led timers are too fragile under real
  network conditions (phone sleep, reconnects, clock drift).

**Consequence:** if the solo app wrote mutable streak counters and let the client own timer state,
building group study later would mean rewriting the core loop. Writing to the ledger and letting
the server own session time **from day one** means the room is a `room_id` plus a few extra
tables layered on top of an unchanged solo path.

---

## 2. Seam tables — build now

`user_id` on every row; RLS policy `auth.uid() = user_id` unless noted otherwise.

```sql
-- identity
profiles(id uuid pk → auth.users, display_name, is_anonymous bool, created_at)

-- the plan (ports goals.json)
plans(id, user_id, app_name, goal_line, is_active, created_at)
plan_categories(id, plan_id, name, label, days int[], min_blocks, score_weight,
                topic_type, coaching_framework jsonb, sort_order)
curriculum_items(id, category_id, week_index, position, task, meta jsonb)
  -- meta keeps focus_points/questions/mistakes/tips/mental_models as jsonb:
  -- rich, nested, always read whole. Do not over-normalize.

-- daily work (ports state.json per-date entries)
blocks(id, user_id, plan_id, category_id, date, position, text,
       status check in ('todo','in_progress','done'), notes, coaching jsonb,
       claimed, started_at, elapsed_seconds, completed_at,
       unique(user_id, date, category_id, position))

-- THE LEDGER (D14) — append-only, source of truth
activity_events(id bigint identity pk, user_id, room_id null, session_id null,
                kind text, occurred_at timestamptz default now(), payload jsonb)
  -- RLS grants INSERT + SELECT only. No UPDATE, no DELETE, ever.
  -- Corrections are compensating events, not mutations.

-- server-authoritative sessions (D12) — one table, solo and room
focus_sessions(id, user_id, room_id null, block_id null,
               started_at timestamptz default now(),   -- SERVER stamps, never the client
               planned_duration_s, state check in ('running','completed','abandoned'),
               completed_at, grace_expires_at)

-- proof (D7) — visibility enum fixed now, only 'private' built in solo phases
proofs(id, user_id, session_id, block_id, body, artifact_url,
       visibility check in ('private','squad','public'))

-- direct ports of state.json reserved keys
notes(id, user_id, title, body, tags text[], created_at, updated_at)      -- _notes
companies(id, user_id, name, status, date_added, notes)                   -- _companies

-- derived, NEVER hand-written (D13) — materialized from activity_events
daily_rollups(user_id, date, blocks_done, focus_seconds, sessions_completed)
```

**Deliberately not designed yet** (room-only, shapes stay open until Phase W4a): `rooms`,
`room_members`, `room_goals`, `milestones`, `contribution_links`, `accountability_contracts`,
`rank_snapshots`. Per D17, rank formulas are meant to be tuned against real ledger data that
doesn't exist until Phase 1 (W4a) has run.

---

## 3. AI Tutor Memory (added 2026-09-04)

The AI tutor's scope was upgraded from "better prompts" to real conversational memory across
sessions — a genuinely new subsystem, additive to the seam above, sequenced as Wave **W3b**.

```sql
tutor_conversations(id, user_id, created_at, last_message_at)
tutor_messages(id, conversation_id, role check in ('user','assistant'), content, created_at)
tutor_memory_summaries(user_id pk, summary text, updated_at, source_message_count)
```

**Do not replay full history on every request** — cost and latency both blow up by month two.
`tutor_memory_summaries` holds a rolling summary, regenerated periodically (not per-message),
which is what makes memory affordable. **This retrieval strategy is a single design decision,
made once, before any implementation runs against it** — get it wrong once and it's wrong for
every user forever, the same tier of mistake as a bad schema choice.

**Soft free-tier usage cap**, enforced via `activity_events` counts (a `WHERE` clause over the
existing ledger, not new infra): N tutor messages/day on the free tier. Stripe is deliberately
deferred to Phase W6, but a stateful, per-message-cost AI feature running unmetered against free
users for months is a real bill, not a hypothetical one — this cap is cheap to build now and
graduates into the real paywall at W6.

---

## 4. Sessions are server-authoritative (D12)

The client sends **intents** (`start`, `complete`, `abandon`); the server stamps `started_at`.
The timer renders `started_at + planned_duration_s − now()`. This is what survives phone sleep,
reconnects, and clock drift — and it is why the room version of a session later reuses the exact
same code path rather than needing a new one.

## 5. RLS

- Every table above: `auth.uid() = user_id`.
- `activity_events`: **INSERT + SELECT only**. No `UPDATE`, no `DELETE`, ever, for any role except
  a service-role migration path. Corrections are compensating events appended to the ledger, not
  mutations of history.
- Auth model: Supabase **anonymous auth from first visit**, upgraded in place to a real account.
  Every ledger event carries a real `user_id` from event #1 — no pre-signup gap in the data, and
  no migration needed when a user later signs up for real (same row, same id).

## 6. What to reuse from the terminal app (`src/mtdo/`)

| Reuse | Where | Note |
|---|---|---|
| Ledger pattern | `analytics.py` | Already an append-only event table with hashed refs — D14 has a working precedent in this repo |
| Event vocabulary | `analytics.py` | `task_completed`, `pomodoro_started/completed`, `focus_mode_toggled`, `screen_opened`… substantially overlaps the web plan's required event list |
| Coaching logic | `coaching.py` (505 LOC) | Pure prompt-builders + parsers, **no network calls** — port directly, don't re-derive |
| Plan shape | `config.py` `goals_to_config()` | The goals.json → normalized-config conversion is the schema mapping above, already written once |
| Friction detectors | `analytics.py` | `friction_task_flapping`, `friction_abandoned_onboarding`, … → become SQL views over `activity_events` |

**Do not port:** the profile envelope encryption (Fernet + PBKDF2 double-wrapped data key).
Supabase RLS replaces it; porting client-side zero-knowledge encryption would block every
server-derived feature — rank, the AI manager, group progress.

**Nothing to reuse from `dashboard.py`** — it's a maintainer bug-tracker HTML generator, unrelated
to the product.
