-- 103_bot_feedback_core.sql — Bot Review Phase 0–1 core tables.
-- Apply in LP Supabase SQL editor, sections A→F in order.
--
-- Handoff: "CLAUDE CODE HANDOFF — Bot Review & Controlled Learning System (v1)" §4.1.
-- Phase 0 uses A (bot_message_context), B (bot_outcomes) and F (bot_change_log).
-- C/D/E ship now because §4.1 is one file; Phase 1 is the first code to write to them.
--
-- DDL doctrine: see sql/README.md. This file is applied BY HAND in the Supabase
-- dashboard — no tool, no boot-time migration. LP MCP code degrades gracefully
-- when any of these relations is absent (logs once, skips, never throws into the
-- send path), so merging the code before applying this file is safe.

-- A. Fingerprint: one row per bot reply / skip / nurture send
CREATE TABLE IF NOT EXISTS bot_message_context (
  id                         bigserial PRIMARY KEY,
  message_type               text NOT NULL CHECK (message_type IN ('reply','skip','nurture')),
  message_ref                text NOT NULL,            -- agent_actions.action_id (reply/skip) | agentic_messages.id (nurture)
  ghl_contact_id             text,
  channel                    text,                     -- normalized: sms | email | live_chat
  intent_class               text,
  buyer_stage                integer,
  rule_applied               text,
  workflow_code              text,
  prompt_code                text,
  prompt_version             integer,
  core_prompt_version        text,                     -- response-generator header version + git sha (RAILWAY_GIT_COMMIT_SHA)
  model                      text,
  inbound_text               text,
  reply_text                 text,
  skip_reason                text,
  input_snapshot             jsonb,                    -- everything needed to replay: thread (last 10), contact tags, stage,
                                                       -- active-entry tag, lp disposition, intent, detected signals,
                                                       -- booking availability offered, channel, now_et. PII: keep as-is (internal DB).
  kb_modes                   jsonb,                    -- {faq_semantic, vector, exemplars, call_moments, guidance, examples}
  kb_sources                 jsonb,                    -- ids used: faqs, objection_script, exemplars, call_moments, vector chunks
  guidance_version_ids       bigint[] NOT NULL DEFAULT '{}',   -- LIVE guidance versions injected
  example_ids                bigint[] NOT NULL DEFAULT '{}',   -- LIVE examples injected
  shadow_guidance_version_ids bigint[] NOT NULL DEFAULT '{}',  -- retrieved in shadow, not injected
  shadow_example_ids         bigint[] NOT NULL DEFAULT '{}',
  generated_at               timestamptz NOT NULL DEFAULT now(),
  sent_at                    timestamptz,
  UNIQUE (message_type, message_ref)
);
CREATE INDEX IF NOT EXISTS idx_bmc_contact ON bot_message_context (ghl_contact_id, generated_at DESC);
CREATE INDEX IF NOT EXISTS idx_bmc_generated ON bot_message_context (generated_at DESC);
CREATE INDEX IF NOT EXISTS idx_bmc_rule ON bot_message_context (rule_applied, workflow_code);
-- Phase 0 addition (outcomes.js scope scan: sent_at in the last 8 days, final=false).
-- Not in the handoff text; a plain (sent_at DESC) index keeps syncOutcomes() off a
-- full scan once this table is large. Purely additive.
CREATE INDEX IF NOT EXISTS idx_bmc_sent ON bot_message_context (sent_at DESC) WHERE sent_at IS NOT NULL;

-- B. Outcomes (computed from HL cache by LP MCP job; never joined across DBs)
CREATE TABLE IF NOT EXISTS bot_outcomes (
  message_type   text NOT NULL,
  message_ref    text NOT NULL,
  ghl_contact_id text,
  sent_at        timestamptz,
  replied_at     timestamptz,     -- first inbound from contact within 24h of sent_at
  booked_at      timestamptz,     -- first appointment created within 7d of sent_at
  opted_out_at   timestamptz,     -- STOP-family inbound or DNC-family tag within 24h
  source_fresh   boolean,         -- HL sync was fresh (<2h) when computed
  checked_at     timestamptz NOT NULL DEFAULT now(),
  final          boolean NOT NULL DEFAULT false,   -- true once the 7-day window closed
  PRIMARY KEY (message_type, message_ref)
);
-- Phase 0 addition: syncOutcomes() selects the not-yet-final rows every 30 min.
CREATE INDEX IF NOT EXISTS idx_bo_open ON bot_outcomes (final, sent_at DESC);

-- C. Feedback reasons (editable list)
CREATE TABLE IF NOT EXISTS bot_feedback_reasons (
  code          text PRIMARY KEY,
  label         text NOT NULL,
  default_lane  text NOT NULL CHECK (default_lane IN ('knowledge','guidance','example','rule','prompt','guardrail','code')),
  severity      integer NOT NULL DEFAULT 2,       -- 1 low … 3 high
  sort          integer NOT NULL DEFAULT 100,
  active        boolean NOT NULL DEFAULT true
);
INSERT INTO bot_feedback_reasons (code,label,default_lane,severity,sort) VALUES
 ('dodged_question','Dodged the question','knowledge',2,10),
 ('wrong_facts','Wrong facts','knowledge',3,20),
 ('booking_error','Booking error','rule',3,30),
 ('tone_voice','Tone or voice','guidance',1,40),
 ('too_pushy','Too pushy for stage','guidance',2,50),
 ('repeated','Repeated itself','guidance',1,60),
 ('compliance','Compliance','guardrail',3,70),
 ('shouldnt_have_messaged','Shouldn''t have messaged','rule',3,80),
 ('should_have_replied','Should have replied','code',3,90),
 ('missed_opportunity','Missed opportunity','example',2,100),
 ('formatting','Formatting','guidance',1,110)
ON CONFLICT (code) DO NOTHING;

-- D. Feedback (append-only except undone_at)
CREATE TABLE IF NOT EXISTS bot_feedback (
  id                 bigserial PRIMARY KEY,
  message_type       text NOT NULL CHECK (message_type IN ('reply','skip','nurture')),
  message_ref        text NOT NULL,
  context_id         bigint REFERENCES bot_message_context(id),
  ghl_contact_id     text,
  reviewer_email     text NOT NULL,
  reviewer_role      text NOT NULL,          -- operator | team | admin
  verdict            text NOT NULL CHECK (verdict IN ('good','needs_work','unsafe')),
  reason_codes       text[] NOT NULL DEFAULT '{}',
  better_text        text,
  note               text,
  seen_before        boolean NOT NULL DEFAULT false,
  gold               boolean NOT NULL DEFAULT false,
  is_calibration     boolean NOT NULL DEFAULT false,
  counts             boolean NOT NULL DEFAULT true,   -- false for uncalibrated team reviewers
  ai_score_at_review numeric,
  supersedes_id      bigint REFERENCES bot_feedback(id),
  undone_at          timestamptz,
  created_at         timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT bf_reason_required CHECK (verdict = 'good' OR cardinality(reason_codes) > 0),
  CONSTRAINT bf_unsafe_note     CHECK (verdict <> 'unsafe' OR length(coalesce(trim(note),'')) > 0),
  CONSTRAINT bf_gold_good_only  CHECK (gold = false OR verdict = 'good')
);
CREATE INDEX IF NOT EXISTS idx_bf_msg ON bot_feedback (message_type, message_ref);
CREATE INDEX IF NOT EXISTS idx_bf_created ON bot_feedback (created_at DESC);
-- Only undone_at may change, and only within 10 seconds of creation:
CREATE OR REPLACE FUNCTION bot_feedback_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'bot_feedback is append-only'; END IF;
  IF (to_jsonb(NEW) - 'undone_at') <> (to_jsonb(OLD) - 'undone_at') THEN
    RAISE EXCEPTION 'bot_feedback: only undone_at may change'; END IF;
  IF OLD.undone_at IS NULL AND NEW.undone_at IS NOT NULL AND now() > OLD.created_at + interval '15 seconds' THEN
    RAISE EXCEPTION 'bot_feedback: undo window closed'; END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS trg_bot_feedback_guard ON bot_feedback;
CREATE TRIGGER trg_bot_feedback_guard BEFORE UPDATE OR DELETE ON bot_feedback
  FOR EACH ROW EXECUTE FUNCTION bot_feedback_guard();

-- E. Settings (tunable without deploy)
CREATE TABLE IF NOT EXISTS bot_settings (key text PRIMARY KEY, value jsonb NOT NULL, updated_at timestamptz NOT NULL DEFAULT now());
INSERT INTO bot_settings (key,value) VALUES
 ('weekly_live_cap','2'), ('shadow_days','3'), ('shadow_min_samples','10'), ('shadow_max_days','7'),
 ('shadow_win_rate','0.60'), ('pattern_min_flags','3'), ('pattern_min_reviewers','2'),
 ('calibration_cases','30'), ('calibration_agreement','0.80'), ('report_min_sample','30'),
 ('guidance_max_per_message','5'), ('guidance_max_chars','300'), ('guidance_review_days','90'),
 ('examples_max_per_message','3'), ('examples_min_similarity','0.78'),
 ('eval_target_win_rate','0.55'), ('eval_noninferior_rate','0.45'), ('eval_max_judge_drop','2'),
 ('rollback_optout_multiplier','2'), ('rollback_judge_drop','10'), ('rollback_watch_hours','72'),
 ('measure_days','14'), ('measure_max_days','28'), ('undo_seconds','10')
ON CONFLICT (key) DO NOTHING;

-- F. Change log (append-only, enforced)
CREATE TABLE IF NOT EXISTS bot_change_log (
  id           bigserial PRIMARY KEY,
  at           timestamptz NOT NULL DEFAULT now(),
  actor        text NOT NULL,                -- email | 'system:<job>'
  action       text NOT NULL,                -- feedback_unsafe_alert, stop_bot, proposal_created, eval_run, approved, rejected,
                                             -- shadow_started, promoted_live, rolled_back, auto_rolled_back, verified, retired, ...
  target_table text NOT NULL,
  target_id    text NOT NULL,
  proposal_id  bigint,
  reason       text,
  before       jsonb,
  after        jsonb
);
CREATE INDEX IF NOT EXISTS idx_bcl_target ON bot_change_log (target_table, target_id);
CREATE INDEX IF NOT EXISTS idx_bcl_at ON bot_change_log (at DESC);
CREATE OR REPLACE FUNCTION bot_change_log_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'bot_change_log is append-only'; END $$;
DROP TRIGGER IF EXISTS trg_bot_change_log_immutable ON bot_change_log;
CREATE TRIGGER trg_bot_change_log_immutable BEFORE UPDATE OR DELETE ON bot_change_log
  FOR EACH ROW EXECUTE FUNCTION bot_change_log_immutable();

-- ── Verify (run after applying; every count should be 6 / 11 / 24) ──────────
-- SELECT
--   (SELECT count(*) FROM information_schema.tables WHERE table_schema='public'
--      AND table_name IN ('bot_message_context','bot_outcomes','bot_feedback_reasons',
--                         'bot_feedback','bot_settings','bot_change_log'))       AS tables_6,
--   (SELECT count(*) FROM bot_feedback_reasons)                                  AS reasons_11,
--   (SELECT count(*) FROM bot_settings)                                          AS settings_24;
