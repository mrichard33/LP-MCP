-- Agentic Messages — Outbound Nurture Generation Audit Log
--
-- One row per generation cycle. The orchestrator
-- (src/nurture/nurture-orchestrator.js) INSERTs a 'pending' row at the
-- start of each cycle and UPDATEs the same row as the pipeline
-- progresses through hard blockers, scoring, and writeback.
--
-- State machine (enforced in app code; DB only constrains the enum):
--
--   (none)              ─INSERT─→ pending
--   pending             ─UPDATE─→ generated_ready       (writeback ok)
--   pending             ─UPDATE─→ suppressed_low_conf   (score < threshold after retry)
--   pending             ─UPDATE─→ suppressed_interrupt  (pre-gen interrupt: booked, DNC, etc.)
--   pending             ─UPDATE─→ suppressed_overlap    (too-recent message)
--   pending             ─UPDATE─→ failed_generation     (LLM error after retry)
--   generated_ready     ─UPDATE─→ cancelled_state_change  (future — Decision Engine listener)
--   generated_ready     ─UPDATE─→ ghl_sent_confirmed      (future — engagement webhook)
--   generated_ready     ─UPDATE─→ ghl_send_failed         (future — engagement webhook)
--
-- v1 implements only the pending → {generated_ready | suppressed_* |
-- failed_generation} transitions. The 'ghl_sent_confirmed' path
-- requires the engagement webhook receiver (not in v1).

CREATE TABLE IF NOT EXISTS agentic_messages (
  id                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  generation_id            TEXT UNIQUE NOT NULL,
  ghl_contact_id           TEXT NOT NULL,
  workflow_code            TEXT NOT NULL,
  sequence_position        INTEGER,
  channel                  TEXT NOT NULL
    CHECK (channel IN ('email','sms','email+sms')),
  prompt_id                UUID REFERENCES agentic_messaging_prompts(id),
  prompt_code              TEXT,
  context_snapshot         JSONB NOT NULL,
  generated_subject        TEXT,
  generated_preheader      TEXT,
  generated_body           TEXT,
  generated_sms            TEXT,
  generated_meta           JSONB,
  hard_blocker_failures    TEXT[] DEFAULT '{}',
  confidence_score         NUMERIC,
  confidence_breakdown     JSONB,
  retry_count              INTEGER DEFAULT 0,
  send_status              TEXT NOT NULL DEFAULT 'pending'
    CHECK (send_status IN (
      'pending','generated_ready',
      'suppressed_low_conf','suppressed_interrupt','suppressed_overlap',
      'cancelled_state_change','failed_generation',
      'ghl_sent_confirmed','ghl_send_failed'
    )),
  suppressed_reason        TEXT,
  generated_at             TIMESTAMPTZ DEFAULT now(),
  updated_at               TIMESTAMPTZ DEFAULT now(),
  written_at               TIMESTAMPTZ,
  ghl_sent_at              TIMESTAMPTZ,
  opened_at                TIMESTAMPTZ,
  clicked_at               TIMESTAMPTZ,
  replied_at               TIMESTAMPTZ,
  unsubscribed_at          TIMESTAMPTZ,
  booking_attributed       BOOLEAN DEFAULT false,
  booking_attributed_at    TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_agmsg_contact
  ON agentic_messages(ghl_contact_id, generated_at DESC);

CREATE INDEX IF NOT EXISTS idx_agmsg_prompt
  ON agentic_messages(prompt_id);

CREATE INDEX IF NOT EXISTS idx_agmsg_workflow_pos
  ON agentic_messages(workflow_code, sequence_position);

CREATE INDEX IF NOT EXISTS idx_agmsg_status
  ON agentic_messages(send_status);

CREATE INDEX IF NOT EXISTS idx_agmsg_attrib
  ON agentic_messages(booking_attributed) WHERE booking_attributed = true;

COMMENT ON TABLE agentic_messages IS
  'Audit log of every outbound nurture message generation. Each generation gets ONE row; state transitions happen via UPDATE. send_status state machine: pending → generated_ready → ghl_sent_confirmed (or any of the suppressed_* / cancelled_* / failed_* terminal states).';
