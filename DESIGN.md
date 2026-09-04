# Design System — mtdo web

> Source of truth for every visual decision in the mtdo **web** product.
> Approved 2026-09-03 from the "Graphite" direction (`/tmp/mtdo-renders/4-graphite.html`), and
> extended 2026-09-04 to **`C · Ember Graphite`**: Graphite is the core identity, Ember is reserved
> for the focus transition and high-intent moments.
> The mtdo **terminal** app is a separate product with its own skin and its own vocabulary
> (§Vocabulary). It stays dark, but *readable* dark — slate/charcoal rather than crushed black.

## Product Context

- **What this is:** A goal-achievement system. State a goal in plain language, get a real
  AI-built curriculum, get coached through each focused session, and keep honest proof you're
  improving. Group study rooms let people chase a shared goal with live presence.
- **Who it's for:** Students and self-directed learners (competitive exams, college applications,
  school and college projects, job switches), plus engineers doing interview prep.
- **Space:** Focus/productivity/study. Peers: Notion, Todoist, Forest, Duolingo, Habitica.
  Craft references: Linear, Vercel, Raycast.
- **Project type:** Mobile-first PWA web app + marketing landing page.
- **The memorable thing:** *"This app actually takes my goals seriously. Built for people who are
  serious about getting somewhere."* Every decision below serves that sentence.

## Aesthetic Direction

- **Direction:** **`C · Ember Graphite`** — premium consumer dark. Minimal, calm, confident.
  Graphite carries the whole product; **Ember** appears only at the focus transition and other
  high-intent moments (§Motion → The morph). Ember is a signal, never decoration.
- **Decoration level:** minimal. Type, space, and one accent do the work.
- **Mood:** a quiet, expensive tool. Nothing shouts. Surfaces are glass over near-black, edges are
  hairlines rather than shadows, and motion is soft rather than snappy. It should feel like
  somewhere you'd willingly spend fifty minutes.
- **Positioning:** the study category is saturated with cheerful gamification (Duolingo's mascot,
  Forest's trees, Habitica's loot). Graphite deliberately occupies the unclaimed *serious for
  learners* position — the restraint of Linear and Raycast, pointed at students.

### Hard prohibitions

No mascot. No confetti. No coins, XP, badges, or loot. No cartoon illustration. No purple
gradients. No three-column icon grid. No centered-everything hero. No stock photography. No
inflated numbers, fake progress bars, or "you're on fire!" for a nine-minute session. **The app
never exaggerates the user's record.** That honesty is inherited from the terminal app and is
non-negotiable.

## Typography

- **Display / Body / UI / Data:** **Satoshi** (Fontshare, free for commercial use).
  One family across the whole product. Weights in use: 300, 400, 500, 700, 900.
  Chosen because it is geometric enough to feel designed, neutral enough to disappear at 14px on
  a cheap Android, and its 900 weight is genuinely expressive at display sizes.
- **Code (Practice Lab only):** JetBrains Mono.
- **No monospace in the interface**, including the session timer. Use `tabular-nums` instead.

```html
<link href="https://api.fontshare.com/v2/css?f[]=satoshi@300,400,500,700,900&display=swap" rel="stylesheet">
```

**All numerals must use tabular figures** so timers and counters do not jitter while animating:

```css
.num { font-variant-numeric: tabular-nums; font-feature-settings: "tnum" 1; }
```

### Scale

| Level | Size | Weight | Tracking |
|---|---|---|---|
| Hero | `clamp(44px, 7vw, 88px)` | 900 | -0.045em |
| Timer | `clamp(58px, 9.5vw, 110px)` | 900 | -0.055em |
| H2 | `clamp(28px, 3.6vw, 44px)` | 700 | -0.035em |
| Stat numeral | 34px | 700 | -0.04em |
| H3 / card title | 16px | 700 | -0.015em |
| Body | 16px | 300 | 0 |
| UI / label | 13.5px | 400 | 0 |
| Eyebrow / meta | 11.5-12.5px | 400 | 0.14em, uppercase |

Body copy is **300 weight**. This is load-bearing: at 400 the pages read heavy and generic.

## Color

**Approach:** restrained. Near-monochrome, with one structural accent and one live-state signal.

```css
:root{
  --bg:      #0B0B0C;                    /* page */
  --surface: rgba(255,255,255,.032);     /* cards, glass panels */
  --surface-hover: rgba(255,255,255,.055);
  --border:  rgba(255,255,255,.09);      /* hairlines, never shadows */
  --text:    #FAFAFA;
  --muted:   #8A8A93;
  --dim:     #5C5C64;                    /* meta, timestamps, footers */

  --accent:     #22D3EE;                 /* cyan: structure, links, progress, heatmap */
  --live:       #F97316;                 /* EMBER: ONLY when something is happening now */
  --ember-deep: #C2410C;                 /* bloom gradient inner stop — focus transition only */

  --success: #34D399;
  --warning: #FBBF24;
  --danger:  #DC2626;                    /* true red; see rule 2 below */
}
```

### Two enforceable color rules

1. **`--live` is a state, not a decoration.** Ember appears only when something is happening *this
   second*: a running timer, a member in session, a streak at risk. If it is on screen, something
   is live. Never use it for emphasis, headings, or ordinary CTAs.
2. **`--danger` must never be confused with `--live`.** `#DC2626` is a true red, `#F97316` a warm
   orange. ⚠️ This rule was originally written against rose `#FB7185`, which sat much further from
   red. **Revalidate before shipping:** put a destructive button and a running timer side by side —
   a delete must never read as "in progress."
3. **`--warning` must never be confused with `--live`.** Amber `#FBBF24` and Ember `#F97316` are
   close neighbours, and this collision is new with Ember. Prefer separating them by *form* rather
   than hue — Ember only ever pulses or blooms; warning is always static.

Surfaces are defined by **hairline borders and translucency**, never by drop shadows. The only
shadow permitted is the glass nav's `0 10px 40px rgba(0,0,0,.6)` on scroll.

### Gradients

Three permitted uses only:
- **Text clip** on large numerals: `linear-gradient(180deg,#FFF,#8A8A93)` with `background-clip:text`.
- **Ambient hero wash:** `radial-gradient(ellipse 80% 50% at 50% -10%, rgba(34,211,238,.09), transparent 70%)`.
- **Ember bloom**, the focus transition only (§Motion → The morph):
  `radial-gradient(circle at 50% 50%, var(--ember-deep), var(--live) 40%, transparent 72%)`.

No gradient buttons. No purple. The ember bloom is the *only* place `--ember-deep` may appear.

### Heatmap ramp

`rgba(255,255,255,.06)` → `#0E7490` → `#0891B2` → `#06B6D4` → `#22D3EE`

Replaces the terminal app's GitHub green. Keep the grid DNA (dense, honest, unforgiving); change
only the ramp.

### Light mode

**Dark-only for v1.** If added later, do not invert: redesign surfaces from scratch, drop accent
saturation 10-15%, and reserve the treatment for a v2 theming feature.

## Spacing

- **Base unit:** 4px.
- **Density:** comfortable. Generous vertical rhythm, restrained horizontal.
- **Scale:** `2xs 2 · xs 4 · sm 8 · md 16 · lg 24 · xl 32 · 2xl 48 · 3xl 64`
- **Section padding:** 100px desktop, 64px mobile.
- **Hero top padding:** 186px desktop (clears the floating nav with air to spare).

## Layout

- **Approach:** hybrid. Grid-disciplined inside the app, looser and composition-led on marketing.
- **Max content width:** 1080px, 30px gutters.
- **Alignment:** left-aligned by default. Centered hero is prohibited.
- **Grid:** cards `repeat(auto-fit, minmax(246px, 1fr))`, gap 14px.
- **Border radius (hierarchical, and part of Graphite's softness):**

| Token | Value | Use |
|---|---|---|
| `sm` | 6px | swatches, chips, inline marks |
| `md` | 14px | stat tiles |
| `lg` | 16px | cards |
| `xl` | 20px | large mock panels, session surface |
| `full` | 999px | nav shell, pills, buttons, progress tracks |

Buttons and the nav are fully rounded pills. This is deliberate and is what separates Graphite from
the harder-edged directions considered alongside it.

## Motion

**Approach:** intentional. Motion signals state and rewards scrolling; it never decorates.

- **Easing:** reveals and progress `cubic-bezier(.2,.8,.2,1)`; hover/press springs
  `cubic-bezier(.2,1.5,.4,1)`; nav and color `ease`.
- **Duration:** micro 200ms (hover) · short 300-450ms (nav, background) · medium 900ms (reveals) ·
  long 1400-1500ms (counter tick-ups, progress fills).
- **Signature moves:**
  - **Blur-in reveal:** `opacity 0 → 1`, `translateY(30px) → 0`, `scale(.985) → 1`,
    `blur(6px) → 0`. Stagger siblings by 80ms.
  - **Counter tick-up:** cubic ease-out over 1400ms on scroll entry, `tabular-nums` so digits
    don't jitter.
  - **Progress fill:** lanes animate width from 0 over 1500ms on entry.
  - **Presence pulse:** 2s infinite opacity + expanding ring on `--live` dots.
  - **Spring hover:** `scale(1.045)` on primary buttons; `translateY(-4px)` on cards.
  - **Scroll progress bar:** 2px, `--accent`, fixed top.

### The morph — entering focus

The single highest-craft moment in the product. Starting a session is not a navigation, it is a
ritual, and the transition is what makes the timer the emotional center rather than a widget.

```
Graphite home  →  ember bloom across viewport  →  terminal focus shell
```

- **Trigger:** starting the focus timer. Never a manual theme toggle — there is no "switch to
  terminal mode" control anywhere.
- **Bloom:** the ember gradient above expands from the timer's origin point to fill the viewport,
  then dissipates as the focus shell settles under it. It should read as a room dimming and a coal
  catching, not as a page transition.
- **Destination — the terminal focus shell:** a terminal-*flavored* web screen built from these
  same Graphite tokens. Slate/charcoal ground, tighter grid, operational tone, Satoshi throughout.
  It is a **mood, not an emulator**: no xterm.js, no PTY, no dependency on the local bridge. (A web
  PTY is ruled out outright — see `docs/designs/mtdo-web-v1-plan.md` §6.)
- **Exit:** reverses, faster. Leaving focus should feel like coming up, not like another ceremony.

**`prefers-reduced-motion` collapses the bloom to an instant state change** — the focus shell
appears without the animation. It must never resolve to a blank screen; same blocking rule as
every other reveal below.

### Accessibility requirements (blocking, do not ship without)

Reveal animations gate content visibility, so both fallbacks are mandatory:

```css
@media (prefers-reduced-motion: reduce){
  .rv{opacity:1 !important;transform:none !important;filter:none !important;transition:none !important}
  *{animation:none !important}
}
```
```html
<html class="no-js"> <!-- script removes this; CSS shows .rv when .no-js is present -->
```

Without these, the page is blank for anyone with JS disabled or motion sensitivity.

Also required: 4.5:1 contrast on body text (`--muted` on `--bg` passes; `--dim` is for meta only
and must never carry body copy), visible focus rings on all interactive elements, and 44px minimum
touch targets.

## Component Notes

- **Nav:** floating pill, `backdrop-filter: blur(20px) saturate(160%)`, gains a shadow past 20px scroll.
- **Session screen (the terminal focus shell):** the highest-focus surface in the product, and the
  destination of the morph. Timer in gradient-clipped 900-weight Satoshi, coaching content in a
  252px right rail, nothing else on screen. Ground shifts to slate/charcoal and the grid tightens
  to carry the operational, terminal-flavored tone — using these tokens, not a second design system.
  The running timer is `--live`; it is the canonical use of Ember.
- **Study rooms:** a **timing board with lanes**, never a ranked leaderboard. Group total is shared
  and filled together; each member's line is measured against their own past self. In-session lanes
  use `--live`; idle lanes use `--accent`. A ranked leaderboard demotivates exactly the user we
  most want to retain.
- **Presence:** "N people are focusing right now" in a pill at the top of the hero. This is the
  single most motivating element on the page.
- **Record Card:** milestone artifact at **1080×1920**, sized to screenshot into a WhatsApp status
  or Instagram story uncropped. It is the reward mechanic and the distribution mechanic at once.
  Needs a dedicated design pass; it was the weakest element in the light-theme exploration.

## Vocabulary

mtdo web and mtdo terminal are two expressions of one system, and they deliberately **do not share
names**. Web copy is human, motivating, direct, outcome-focused. Terminal copy is precise,
operational, tool-like.

| Concept | Web | Terminal |
|---|---|---|
| Goal / plan | Goal route | `mission_compiler` |
| Focus | Focus timer | `focus_orbit` |
| Group study | Study rooms | `mesh_signal` |
| Notes | Vault | `archive_index` |

Two rules:

1. **The website must never read like a CLI manual, and the terminal must never read like the
   website.** If a web string would look at home in a man page, rewrite it.
2. **This is a presentation layer only.** Schema, API, and component names stay neutral —
   `plans`, `focus_sessions`, `rooms`, `notes`. Naming a database table after marketing copy means
   you can no longer change either one independently. The web mapping lives in exactly one
   dictionary, `web/lib/copy.ts`.

## Decisions Log

| Date | Decision | Rationale |
|---|---|---|
| 2026-09-03 | Initial design system created | `/design-consultation` with competitive research (Linear, Duolingo, Todoist, Forest) plus two independent outside voices (Codex + Claude subagent) |
| 2026-09-03 | Web product abandons the terminal green-on-black identity | Unanimous across three independent reviews: it signals "for programmers" at the moment of highest churn. Terminal app keeps its own skin. |
| 2026-09-03 | **Graphite (dark) chosen** over "Results Day" (warm paper/light) | User preference after reviewing four built directions. The "dark reads as technical" concern was overweighted: Linear, Vercel, Raycast, and Arc are all dark with mass appeal. The neon green and terminal chrome were the actual problem, not darkness. |
| 2026-09-03 | Single type family (Satoshi) | Three-family systems were explored and rejected as harder to hold consistent across a solo-built product |
| 2026-09-03 | `--live` reserved strictly as a state color | Makes the interface feel wired to real time and keeps urgency meaningful as screens multiply |
| 2026-09-03 | Rounded pills and 16px cards kept | The softness is what makes Graphite feel consumer rather than developer-tool |
| 2026-09-04 | Direction extended to **`C · Ember Graphite`** | Graphite alone had no register for high-intent moments; Ember gives the focus ritual its own signal without adding a second identity |
| 2026-09-04 | **Ember replaces rose as `--live`** (`#FB7185` → `#F97316`) | One warm high-intent color instead of two. The bloom then reads as the same signal scaled up, rather than an unrelated effect. Hex is a starting point — tune against a real screen |
| 2026-09-04 | The morph is a **ritual, not a toggle**; no manual mode switch exists | Starting focus is the emotional center of the product; a settings toggle would make it a preference instead of a moment |
| 2026-09-04 | Terminal focus shell is **terminal-flavored, built from Graphite tokens** — not an emulator, not the TUI | Keeps one design system and one codebase. A real web PTY is ruled out outright (`mtdo-web-v1-plan.md` §6), and a bridge dependency would make the core focus path Pro-only |
| 2026-09-04 | Web and terminal keep **separate vocabularies**, mapped in one dictionary | Two expressions of one system should not sound alike; keeping the mapping out of the schema means either side can be renamed without a migration |
| 2026-09-04 | Terminal moves to readable dark (slate/charcoal), diagonal shadow treatment dropped | The shadows hurt readability, and crushed black was fighting legibility for no identity gain |
