-- ============================================================================
-- 156_restore_0_apr_faq.sql — Restore Mark's 0% APR ruling on the financing FAQ
-- ============================================================================
-- 2026-10-10.
--
-- DASHBOARD-APPLIED ONLY. DML, no DDL. Idempotent: the UPDATE is keyed on the
-- row still carrying the answer sql/155 wrote, so a second run changes nothing.
-- EXECUTION: Supabase dashboard SQL editor, LP MCP instance, AFTER the PR merges.
--
-- WHY. sql/155_kb_faq_conflicts.sql (PR #1236, 2026-10-10) replaced kb_faqs 99
-- (LIB-X06) and removed "0% APR" to match a prompt line that said "NEVER quote
-- rates or terms". That was the wrong side to change: the row's own note
-- recorded Mark's ruling of 2026-09-25 ("KEEP the 0% APR claim ... Beyond 0%
-- APR, quote no rates or terms in chat"), and Mark reconfirmed it on
-- 2026-10-10. The prompt (system-core.js FINANCING, nepq-backbone.js
-- NEPQ_ALWAYS) and the money guards now allow exactly that one claim.
--
-- THE RULING: the bot may say Reece offers 0% APR financing. It may quote NO
-- other rate, term, monthly payment or financing figure.
--
-- The answer below is the pre-#1236 wording, verbatim, and equals LIB-X06 in
-- sql/seeds/2026-09-25_golden_kb_v1.sql.
--
-- NOT TOUCHED: kb_faqs 2 (repairs). sql/155's repairs change stays.
--
-- AFTER RUNNING. The row carries embedding / embedding_hash; the FAQ sweep
-- re-embeds by content hash every 6 hours. Force it with the operator token:
--   POST /n8n/kb/reembed  {"faqs": true}
-- then GET /n8n/kb/faq-probe?q=Do+you+offer+financing (read would_match).
-- ============================================================================

UPDATE kb_faqs
SET canonical_answer = 'Yes, we offer 0% APR financing so you can protect your home now and pay over time. A specialist walks you through the terms at the visit so you can pick a monthly amount that fits.',
    notes = concat_ws(' | ', notes, '2026-10-10: 0% APR RESTORED per Mark''s 2026-09-25 ruling (reconfirmed 2026-10-10); the earlier 2026-10-10 removal was an audit error'),
    updated_at = now()
WHERE id = 99 AND canonical_answer = 'Yes, several options. The rep walks you through exactly what fits during the visit.';

-- ── Verification (run after the UPDATE) ──────────────────────────────────
-- SELECT id, canonical_answer, notes FROM kb_faqs WHERE id = 99;
-- -- canonical_answer starts with 'Yes, we offer 0% APR financing'
