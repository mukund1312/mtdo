# Architecture 02 — Account and profile flow

## Purpose

Signal Deck is anonymous-auth-first. The proxy creates a Supabase anonymous user on a first
visit so every plan, block, session, and progress record has an owner from the beginning.
The Architecture 02 account flow makes that identity visible and lets a person either save it
as a real account or return to an existing account.

It is an account layer over the existing product, not a second onboarding system.

## Existing infrastructure reused

- `web/proxy.ts` — refreshes session cookies and creates the initial anonymous identity.
- `profiles` — one row is created for every auth user by `handle_new_user()`; it stores the
  editable `display_name` only.
- `web/lib/auth/upgradeAccount.ts` — Sign Up calls `auth.updateUser()` on the active anonymous
  session rather than `signUp()`. The auth user ID does not change, so existing data is retained.
- `web/app/auth/callback/route.ts` — safely exchanges Supabase callback codes and returns the
  user to the requested internal Signal Deck location.
- Supabase browser auth — provides password login, session refresh/persistence, sign-out, password
  reset mail, and password update. No custom authentication API or service-role access is added.

## Flows

### New visitor / guest route

```text
Guest route
  → Create account
  → update current anonymous auth user with email + password
  → immediate upgrade: Architecture 02 onboarding
  → email confirmation required: callback → verified welcome → existing Signal Deck guide → Architecture 02 onboarding
```

The upgrade helper accepts an `emailRedirectTo` value for this screen. With email confirmation
enabled, the confirmation link returns through `/auth/callback?next=/architecture-02?auth=confirmed`.
The callback exchanges the real one-time code, preserves the upgraded anonymous account's session,
and opens a short Signal Deck welcome surface. That surface reads the authenticated `profiles.display_name`
(or falls back gracefully when no name exists), then opens the existing guide. Completing, closing,
or skipping that guide continues into the existing `/architecture-02/onboarding` questionnaire and
its NDJSON plan endpoint; no second plan or onboarding model exists.

The optional sign-up display name is written to the existing RLS-owned profile attached to the same
anonymous user id. It is never accepted from a callback URL or treated as authentication evidence.

### Returning visitor

```text
Log in → auth.signInWithPassword → refresh Signal Deck Today / Work → existing route/data is visible
```

Logging into a different existing account intentionally restores that account's data. The UI
explains that a temporary guest route remains a separate anonymous identity unless it is saved
first; this avoids silently moving user-owned data between IDs.

### Password recovery

```text
Forgot password → resetPasswordForEmail
  → email link → /auth/callback?next=/architecture-02?auth=reset
  → updateUser({ password }) → Signal Deck
```

### Confirmation failure / already-used link

`/auth/callback` classifies a failed confirmation or reset exchange and redirects to the matching
Signal Deck account-recovery state rather than the marketing root. The UI never displays the
success welcome until `auth.getUser()` returns a non-anonymous authenticated user. A fresh link
can be requested from the surfaced account panel.

### Profile and sign-out

- The compact header avatar opens the contextual account menu.
- Profile edits update only `profiles.display_name` under its existing owner RLS policy.
- Email comes from the authenticated Supabase user and is read-only here.
- There is no profile-image upload/storage backend, so the UI uses initials and states that limit
  rather than pretending an upload exists.
- Theme Studio is linked as the existing device-level preference surface; this work does not add
  a second theme system or persist a new preference model.
- Sign-out uses `auth.signOut()`, displays a brief loading state, then returns the browser to a
  fresh guest route. The saved account remains available through Log In.

## States and accessibility

- Guest / anonymous, authenticated account, profile loading, account menu, sign-up, login,
  password reset request, password reset completion, profile save, settings, logout, inline
  error, and success states are all explicit.
- A `SIGNED_OUT` auth event opens Login with a session-expired explanation.
- The verified welcome is callback-only: its transient query marker is removed after it opens, so
  normal refreshes and returning password logins do not replay it. The regular guide's existing
  local preference remains the completion state for both guide entry paths.
- Supabase session persistence remains owned by `@supabase/ssr` and `proxy.ts`.
- The dialog uses Architecture 02’s existing Signal Deck tokens, visible focus treatment, clear
  labels, native form semantics, and `prefers-reduced-motion` fallbacks.

## Files

- `web/app/(marketing)/architecture-02/account-control.tsx`
- `web/app/(marketing)/architecture-02/account-control.css`
- `web/app/(marketing)/architecture-02/page.tsx`
- `web/lib/auth/upgradeAccount.ts`
