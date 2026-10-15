-- 20261015180100_appt_time_change_requests.sql
--
-- WHAT: appt_time_change_requests, one row per lead who asked the bot for an evening time after 6:00 PM
--       (6:30, 7:00) and was booked at 6:00 PM instead.
-- WHY: Mark, 2026-10-15 (rules R5 and R8). The bot never books 6:30 or 7:00. It books 6:00 and tells the lead
--      the team will confirm and adjust. The confirming agent works in Lead Perfection, so the request goes onto
--      the LP prospect as an IMPORTANT note once the appointment is in LP. This row is that note's idempotency
--      record: src/services/time-change-lp-note.js writes the note only while status = 'pending', from the LP
--      appointment sync's success path or the 15-minute sweep, then sets status 'written'. An appointment cancelled
--      or moved off 6:00 PM first is 'superseded' and gets no note. Still pending after 24h is 'failed'.
--      alerted_at records the ONE #contact-center card for a note that has not been written in time.
-- NOT: no GHL tag and no GHL task (Mark does not use GHL tasks). No customer text is stored beyond the
--      requested time.
-- ROLLBACK: CAPACITY_GATE_ENABLED=false stops new rows; the sweep still drains pending ones. Additive; leave it.

create table if not exists public.appt_time_change_requests (
  id                  uuid        primary key default gen_random_uuid(),
  ghl_contact_id      text        not null,
  ghl_appointment_id  text        not null unique,
  market_code         text,
  booked_start        timestamptz not null,
  requested_time      text        not null,   -- "6:30 PM"
  requested_label     text        not null,   -- "6:30 PM on Thu Oct 16"
  lp_prospect_id      text,
  lp_note_written_at  timestamptz,
  lp_note_id          text,
  status              text        not null default 'pending'
    check (status in ('pending', 'written', 'superseded', 'failed')),
  alerted_at          timestamptz,
  last_error          text,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);

create index if not exists appt_time_change_requests_status_created_idx
  on public.appt_time_change_requests (status, created_at);

alter table public.appt_time_change_requests enable row level security;
