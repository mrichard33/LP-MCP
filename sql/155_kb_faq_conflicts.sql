-- ============================================================================
-- 155_kb_faq_conflicts.sql — Two active FAQ answers contradicted the reply prompt
-- ============================================================================
-- 2026-10-10. Read-only audit of 2026-10-09 (LP Supabase + LP-MCP main at 81cab2b).
--
-- DASHBOARD-APPLIED ONLY. DML, no DDL. Idempotent: each UPDATE is keyed on the
-- row still carrying the old wording, so a second run changes nothing.
-- EXECUTION: Supabase dashboard SQL editor, LP MCP instance, AFTER the PR merges.
--
-- WHY. The KB PACK handed to the reply writer is "authoritative", and
-- src/prompts/response-generator/system-core.js says, in the same prompt:
--   - FINANCING: "... NEVER quote rates or terms."
--   - REPAIRS: "... route to the team for a judgment call, never a hard decline."
-- Two active kb_faqs rows said the opposite, so the model was handed both
-- instructions at once:
--   - id 99 (LIB-X06) quoted "0% APR financing".
--   - id 2 said "we don't do repairs on existing windows".
--
-- Both replacement answers are assembled from scripts already approved in
-- system-core.js (FINANCING, REPAIRS, UNKNOWN ANSWERS). Do not reword them here.
-- Inactive rows (8, 20, 23, 26, 31, 38, 41, 44, 49) are left alone.
--
-- NOTE. sql/seeds/2026-09-25_golden_kb_v1.sql records Mark's 2026-09-25 ruling
-- to KEEP the 0% APR claim. The 2026-10-09 audit handoff reverses that so the
-- FAQ stops contradicting the prompt; the seed is amended in the same PR so a
-- re-ingest does not bring the rate back.
--
-- AFTER RUNNING. Both rows carry embedding / embedding_hash, and the FAQ sweep
-- re-embeds by content hash only every 6 hours. Force it with the operator
-- token (see the PR body):
--   POST /n8n/kb/reembed  {"faqs": true}
-- then confirm with GET /n8n/kb/faq-probe?q=Do+you+offer+financing (read
-- would_match, not matched).
-- ============================================================================

UPDATE kb_faqs
SET canonical_answer = 'Yes, several options. The rep walks you through exactly what fits during the visit.',
    notes = concat_ws(' | ', notes, '2026-10-10: removed 0% APR; prompt forbids quoting rates or terms'),
    updated_at = now()
WHERE id = 99 AND canonical_answer LIKE '%0% APR%';

UPDATE kb_faqs
SET canonical_answer = 'Reece installs new, complete impact window and door systems. For a repair on windows you already have, I want to get you the exact answer rather than guess. Let me have someone confirm that for you.',
    answer_short = 'We install new, complete impact systems. For a repair, let me have someone confirm what we can do.',
    notes = concat_ws(' | ', notes, '2026-10-10: no hard decline on repairs; route to the team'),
    updated_at = now()
WHERE id = 2 AND canonical_answer LIKE '%we don''t do repairs%';

-- ── Verification (run after the two UPDATEs) ─────────────────────────────
-- SELECT id, active, canonical_answer, answer_short FROM kb_faqs WHERE id IN (99, 2);
--
-- Check the two columns the model reads, not the whole row: `notes` on id 99
-- mentions "0% APR" (the 2026-09-25 ruling and the line this file appends), so
-- a `f::text` match would read 1 forever.
-- SELECT count(*) FROM kb_faqs
--  WHERE active
--    AND (canonical_answer ILIKE '%0\% APR%' OR coalesce(answer_short, '') ILIKE '%0\% APR%'
--      OR canonical_answer ILIKE '%don''t do repairs%' OR coalesce(answer_short, '') ILIKE '%don''t do repairs%');
-- -- expect 0
