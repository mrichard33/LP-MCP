-- ─── sql/157 — agentic_no_reply_followups: one check-in per welcome text ─────
--
-- 2026-10-11 (Javier, GHL r5hMYoAdxhAPmj9U5Mjv). His web-chat "Hi" landed at
-- 20:51:40Z, GHL's welcome SMS at 20:51:49Z, and the bot answered the "Hi" at
-- 20:52:26Z with "thanks for reaching back out". He had replied to nothing.
--
-- When the lead's message is OLDER than the welcome text and they have not
-- answered it, the reply is held (OPENER_HOLD_MODE=live) and one row lands
-- here. src/jobs/no-reply-followup.js sends the single approved follow-up
-- (buildNoReplyFollowup) once due_at passes, unless the lead replied, anyone
-- messaged since, the contact is opted out / suppressed, or a visit is booked.
-- In shadow mode the rows are written with status 'shadow' and never sent.
--
-- status: pending | sending (claimed by one tick) | sent | skipped | shadow
-- mode:   shadow | live (the OPENER_HOLD_MODE that wrote the row)
-- sent_message_id: the agent_actions.id of the queued send_message row.
--
-- UNIQUE (ghl_contact_id, opener_message_at) is the "one follow-up per welcome
-- text" rule; the code inserts with ON CONFLICT DO NOTHING.
--
-- ADDITIVE ONLY. Apply from the Supabase dashboard (LP instance); the boot
-- mirror creates it too. Code fails soft until it exists.

CREATE TABLE IF NOT EXISTS agentic_no_reply_followups (
  id                 bigserial PRIMARY KEY,
  ghl_contact_id     text        NOT NULL,
  conversation_id    text,
  opener_message_at  timestamptz NOT NULL,
  trigger_message_at timestamptz,
  due_at             timestamptz NOT NULL,
  status             text        NOT NULL DEFAULT 'pending',  -- pending | sending | sent | skipped | shadow
  skip_reason        text,
  mode               text        NOT NULL,                    -- shadow | live
  message_text       text,
  sent_message_id    text,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (ghl_contact_id, opener_message_at)
);
CREATE INDEX IF NOT EXISTS agentic_no_reply_followups_due_idx
  ON agentic_no_reply_followups (status, due_at);
