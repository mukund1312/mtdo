-- mtdo web -- AI Tutor Memory schema (docs/architecture/schema.md §3)
-- Do NOT replay full history on every request -- tutor_memory_summaries holds
-- a rolling summary, regenerated periodically, which is what keeps this
-- affordable.
--
-- This file makes the cheap query the easy one and the expensive query the
-- awkward one, rather than the reverse:
--   * reads go through tutor_context(), which returns summary + a bounded
--     recent window in one call, and is the ONLY read path granted to clients;
--   * the summarization job's "what is not yet summarized" question is
--     answered by a timestamp watermark (summarized_through), not by a row
--     count that cannot identify *which* rows it covered.
--
-- Read the security-model header of 0001_seam.sql first: the same rules about
-- RLS-vs-GRANTs and security-definer ownership apply here.

create table tutor_conversations (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  created_at timestamptz not null default now(),
  last_message_at timestamptz not null default now()
);

create index tutor_conversations_user_recent_idx
  on tutor_conversations (user_id, last_message_at desc);

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
  -- Watermark, not a count. The uncovered tail is exactly
  --   select * from tutor_messages
  --    where conversation_id = $1 and created_at > summarized_through
  --    order by created_at
  -- which a count could never express: a count cannot say *which* messages it
  -- covered, so any insert, backfill, or out-of-order write silently
  -- desynchronizes it and the summary starts skipping or repeating messages.
  -- '-infinity' means "nothing summarized yet", so the first run reads all.
  summarized_through timestamptz not null default '-infinity'
);

alter table tutor_conversations enable row level security;
alter table tutor_messages enable row level security;
alter table tutor_memory_summaries enable row level security;

-- Conversations stay fully user-owned: a conversation row is just a container,
-- and deleting your own chat history is a legitimate action. (Deleting one
-- does not affect the usage cap, which counts immutable ledger events.)
create policy "tutor_conversations_owner_all" on tutor_conversations
  for all to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

-- tutor_messages is server-written only.
--
-- The old `for all` policy checked conversation ownership but nothing else --
-- notably not `role`. A client could therefore insert its own
-- role='assistant' messages, which the summarization job would later fold into
-- the rolling summary and feed back into the model as its own prior words:
-- a self-directed prompt-injection channel, laundered through memory.
--
-- Reads are revoked too (see the REVOKE below): with no direct-read path,
-- tutor_context() is the only way in, and the schema fails closed until the
-- real chat backend exists. Nothing today depends on direct client reads, so
-- closed is the cheap default.
--
-- This policy is kept, scoped to SELECT, so that if a future direct-read path
-- is ever granted it is already correctly bounded -- today the missing GRANT
-- is what actually denies the read.
create policy "tutor_messages_select_own" on tutor_messages
  for select to authenticated using (
    exists (
      select 1 from tutor_conversations c
      where c.id = tutor_messages.conversation_id and c.user_id = (select auth.uid())
    )
  );

-- `all`, not just the four DML verbs: Supabase's `grant all on tables` also
-- hands out TRUNCATE, which is not subject to RLS. See 0001_seam.sql §9.
revoke all on public.tutor_messages from anon, authenticated;

create policy "tutor_memory_summaries_owner_select" on tutor_memory_summaries
  for select to authenticated using ((select auth.uid()) = user_id);

-- Derived artifact, written only by the (future) summarization job running as
-- service_role. Explicit REVOKE rather than relying on "no policy = deny",
-- because Supabase's default privileges have already granted the table rights.
revoke all on public.tutor_memory_summaries from anon, authenticated;
grant select on public.tutor_memory_summaries to authenticated;

-- THE sanctioned tutor read path: rolling summary + a bounded recent window,
-- one round trip, ownership verified server-side.
--
-- Making this the only available shape is the point. A client that could read
-- tutor_messages directly would inevitably grow a "just fetch the whole thread"
-- call site, and full-history replay is the single decision this subsystem
-- cannot afford to get wrong (schema.md §3).
create function public.tutor_context(
  p_conversation_id uuid,
  p_recent_limit integer default 20
)
returns table (summary text, recent jsonb)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_limit integer := least(greatest(coalesce(p_recent_limit, 20), 1), 100);
  v_summary text;
  v_recent jsonb;
begin
  if v_uid is null then
    raise exception 'tutor_context: no authenticated user' using errcode = '42501';
  end if;

  -- This function is exempt from RLS (it runs as its owner), so this check IS
  -- the access control -- it is not a duplicate of a policy.
  if not exists (
    select 1 from public.tutor_conversations c
    where c.id = p_conversation_id and c.user_id = v_uid
  ) then
    raise exception 'tutor_context: conversation % not found for this user', p_conversation_id
      using errcode = '42501';
  end if;

  select s.summary into v_summary
    from public.tutor_memory_summaries s
   where s.user_id = v_uid;

  -- Inner query takes the newest v_limit rows; the aggregate re-orders them
  -- oldest-first, which is the order a model prompt wants them in.
  select coalesce(jsonb_agg(m order by m.created_at), '[]'::jsonb)
    into v_recent
    from (
      select tm.id, tm.role, tm.content, tm.created_at
        from public.tutor_messages tm
       where tm.conversation_id = p_conversation_id
       order by tm.created_at desc, tm.id desc
       limit v_limit
    ) m;

  return query select coalesce(v_summary, ''), v_recent;
end;
$$;

alter function public.tutor_context(uuid, integer) owner to postgres;
revoke execute on function public.tutor_context(uuid, integer) from public, anon, authenticated;
grant execute on function public.tutor_context(uuid, integer) to authenticated;

-- Soft free-tier usage cap (schema.md §3): count today's 'tutor_message_sent'
-- rows in activity_events for the user, before calling the model.
--
-- 'tutor_message_sent' is deliberately absent from record_event()'s
-- client-appendable whitelist (0001_seam.sql §4), so a client cannot mint one
-- -- and, more importantly, cannot *decline* to mint one. Under the old design
-- the count depended on the client honestly emitting the event alongside its
-- own tutor_messages insert, which made the cap opt-in for anyone who read the
-- network tab. Now the same backend that writes the message writes the event,
-- as service_role, in the same transaction. The cap is only as good as that
-- pairing: keep them in one transaction.
--
-- Backed by activity_events_user_kind_occurred_idx.

-- Repeat of 0001_seam.sql §9 for the tables created above: TRUNCATE (not
-- covered by RLS), REFERENCES and TRIGGER are never needed by a PostgREST
-- client. Every future migration that adds a table to `public` should end the
-- same way.
revoke truncate, references, trigger on all tables in schema public
  from anon, authenticated;
