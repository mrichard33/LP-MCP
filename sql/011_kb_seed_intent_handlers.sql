-- ════════════════════════════════════════════════════════════════════
-- 011_kb_seed_intent_handlers.sql
-- SEED: Bot 2's compliance gates + 9 intent buckets
-- ════════════════════════════════════════════════════════════════════
-- HDL-* codes reference GHL knowledge base files (response content lives
-- in GHL). This seed maps inbound classifications to handler codes.
-- ════════════════════════════════════════════════════════════════════

INSERT INTO kb_intent_handlers
  (intent_class, handler_code, bucket_type, gate_priority, description, trigger_keywords, action_type, ghl_handoff_tag, disqualifier, notes)
VALUES
-- ─── Compliance Gates (priority 1-50, fire BEFORE intent routing) ───
('STOP',           'HDL-STOP-01',          'compliance_gate',  1,  'Opt-out / unsubscribe request',
  ARRAY['stop','unsubscribe','opt out','remove me','cancel','quit','don''t text'],
  'tag_and_handoff', 'hdl:stop', true,
  'TCPA compliance — must honor immediately. GHL workflow handles confirmation.'),

('WHO_IS_THIS',    'HDL-WHO-01',           'compliance_gate',  5,  'Lead doesn''t recognize the source',
  ARRAY['who is this','how did you get my number','who are you','wrong contact','do i know you'],
  'tag_and_handoff', 'hdl:who-is-this', false,
  'Reset context, identify with permission reminder. Critical for trust recovery.'),

('WRONG_NUMBER',   'HDL-WRONG-01',         'compliance_gate',  5,  'Lead says wrong number',
  ARRAY['wrong number','wrong person','not me','no one by that name'],
  'tag_and_handoff', 'hdl:wrong-number', true,
  'Apologize, suppress, no further outreach.'),

('ANGRY',          'HDL-HUMAN-01',         'compliance_gate', 10,  'Frustrated, threatening, or demanding manager',
  ARRAY['frustrated','angry','manager','attorney','lawyer','sue','complaint','furious'],
  'tag_and_handoff', 'hdl:human-handoff', false,
  'Hand to human immediately. Bot must NOT attempt to de-escalate.'),

('RENTER',         'HDL-DQ-RENTER-01',     'compliance_gate', 15,  'Lead is renter / tenant',
  ARRAY['rent','renting','lease','tenant','landlord'],
  'tag_and_handoff', 'hdl:dq-renter', true,
  'Disqualify — renters cannot purchase windows.'),

('MOBILE',         'HDL-DQ-MOBILE-01',     'compliance_gate', 15,  'Mobile or manufactured home',
  ARRAY['mobile home','manufactured home','trailer','double wide','single wide'],
  'tag_and_handoff', 'hdl:dq-mobile', true,
  'Disqualify — mobile homes outside service scope.'),

-- 2026-07-06 (Bot 2/3/4 consolidation, locked decision): the INVESTMENT →
-- HDL-DQ-INVESTMENT-01 compliance gate is REMOVED. Investment properties are
-- normal leads — no DQ, no special handling, no hdl:dq-investment tag. If the
-- live kb_intent_handlers table still carries the INVESTMENT row, delete it
-- (manual operator task — see the consolidation PR).

-- ─── Intent Routing (priority 100+, fires when no compliance gate matched) ───
('APPT_STATUS',    'HDL-APPT-STATUS-01',   'intent_router',  100,  'Asking about an existing appointment',
  ARRAY['my appointment','reschedule','cancel','confirm','what time','when is'],
  'tag_and_handoff', 'hdl:appt-status', false,
  'Hand to APPT Handler workflow.'),

('BOOK',           NULL,                    'intent_router',  110,  'Ready to book / schedule',
  ARRAY['schedule','come out','see the numbers','show me','sounds good','yes','yeah','sure','ready','let''s do it'],
  'generate_response', 'hdl:book-intent', false,
  'LLM writes booking confirmation + booking link.'),

('PRICING',        NULL,                    'intent_router',  120,  'Asking about cost',
  ARRAY['how much','cost','price','ballpark','budget','afford','quote','pricing'],
  'generate_response', 'hdl:pricing-intent', false,
  'LLM uses kb_pricing_anchors for framing — never quote a specific number.'),

('OBJECTION',      NULL,                    'intent_router',  130,  'Specific objection raised',
  ARRAY['can''t afford','budget tight','too expensive','spouse','think about it','been burned','later','not sure'],
  'generate_response', 'hdl:objection-intent', false,
  'LLM uses kb_objection_scripts for response template.'),

('QUESTION',       NULL,                    'intent_router',  140,  'Generic information question',
  ARRAY['process','warranty','timeline','how long','what kind','do you','can you'],
  'generate_response', 'hdl:question-intent', false,
  'LLM uses kb_faqs first, vector KB for novel questions.'),

('CALLBACK',       'HDL-CALLBACK-01',       'intent_router',  150,  'Wants a phone callback',
  ARRAY['call me','talk to someone','speak to a person','give me a ring'],
  'tag_and_handoff', 'hdl:callback-request', false,
  'Hand to rep callback workflow.'),

('NOT_INTERESTED', NULL,                    'intent_router',  160,  'Soft no',
  ARRAY['no thanks','later','not now','maybe in the future','not interested'],
  'generate_response', 'hdl:not-interested-intent', false,
  'LLM offers downgrade — info instead of appt. Never give up here, downgrade gracefully.'),

('SEND_INFO',      NULL,                    'intent_router',  170,  'Wants information',
  ARRAY['send info','more info','details','browsing','just looking','some info'],
  'generate_response', 'hdl:send-info-intent', false,
  'LLM offers content via trigger link. Sets up next touchpoint.'),

('RECONNECT',      NULL,                    'intent_router',  180,  'Restarting after silence',
  ARRAY['hi','hello','hey','still there','back','sorry'],
  'generate_response', 'hdl:reconnect-intent', false,
  'LLM resumes warm — references prior context if available.'),

('UNCLEAR',        NULL,                    'intent_router',  200,  'Cannot classify',
  ARRAY[]::TEXT[],
  'generate_response', 'hdl:unclear-intent', false,
  'LLM asks ONE clarifying question. No assumptions.')

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
  updated_at       = now();
