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
  → email confirmation required: callback → Architecture 02 onboarding
```

The upgrade helper accepts an `emailRedirectTo` value for this screen. With email confirmation
enabled, the confirmation link returns through `/auth/callback` and then enters the existing
`/architecture-02/onboarding` route. This is the same #86 questionnaire and NDJSON plan endpoint;
the account UI never generates or persists plans itself.

### Returning visitor

```text
Log in → auth.signInWithPassword → refresh Signal Deck → existing route/data is visible
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
- Supabase session persistence remains owned by `@supabase/ssr` and `proxy.ts`.
- The dialog uses Architecture 02’s existing Signal Deck tokens, visible focus treatment, clear
  labels, native form semantics, and `prefers-reduced-motion` fallbacks.

## Files

- `web/app/(marketing)/architecture-02/account-control.tsx`
- `web/app/(marketing)/architecture-02/account-control.css`
- `web/app/(marketing)/architecture-02/page.tsx`
- `web/lib/auth/upgradeAccount.ts`
