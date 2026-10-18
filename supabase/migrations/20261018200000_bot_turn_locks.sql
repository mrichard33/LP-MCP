-- 20261018200000_bot_turn_locks.sql
--
-- WHAT: bot_turn_locks — one row per (contact, inbound turn): which reply path owns it, when it was claimed, and
--       how it ended (sent | watchdog_recovered | a skip reason). turn_key is the inbound's GHL message id
--       ("msg:<id>") or the sha256 of its normalised text ("txt:<hex>"); see src/agentic/turn-key.js.
-- WHY: Phase 1 (architecture review 2026-10-17, cause 4). Four Decision Engine rules (106, 161, 228, 373) can answer
--      one SMS and a rule-written send can re-fire with no new inbound: Teresa got two DQ replies (2026-10-18), Shawn
--      (2026-10-15) and Paul (2026-10-17) two replies to one text. Every reply path claims the turn here before any
--      model call (src/agentic/turn-lock-io.js); a failed claim is a skip row, never a second message.
--      owner_action_id lets a deferred retry of the SAME action re-enter its own claim.
-- NOT: no backfill; rows are written from deploy on. TURN_LOCK_MODE=shadow claims and records only.
-- ROLLBACK: TURN_LOCK_MODE=shadow (behaviour), then drop table bot_turn_locks (nothing else reads it).

create table if not exists public.bot_turn_locks (
  contact_id text not null,
  turn_key text not null,
  owner_rule text,
  owner_action_id text,
  channel text,
  claimed_at timestamptz not null default now(),
  released_at timestamptz,
  outcome text,
  primary key (contact_id, turn_key)
);

create index if not exists bot_turn_locks_contact_claimed_idx on public.bot_turn_locks (contact_id, claimed_at desc);

alter table public.bot_turn_locks enable row level security;

comment on table public.bot_turn_locks is 'Phase 1 (2026-10-18): one owner per inbound turn. Written by src/agentic/turn-lock-io.js; a failed claim is a skip row in bot_message_context.';
