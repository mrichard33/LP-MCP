-- ════════════════════════════════════════════════════════════════════
-- 018_customer_status_intents.sql
-- ════════════════════════════════════════════════════════════════════
-- Adds two new intent handlers for the HDL.3 "are you a current customer?"
-- ask flow. When a lead with a `pending:customer-status-check` tag replies
-- yes/no, these handlers classify the response and apply the concrete
-- handoff tag (hdl:callback-service or hdl:callback-sales) so HDL.1 or
-- HDL.2 picks up.
--
-- ─── IMPORTANT: GATING ──────────────────────────────────────────────
-- Both handlers are compliance_gate + tag_and_handoff (short-circuit).
-- WITHOUT a context guard, a random "yes" reply on ANY contact would
-- get classified as CUSTOMER_STATUS_AFFIRMATIVE and apply the service
-- tag — that's a misroute.
--
-- The context guard is implemented in src/response-generator.js v2.5
-- (post-classification gate). When the classifier returns one of these
-- two intents, response-generator checks that the contact actually has
-- the `pending:customer-status-check` tag. If not, it converts the
-- classification to UNCLEAR and falls through to the normal response
-- generator. See the postProcessClassification function in v2.5.
--
-- This avoids needing schema-level context guards on kb_intent_handlers
-- (which would require an intent-classifier code change to honor).
-- ════════════════════════════════════════════════════════════════════

INSERT INTO kb_intent_handlers
  (intent_class, handler_code, bucket_type, gate_priority, description, trigger_keywords, action_type, ghl_handoff_tag, disqualifier, notes)
VALUES
('CUSTOMER_STATUS_AFFIRMATIVE', 'HDL-CUST-STATUS-YES-01', 'compliance_gate', 8,
  'Lead confirmed YES — they are a current Reece customer (response to HDL.3 ask).',
  ARRAY['yes','yep','yeah','yup','i am','we are','current customer','existing customer','already a customer','customer','existing','i''m a customer']::TEXT[],
  'tag_and_handoff',
  'hdl:callback-service',
  FALSE,
  'GATED in src/response-generator.js v2.5 — only fires effective when contact has pending:customer-status-check tag. HDL.2 then routes to service.'),

('CUSTOMER_STATUS_NEGATIVE', 'HDL-CUST-STATUS-NO-01', 'compliance_gate', 8,
  'Lead confirmed NO — they are NOT a current customer / new to Reece (response to HDL.3 ask).',
  ARRAY['no','nope','not yet','never','first time','new','not a customer','don''t think so','i''m new','we''re new','just looking','not customer']::TEXT[],
  'tag_and_handoff',
  'hdl:callback-sales',
  FALSE,
  'GATED in src/response-generator.js v2.5 — only fires effective when contact has pending:customer-status-check tag. HDL.1 then routes to sales callback.')

ON CONFLICT (intent_class) DO UPDATE SET
  handler_code     = EXCLUDED.handler_code,
  bucket_type      = EXCLUDED.bucket_type,
  gate_priority    = EXCLUDED.gate_priority,
  description      = EXCLUDED.description,
  trigger_keywords = EXCLUDED.trigger_keywords,
  action_type      = EXCLUDED.action_type,
  ghl_handoff_tag  = EXCLUDED.ghl_handoff_tag,
  disqualifier     = EXCLUDED.disqualifier,
  notes            = EXCLUDED.notes,
  updated_at       = NOW();

-- ─── VERIFICATION ───────────────────────────────────────────────────
-- After running, confirm:
--
--   SELECT intent_class, ghl_handoff_tag, gate_priority FROM kb_intent_handlers
--   WHERE intent_class LIKE 'CUSTOMER_STATUS%' OR intent_class = 'CALLBACK'
--   ORDER BY gate_priority;
--
-- Expected:
--   CUSTOMER_STATUS_AFFIRMATIVE  | hdl:callback-service                  | 8
--   CUSTOMER_STATUS_NEGATIVE     | hdl:callback-sales                    | 8
--   CALLBACK                     | hdl:callback-pending-classification   | 150
-- ════════════════════════════════════════════════════════════════════
