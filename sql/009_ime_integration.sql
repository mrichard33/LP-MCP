-- =============================================================================
-- IME MIC integration — Sam's Club partnership (Affiliate ID 17050371)
-- =============================================================================
-- Reece is the affiliate provider for Sam's Club Construction leads via IME MIC.
-- Inbound is handled in GHL (workflow 1453da0c-d854-45d3-8213-21eb9d760707).
-- This migration adds the Reece-side state for Work Orders and inbound events.
--
-- All statements idempotent (CREATE IF NOT EXISTS / ON CONFLICT DO NOTHING).
-- =============================================================================

-- Main work order tracking table
CREATE TABLE IF NOT EXISTS ime_work_orders (
  ime_work_order_id     bigint PRIMARY KEY,
  ime_affiliate_id      bigint NOT NULL,
  ime_status            text,
  ime_status_history    jsonb DEFAULT '[]'::jsonb,

  -- Mapped from IME GET /WorkOrders/{id} response
  partner_id            int,
  subcategory_id        int,
  business_model_id     int,
  retail_partner        text DEFAULT 'Sams_Club',
  category              text DEFAULT 'Construction',

  -- Reece-side IDs
  lp_prospect_id        text,
  lp_lead_id            text,
  lp_inbound_lead_id    text,        -- in1_id from addlead, populated immediately
  ghl_contact_id        text,
  ghl_opportunity_id    text,
  ime_estimate_id       bigint,

  -- IME customer payload snapshot
  customer_payload      jsonb,
  job_address           jsonb,

  -- State tracking
  ime_enrichment_status text DEFAULT 'pending',  -- pending | enriched | failed
  retry_count           int DEFAULT 0,
  last_webhook_at       timestamptz,
  last_outbound_at      timestamptz,
  last_error            text,

  created_at            timestamptz DEFAULT now(),
  updated_at            timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_ime_lp_prospect ON ime_work_orders (lp_prospect_id);
CREATE INDEX IF NOT EXISTS idx_ime_lp_lead ON ime_work_orders (lp_lead_id);
CREATE INDEX IF NOT EXISTS idx_ime_ghl_contact ON ime_work_orders (ghl_contact_id);
CREATE INDEX IF NOT EXISTS idx_ime_status ON ime_work_orders (ime_status);
CREATE INDEX IF NOT EXISTS idx_ime_enrichment_pending
  ON ime_work_orders (ime_enrichment_status, last_webhook_at)
  WHERE ime_enrichment_status = 'pending';

-- Append-only event audit log
CREATE TABLE IF NOT EXISTS ime_webhook_events (
  id                  bigserial PRIMARY KEY,
  ime_work_order_id   bigint NOT NULL,
  affiliate_id        bigint NOT NULL,
  event_type          text NOT NULL,
  status              text,
  doc_type            text,
  changed_date        timestamptz,
  raw_payload         jsonb NOT NULL,
  received_at         timestamptz DEFAULT now(),
  processed           boolean DEFAULT false,
  processed_at        timestamptz,
  process_error       text
);

CREATE INDEX IF NOT EXISTS idx_ime_events_wo
  ON ime_webhook_events (ime_work_order_id, received_at DESC);
CREATE INDEX IF NOT EXISTS idx_ime_events_unprocessed
  ON ime_webhook_events (received_at) WHERE processed = false;

-- LP source mapping for Sam's Club
INSERT INTO lp_source_mapping (
  lp_source_raw,
  lp_source_subdetail,
  ghl_intent_bucket,
  ghl_entry_tag,
  ghl_bridge_wf_id,
  notes,
  confidence
) VALUES (
  'Retail Partner',
  'Sams Club',
  'sams-club-ime',
  'entry:sams-club-ime',
  '1453da0c-d854-45d3-8213-21eb9d760707',
  'Sam''s Club Construction leads via IME MIC platform. Affiliate ID 17050371. WO originates in IME, assigned to Reece. Reece reports back via /api/v2/WorkOrders/{id} endpoints.',
  'high'
)
ON CONFLICT (lp_source_subdetail) DO NOTHING;

-- updated_at trigger on ime_work_orders
CREATE OR REPLACE FUNCTION ime_work_orders_set_updated_at()
RETURNS trigger AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_ime_work_orders_updated_at ON ime_work_orders;
CREATE TRIGGER trg_ime_work_orders_updated_at
  BEFORE UPDATE ON ime_work_orders
  FOR EACH ROW EXECUTE FUNCTION ime_work_orders_set_updated_at();
