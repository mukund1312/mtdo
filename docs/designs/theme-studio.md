# MTDO Theme Studio — implementation record

**Status:** Implemented prototype

**Scope:** `web/` only. This document records the visual-theme exploration and Theme Studio
implementation. It does not replace the product architecture or the Graphite design system in
`docs/designs/mtdo-web-v1-plan.md` and `DESIGN.md`.

## Purpose

Theme Studio is an in-app gallery for five fully realized MTDO visual explorations. It lets a
user compare the directions, see the real route for each direction in a live preview, and enter a
selected full-theme workspace.

The Studio is available at `/theme-studio`. The marketing homepage has a `Theme Studio ↗` link in
its primary navigation.

## Included theme routes

| Studio number | Theme | Route | Character |
|---|---|---|---|
| 01 | Daily Route | `/architecture-01` | Warm editorial planning workspace |
| 02 | Signal Deck | `/architecture-02` | High-energy chromatic productivity workspace |
| 03 | Chronicle | `/architecture-03` | Calm personal archive and long-term record |
| 04 | Manga Study | `/architecture-07` | Ink, vermilion, manga-inspired study environment |
| 05 | Personal Studio | `/architecture-08` | Blush editorial workspace for personal planning |

The missing route numbers are intentional: previously explored directions were removed from the
gallery and are not part of the current five-theme system.

## Theme Studio composition

Desktop layout is intentionally structured as:

```text
Header
Intro
Horizontal five-theme selector
┌──────────────────────── Live preview ────────────────────────┬─ Theme information ─┐
│                                                               │ selected name       │
│   Live iframe for the selected full-theme route               │ tagline/accent       │
│                                                               │ description          │
│                                                               │ philosophy           │
│                                                               │ personality          │
│                                                               │ recommended use      │
└───────────────────────────────────────────────────────────────┴─────────────────────┘
```

### Theme information

Selecting a theme updates the right-hand information panel without navigation. It includes:

- Number, name, and short tagline.
- Theme-specific accent indicator.
- Description and design philosophy.
- Personality characteristics.
- Recommended use case.

The exact content is held in the shared `themes` data array in
`web/app/(marketing)/theme-studio/page.tsx`; it is not duplicated per screen.

### Theme selector

- Desktop: all five themes are a single horizontal row directly above the preview.
- Mobile: the row becomes a touch-scrollable horizontal rail with snap points.
- Selection persists in `localStorage` as `mtdo-theme`.
- A `mtdo-theme-change` document event is emitted after a selection changes, providing a seam for
  future shared UI to react to the active theme.

### Live previews

Every preview, including Daily Route, uses a live iframe of its actual route. The frame fills the
preview region (`width` and `height` are both `100%`), so it does not leave unused black space or
rely on a static screenshot.

## Entry and checkout behavior

The existing `Enter full theme ↗` control is retained.

| Selected theme | Action |
|---|---|
| Signal Deck (02) | Free. Saves selection and opens `/architecture-02` directly. |
| Daily Route, Chronicle, Manga Study, Personal Studio | Opens an in-place theme-aware checkout modal. |

Checkout modal behavior:

- Opens without navigating and blurs the current Studio page.
- Uses the selected theme’s colors, surface, accent, border treatment, and shape language.
- Shows selected theme, description, `$12.00` one-time price, payment-method choice, billing
  explanation, secure-payment indicator, cancel/close actions, and `Pay & Apply Theme`.
- Is a prototype UI only: it does not process a payment.
- `Pay & Apply Theme` saves the selection and navigates to that theme’s existing route.
- The modal is rendered through a React portal to `document.body`, avoiding iframe and stacking
  context conflicts.

`Open selected ↗` in the Studio header remains a direct navigation path for every theme.

## Dynamic background system

`web/app/(marketing)/theme-studio/theme-atmosphere.css` is the reusable Studio atmosphere layer.
Each theme declares the same set of tokens:

```css
--theme-background
--theme-background-secondary
--theme-gradient-primary
--theme-gradient-secondary
--theme-accent
--theme-glow
--theme-surface
--theme-border
--theme-text
--theme-muted
```

The layer combines a base field, blurred radial gradients, low-opacity ambient color fields, and
subtle texture. Only the variables change per theme; the background composition remains shared.
Theme transitions use approximately 400–650 ms easing. `prefers-reduced-motion: reduce` disables
those transitions.

## Responsive behavior

- The five-theme selector remains horizontal and scrollable on narrow screens.
- The theme-information panel moves below the preview at tablet/mobile widths.
- At compact phone widths, information fields become a single readable column.
- Checkout has mobile spacing and a smaller theme preview swatch.

## Files added or changed

| Area | Main files |
|---|---|
| Theme Studio UI and interaction state | `web/app/(marketing)/theme-studio/page.tsx` |
| Studio base, horizontal selector, right information panel | `theme-studio.css`, `theme-gallery-layout.css`, `theme-gallery-position.css` |
| Theme tokens and ambient backgrounds | `theme-atmosphere.css` |
| Checkout | `theme-checkout.css`, `theme-interaction.css` |
| Live preview behavior | `live-preview.css` |
| Full-theme explorations | `web/app/(marketing)/architecture-01`, `02`, `03`, `07`, `08` |
| Focus visual asset | `web/public/images/a07-focus-room.png` |
| Local prototype availability | `web/proxy.ts` |

`web/proxy.ts` intentionally bypasses Supabase session setup only when both public Supabase
environment values are absent. With credentials present, the normal server-client session path is
unchanged. This allows visual prototype routes to be viewed locally before Supabase setup.

`web/next.config.ts` sets `agentRules: false` to avoid development tooling creating contributor
instruction files in the working tree.

## Validation at implementation time

- `npm run lint` passed.
- `git diff --check` passed.
- Before the latest upstream rebase, typecheck and production build passed for this Theme Studio
  work.
- After rebasing onto `origin/main` on 2026-09-06, repository-wide typecheck/build are blocked by
  upstream `app/api/onboarding/plan/route.ts` importing unavailable `@anthropic-ai/sdk`. This is
  unrelated to Theme Studio; lint still passes.

## Non-goals and follow-up

- No real payment provider, billing state, or entitlement system exists yet.
- Theme choice is local-only; account-level persistence can be added after auth/profile work is
  ready.
- These theme explorations are deliberately separate routes. They are not yet the chosen product
  design system or a replacement for the approved Graphite web direction.
