-- mtdo web -- AI Tutor Memory schema (docs/architecture/schema.md §3)
-- Do NOT replay full history on every request -- tutor_memory_summaries holds
-- a rolling summary, regenerated periodically, which is what keeps this
-- affordable. Never read tutor_messages beyond a recent window in application
-- code without also consulting the summary.

create table tutor_conversations (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  created_at timestamptz not null default now(),
  last_message_at timestamptz not null default now()
);

create table tutor_messages (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references tutor_conversations (id) on delete cascade,
  role text not null check (role in ('user', 'assistant')),
  content text not null,
  created_at timestamptz not null default now()
);

create index tutor_messages_conversation_idx on tutor_messages (conversation_id, created_at);

create table tutor_memory_summaries (
  user_id uuid primary key references auth.users (id) on delete cascade,
  summary text not null default '',
  updated_at timestamptz not null default now(),
  source_message_count integer not null default 0
);

alter table tutor_conversations enable row level security;
alter table tutor_messages enable row level security;
alter table tutor_memory_summaries enable row level security;

create policy "tutor_conversations_owner_all" on tutor_conversations
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

create policy "tutor_messages_owner_all" on tutor_messages
  for all using (
    exists (
      select 1 from tutor_conversations c
      where c.id = tutor_messages.conversation_id and c.user_id = auth.uid()
    )
  ) with check (
    exists (
      select 1 from tutor_conversations c
      where c.id = tutor_messages.conversation_id and c.user_id = auth.uid()
    )
  );

create policy "tutor_memory_summaries_owner_select" on tutor_memory_summaries
  for select using (auth.uid() = user_id);
-- Insert/update happens only via the summarization job (service role), not
-- directly by users -- the summary is derived, not user-authored.

-- Soft free-tier usage cap support (schema.md §3): count today's tutor
-- messages from the ledger. Enforced in application code as a WHERE clause
-- over activity_events; no new infrastructure required. Emit a
-- 'tutor_message_sent' activity_events row alongside every tutor_messages
-- insert so this count stays accurate.
