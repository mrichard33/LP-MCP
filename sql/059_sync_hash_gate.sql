-- 059: hash gate substrate for incremental sync (v6.11).
-- lp_payload_hash = sha256 of the sorted-key JSON of the FULL GetLead
-- payload (options=261120) last processed for this lead. NULL = never
-- hashed; the sweep treats NULL as "changed" and processes normally.
ALTER TABLE lp_leads ADD COLUMN IF NOT EXISTS lp_payload_hash text;
