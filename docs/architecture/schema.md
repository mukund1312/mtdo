# mtdo web — schema

**Status:** ACTIVE — source of truth for the Supabase schema.
**Created:** 2026-09-04
**Last revised:** 2026-09-04 (adversarial schema/RLS audit — see `decisions.md`)
**Related:** `docs/designs/mtdo-web-v1-plan.md` (product plan), `docs/designs/mtdo-group-study-dashboard-plan.md`
(group study decisions D1-D24), `DESIGN.md` (Ember Graphite, the morph).

This is the missing engineering layer the group-study doc's §5 flagged as outstanding
("Architecture review has not run yet"). It designs the seam between the solo webapp and the
group-study room so the room is **additive, not a rewrite** — see §1.

> **The SQL is the source of truth, this document is its explanation.**
> `supabase/migrations/0001_seam.sql` and `0002_tutor_memory.sql` carry a security-model
> header that must be read before adding any policy, grant, or table. Requires **PostgreSQL
> 15+** (Supabase's floor).

---

## 1. The seam: how the solo webapp and group study join

Two columns do the joining:

```sql
activity_events (..., room_id uuid null)   -- null = solo, set = room activity
focus_sessions  (..., room_id uuid null)   -- same table serves solo and synchronized room sessions
daily_rollups   (..., room_id uuid null)   -- the same seam on the derived table
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

**What `room_id` does and does not capture.** `activity_events.room_id` records only that an
event *happened inside a room session*. It is not the whole of D13's room-progress derivation:
solo work that a member contributes toward a shared room goal carries `room_id = null` and will
be attributed through the `contribution_links` join path, which is deliberately deferred to W4a
along with the rest of the room tables. Do not build a room-progress query that assumes
`room_id` alone is sufficient.

**Until rooms exist, `room_id` is fenced shut.** `activity_events` and `focus_sessions` both
carry `check (room_id is null)`. There is no membership check to validate a room id against yet,
and the ledger has no DELETE path by design — so anything written now would be stuck forever.
The W4a migration drops those two CHECKs (a catalog-only operation) and replaces them with a real
membership check.

---

## 2. Seam tables — build now

`user_id` on every row. RLS is `(select auth.uid()) = user_id`, scoped `to authenticated`,
unless noted otherwise. **Read §6 for which tables are client-writable at all** — several of
these are read-only to clients and are written exclusively through the functions in §5/§6.

```sql
-- identity
profiles(id uuid pk → auth.users, display_name, is_anonymous, created_at)
  -- is_anonymous is INFORMATIONAL ONLY; never an auth signal (the JWT claim is).
  -- Created automatically by an `after insert on auth.users` trigger.

-- the plan (ports goals.json)
plans(id, user_id, app_name, goal_line, is_active, created_at,
      unique(id, user_id))                      -- composite-FK target
  -- unique index plans_one_active (user_id) where is_active  → free tier's "one goal"
plan_categories(id, plan_id, name, label, days int[], min_blocks, score_weight,
                topic_type, coaching_framework jsonb, sort_order,
                unique(plan_id, name), unique(id, plan_id))
curriculum_items(id, category_id, week_index, position, task, meta jsonb)
  -- meta keeps focus_points/questions/mistakes/tips/mental_models as jsonb:
  -- rich, nested, always read whole. Do not over-normalize.

-- daily work (ports state.json per-date entries)
blocks(id, user_id, plan_id, category_id, date, position, text,
       status check in ('todo','in_progress','done'), notes, coaching jsonb,
       claimed, started_at, elapsed_seconds check (>= 0), completed_at,
       unique(user_id, date, category_id, position) DEFERRABLE INITIALLY DEFERRED,
       unique(id, user_id),
       fk (plan_id, user_id)     → plans (id, user_id)              on delete restrict,
       fk (category_id, plan_id) → plan_categories (id, plan_id)    on delete restrict)
  -- blocks.elapsed_seconds is a client-maintained convenience mirror. It is NOT a
  -- trustworthy focus-time source — the rollup job must use focus_sessions/the ledger.

-- THE LEDGER (D14) — append-only, source of truth
activity_events(id bigint identity pk, user_id, room_id null, session_id null,
                kind text check in (§4's list), occurred_at timestamptz, payload jsonb)
  -- Clients get SELECT only. Appends go through record_event() (§6). INSERT/UPDATE/
  -- DELETE/TRUNCATE are REVOKED, not merely unpolicied.

-- server-authoritative sessions (D12) — one table, solo and room
focus_sessions(id, user_id, room_id null, block_id null,
               started_at,                              -- SERVER stamps, never the client
               planned_duration_s check (> 0 and <= 86400),
               state check in ('running','completed','abandoned'),
               completed_at, grace_expires_at,
               check ((state = 'running') = (completed_at is null)),
               unique(id, user_id),
               fk (block_id, user_id) → blocks (id, user_id) on delete set null (block_id))
  -- unique index focus_sessions_one_running (user_id) where state = 'running'
  -- Clients get SELECT only; all writes go through start/complete/abandon_session() (§5).

-- proof (D7) — visibility enum fixed now, only 'private' built in solo phases
proofs(id, user_id, session_id, block_id, body NOT NULL check (btrim <> ''),
       artifact_url, visibility check in ('private','squad','public'), created_at,
       fk (session_id, user_id) → focus_sessions (id, user_id) on delete set null (session_id),
       fk (block_id, user_id)   → blocks (id, user_id)         on delete set null (block_id))
  -- D7 reads "note + optional artifact": the note is required, the artifact is the
  -- optional add-on. An artifact-only proof is deliberately not storable.

-- direct ports of state.json reserved keys
notes(id, user_id, title, body, tags text[], created_at, updated_at)      -- _notes
  -- updated_at is maintained by a `before update` trigger, not by the client.
companies(id, user_id, name, status check in (…), date_added, notes)     -- _companies
  -- status mirrors CAREER_STATUSES in src/mtdo/core.py:
  -- 'applied','oa','interview','offer','rejected','ghosted'. One vocabulary across
  -- the terminal CRM and the web CRM, because the Phase 5 bridge shares this data.

-- derived, NEVER hand-written (D13) — materialized from activity_events
daily_rollups(id uuid pk, user_id, date, room_id null,
              blocks_done, focus_seconds, sessions_completed (each check >= 0),
              computed_at,
              unique nulls not distinct (user_id, date, room_id))
  -- Clients get SELECT only. Written by a future service-role recompute job.
```

**The composite foreign keys are the point, not decoration.** `user_id` on a row proves only
that the row *claims* to be yours. The composite FKs prove that everything the row *references*
is yours too: a block's plan belongs to the same user, a block's category belongs to that same
plan, a session's block belongs to the session's user, a proof's session and block belong to the
proof's user. Without them, ownership was checked in exactly one place per table and every other
foreign key was unvalidated — not exploitable while ids are unguessable UUIDv4s, but exploitable
the moment room members can see each other's ids (W4a), which is precisely when it would be
hardest to retrofit.

**Retiring a goal is `is_active = false`, never a DELETE.** `plans` and `plan_categories` have
no DELETE policy, and `blocks` references them `on delete restrict`. Blocks hold the user's whole
progress history, and the free tier's headline promise is 30 days of it; a "delete goal" button
wired to a real DELETE would silently destroy exactly that. Account deletion still works — the
`auth.users` cascade removes plans and blocks inside one statement, so the RESTRICT check finds
nothing left to protect (verified against a real Postgres, not assumed).

**Deliberately not designed yet** (room-only, shapes stay open until Phase W4a): `rooms`,
`room_members`, `room_goals`, `milestones`, `contribution_links`, `accountability_contracts`,
`rank_snapshots`. Per D17, rank formulas are meant to be tuned against real ledger data that
doesn't exist until Phase 1 (W4a) has run.

**Data-retention tension, flagged not solved.** `on delete cascade` from `auth.users` is right
for a real account deletion (GDPR deletion has to actually work). But this product creates an
*anonymous* user on first visit, and Supabase can reap anonymous users on a schedule — which
would delete exactly the activation-funnel population that the product's only two early metrics
(activation, D1/D7 retention) are measured over. `activity_events` and `daily_rollups` carry this
warning in the SQL itself, at the point of maximum relevance. Whoever wires up anonymous-user
cleanup owns the decision.

---

## 3. AI Tutor Memory (added 2026-09-04)

The AI tutor's scope was upgraded from "better prompts" to real conversational memory across
sessions — a genuinely new subsystem, additive to the seam above, sequenced as Wave **W3b**.

```sql
tutor_conversations(id, user_id, created_at, last_message_at)   -- client-owned (full CRUD)
tutor_messages(id, conversation_id, role check in ('user','assistant'), content, created_at)
  -- NO client access at all: select/insert/update/delete revoked. Written only by the
  -- future chat backend (service role); read only through tutor_context().
tutor_memory_summaries(user_id pk, summary text, updated_at, summarized_through timestamptz)
  -- select-only for the owning user; written by the future summarization job.
```

**Do not replay full history on every request** — cost and latency both blow up by month two.
`tutor_memory_summaries` holds a rolling summary, regenerated periodically (not per-message),
which is what makes memory affordable. **This retrieval strategy is a single design decision,
made once, before any implementation runs against it** — get it wrong once and it's wrong for
every user forever, the same tier of mistake as a bad schema choice.

Two things enforce that rather than merely recommending it:

- **`tutor_context(p_conversation_id, p_recent_limit default 20)`** is the only read path granted
  to clients. It verifies conversation ownership server-side and returns `(summary text, recent
  jsonb)` — the rolling summary plus a bounded window of recent messages, oldest-first, in one
  round trip. `p_recent_limit` is clamped to 1..100. Because direct `select` on `tutor_messages`
  is revoked, "just fetch the whole thread" is not a call site anyone can write by accident.
- **`summarized_through timestamptz`** replaces the original `source_message_count integer`. A
  count cannot say *which* messages a summary covered, so any insert, backfill, or out-of-order
  write silently desynchronizes it and the summary starts skipping or repeating. A watermark
  makes the uncovered tail an exact query:
  `where conversation_id = $1 and created_at > summarized_through order by created_at`.

**Why the client cannot write `tutor_messages`.** The original policy checked conversation
ownership and nothing else — notably not `role`. A client could therefore insert its own
`role='assistant'` messages, which the summarization job would fold into the rolling summary and
feed back to the model as its own prior words: a self-directed prompt-injection channel,
laundered through memory. The chat backend (a Route Handler using the service-role key, **not
built yet**) becomes the only writer.

**Soft free-tier usage cap**, enforced via `activity_events` counts (a `WHERE` clause over the
existing ledger, not new infra): N tutor messages/day on the free tier. The cap used to depend on
the client honestly emitting a `tutor_message_sent` event alongside its own message insert —
trivially bypassed by just not emitting it. Now `tutor_message_sent` is **not** in
`record_event()`'s client-appendable list, so the same backend that writes the message writes the
event, as service_role, in the same transaction. Keep those two writes in one transaction: the
cap is only as good as that pairing. Stripe is deliberately deferred to Phase W6, but a stateful,
per-message-cost AI feature running unmetered against free users for months is a real bill.

---

## 4. Canonical event vocabulary (the ledger's `kind`)

Three different event lists existed across the docs — this section's predecessor, the group-study
D14 list, and the web plan's PostHog list — and they disagreed. This is now the single canonical
list, enforced as a `check` constraint on `activity_events.kind`.

The rules that produced it:

1. **The ledger stores facts that happened**, one row per fact. Anything *derivable* from those
   facts is computed at read time and never stored as an event.
2. **PostHog is a different sink.** The web plan's instrumentation list is product analytics;
   overlapping names are fine, but a PostHog event is not automatically a ledger event.
3. **Room events wait for rooms.** `room_id` is fenced null until W4a (§1), so room-only kinds
   would be unwritable anyway.
4. **Anything that must be unfarmable is server-minted**, because D17/D21 require rank to be
   ledger-derived and not gameable.

| `kind` | Written by | Note |
|---|---|---|
| `signup` | client via `record_event()` | anonymous → real account upgrade |
| `goal_created` | client | |
| `plan_generated` | client | |
| `task_completed` | client | a user really can complete a task; nothing is fabricated by claiming it |
| `task_regressed` | client | mirrors the terminal app's `task_regressed` |
| `proof_submitted` | client | |
| `note_created` | client | |
| `screen_opened` | client | |
| `focus_mode_toggled` | client | |
| `paywall_viewed` | client | the tutor cap is a real paywall surface today |
| `session_started` | **server** — `start_session()` | |
| `session_completed` | **server** — `complete_session()` | payload carries server-measured `elapsed_s` |
| `session_abandoned` | **server** — `abandon_session()` | |
| `tutor_message_sent` | **server** — the future chat backend (service role) | makes the free-tier cap enforceable |

**Deliberately not events:** `first_session_started`, `returned_day_2`, `returned_day_7`,
`streak_broken` — all derivable from the rows above, so storing them would create a second,
divergeable source of truth (rule 1). **Deferred to W4a:** `joined_room_session`,
`room_created`, `room_joined`, `milestone_progressed` (rule 3). **Deferred to W6:** `upgraded`
(no billing exists). **Not applicable:** the terminal app's TUI-only kinds (`app_launched`,
`practice_lab_*`, `pty_*`).

Adding a kind means editing two places that must stay in sync: the `activity_events_kind_check`
constraint, and — only if clients should be able to emit it — the whitelist inside
`record_event()`. Adding it to the constraint alone makes it server-only, which is the safer
default.

Payloads are capped at 4 KB on the client path. The ledger has no DELETE by design, so an
unbounded payload would be permanent storage growth from a cheap call.

---

## 5. Sessions are server-authoritative (D12)

The client sends **intents**; the server stamps the time. The timer renders
`started_at + planned_duration_s − now()`. This is what survives phone sleep, reconnects, and
clock drift — and it is why the room version of a session later reuses the exact same code path
rather than needing a new one.

`started_at` used to be only a `default now()`, which is not a stamp — a client could supply any
value on INSERT, or `UPDATE` a running session's start time afterwards, or insert a fabricated
multi-hour `completed` session outright. It is now enforced: clients hold **SELECT only** on
`focus_sessions`, and the whole write surface is three RPCs.

| RPC | Does |
|---|---|
| `start_session(p_block_id uuid, p_planned_duration_s int) → focus_sessions` | Sets `user_id := auth.uid()` and `started_at := now()` internally — neither is a parameter. Validates duration (1..86400) and that the block is the caller's. Refuses if a session is already running. Mints `session_started`. |
| `complete_session(p_id uuid) → focus_sessions` | Owner-checked, must currently be `running`. Sets `completed_at := now()`. Mints `session_completed` with server-measured `elapsed_s`. |
| `abandon_session(p_id uuid) → focus_sessions` | Same, mints `session_abandoned`. |

Called from the app as `supabase.rpc('start_session', { p_block_id, p_planned_duration_s })` —
the ordinary anon key is enough, no service-role client is needed for the session loop. See
`api.md` §3 for the call-site contract.

**One running session per user**, enforced by a partial unique index. Two would double-count
focus time in the rollups and leave the UI with no defensible answer to "which timer is mine".

**Stale-session recovery is the client's job.** A user who closes the tab mid-session leaves a
`running` row behind and hits `55006` on their next `start_session`. This is deliberately an
error, not a silent auto-abandon — discarding a session the user may still want to finish is not
a decision the database should make. The UI can `select` the running session (that read is
allowed) and must offer resume-or-discard, calling `abandon_session()` before starting a new one.

---

## 6. RLS, grants, and the write paths

**RLS alone is not the access control.** Supabase's default privileges are
`alter default privileges for role postgres in schema public grant all on
tables/functions/sequences to postgres, anon, authenticated, service_role`. So "there is no
policy for that command" is an *incidental* denial that a future `for all` policy — added by
copy-paste habit — would silently undo. Every table that must not be client-written therefore
carries an explicit `REVOKE`, which makes the denial structural.

"Can" below is the *effective* capability — grant AND policy. Where a grant still exists but no
policy matches (e.g. `delete on plans`), the statement succeeds affecting zero rows rather than
erroring; where the grant itself is revoked, it errors with `42501`.

| Table | A client can | Written by |
|---|---|---|
| `profiles` | select, insert, update | client (own row); trigger on `auth.users` insert |
| `plans`, `plan_categories` | select, insert, update (**no delete**) | client |
| `curriculum_items`, `blocks`, `proofs`, `notes`, `companies`, `tutor_conversations` | select, insert, update, delete | client |
| `activity_events` | **select only** | `record_event()` / `append_event()` |
| `focus_sessions` | **select only** | `start_session()` / `complete_session()` / `abandon_session()` |
| `daily_rollups` | **select only** | future service-role recompute job |
| `tutor_memory_summaries` | **select only** | future service-role summarization job |
| `tutor_messages` | **nothing** | future service-role chat backend; read via `tutor_context()` |

Other rules, all enforced in the SQL:

- **Ledger immutability.** `activity_events` is INSERT-by-function + SELECT. No UPDATE, no
  DELETE, ever, for any role except a service-role migration path. Corrections are compensating
  events appended to the ledger, not mutations of history.
- **TRUNCATE is revoked** on every table, along with REFERENCES and TRIGGER, and removed from the
  default privileges for future tables. RLS does not apply to TRUNCATE, so the grant Supabase
  hands out by default was the one privilege that could have emptied the append-only ledger for
  every user at once. **Every future migration that creates a table in `public` must re-run that
  revoke.**
- **Every policy is `to authenticated`** and uses `(select auth.uid())`, so the predicate is
  evaluated once per query as an InitPlan rather than once per row. Note that Supabase's
  *anonymous* sign-in issues a JWT whose role is `authenticated`; the `anon` role is only for
  requests with no JWT at all. Since this product signs in anonymously on first visit,
  `to authenticated` is the correct scoping for real users.
- **Security-definer functions are the write path**, owned by `postgres`, which also owns the
  tables — that ownership is what exempts them from RLS. Consequently: **do not add
  `force row level security`** to any table those functions write; it would break the only write
  path. Inside each function, the `user_id = auth.uid()` check *is* the access control, not a
  duplicate of a policy. `append_event()` and `settle_session()` are internal and are executable
  by nobody but the owner.
- **Auth model:** Supabase **anonymous auth from first visit**, upgraded in place to a real
  account. Every ledger event carries a real `user_id` from event #1 — no pre-signup gap in the
  data, and no migration needed when a user later signs up (same row, same id). A `profiles` row
  is created by an `after insert on auth.users` trigger, so every auth path has one.

**When a room SELECT policy is added to `activity_events` (W4a), it must not be a direct table
policy.** Room reads have to go through a `security definer` view or function that projects only
coarse fields — never raw `payload`, `kind`, or `occurred_at` to every room member. D18 says the
squad sees squad-level rank and coarse signals only, never exact peer data, and D19 forbids
default-public exposure. A naive `for select using (room_id in (my rooms))` policy would hand
every member the other members' full event stream, which is a direct violation of both.

---

## 7. What to reuse from the terminal app (`src/mtdo/`)

| Reuse | Where | Note |
|---|---|---|
| Ledger pattern | `analytics.py` | Already an append-only event table with hashed refs — D14 has a working precedent in this repo |
| Event vocabulary | `analytics.py` | `task_completed`, `pomodoro_started/completed`, `focus_mode_toggled`, `screen_opened`… fed into §4's canonical list |
| Career CRM statuses | `core.py` `CAREER_STATUSES` | Ported verbatim into `companies.status`'s check constraint — one vocabulary across both apps |
| Coaching logic | `coaching.py` (505 LOC) | Pure prompt-builders + parsers, **no network calls** — port directly, don't re-derive |
| Plan shape | `config.py` `goals_to_config()` | The goals.json → normalized-config conversion is the schema mapping above, already written once |
| Friction detectors | `analytics.py` | `friction_task_flapping`, `friction_abandoned_onboarding`, … → become SQL views over `activity_events` |

**Do not port:** the profile envelope encryption (Fernet + PBKDF2 double-wrapped data key).
Supabase RLS replaces it; porting client-side zero-knowledge encryption would block every
server-derived feature — rank, the AI manager, group progress.

**Nothing to reuse from `dashboard.py`** — it's a maintainer bug-tracker HTML generator, unrelated
to the product.
