-- 105_bot_review_contact_identity.sql — who the conversation is actually with.
-- Apply in LP Supabase SQL editor. Requires sql/104_bot_review_views.sql.
--
-- PROBLEM: v_bot_review_queue identified a conversation as "Lead · ORL_MKT".
-- That is a market, not a person. A reviewer who spots a bad reply cannot look
-- the lead up in LeadPerfection, cannot find them in GHL, and cannot tell two
-- Orlando conversations apart — and three of the first seven messages in the
-- queue were the SAME contact, which the market label hid completely.
--
-- FIX: append the identity columns the reviewer needs — the contact's name, the
-- LP prospect id, the LP lead id, plus city / phone / email / rep.
--
-- CROSS-DB RULE (handoff §1.3) still holds: lp_leads lives in LP Supabase, the
-- same database as bot_message_context, so this is an ordinary join and NOT a
-- cross-database one. The HL contacts cache is deliberately not consulted here.
--
-- CREATE OR REPLACE VIEW can APPEND columns but cannot rename, retype or
-- reorder existing ones. Every column from sql/104 keeps its name, type and
-- position; the new ones are added at the end. If a future edit needs to change
-- one of the originals, use the drop block at the foot of sql/104 first.

CREATE OR REPLACE VIEW v_bot_review_queue AS
WITH scores AS (
  -- One score per action: the scorer can retry, so keep the newest.
  SELECT DISTINCT ON (s.action_id)
    s.action_id::text AS message_ref,
    s.overall_score,
    s.created_at
  FROM message_scores s
  WHERE s.action_id IS NOT NULL
  ORDER BY s.action_id, s.created_at DESC
),
office AS (
  SELECT DISTINCT ON (l.ghl_contact_id)
    l.ghl_contact_id,
    m.resolved_market_code
  FROM lp_leads l
  JOIN lp_lead_market_assignments m ON m.lead_id = l.lp_lead_id
  WHERE l.ghl_contact_id IS NOT NULL AND m.resolved_market_code IS NOT NULL
  ORDER BY l.ghl_contact_id, m.resolved_at DESC NULLS LAST
),
-- One LP lead per GHL contact. A contact can carry several leads over time
-- (a re-quote, a second product), so pick the NEWEST by LP creation date —
-- that is the one a reviewer opening the record today would land on.
-- lp_prospect_id breaks a tie when created_at_lp is absent, since the ids are
-- issued in order.
identity AS (
  SELECT DISTINCT ON (l.ghl_contact_id)
    l.ghl_contact_id,
    nullif(trim(concat_ws(' ', l.first_name, l.last_name)), '') AS contact_name,
    l.lp_prospect_id,
    l.lp_lead_id,
    l.city,
    l.phone,
    l.email,
    l.rep_name
  FROM lp_leads l
  WHERE l.ghl_contact_id IS NOT NULL
  ORDER BY l.ghl_contact_id, l.created_at_lp DESC NULLS LAST, l.lp_prospect_id DESC NULLS LAST
),
reviews AS (
  SELECT
    cf.message_type,
    cf.message_ref,
    count(*)                                              AS review_count,
    count(*) FILTER (WHERE cf.counts)                     AS counting_count,
    count(*) FILTER (WHERE cf.counts AND cf.verdict = 'good')       AS good_count,
    count(*) FILTER (WHERE cf.counts AND cf.verdict = 'needs_work') AS needs_count,
    count(*) FILTER (WHERE cf.counts AND cf.verdict = 'unsafe')     AS unsafe_count,
    max(cf.verdict) FILTER (WHERE cf.reviewer_role = 'admin')       AS admin_verdict
  FROM v_bot_current_feedback cf
  GROUP BY cf.message_type, cf.message_ref
)
SELECT
  c.id                                   AS context_id,
  c.message_type,
  c.message_ref,
  c.ghl_contact_id,
  c.channel,
  c.rule_applied,
  c.workflow_code,
  c.intent_class,
  c.buyer_stage,
  c.inbound_text,
  c.reply_text,
  c.skip_reason,
  c.generated_at,
  c.sent_at,
  o.resolved_market_code                 AS office,
  CASE
    WHEN c.message_type = 'nurture' THEN round(am.confidence_score * 100)
    ELSE round(sc.overall_score * 100)
  END::numeric                           AS ai_score,
  bo.replied_at,
  bo.booked_at,
  bo.opted_out_at,
  (cardinality(c.guidance_version_ids) + cardinality(c.example_ids))::int AS learned_items_count,
  COALESCE(r.review_count, 0)::int       AS review_count,
  NULL::text                             AS my_verdict,
  CASE
    WHEN r.admin_verdict IS NOT NULL THEN r.admin_verdict
    WHEN COALESCE(r.counting_count, 0) = 0 THEN NULL
    WHEN r.unsafe_count > r.good_count AND r.unsafe_count >= r.needs_count THEN 'unsafe'
    WHEN r.good_count > (r.needs_count + r.unsafe_count) THEN 'good'
    WHEN (r.needs_count + r.unsafe_count) > r.good_count THEN 'needs_work'
    ELSE NULL
  END                                    AS consensus_verdict,
  CASE
    WHEN bo.opted_out_at IS NOT NULL THEN 1
    WHEN c.message_type = 'skip' THEN 2
    WHEN CASE WHEN c.message_type = 'nurture' THEN round(am.confidence_score * 100)
              ELSE round(sc.overall_score * 100) END < 60 THEN 3
    WHEN c.rule_applied LIKE 'OBJ\_%' OR c.rule_applied LIKE '%BOOKING%'
      OR c.rule_applied = 'LAYER3_DISPATCH' THEN 4
    ELSE 5
  END::int                               AS priority,
  -- ── sql/105: who this conversation is actually with ──────────────
  id2.contact_name,
  id2.lp_prospect_id,
  id2.lp_lead_id,
  id2.city                               AS contact_city,
  id2.phone                              AS contact_phone,
  id2.email                              AS contact_email,
  id2.rep_name
FROM bot_message_context c
LEFT JOIN scores sc            ON sc.message_ref = c.message_ref AND c.message_type <> 'nurture'
LEFT JOIN agentic_messages am  ON am.id::text = c.message_ref    AND c.message_type = 'nurture'
LEFT JOIN bot_outcomes bo      ON bo.message_type = c.message_type AND bo.message_ref = c.message_ref
LEFT JOIN office o             ON o.ghl_contact_id = c.ghl_contact_id
LEFT JOIN identity id2         ON id2.ghl_contact_id = c.ghl_contact_id
LEFT JOIN reviews r            ON r.message_type = c.message_type AND r.message_ref = c.message_ref;

-- ── Verify ────────────────────────────────────────────────────────────────
-- Every row should carry a name and a prospect id; unresolved should be 0.
-- SELECT count(*) AS rows,
--        count(contact_name)    AS with_name,
--        count(lp_prospect_id)  AS with_prospect_id,
--        count(*) FILTER (WHERE contact_name IS NULL) AS unresolved
--   FROM v_bot_review_queue;
--
-- SELECT contact_name, lp_prospect_id, ghl_contact_id, rule_applied, ai_score, priority
--   FROM v_bot_review_queue ORDER BY priority, generated_at DESC;

-- ── Rollback ──────────────────────────────────────────────────────────────
-- Re-apply sql/104_bot_review_views.sql section B. Dropping is NOT needed:
-- the originals keep their name, type and position, so a replace is enough.
-- The dashboard tolerates the columns being absent (they render as "—").
