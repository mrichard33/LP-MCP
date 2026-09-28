-- ════════════════════════════════════════════════════════════════════
-- sql/139 — record_consent_change(): one transaction per consent change
-- (2026-09-28)
--
-- Part 1, execution 4 of 5. Run AFTER sql/136 and sql/137. Safe to re-run
-- (CREATE OR REPLACE). NOT mirrored at boot on purpose: a function block runs
-- every boot, and every DDL statement reloads PostgREST's schema cache — the
-- PGRST002 noise sql/startup-schema was built to stop. Until this exists the
-- code logs and skips consent writes (shadow data only); nothing else breaks.
--
-- WHY A FUNCTION
--   The handoff requires the contact_consent upsert and the consent_events
--   insert to land together or not at all. supabase-js has no transactions;
--   a plpgsql body runs in one. A half-write (state changed, no audit row)
--   is exactly the "why is this lead blocked?" question this model exists to
--   answer, so it must not be possible.
--
-- STATE RULES (mirrored by applyConsentChange in src/consent/consent-store.js,
-- which the tests exercise — keep the two in step):
--   revoked / granted  → phone_consent when channel is phone or all,
--                        email_consent when channel is email or all
--   dnc_full_on / off  → dnc_full
--   carrier_stop_on/off→ sms_carrier_stop
--   A change never touches a column it does not name: an email unsubscribe
--   cannot move phone_consent, a texted STOP cannot move email_consent.
-- ════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION record_consent_change(
  p_ghl_contact_id  text,
  p_channel         text,
  p_change          text,
  p_source          text,
  p_reason          text,
  p_actor           text,
  p_evidence        jsonb DEFAULT NULL,
  p_lp_lead_id      text DEFAULT NULL,
  p_lp_prospect_id  text DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
AS $$
DECLARE
  v_phone_hit boolean := p_channel IN ('phone','all') AND p_change IN ('revoked','granted');
  v_email_hit boolean := p_channel IN ('email','all') AND p_change IN ('revoked','granted');
  v_row       contact_consent%ROWTYPE;
  v_event_id  bigint;
BEGIN
  INSERT INTO contact_consent AS c (
    ghl_contact_id, lp_lead_id, lp_prospect_id,
    phone_consent, email_consent, sms_carrier_stop, dnc_full,
    last_reason, last_source, last_changed_by, updated_at
  ) VALUES (
    p_ghl_contact_id, p_lp_lead_id, p_lp_prospect_id,
    CASE WHEN v_phone_hit THEN p_change ELSE 'unknown' END,
    CASE WHEN v_email_hit THEN p_change ELSE 'unknown' END,
    p_change = 'carrier_stop_on',
    p_change = 'dnc_full_on',
    p_reason, p_source, p_actor, now()
  )
  ON CONFLICT (ghl_contact_id) DO UPDATE SET
    lp_lead_id       = COALESCE(EXCLUDED.lp_lead_id, c.lp_lead_id),
    lp_prospect_id   = COALESCE(EXCLUDED.lp_prospect_id, c.lp_prospect_id),
    phone_consent    = CASE WHEN v_phone_hit THEN p_change ELSE c.phone_consent END,
    email_consent    = CASE WHEN v_email_hit THEN p_change ELSE c.email_consent END,
    sms_carrier_stop = CASE p_change WHEN 'carrier_stop_on' THEN true
                                     WHEN 'carrier_stop_off' THEN false
                                     ELSE c.sms_carrier_stop END,
    dnc_full         = CASE p_change WHEN 'dnc_full_on' THEN true
                                     WHEN 'dnc_full_off' THEN false
                                     ELSE c.dnc_full END,
    last_reason      = p_reason,
    last_source      = p_source,
    last_changed_by  = p_actor,
    updated_at       = now()
  RETURNING * INTO v_row;

  INSERT INTO consent_events (ghl_contact_id, channel, change, source, reason, actor, evidence)
  VALUES (p_ghl_contact_id, p_channel, p_change, p_source, p_reason, p_actor, p_evidence)
  RETURNING id INTO v_event_id;

  RETURN jsonb_build_object('event_id', v_event_id, 'consent', to_jsonb(v_row));
END;
$$;
