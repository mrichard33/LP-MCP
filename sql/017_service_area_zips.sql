-- ════════════════════════════════════════════════════════════════════
-- 017_service_area_zips.sql
-- ════════════════════════════════════════════════════════════════════
-- Service area data layer for HDL.1 / HDL.2 customer-service routing.
--
-- TWO-STEP MIGRATION:
--   STEP 1 (this file): Run via Supabase SQL editor — creates schema,
--                       seeds service_markets, updates kb_intent_handlers.
--   STEP 2 (after this): Use Supabase Table Editor → service_area_zips
--                        → Insert → Import data from CSV → upload
--                        data/service_area_zips.csv. 1,060 rows.
--
-- ─── What this migration provides ───────────────────────────────────
--
-- Two new tables:
--   service_markets — one row per office/region with phone + dispatch meta
--   service_area_zips — 1,060 zips mapped to a market_code (FK)
--
-- One new intent handler:
--   SERVICE_AREA_INQUIRY — "do you service my area?" routed through the
--                          response generator. The kb-retriever extension
--                          (separate code change in src/knowledge/) looks
--                          up the contact's postal_code or any explicit
--                          zip in the message against service_area_zips
--                          and provides confirmation/decline talking points.
--
-- One UPDATE to existing CALLBACK row:
--   Handoff tag changes from 'hdl:callback-request' to
--   'hdl:callback-pending-classification'. The response-generator post-
--   processes CALLBACK with LP context to pick the concrete tag:
--     hdl:callback-service        — closed_won/Sale/PM/P2 detected
--     hdl:callback-sales          — active lead detected
--     hdl:callback-pending-status — genuinely ambiguous (agentic system asks)
--
-- ─── Market codes ───────────────────────────────────────────────────
-- 9 distinct from the source CSV + 1 GENERAL fallback:
--   FTMYR, FTLAU, MIAMI, BOCA, STPET, SAR, LAKE, ORL, JAX, GENERAL
--
-- ─── Phone routing (per Mark 2026-04-28) ────────────────────────────
--   FTMYR              → (239) 310-4809
--   FTLAU/MIAMI/BOCA   → (754) 203-9190  (same office)
--   STPET/SAR          → (727) 522-3035  (same office)
--   LAKE/ORL           → (407) 604-7114  (same office)
--   JAX + anything else→ (954) 800-8906  (general fallback)
-- ════════════════════════════════════════════════════════════════════

-- ─── SCHEMA ─────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS service_markets (
  market_code         TEXT        PRIMARY KEY,
  market_name         TEXT        NOT NULL,
  service_phone       TEXT        NOT NULL,
  service_phone_e164  TEXT        NOT NULL,
  hours               TEXT        DEFAULT 'Mon-Fri 8am-5pm ET',
  has_dedicated_phone BOOLEAN     DEFAULT TRUE,
  notes               TEXT,
  enabled             BOOLEAN     DEFAULT TRUE,
  created_at          TIMESTAMPTZ DEFAULT NOW(),
  updated_at          TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS service_area_zips (
  zip          TEXT        PRIMARY KEY,
  city         TEXT,
  county       TEXT,
  market_code  TEXT        NOT NULL REFERENCES service_markets(market_code) ON UPDATE CASCADE,
  created_at   TIMESTAMPTZ DEFAULT NOW(),
  updated_at   TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_service_area_zips_market ON service_area_zips(market_code);
CREATE INDEX IF NOT EXISTS idx_service_area_zips_city   ON service_area_zips(LOWER(city));
CREATE INDEX IF NOT EXISTS idx_service_area_zips_county ON service_area_zips(LOWER(county));

-- ─── SEED service_markets ───────────────────────────────────────────
-- 9 CSV-derived market codes + 1 GENERAL fallback.

INSERT INTO service_markets (market_code, market_name, service_phone, service_phone_e164, has_dedicated_phone, notes) VALUES
  ('FTMYR',  'Ft. Myers / SW Florida',                 '(239) 310-4809', '+12393104809', TRUE,  'Lee, Collier, Charlotte, Hendry counties'),
  ('FTLAU',  'Ft. Lauderdale',                          '(754) 203-9190', '+17542039190', TRUE,  'Broward county. Shares office with MIAMI and BOCA.'),
  ('MIAMI',  'Miami',                                   '(754) 203-9190', '+17542039190', TRUE,  'Miami-Dade. Routed through FTLAU office per 2026-04-28.'),
  ('BOCA',   'Boca Raton / Palm Beach',                 '(754) 203-9190', '+17542039190', TRUE,  'Palm Beach + Martin counties. Routed through FTLAU office.'),
  ('STPET',  'St. Petersburg / Tampa',                  '(727) 522-3035', '+17275223035', TRUE,  'Pinellas, Hillsborough, Pasco, Hernando. Shares office with SAR.'),
  ('SAR',    'Sarasota',                                '(727) 522-3035', '+17275223035', TRUE,  'Sarasota, Manatee. Routed through STPET office.'),
  ('LAKE',   'Lakeland',                                '(407) 604-7114', '+14076047114', TRUE,  'Polk. Shares office with ORL.'),
  ('ORL',    'Orlando / Central Florida',               '(407) 604-7114', '+14076047114', TRUE,  'Orange, Seminole, Osceola, Lake, Marion, Citrus, Sumter.'),
  ('JAX',    'Jacksonville / NE Florida',               '(954) 800-8906', '+19548008906', FALSE, 'In service area but NO dedicated service phone — uses general fallback.'),
  ('GENERAL','General / Out-of-mapped-area fallback',   '(954) 800-8906', '+19548008906', FALSE, 'Catch-all when contact zip not in service_area_zips. Treat as out-of-area.')
ON CONFLICT (market_code) DO UPDATE SET
  market_name         = EXCLUDED.market_name,
  service_phone       = EXCLUDED.service_phone,
  service_phone_e164  = EXCLUDED.service_phone_e164,
  has_dedicated_phone = EXCLUDED.has_dedicated_phone,
  notes               = EXCLUDED.notes,
  updated_at          = NOW();

-- ─── kb_intent_handlers ─────────────────────────────────────────────
-- 1) Update CALLBACK row — handoff_tag becomes a placeholder. The
--    response-generator post-processes CALLBACK using LP context and
--    rewrites this to one of the three concrete tags (sales/service/
--    pending-status) before short-circuiting.
UPDATE kb_intent_handlers
SET ghl_handoff_tag = 'hdl:callback-pending-classification',
    notes = 'Placeholder — response-generator overrides at gen-time. Resolves to hdl:callback-service (known customer), hdl:callback-sales (known lead), or hdl:callback-pending-status (ambiguous, agentic asks). See src/response-generator.js v2.5+.',
    updated_at = NOW()
WHERE intent_class = 'CALLBACK';

-- 2) New intent: SERVICE_AREA_INQUIRY — "do you service my area / zip / city?"
--    Routed through generate_response so the AI can answer with confirmation
--    or graceful "not in our service area" + value-preserving alternative.
--    KB pack extension (kb-retriever.js) ships separately and looks up
--    the contact's postal_code OR an explicit zip mentioned in the message
--    against service_area_zips.
INSERT INTO kb_intent_handlers
  (intent_class, handler_code, bucket_type, gate_priority, description, trigger_keywords, action_type, ghl_handoff_tag, disqualifier, notes)
VALUES
('SERVICE_AREA_INQUIRY', 'HDL-SERVICE-AREA-01', 'intent_router', 145,
  'Asking whether Reece services their area, zip, or city',
  ARRAY['do you service','service my area','in my area','do you cover','cover my zip','service this zip','service in','available in','work in','do you work in','any service in']::TEXT[],
  'generate_response',
  'hdl:service-area-inquiry',
  FALSE,
  'AI looks up contact postal_code (or explicit zip in message) against service_area_zips. In-area: confirm + nudge to next step. Out-of-area: graceful decline. kb-retriever.js extension required.')
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

-- ════════════════════════════════════════════════════════════════════
-- STEP 2 — LOAD ZIP DATA FROM CSV
-- ════════════════════════════════════════════════════════════════════
-- After running this migration, load the 1,060 zip rows:
--
--   1. Open Supabase dashboard → Table Editor
--   2. Select service_area_zips
--   3. Click "Insert" → "Import data from CSV"
--   4. Upload data/service_area_zips.csv from this repo
--   5. Confirm column mapping (zip, city, county, market_code)
--   6. Click "Import"
--
-- Verify load:
--
--   SELECT market_code, COUNT(*) FROM service_area_zips
--   GROUP BY market_code ORDER BY 2 DESC;
--
--   Expected counts:
--     STPET 222 | ORL 204 | JAX 126 | MIAMI 124 | BOCA 89
--     FTLAU 88  | FTMYR 85 | SAR 63  | LAKE 59
--     Total: 1,060
-- ════════════════════════════════════════════════════════════════════
