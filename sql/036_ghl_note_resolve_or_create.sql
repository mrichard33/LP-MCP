-- 036_ghl_note_resolve_or_create.sql
-- Resolve-or-Create LP lead for the GHL Inbound → LP Note pipeline.
--
-- When the note processor can't resolve an inbound GHL contact to an
-- already-linked LP lead, it now searches LP by phone/email, links the best
-- existing match, or creates a new lead. These columns record the decision for
-- observability (and to dedupe deferral alerts). See src/ghl-note-pipeline/
-- resolve-or-create.js.
--
-- Run against the LP Supabase database. Idempotent.

ALTER TABLE ghl_conversation_pending
  ADD COLUMN IF NOT EXISTS lead_action text,        -- resolved | linked | created_deferred | ambiguous_deferred | missing_fields_deferred | lp_unavailable | error
  ADD COLUMN IF NOT EXISTS lead_action_at timestamptz;

ALTER TABLE ghl_note_shadow_log
  ADD COLUMN IF NOT EXISTS lead_action text;         -- would_resolve/resolved | would_link:<cstId> | would_create | would_ambiguous:<ids> | lp_unavailable
