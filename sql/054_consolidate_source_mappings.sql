-- 054_consolidate_source_mappings.sql — one channel per asset (2026-08-01)
--
-- REPORTING FIX, NOT A ROUTING FIX. Read this before assuming behaviour
-- changes: entry-source-map.js `lookup()` matches on lp_source_subdetail
-- ALONE, and all four rows below ALREADY resolve to the correct bucket
-- (verified live 2026-08-01 — every row was already chatbot /
-- estimate-calculator with the matching entry tag). Nothing routes
-- differently after this runs. What changes is that the split is now
-- DOCUMENTED on the rows themselves, so the next person to read
-- lp_source_mapping learns why one bot has two source records instead of
-- rediscovering it from a close-rate anomaly.
--
-- WHY THE CHATBOT SPLIT EXISTS. GHL workflow I.CT Chatbot Contact Created
-- Timeout (98f54471-9312-4bb9-ac80-6dcaf2e1cb10) shipped its addleads URL
-- with srs_id and pro_id REVERSED — `srs_id=830&pro_id=5574`, when 5574 is
-- the chatbot SubSource and 830 is the promoter. Every lead it pushed
-- landed under srs 830 → "Chat (REECE WEBSITE)", while the agentic
-- create_lp_lead path used 5574 → "Reece ChatBot". One bot, two source
-- records:
--
--   Chat (REECE WEBSITE)   670 leads, 12 demos, 4 won, 0.6% close, → 2026-07-27
--   Reece ChatBot          120 leads, 18 demos, 9 won, 7.5% close, → today
--
-- THE CLOSE-RATE GAP IS NOT CHANNEL QUALITY, and nobody should cut the
-- channel on it. I.CT pushes on a TIMER (wait 5 min → check `chatbot` tag →
-- wait 1 hr → require phone → POST) regardless of qualification, so 0.6%
-- measures everyone who opened the widget. The agentic path pushes on a
-- BOOKING EVENT, so 7.5% measures everyone who booked. Different
-- denominators, not different channels. It self-corrects once pushes are
-- qualified.
--
-- BOTH ROWS ARE RETAINED, deliberately. LP is the system of record and both
-- source strings live there permanently; we map around them rather than
-- renaming, because renaming in LP splits history. Drop the
-- "Chat (REECE WEBSITE)" row only once I.CT is corrected AND no new leads
-- have arrived under srs 830 for a full reporting period.
--
-- WHY THE CALCULATOR SPLIT EXISTS. This one is not a bug. "Estimate
-- Calculator"/Direct Mail (5 leads) and "Website Estimate Calculator"/Main
-- Website (373) are the SAME on-site asset reached via different campaigns —
-- a mailer vs the site. That is a CAMPAIGN distinction wearing a source
-- distinction's clothes. The durable fix is to capture campaign in
-- lp_source_raw (already populated here) and report bucket × raw, keeping
-- the calculator one source with a campaign breakdown. Expect this shape to
-- recur for every offline campaign driving to an online asset.
--
-- The transposition that caused the chatbot split is now guarded in code:
-- src/lp-source-ids.js assertNotTransposed(), called from
-- src/actions/handlers/lp-lead.js once srs_id and pro_id are both resolved.
--
-- ROLLBACK: a no-op on the data that matters. ghl_intent_bucket and
-- ghl_entry_tag are written to the values the rows already hold, so only
-- `notes` and `updated_at` change. Reverting means editing notes back.
--
-- AFTER RUNNING: POST /n8n/decision-engine/reload-rules and call
-- reloadSourceMap() — entry-source-map.js caches this table for 5 minutes,
-- so changes look inert until the cache expires.

-- ─── Chatbot: "Chat (REECE WEBSITE)" is the same bot as "Reece ChatBot" ───
WITH u AS (
  UPDATE lp_source_mapping
  SET ghl_intent_bucket = 'chatbot',
      ghl_entry_tag     = 'entry:chatbot',
      notes = coalesce(notes, '') || E'\n2026-08-01: consolidated. "Chat (REECE WEBSITE)" is the same bot as "Reece ChatBot" — split caused by the srs_id/pro_id transposition in GHL workflow I.CT (98f54471). Retain both rows until I.CT is corrected and no new leads arrive under srs 830.',
      updated_at = now()
  WHERE lp_source_subdetail IN ('Chat (REECE WEBSITE)', 'Reece ChatBot')
  RETURNING 1
)
SELECT count(*) FROM u;

-- ─── Calculator: one asset, two campaigns ────────────────────────────────
WITH u AS (
  UPDATE lp_source_mapping
  SET ghl_intent_bucket = 'estimate-calculator',
      ghl_entry_tag     = 'entry:estimate-calculator',
      notes = coalesce(notes, '') || E'\n2026-08-01: consolidated. "Estimate Calculator"/Direct Mail (5 leads) and "Website Estimate Calculator"/Main Website (373) are the same asset reached via different campaigns.',
      updated_at = now()
  WHERE lp_source_subdetail IN ('Estimate Calculator', 'Website Estimate Calculator')
  RETURNING 1
)
SELECT count(*) FROM u;

-- ─── Verification ────────────────────────────────────────────────────────
-- Expect 4 rows: two on bucket 'chatbot', two on 'estimate-calculator',
-- each carrying the dated consolidation note.
SELECT json_agg(row_to_json(s)) FROM (
  SELECT lp_source_subdetail, lp_source_raw, ghl_intent_bucket, ghl_entry_tag, notes, updated_at
  FROM lp_source_mapping
  WHERE lp_source_subdetail IN (
    'Chat (REECE WEBSITE)', 'Reece ChatBot',
    'Estimate Calculator', 'Website Estimate Calculator'
  )
  ORDER BY ghl_intent_bucket, lp_source_subdetail
) s;
