-- AI provider abstraction (Phase 2 of the operating-engine plan): a
-- per-user override for self-hosters, and the audit trail the future Tutor
-- free-tier cap (Phase 8) will read from. Provider selection itself is
-- server-env-driven (AI_PROVIDER/OLLAMA_ENDPOINT/OLLAMA_MODEL, see
-- web/lib/ai/service.ts) -- this table is only consulted for a user who has
-- explicitly chosen to override the deployed default, not the primary
-- selection path.

-- 1. ai_provider_settings -------------------------------------------------
-- One row per user, ordinary client-writable table (same posture as
-- profiles): a user's own choice of provider/model, nothing server-derived.

create table ai_provider_settings (
  user_id uuid primary key references auth.users (id) on delete cascade,
  provider text not null default 'anthropic' check (provider in ('anthropic', 'ollama')),
  -- Only meaningful when provider = 'ollama'; null otherwise. Not validated
  -- as a reachable URL here -- GET /api/ai/status is the live reachability
  -- check, a CHECK constraint can't make an HTTP request.
  endpoint text,
  planning_model text,
  coaching_model text,
  updated_at timestamptz not null default now()
);

alter table ai_provider_settings enable row level security;

create policy "ai_provider_settings_select_own" on ai_provider_settings
  for select to authenticated using ((select auth.uid()) = user_id);
create policy "ai_provider_settings_insert_own" on ai_provider_settings
  for insert to authenticated with check ((select auth.uid()) = user_id);
create policy "ai_provider_settings_update_own" on ai_provider_settings
  for update to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

revoke all on public.ai_provider_settings from anon, authenticated;
grant select, insert, update on public.ai_provider_settings to authenticated;

create trigger ai_provider_settings_set_updated_at
  before update on ai_provider_settings
  for each row execute function public.set_updated_at();

comment on table ai_provider_settings is
  'Per-user override of the server-env-driven default provider (web/lib/ai/service.ts). Ordinary client-writable settings row, not an access-control surface. See docs/architecture/api.md §2.';

-- 2. ai_generations --------------------------------------------------------
-- Append-only audit trail of every AI call this app makes on a user's
-- behalf, across every domain method (goal plan, weekly review, tutor
-- reply, ...) -- same posture as activity_events: service-role write,
-- SELECT-own read, no client write path. `kind` is deliberately open text,
-- not a CHECK-constrained enum: new AI-backed features (Phase 7's
-- reviewWeek, Phase 8's Tutor) add new kinds over time and a closed enum
-- would need a migration per feature just to log it.

create table ai_generations (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  kind text not null,
  provider text not null,
  model text not null,
  valid boolean not null,
  error_code text,
  input_tokens integer check (input_tokens >= 0),
  output_tokens integer check (output_tokens >= 0),
  created_at timestamptz not null default now()
);

create index ai_generations_user_created_idx on ai_generations (user_id, created_at desc);

alter table ai_generations enable row level security;

create policy "ai_generations_select_own" on ai_generations
  for select to authenticated using ((select auth.uid()) = user_id);

revoke all on public.ai_generations from anon, authenticated;
grant select on public.ai_generations to authenticated;
grant insert on public.ai_generations to service_role;

comment on table ai_generations is
  'Append-only audit trail of every AI provider call made on a user''s behalf -- service-role insert only, SELECT-own to the client, same posture as activity_events. Backs the future Tutor free-tier cap (Phase 8) and provider/cost visibility in Settings -> AI. See docs/architecture/api.md §2.';
