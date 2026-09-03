# mtdo web — product plan & phase breakdown

**Status:** ACTIVE — living document
**Created:** 2026-09-03
**Owner:** Mukund Umashankar
**Source:** `/plan-ceo-review` → `/office-hours` → `/design-consultation` session, 2026-09-03
**Related:** `README.md` (terminal app), `.claude/PROGRESS.md` (terminal app history)

---

## 1. What we decided and why

### The core call: web app, not a Mac app, not terminal-only

mtdo (the terminal app) stays exactly what it is. A **separate web product** is the growth
vehicle. Reasoning, in order of weight:

1. **Reachable audience.** A TUI's ceiling is people who open a terminal by choice. A `.dmg`'s
   ceiling is Mac owners willing to clear a Gatekeeper warning (Mac is ~15% of desktops, and
   students skew Windows/Chromebook). The web has no ceiling.
2. **The users are on their phones.** People "chasing goals who get distracted very soon" get
   distracted *by the phone in their hand*. Only the web puts the focus timer on the same
   screen the distraction lives on. A TUI and a Mac app both structurally cannot.
3. **Distribution.** One link, shareable in a group chat. No install, no download, no trust
   dialog, no App Store review, no $99/yr Apple Developer fee.

### The wedge is the coaching, not the timer

A focus timer with streaks is Forest, Flora, Session, and Opal. Commoditized, with years of
polish and millions of users ahead of us. **What nobody else does is tell you what to work on
and coach you through it.** mtdo already has this: goals → curriculum, the Learning Coach, and
proof-of-improvement. That is the moat and it must be in v1, not deferred.

**Real v1 loop:** state your goal → AI builds a real plan → it tells you today's next thing and
*why* → focused session with coaching on screen → proof you moved.

### The positioning gap (from competitive research)

- **Duolingo owns *friendly*.** Bright white, cartoon mascot, bubbly. Deliberately unserious.
- **Linear owns *serious*.** Near-black, brutal restraint, no decoration. For professionals.
- **Nobody owns *serious* for learners.** Every student product copies Duolingo, assuming study
  is unpleasant so the app must make it fun. The person four weeks out from a banking exam
  finds that patronizing. They are already motivated. They want the tool to match the
  seriousness of what they're attempting.

That unoccupied position is the brief.

### The memorable thing (north star for every design decision)

> "This app actually takes my goals seriously. Built for people who are serious about getting
> somewhere."

### Group study is the growth engine

Every other feature makes the product better for one person. **Group study rooms make it
spread** — to use them you must invite people. It is the only mechanic discussed with
distribution built in rather than bolted on. It also answers the single biggest risk (retention:
people abandon goals), because social accountability is the strongest known counter.

**Design constraints for it:**
- **Collaborative, not competitive.** A ranked leaderboard demotivates exactly the person you
  most want to keep. Use a shared group progress bar plus each person's private progress against
  their own past self.
- **Solve the empty room.** Solo experience must be genuinely good on its own; group is an
  upgrade, never a requirement.
- **Invite-only at launch.** Public groups mean moderation, spam, and strangers.
- **Presence is the magic.** "3 people are focusing right now" is the most motivating thing you
  can put on that screen. Supabase Realtime gives this without hand-building websockets.
- **Pricing:** 3-4 members free, larger groups are Pro. The group hits the limit and one person
  upgrades on behalf of everyone (how Notion and Figma grew).

---

## 2. Design system — "Graphite"

**Full spec: `DESIGN.md` at the repo root.** That file is the source of truth; this is the summary.

**Direction:** premium consumer dark. Near-black `#0B0B0C`, glass surfaces defined by hairline
borders rather than shadows, one cyan accent `#22D3EE` for structure and one rose `#FB7185`
reserved strictly as a live state. Single type family (Satoshi). Rounded pills and 16px cards.
Blur-in scroll reveals, counter tick-ups, spring hovers. Craft references: Linear, Vercel, Raycast.

**Why dark, after three reviews argued for light:** a light "Results Day" direction (warm bone
paper, monumental numerals, vermilion signal) was explored and built first, backed by Claude,
Codex, and an independent subagent all arguing that dark signals "for programmers" to the student
audience. **Overruled after seeing four built directions side by side.** The argument was
overweighted: Linear, Vercel, Raycast, and Arc are all dark with mass appeal. What actually said
"for programmers" was the neon green and the terminal chrome, not the darkness itself. Graphite
keeps the restraint and drops the costume.

Four directions were built and compared as live scrollable pages: Night Shift (Linear-like
indigo), Ink & Signal (editorial, serif, vermilion), Terminal Evolved (matured green), and
**Graphite (chosen)**.

**Verdict on the terminal brand:** abandon the green-on-black identity for the web product.
Claude, Codex, and an independent Claude subagent all reached this independently. The terminal app
keeps its own skin; it is a different product for different people.

**Tokens (summary, full set in `DESIGN.md`):**
```css
--bg:#0B0B0C  --surface:rgba(255,255,255,.032)  --border:rgba(255,255,255,.09)
--text:#FAFAFA  --muted:#8A8A93  --dim:#5C5C64
--accent:#22D3EE   /* cyan: structure, links, progress, heatmap */
--live:#FB7185     /* rose: ONLY when something is happening right now */
--success:#34D399  --warning:#FBBF24  --danger:#DC2626
```
Type: **Satoshi** (Fontshare) across the whole product, body at 300 weight, all numerals
`tabular-nums`. No monospace in the interface, including the timer.

**Two ideas carried forward from the light exploration, because they are product ideas rather than
visual ones:**

1. **The Record Card.** Every milestone mints a shareable artifact at **1080×1920**, sized to
   screenshot into a WhatsApp status or Instagram story uncropped. Aspirants already post their
   study hours; this gives them a better-looking version of a behaviour they have, which makes the
   reward mechanic double as the distribution mechanic. Needs a dedicated design pass.
2. **Rooms are a timing board, not a leaderboard.** Group total filled together, individual
   progress measured against your own past self. Ranking demotivates exactly the user we most
   want to retain.

**Blocking accessibility requirement:** the scroll reveals gate content visibility, so
`prefers-reduced-motion` and no-JS fallbacks are mandatory before shipping. Without them the page
is blank for anyone with JS off or motion sensitivity.

## 3. Stack

| Concern | Choice | Why |
|---|---|---|
| App | **Next.js** on **Vercel** | Server-rendered, fast, free tier. PWA support = "add to home screen" gives an app icon on a phone with no App Store, no review, no fee. |
| DB + auth | **Supabase** | Postgres + auth + row-level security + Realtime (needed for group presence) in one. Satisfies "log it in a DB." |
| Errors/crashes | **Sentry** | Stack traces with user context. The piece people skip and regret. |
| Product analytics | **PostHog** | Funnels, retention curves, session replay. Generous free tier. |
| Payments | **Stripe** | Not until Phase 6. |

*Alternative on the table:* FastAPI + HTMX plays to existing Python strength and would be faster
to write, but slower to make feel like a phone app. Not chosen.

### Instrumentation (wire from day one, before real users)

Events: `signup` · `goal_created` · `plan_generated` · `first_session_started` ·
`session_completed` · `session_abandoned` · `returned_day_2` · `returned_day_7` ·
`streak_broken` · `room_created` · `room_joined` · `paywall_viewed` · `upgraded`

Plus an always-visible in-app feedback widget writing to a `feedback` table with user id and
current screen. 20 of those teach more than any dashboard.

**The only two numbers that matter early:**
1. **Activation** — % of landing visitors who complete one session.
2. **D7 retention** — % who come back on day 7. **If this is under 20%, the product is not ready
   and no amount of marketing fixes it.** Signups are a vanity metric.

---

## 4. Monetization

The AI coaching is the correct paywall: it is the only part with real marginal cost, which makes
charging for it honest and the unit economics sane.

| Tier | Includes |
|---|---|
| **Free** | One goal, full core loop, streaks, 30 days of history, study rooms up to 3-4 members |
| **Pro** (~$5-8/mo) | AI coaching + plan generation, unlimited goals, full history and analytics, exports, larger study rooms, **Practice Lab local bridge** |

**Do not build Stripe in v1.** Ship free, get 100 real users, learn what they'd actually pay for,
then charge. Charging before retention exists teaches nothing slowly.

---

## 5. Practice Lab: run code on the user's machine, never ours

Running strangers' code server-side means container sandboxing, abuse handling, resource limits,
and an ongoing bill. Two ways to avoid that entirely:

**Free tier — in-browser (WASM).** **Pyodide** runs real CPython in the browser tab;
**DuckDB-WASM** or **sql.js** gives a real SQL engine. Executes on the user's machine, sandboxed
by the browser. Zero server cost, zero security exposure. Covers Python and SQL, which is most of
interview prep. C/C++ is real work; Java is the hard one. **Ship Python + SQL, promise nothing else yet.**

**Pro tier — local bridge.** `mtdo serve --bridge` exposes a localhost endpoint the web app calls.
Same pattern as Ollama, Jupyter, Docker Desktop, and Figma's font helper. **This makes installing
the terminal app *be* the pro feature**: full language support, the user's real files and
environment, and it costs nothing per run because it's their CPU. The TUI stops being legacy and
becomes the power tier.

*Must get right:* bind to localhost only, require a token the web app presents (otherwise any
site the user visits can hit that port), and handle CORS + mixed-content correctly for an
`https://` page calling `http://localhost`.

---

## 6. What stays terminal-only, forever

- **Practice Lab full runtime** (beyond WASM Python/SQL) — reachable from web only via the Pro bridge.
- **PTY panel** — a web PTY hands anonymous visitors a shell. There is no cheap safe version.

**Positioning line:** *mtdo web is where you plan, learn, and focus. mtdo terminal is where you
build. Same account, same data.*

---

## 7. Known constraints (verified, do not rediscover)

- **`music.py` does not port.** Spotify control uses `nowplaying-cli` + AppleScript, both
  macOS-local. A web page cannot see or control desktop Spotify. On web: our own radio (easy,
  already works as internet-radio streams) plus at most an embedded player. Spotify's Web
  Playback SDK requires the *listener* to have Premium. YouTube Music has no official API.
- **YouTube → notes is an ops problem, not a port.** `youtube_notes.py` uses `yt-dlp` caption
  extraction. Works great on a laptop; YouTube blocks datacenter IPs aggressively, so
  server-side this is an ongoing fight. Solvable, not free. Deferred to Phase 7.
- **The Career CRM serves the job-switcher, not the student.** Great feature, different persona.
  Keep it out of the launch pitch.
- **Privacy obligations change completely.** `PRIVACY.md` currently describes local-only, opt-in,
  never-transmitted analytics. The moment data hits a server you need a real privacy policy, a
  data-deletion path, and GDPR handling if any EU user appears. Half a day now, a serious problem
  later.
- **mtdo already supports the mouse.** `app.py` has 32 `Button` widgets and 11
  `on_button_pressed` handlers; `pty_panel.py:478` handles clicks and `:491` scroll. The README's
  "keyboard-first, no mouse required" undersells it. Fix the copy.

---

## 8. Phase breakdown

Each phase ends with something that works. Do not start the next until the current one is real.

### Phase 0 — Foundations (~1 week CC)
- [ ] Next.js + Vercel skeleton, PWA manifest, "add to home screen" working on a real phone
- [ ] Supabase project, schema v1, row-level security
- [ ] `DESIGN.md` tokens implemented as CSS custom properties; Archivo / Switzer / Instrument Serif loaded
- [ ] Sentry + PostHog wired (before any user exists)
- [ ] Privacy policy + data deletion path
**Done when:** a blank styled page loads on your phone from a URL and an error in it shows up in Sentry.

### Phase 1 — The engine (the first shippable product)
- [ ] Onboarding: one free-text question → AI-generated plan and curriculum (port the `goals.json` → config logic)
- [ ] Today: one card, next task + why
- [ ] Session: timer on the ink field, coaching content on screen
- [ ] Done: mark complete, streak updates, one line on what unlocked
- [ ] Progress: heatmap in the ultramarine ramp
- [ ] Record Card minting + 1080×1920 export
**Done when:** you can run your own real goal through it for a week without opening the TUI.

### Phase 2 — Accounts + real users
- [ ] Supabase auth (delayed signup: only prompt when there's a streak worth losing)
- [ ] Feedback widget on every screen → `feedback` table
- [ ] Full event instrumentation live
- [ ] Ship to 10-20 real people, at least half non-engineers
**Done when:** you can read D1/D7 retention off a dashboard.
**Gate: if D7 < 20%, fix the engine before building Phase 3.**

### Phase 3 — The bundle (the acquisition surface)
- [ ] Kanban board (easier on web than TUI; drag and drop is free)
- [ ] Knowledge Vault: notes, markdown, search
- [ ] AI coach panel
- [ ] Radio + ink-blue chart-recorder visualizer
**Done when:** the landing page can honestly claim "everything in one place."

### Phase 4 — Group study rooms (the growth engine)
- [ ] Create/join room by invite link, shared goal
- [ ] Timing board with lanes, live presence via Supabase Realtime
- [ ] Group + individual progress in one ruled table
- [ ] 3-4 member free cap
**Done when:** a group of real friends uses it for one exam cycle.

### Phase 5 — Practice Lab
- [ ] Pyodide (Python) + DuckDB-WASM (SQL) in-browser, free tier
- [ ] `mtdo serve --bridge` localhost endpoint + token auth, Pro tier
**Done when:** a Pro user runs code from the web app against their own machine.

### Phase 6 — Monetization
- [ ] Stripe, free/pro gating, paywall on AI coaching + big rooms + bridge
**Only start when Phase 2's retention gate has been cleared and users are asking.**

### Phase 7 — v1.5
- [ ] YouTube → transcript → notes (solve the datacenter-IP problem first)
- [ ] Career CRM
- [ ] Themes / personalization

---

## 9. Honest timeline

- **Phases 0-2:** ~5-8 weeks solo with Claude Code. This is the real "v1."
- **Everything through Phase 7:** ~4-5 months.

Setting a 6-week target for the full list is how solo projects die at week 10, 60% done and no
longer fun. Phase gates exist to prevent that.

---

## 10. Open risks

1. **Retention is the biggest risk, not acquisition.** A goal app has a brutal failure mode: the
   user achieves the goal, or abandons it, and either way leaves. The curriculum system is a
   strong answer (there is always a next thing) but design it deliberately rather than hope.
2. **Two products to maintain.** The terminal app and the web app. The bridge (Phase 5) is what
   makes that a feature instead of a tax.
3. **The all-in-one bet.** Breadth is the differentiator and also the reason a new visitor
   bounces. Phase order exists to put the engine in front and the bundle behind it.

---

## Decisions log

| Date | Decision | Rationale |
|---|---|---|
| 2026-09-03 | Web app, not Mac app or terminal-only, for audience growth | No install ceiling; students are on phones; TUI/Mac cannot reach the phone |
| 2026-09-03 | Terminal app kept, repositioned as the power/dev tier | 14,283 LOC of working product; becomes the Pro runtime via the bridge |
| 2026-09-03 | Wedge is coaching + curriculum, not the focus timer | Timer category is commoditized; coaching is the only defensible part |
| 2026-09-03 | Abandon green-on-black terminal identity for web | Unanimous across Claude, Codex, and an independent subagent; signals "for programmers" at peak-churn moment |
| 2026-09-03 | "Results Day" design direction, daylight default, one dark screen | Occupies the unclaimed "serious for learners" position |
| 2026-09-03 | Record Card as the reward mechanic | Reward doubles as organic distribution in the target audience |
| 2026-09-03 | Practice Lab via WASM (free) + localhost bridge (Pro), never server-side | Avoids sandboxing infra, cost, and RCE exposure entirely |
| 2026-09-03 | PTY never ships to web | No cheap safe version exists |
| 2026-09-03 | Stripe deferred to Phase 6 | Charging before retention exists teaches nothing |
