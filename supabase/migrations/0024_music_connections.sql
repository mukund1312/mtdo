-- Spotify playback for the Listen deck. ONE table, no functions -- every
-- write here goes through a service-role Route Handler
-- (web/app/api/music/spotify/**), because the whole row is credential
-- material a browser must never be able to touch.
--
-- WHY music_connections AND NOT spotify_connections. calendar_connections
-- (0020) already established the shape: one row per (user, provider), with
-- provider as a CHECK-constrained column rather than baked into the table
-- name. The Listen deck's own data model already names three providers
-- (web/app/(marketing)/architecture-02/listen-data.ts: 'apple', 'spotify',
-- 'local'), so a second music provider is a named, visible possibility here
-- in a way a second calendar provider was not. Naming the table after the
-- category and the row after the provider means adding Apple Music later is a
-- one-line CHECK change, not a second table with a duplicated encryption
-- column and a duplicated service-role posture to get right twice. Only
-- 'spotify' is implemented today (web/lib/music/spotify/), and the CHECK says
-- so -- a typo is a 23514, not a silently unusable row.
--
-- Playback is ENTIRELY OPTIONAL and nothing in the core loop touches it. A
-- user who never connects Spotify has a fully working board, focus timer and
-- calendar; the Listen deck simply reports itself honestly as unconnected.

-- SERVICE-ROLE ONLY, the same strictest-in-the-schema posture as
-- calendar_connections: RLS enabled with NO policies at all, *and* every
-- privilege revoked from anon and authenticated. Either alone is a weaker
-- claim than it looks (schema.md sec6 spells out why "there is no policy" is
-- only an incidental denial under Supabase's default privileges, and a grant
-- with no policy is an equally incidental one). Both together make it
-- structural: a browser client cannot read this table even for its own row.
--
-- That matters MORE here than it did for the calendar, not less. A Spotify
-- refresh token is a six-month credential to a third-party account; the only
-- thing a browser is ever handed is a one-hour access token, minted on demand
-- by GET /api/music/spotify/token and never persisted anywhere the client can
-- reach.

create table music_connections (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  provider text not null default 'spotify' check (provider in ('spotify')),

  -- ENCRYPTED AT REST, BY THE APPLICATION, NOT BY THE DATABASE.
  -- Opaque ciphertext in a self-describing 'v1:<iv>:<tag>:<ct>' envelope,
  -- AES-256-GCM, produced and consumed only by
  -- web/lib/crypto/token-envelope.ts under SPOTIFY_TOKEN_ENCRYPTION_KEY. The
  -- reasoning against pgcrypto is unchanged from 0020's own header and
  -- decisions.md's 2026-09-11 entry: pgcrypto is deliberately not installed,
  -- there is no Vault precedent, and without Vault the key would have to
  -- cross PostgREST and the wire on every read and write. Encrypting in the
  -- Route Handler means the database never sees the key, so a database dump
  -- is not a token compromise.
  --
  -- SPOTIFY REFRESH TOKENS EXPIRE. Six months from the original
  -- authorization, and refreshing an access token does NOT extend that
  -- window. So unlike Google's, this token has a real, known death date and
  -- the app must treat a rejected refresh as "ask the user to reconnect", not
  -- as a transient error to retry. See refresh_token_expires_at below.
  refresh_token_encrypted text not null,

  -- CACHED ACCESS TOKEN, also encrypted, also never client-readable.
  -- Nullable: a connection is fully valid with no cached token yet (the next
  -- /token call mints one). This column is the deliberate difference from
  -- calendar_connections, which stores no access token at all -- the reason
  -- is a real architectural difference in the consumer, not inconsistency for
  -- its own sake. The calendar mints one token per explicit user-initiated
  -- sync. The Spotify Web Playback SDK instead calls its getOAuthToken
  -- callback whenever it wants a token -- on init, on transfer, on expiry, on
  -- reconnect -- so refreshing on every call would turn ordinary playback
  -- into a stream of token requests to Spotify. Caching bounds that to one
  -- refresh per hour per user. decisions.md 2026-09-13 has the full tradeoff.
  access_token_encrypted text,
  -- When the cached access token above stops being usable (Spotify issues
  -- them with a one-hour life). Readers treat a token within a short skew of
  -- this as already expired rather than racing it -- see
  -- web/lib/music/spotify/connection.ts.
  access_token_expires_at timestamptz,

  -- When the REFRESH token dies, six months out, computed at consent time.
  -- Stored rather than derived from connected_at so that a future change to
  -- Spotify's window does not silently retro-date every existing row, and so
  -- the status route can warn honestly before playback breaks instead of
  -- after. Nullable for forward-compatibility with a provider that has no
  -- such limit (Google does not) -- null means "no known expiry".
  refresh_token_expires_at timestamptz,

  -- What the user actually consented to, as returned by Spotify -- not what
  -- was requested. Stored so a scope added later is detectable as missing
  -- consent rather than surfacing as an opaque 403 mid-playback. Same
  -- reasoning as calendar_connections.scopes.
  scopes text[] not null default '{}',

  -- ACCOUNT IDENTITY AND TIER, captured once at consent time from Spotify's
  -- /v1/me. None of this is a credential -- it is the connection's human-
  -- readable identity plus the one signal that decides whether playback can
  -- work at all -- but it lives in this service-role-only table anyway
  -- because it belongs to the same row and there is no client-readable
  -- projection of it other than GET /api/music/spotify/status.
  --
  -- product is 'premium' | 'free' | 'open'. THE WEB PLAYBACK SDK REQUIRES
  -- 'premium' -- a permanent Spotify platform restriction with no app-side
  -- workaround (decisions.md 2026-09-13). Storing it is what lets the Listen
  -- deck render an honest "Premium required" state instead of a player that
  -- silently never produces sound.
  --
  -- KNOWN STALENESS, named rather than hidden: this is a snapshot from
  -- connect time. A user who upgrades to Premium afterwards still reads as
  -- 'free' here until they reconnect. Re-reading /v1/me on every status call
  -- was rejected as a per-page-load request to Spotify for a field that
  -- changes roughly never; the status route reports the captured value and
  -- the deck's reconnect path is the remedy.
  --
  -- All three are nullable: a profile read that fails must never cost the
  -- user a consent they just granted, so the callback stores the connection
  -- with these left null rather than failing the whole exchange.
  provider_account_id text,
  display_name text,
  product text,
  connected_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  -- One connection per user per provider. The OAuth callback upserts on this:
  -- re-consenting replaces the stored token rather than accumulating dead
  -- ones. "Newest wins" is the only correct merge -- the old refresh token
  -- carries the OLD six-month clock, so keeping it would be strictly worse.
  constraint music_connections_user_provider_key unique (user_id, provider),

  -- A cached access token is only meaningful alongside its expiry. Storing
  -- one without the other would leave a reader unable to tell a fresh token
  -- from an hours-dead one, and the safe fallback (assume expired) would make
  -- the cache silently useless rather than visibly wrong.
  constraint music_connections_access_token_paired check (
    (access_token_encrypted is null) = (access_token_expires_at is null)
  )
);

alter table music_connections enable row level security;
-- No policies, deliberately. Do not add one. See the header above.

revoke all on public.music_connections from anon, authenticated;
revoke truncate, references, trigger on public.music_connections from anon, authenticated;
grant select, insert, update, delete on public.music_connections to service_role;

create trigger music_connections_set_updated_at
  before update on music_connections
  for each row execute function public.set_updated_at();

comment on table music_connections is
  'A user''s OAuth connection to a music provider for in-app playback. SERVICE-ROLE ONLY: RLS enabled with no policies AND all privileges revoked from anon/authenticated, so neither the refresh token nor the cached access token ever reaches a browser -- not even its owner''s. The browser receives only a short-lived access token, minted on demand by GET /api/music/spotify/token. Written exclusively by web/app/api/music/spotify/**. See docs/architecture/api.md sec3i.';
comment on column music_connections.refresh_token_encrypted is
  'AES-256-GCM ciphertext in a self-describing ''v1:<iv>:<tag>:<ct>'' envelope, encrypted and decrypted by web/lib/crypto/token-envelope.ts under SPOTIFY_TOKEN_ENCRYPTION_KEY. Never plaintext, never client-readable, and the key is never sent to the database. Spotify may or may not return a NEW refresh token on each refresh -- when it does not, the existing value here is kept rather than nulled out.';
comment on column music_connections.access_token_encrypted is
  'Cached one-hour Spotify access token, encrypted with the same envelope as the refresh token. Nullable -- a connection with no cached token is valid and the next /token call mints one. Exists (where calendar_connections deliberately stores no access token) because the Web Playback SDK''s getOAuthToken callback fires on its own schedule; caching bounds refreshes to roughly one per hour per user instead of one per SDK callback. See decisions.md 2026-09-13.';
comment on column music_connections.refresh_token_expires_at is
  'When the refresh token itself dies -- Spotify''s is six months from the original authorization, and refreshing an access token does NOT extend it. Computed at consent time and stored rather than derived, so a later change to Spotify''s window cannot retro-date existing rows. Null means no known expiry.';
comment on column music_connections.product is
  'The Spotify account tier at connect time -- ''premium'' | ''free'' | ''open''. The Web Playback SDK REQUIRES ''premium''; this is a permanent Spotify platform restriction with no app-side workaround, so this column exists to let the Listen deck say so honestly rather than render a player that never produces sound. Deliberately a connect-time snapshot: a user who upgrades later reads stale until they reconnect, which was judged better than a Spotify request per status call for a field that changes roughly never. Null when the profile read failed (which never costs the user their consent).';
comment on column music_connections.scopes is
  'The scopes Spotify actually granted (from the token response), not the ones requested -- so a later scope addition is detectable as missing consent rather than an opaque 403 mid-playback.';
