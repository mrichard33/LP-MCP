-- 20261015221000_live_chat_summaries.sql
--
-- WHAT: live_chat_summaries, one row per live-chat SESSION (a contact's turns with no gap longer than
--       LIVE_CHAT_SUMMARY_QUIET_MIN, default 15). The row is the claim, the shadow record and the Slack record
--       of that session's ONE summary card.
-- WHY: 2026-10-15 (Mark: "no redundant or unnecessary Slack notifications … group a chat into one summary after the
--      conversation ends"). One chat (contact jhVZZUtXp3jDrBsXOZcK) posted six LARGE JOB cards in six minutes.
--      src/jobs/live-chat-summary.js (every minute) inserts this row BEFORE it builds or posts anything, so
--      UNIQUE (contact_id, session_start) is what makes it one card per session across passes and replicas.
--      A later session for the same contact is posted as a thread reply under the first card (thread_ts).
-- NOT: no customer phone or email in payload (the facts are codes and counts, plus the 2-3 line summary).
-- ROLLBACK: LIVE_CHAT_SUMMARY_MODE=off stops all reads and writes. Additive; leave the table.

create table if not exists public.live_chat_summaries (
  id             bigserial   primary key,
  contact_id     text        not null,
  session_start  timestamptz not null,
  last_turn_at   timestamptz not null,
  turns          integer     not null default 0,
  mode           text        not null check (mode in ('shadow', 'live')),
  posted_at      timestamptz,
  slack_channel  text,
  slack_ts       text,
  thread_ts      text,
  attempts       integer     not null default 0,
  error          text,
  payload        jsonb       not null default '{}'::jsonb,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  constraint live_chat_summaries_session_key unique (contact_id, session_start)
);

create index if not exists live_chat_summaries_contact_posted_idx
  on public.live_chat_summaries (contact_id, posted_at desc);

alter table public.live_chat_summaries enable row level security;
revoke all on public.live_chat_summaries from anon, authenticated;
