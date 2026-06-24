-- 035_ghl_note_pipeline.sql
-- GHL Inbound → LP Note pipeline (receiver + summarizer).
--
-- Turns GoHighLevel inbound conversations into one clean, single, facts-only
-- note per conversation session in Lead Perfection for the call center.
-- Fully independent of Revin. See src/ghl-note-pipeline/* for the worker.
--
-- Run against the LP Supabase database.

CREATE TABLE IF NOT EXISTS ghl_conversation_pending (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ghl_conversation_id text UNIQUE NOT NULL,
  ghl_contact_id text NOT NULL,
  lp_lead_id text,
  last_inbound_at timestamptz NOT NULL DEFAULT now(),
  last_message_body text,
  terminal boolean NOT NULL DEFAULT false,
  terminal_reason text,
  status text NOT NULL DEFAULT 'pending',   -- pending | processing | done | failed
  session_start_at timestamptz,             -- summarize messages strictly AFTER this; null = from beginning
  summarized_through_at timestamptz,        -- end boundary of the last summarized session
  claimed_at timestamptz,
  attempts int NOT NULL DEFAULT 0,
  notes_written int NOT NULL DEFAULT 0,
  last_lp_note_id text,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_gcp_due ON ghl_conversation_pending (status, terminal, last_inbound_at);

-- At-most-once guard per conversation-session
CREATE TABLE IF NOT EXISTS ghl_note_dedupe (
  dedupe_key text PRIMARY KEY,              -- {ghl_conversation_id}:{summarized_through_at epoch_ms}
  ghl_conversation_id text NOT NULL,
  lp_note_id text,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Shadow output for review before going live
CREATE TABLE IF NOT EXISTS ghl_note_shadow_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ghl_conversation_id text NOT NULL,
  ghl_contact_id text NOT NULL,
  lp_lead_id text,
  would_be_note text NOT NULL,
  important boolean NOT NULL DEFAULT false,
  channel_types int[],
  message_count int,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Live write audit
CREATE TABLE IF NOT EXISTS ghl_note_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ghl_conversation_id text NOT NULL,
  ghl_contact_id text NOT NULL,
  lp_lead_id text,
  lp_note_id text,
  important boolean,
  note_preview text,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- ─── Atomic conditional upsert (webhook receiver, §4.5) ──────────
-- The ON CONFLICT branch references the existing row's own columns (terminal
-- OR, status/session_start_at CASE), which the supabase-js client cannot
-- express. This SECURITY DEFINER function performs the upsert atomically and
-- returns the row id. Mirrors the repo's claim_agent_actions RPC convention.
CREATE OR REPLACE FUNCTION ghl_note_upsert_pending(
  p_conv text,
  p_contact text,
  p_body text,
  p_terminal boolean,
  p_reason text
) RETURNS uuid
LANGUAGE plpgsql
AS $$
DECLARE
  v_id uuid;
BEGIN
  INSERT INTO ghl_conversation_pending
    (ghl_conversation_id, ghl_contact_id, last_inbound_at, last_message_body, terminal, terminal_reason)
  VALUES (p_conv, p_contact, now(), p_body, COALESCE(p_terminal, false), p_reason)
  ON CONFLICT (ghl_conversation_id) DO UPDATE SET
    last_inbound_at   = now(),
    last_message_body = EXCLUDED.last_message_body,
    ghl_contact_id    = EXCLUDED.ghl_contact_id,
    terminal          = ghl_conversation_pending.terminal OR EXCLUDED.terminal,
    terminal_reason   = COALESCE(EXCLUDED.terminal_reason, ghl_conversation_pending.terminal_reason),
    status            = CASE WHEN ghl_conversation_pending.status IN ('done','failed')
                             THEN 'pending' ELSE ghl_conversation_pending.status END,
    session_start_at  = CASE WHEN ghl_conversation_pending.status IN ('done','failed')
                             THEN ghl_conversation_pending.summarized_through_at
                             ELSE ghl_conversation_pending.session_start_at END,
    updated_at = now()
  RETURNING id INTO v_id;
  RETURN v_id;
END;
$$;
