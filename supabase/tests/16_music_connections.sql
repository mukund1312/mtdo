\set ON_ERROR_STOP on
\pset pager off
set client_min_messages = notice;
set timezone = 'UTC';

-- migrations/0024 (music_connections) -- the Spotify half of the Listen deck.
--
-- Two claims are worth holding onto here, and they are the ones a future
-- copy-pasted policy or a "helpful" grant would quietly break:
--
--   1. This table is SERVICE-ROLE ONLY, in the strong sense. Not "no policy
--      matches" -- which schema.md sec6 calls an incidental denial -- but the
--      privilege itself revoked, so every client verb is a hard 42501. A
--      Spotify refresh token is a six-month credential to a third-party
--      account; the whole security story of this integration is that a
--      browser cannot read this table even for its own row.
--
--   2. The cached-access-token pair is all-or-nothing. A token without its
--      expiry leaves a reader unable to tell fresh from hours-dead, and the
--      safe fallback (assume expired) would make the cache silently useless
--      rather than visibly wrong. The CHECK is what makes that unrepresentable
--      instead of merely discouraged.

-- ===========================================================================
-- 1. music_connections: authenticated and anon have NO access at all
-- ===========================================================================
do $test$
declare
  v_alice uuid := t.mkuser('spotify_alice');
  v_bob uuid := t.mkuser('spotify_bob');
begin
  -- Seeded as postgres (the table owner), standing in for the service-role
  -- Route Handler that is the only real writer of this table.
  insert into public.music_connections (user_id, refresh_token_encrypted, scopes, product)
    values (v_alice, 'v1:aaaa:bbbb:cccc', '{streaming,user-read-email,user-read-private}', 'premium');
  insert into public.music_connections (user_id, refresh_token_encrypted)
    values (v_bob, 'v1:dddd:eeee:ffff');

  set local role authenticated;
  perform set_config('request.jwt.claim.sub', v_alice::text, true);

  perform t.raises('1 a user cannot SELECT music_connections -- not even their own row',
    'select * from public.music_connections', '42501');
  perform t.raises('1b a user cannot INSERT a music connection',
    format('insert into public.music_connections (user_id, refresh_token_encrypted) values (%L, ''forged'')', v_alice),
    '42501');
  perform t.raises('1c a user cannot UPDATE a music connection',
    'update public.music_connections set product = ''premium''', '42501');
  perform t.raises('1d a user cannot DELETE a music connection',
    'delete from public.music_connections', '42501');
  perform t.raises('1e ...and cannot TRUNCATE it either (RLS does not apply to TRUNCATE)',
    'truncate public.music_connections', '42501');

  -- The refresh token is the point of all of the above. Named explicitly so a
  -- future reader sees WHAT is being protected, not just that a grant is off.
  perform t.raises('1f a user cannot read the encrypted refresh token by naming the column directly',
    'select refresh_token_encrypted from public.music_connections', '42501');
  perform t.raises('1g ...nor the cached access token',
    'select access_token_encrypted from public.music_connections', '42501');

  set local role anon;
  perform t.raises('1h anon cannot SELECT music_connections either',
    'select * from public.music_connections', '42501');
  perform t.raises('1i anon cannot INSERT a music connection',
    format('insert into public.music_connections (user_id, refresh_token_encrypted) values (%L, ''forged'')', v_alice),
    '42501');

  reset role;
  raise notice '--- music_connections is service-role only: complete ---';
end
$test$;

-- ===========================================================================
-- 2. service_role CAN do the work the Route Handlers actually need
-- ===========================================================================
-- The mirror image of section 1, and not a formality: revoking from
-- anon/authenticated with a typo'd grant to service_role would pass every
-- assertion above while leaving the integration completely non-functional.
do $test$
declare
  v_uid uuid := t.mkuser('spotify_service');
  v_row public.music_connections;
begin
  set local role service_role;

  insert into public.music_connections (user_id, refresh_token_encrypted)
    values (v_uid, 'v1:1111:2222:3333');
  perform t.eq('2 service_role can INSERT a connection',
    (select count(*)::int from public.music_connections where user_id = v_uid), 1);

  update public.music_connections set product = 'premium' where user_id = v_uid;
  perform t.eq('2b service_role can UPDATE it',
    (select product from public.music_connections where user_id = v_uid), 'premium');

  select * into v_row from public.music_connections where user_id = v_uid;
  perform t.eq('2c service_role can read the encrypted refresh token back',
    v_row.refresh_token_encrypted, 'v1:1111:2222:3333');

  delete from public.music_connections where user_id = v_uid;
  perform t.eq('2d service_role can DELETE it',
    (select count(*)::int from public.music_connections where user_id = v_uid), 0);

  reset role;
  raise notice '--- service_role has exactly the access the routes need: complete ---';
end
$test$;

-- ===========================================================================
-- 3. Constraints: one connection per user+provider, paired access token,
--    provider CHECK, and the auth.users cascade
-- ===========================================================================
do $test$
declare
  v_uid uuid := t.mkuser('spotify_constraints');
  v_other uuid := t.mkuser('spotify_cascade');
begin
  insert into public.music_connections (user_id, refresh_token_encrypted)
    values (v_uid, 'v1:aaaa:bbbb:cccc');

  -- The upsert target. Re-consenting must REPLACE the row, not accumulate a
  -- second one: the old refresh token carries the old (earlier) six-month
  -- deadline, so a stale duplicate would be strictly worse than no row.
  perform t.raises('3 a second connection for the same user+provider is rejected',
    format('insert into public.music_connections (user_id, refresh_token_encrypted) values (%L, ''v1:x:y:z'')', v_uid),
    '23505');

  -- ...and the constraint is on the PAIR, not on user_id alone, so a second
  -- provider would be free to land here once one is implemented.
  perform t.raises('3b an unimplemented provider is a CHECK violation, not a silently unusable row',
    format('insert into public.music_connections (user_id, provider, refresh_token_encrypted) values (%L, ''apple'', ''v1:x:y:z'')', v_uid),
    '23514');

  -- ===== the cached access token is all-or-nothing =======================
  perform t.raises('3c a cached access token without an expiry is rejected',
    format('update public.music_connections set access_token_encrypted = ''v1:q:r:s'' where user_id = %L', v_uid),
    '23514');
  perform t.raises('3d ...and an expiry without a token is rejected too',
    format('update public.music_connections set access_token_expires_at = now() where user_id = %L', v_uid),
    '23514');

  update public.music_connections
     set access_token_encrypted = 'v1:q:r:s', access_token_expires_at = now() + interval '1 hour'
   where user_id = v_uid;
  perform t.eq('3e the pair set together is accepted',
    (select access_token_encrypted from public.music_connections where user_id = v_uid), 'v1:q:r:s');

  -- Clearing the cache is the other legal half of the pair -- a connection
  -- with no cached token is valid, and the next /token call mints one.
  update public.music_connections
     set access_token_encrypted = null, access_token_expires_at = null
   where user_id = v_uid;
  perform t.eq('3f clearing both together is accepted (a connection with no cached token is valid)',
    (select access_token_encrypted from public.music_connections where user_id = v_uid), null::text);

  -- ===== defaults worth asserting rather than assuming ===================
  perform t.eq('3g provider defaults to spotify',
    (select provider from public.music_connections where user_id = v_uid), 'spotify');
  perform t.eq('3h scopes default to empty, never null',
    (select scopes from public.music_connections where user_id = v_uid), '{}'::text[]);
  perform t.eq('3i a fresh connection has no known refresh-token expiry until the app sets one',
    (select refresh_token_expires_at from public.music_connections where user_id = v_uid), null::timestamptz);

  -- ===== deleting the user takes the credential with it ==================
  -- The one guarantee that matters for account deletion: no orphaned
  -- third-party credential survives the user it belonged to.
  insert into public.music_connections (user_id, refresh_token_encrypted)
    values (v_other, 'v1:cascade:me:now');
  delete from auth.users where id = v_other;
  perform t.eq('3j deleting the user cascades the connection away, leaving no orphaned credential',
    (select count(*)::int from public.music_connections where user_id = v_other), 0);

  raise notice '--- music_connections constraints: complete ---';
end
$test$;

-- ===========================================================================
-- 4. updated_at is maintained by the trigger, not by the caller
-- ===========================================================================
-- The refresh path (lib/music/spotify/connection.ts) updates only the two
-- access-token columns. If updated_at were the app's job, every one of those
-- writes would have to remember it, and the one that forgot would be invisible.
--
-- HOW THIS IS ASSERTED, AND WHY NOT THE OBVIOUS WAY. The natural test --
-- record updated_at, update the row, assert it grew -- CANNOT WORK HERE, and
-- writing it first is how that was discovered. public.set_updated_at() (0001)
-- assigns now(), which is TRANSACTION timestamp, not wall clock: it returns
-- the identical value for every statement in this do-block, so a real,
-- correctly-firing trigger produces before = after and the test fails on a
-- non-bug. pg_sleep() does not help, because it advances the clock but not
-- now().
--
-- So the claim is tested from the other side, which is also the sharper one:
-- the trigger OVERRIDES whatever the caller supplied. That distinguishes a
-- firing trigger from an absent one without depending on time passing at all
-- -- if the trigger were dropped, the bogus value below would survive.
do $test$
declare
  v_uid uuid := t.mkuser('spotify_touch');
  v_stale timestamptz := timestamptz '2000-01-01 00:00:00+00';
begin
  insert into public.music_connections (user_id, refresh_token_encrypted)
    values (v_uid, 'v1:aaaa:bbbb:cccc');

  update public.music_connections
     set access_token_encrypted = 'v1:q:r:s',
         access_token_expires_at = now() + interval '1 hour',
         updated_at = v_stale
   where user_id = v_uid;

  perform t.eq('4 the trigger overrides a caller-supplied updated_at on an access-token refresh',
    (select updated_at from public.music_connections where user_id = v_uid), now());
  perform t.eq('4b ...so the stale value the caller passed did not survive',
    (select updated_at = v_stale from public.music_connections where user_id = v_uid), false);

  raise notice '--- music_connections updated_at trigger: complete ---';
end
$test$;
