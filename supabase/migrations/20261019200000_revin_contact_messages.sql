-- 20261019200000_revin_contact_messages.sql
--
-- WHAT: revin_events_raw (every Revin webhook body, as received), contact_messages (one row per message, any
--       source, attached to a contact) and contact_thread_v (one ordered thread per contact: contact_messages plus
--       our bot's turns from bot_message_context and our sent nurture texts from agentic_messages, read in place).
-- WHY: Revin AI texts our leads and all we kept was the ~160-character summary note it writes into LP
--      (lp_notes.note_origin = 'lp_revin', sql/129). POST /webhooks/revin (src/revin/webhook.js) stores the raw body
--      first and answers 200; src/revin/process.js normalizes it, matches the contact read-only and writes
--      contact_messages; job revin-relink attaches unmatched rows later and follows contact merges.
--      Dedupe: dedupe_key is 'x:<external_id>' when Revin sends a message id, else 'h:' || md5(phone|sent_at|body),
--      UNIQUE with source. One plain unique key (not two partial indexes) so PostgREST can upsert on it.
-- NOT: nothing here sends a message, creates a GHL contact or an LP lead, or touches the lp_revin note sync.
--      A Revin call event is stored as channel 'call_event' for context only: Five9 stays the only call source and
--      nothing counts these rows as calls. The chatbot reads Revin turns only with BOT_INCLUDE_REVIN_THREAD=true.
-- ROLLBACK: unset the Revin webhook in Revin, then drop view contact_thread_v, drop table contact_messages,
--           drop table revin_events_raw (only src/revin/* and the relink job read them).

create table if not exists public.revin_events_raw (
  id uuid primary key default gen_random_uuid(),
  received_at timestamptz not null default now(),
  headers jsonb,
  payload jsonb,
  payload_hash text not null,
  processed_at timestamptz,
  process_status text not null default 'pending',
  process_error text,
  attempts integer not null default 0,
  constraint revin_events_raw_payload_hash_key unique (payload_hash),
  constraint revin_events_raw_status_check check (process_status in ('pending', 'ok', 'unmatched', 'error'))
);

create index if not exists revin_events_raw_status_received_idx
  on public.revin_events_raw (process_status, received_at);

create table if not exists public.contact_messages (
  id uuid primary key default gen_random_uuid(),
  ghl_contact_id text,
  lp_lead_id text,
  phone_e164 text,
  source text not null,
  channel text not null,
  direction text not null,
  body text,
  sent_at timestamptz,
  external_id text,
  external_thread_id text,
  event_type text,
  dedupe_key text not null,
  raw_event_id uuid references public.revin_events_raw (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint contact_messages_source_dedupe_key unique (source, dedupe_key),
  constraint contact_messages_source_check check (source in ('revin', 'chatbot', 'ghl', 'agentic')),
  constraint contact_messages_channel_check check (channel in ('sms', 'email', 'chat', 'call_event', 'system')),
  constraint contact_messages_direction_check check (direction in ('outbound', 'inbound', 'event'))
);

create index if not exists contact_messages_contact_sent_idx on public.contact_messages (ghl_contact_id, sent_at);
create index if not exists contact_messages_lead_sent_idx on public.contact_messages (lp_lead_id, sent_at);
create index if not exists contact_messages_phone_sent_idx on public.contact_messages (phone_e164, sent_at);
create index if not exists contact_messages_unmatched_idx on public.contact_messages (created_at)
  where ghl_contact_id is null;

alter table public.revin_events_raw enable row level security;
alter table public.contact_messages enable row level security;

comment on table public.revin_events_raw is '2026-10-19: every Revin webhook body as received (secret header removed). Written by src/revin/webhook.js; processed by src/revin/process.js.';
comment on table public.contact_messages is '2026-10-19: one row per message from an outside source (Revin today), attached to a contact. Read through contact_thread_v. Revin call events are context only, never a call count.';

-- One thread per contact. Our own turns are read in place, never copied. security_invoker: the view reads as the
-- caller (the service role here), so it never opens the RLS-protected tables to anyone else.
create or replace view public.contact_thread_v with (security_invoker = true) as
select cm.id::text as id, cm.ghl_contact_id, cm.lp_lead_id, cm.phone_e164, cm.source, cm.channel, cm.direction,
       cm.body, cm.sent_at, cm.external_id, cm.event_type
  from public.contact_messages cm
union all
select 'bmc-in-' || b.id, b.ghl_contact_id, null, null, 'chatbot',
       case when b.channel in ('livechat', 'chat') then 'chat' when b.channel = 'email' then 'email' else 'sms' end,
       'inbound', b.inbound_text, b.generated_at, b.message_ref, 'message'
  from public.bot_message_context b
 where b.ghl_contact_id is not null and nullif(btrim(b.inbound_text), '') is not null
union all
select 'bmc-out-' || b.id, b.ghl_contact_id, null, null, 'chatbot',
       case when b.channel in ('livechat', 'chat') then 'chat' when b.channel = 'email' then 'email' else 'sms' end,
       'outbound', b.reply_text, b.sent_at, b.message_ref, 'message'
  from public.bot_message_context b
 where b.ghl_contact_id is not null and b.sent_at is not null and nullif(btrim(b.reply_text), '') is not null
union all
select 'am-' || a.id::text, a.ghl_contact_id, null, null, 'agentic',
       case when a.channel = 'email' then 'email' else 'sms' end,
       'outbound', coalesce(a.generated_sms, a.generated_body), coalesce(a.ghl_sent_at, a.generated_at),
       a.generation_id, 'message'
  from public.agentic_messages a
 where a.send_status = 'ghl_sent_confirmed';

comment on view public.contact_thread_v is '2026-10-19: one thread per contact: contact_messages (Revin) + bot_message_context (our bot, both sides) + sent agentic_messages. Order by sent_at.';
