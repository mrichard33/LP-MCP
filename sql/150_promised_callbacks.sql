-- ─── sql/150 — promised_callbacks: a promised call is an owned task ──────────
--
-- 2026-10-07 (Mark's handoff; McKoy, GHL rRPO34Ooq0QmtSfXyqSw). The text bot
-- told McKoy "I'll have Brian call you in the next few minutes" on 10-01 and
-- "Brian will be reaching out shortly" again on 10-02. No call came; on 10-04
-- he texted "Stop text". The promise was filed to Five9 once
-- (src/agentic/bot-callback.js) but nothing owned it afterwards: nobody saw
-- that it was never kept, and the bot was free to promise again.
--
-- One row per promise. src/agentic/promised-callbacks.js decides;
-- src/services/promised-callbacks-io.js writes; src/jobs/promised-callback-sweep.js
-- (every 15 min in team hours) marks a row KEPT (a Five9 call to the phone
-- after promised_at, from five9_events_raw, or a rep's outbound GHL message)
-- or EXPIRED (past due_at: one #contact-center card, needs-rep-review tag).
--
-- At most ONE open promise per contact (partial unique index): a second
-- promise while one is open is blocked in the reply (live mode) and only
-- bumps reflag_count.
--
-- ADDITIVE ONLY. Apply from the Supabase dashboard (LP instance); the boot
-- mirror creates it too. Code fails soft until it exists (no row, no guard).

CREATE TABLE IF NOT EXISTS promised_callbacks (
  id                 bigserial PRIMARY KEY,
  ghl_contact_id     text        NOT NULL,
  phone10            text,
  promised_at        timestamptz NOT NULL DEFAULT now(),
  promised_by_rule   text,                 -- rule_applied of the send (AGENTIC_RESPOND_POST_CHATBOT, LIVE_CHAT_FAST_LANE, …)
  promised_action_id bigint,               -- agent_actions.id of the send
  channel            text,                 -- sms | email | livechat
  rep                text,                 -- the name the reply used ("Brian"), or NULL when it named none
  promise_text       text,                 -- the sentence that promised (first 300 chars)
  due_at             timestamptz NOT NULL, -- next business day 12:00 ET
  status             text        NOT NULL DEFAULT 'open'
                       CHECK (status IN ('open', 'kept', 'expired', 'cancelled')),
  kept_evidence      jsonb,                -- { source: 'five9'|'ghl_rep_message', at, … }
  kept_at            timestamptz,
  expired_at         timestamptz,
  reflag_count       integer     NOT NULL DEFAULT 0,
  last_reflagged_at  timestamptz,
  mode               text,                 -- PROMISED_CALLBACK_MODE when written (shadow | live)
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_promised_callbacks_open_contact
  ON promised_callbacks (ghl_contact_id) WHERE status = 'open';
CREATE INDEX IF NOT EXISTS idx_promised_callbacks_status_due
  ON promised_callbacks (status, due_at);
CREATE INDEX IF NOT EXISTS idx_promised_callbacks_contact
  ON promised_callbacks (ghl_contact_id, promised_at DESC);
