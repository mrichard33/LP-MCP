-- ============================================================================
-- 073 — Call Intelligence: deliver the note, THEN queue the call
--
-- WHY: 'dnc_request' and 'cancellation_request' are raised during ANALYSIS,
-- and analysis parked the call — before matching, before sync. So the two
-- review reasons that most need to reach a rep's eyes were exactly the two
-- that never produced a note. 85 calls, measured 2026-08-25: 50 cancellation
-- requests and 35 DNC requests, every one of them visible only inside an
-- internal queue while the customer's own record showed nothing at all.
--
-- That is worse than useless. The next rep to open the record has no idea the
-- customer asked to be left alone, and calls them.
--
-- Mark's decision: BOTH. Write the note to LP, AND keep the call in the review
-- queue. This column is what carries the second half across the two stages —
-- stageAnalyze records the reason and advances; stageSync writes the note and
-- then parks the call on that reason instead of completing it.
--
-- ── WHY A COLUMN AND NOT A STATUS ──────────────────────────────────────────
-- ci_calls.status is the pipeline state machine and ci_calls.review_reason is
-- why a call is PARKED. A call carrying this is neither parked nor finished:
-- it is in flight, with a reason waiting to be used once the write lands.
-- Encoding that as a status would add a state to the machine that every
-- claimer, view and health count would have to learn. A nullable column says
-- the same thing and nothing else has to change.
--
-- ── IT IS CLEARED, AND WHEN ───────────────────────────────────────────────
-- stageAnalyze writes it on EVERY advance, null included: a re-analysis that
-- no longer finds the flag must clear it, or a stale value parks a call for a
-- request the customer never made. stageSync clears it in the same write that
-- parks the call. A sync FAILURE leaves it set on purpose — the write did not
-- land, and the customer's request must stay attached to the call.
--
-- ── WHAT THIS DOES NOT DO ─────────────────────────────────────────────────
-- Nothing here, and nothing in the code that reads it, auto-actions a DNC or a
-- cancellation. No tag, no DNC write, no appointment cancelled. This makes the
-- request VISIBLE; acting on it stays human.
--
-- Additive: one nullable column, no backfill, no default. Existing rows read
-- NULL, which is correct — they carry no deferred reason.
--
-- Mirrored in runMigrations() (src/index.js) so a fresh deploy self-heals.
-- This file is the source of truth. DDL executes in the Supabase dashboard,
-- LP MCP instance. See sql/README.md.
--
-- ROLLBACK: ALTER TABLE ci_calls DROP COLUMN IF EXISTS pending_review_reason;
--           (safe — nothing joins on it and nothing else references it)
-- ============================================================================

ALTER TABLE ci_calls ADD COLUMN IF NOT EXISTS pending_review_reason text;

COMMENT ON COLUMN ci_calls.pending_review_reason IS
  'Review reason to apply AFTER the CRM write lands, for flags in '
  'DEFER_REVIEW_UNTIL_SYNCED (dnc_request, cancellation_request). Set by '
  'stageAnalyze, consumed and cleared by stageSync. NULL for every call that '
  'is not carrying one. Never auto-actioned.';
