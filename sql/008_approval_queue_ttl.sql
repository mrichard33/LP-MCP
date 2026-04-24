-- =====================================================================
-- Approval Queue Maintenance — TTL Cleanup
-- =====================================================================
--
-- Purpose:
--   Keeps the pending_approval pipeline healthy by expiring stale approval
--   requests that never received a Yes/No response in GroupMe. Without this,
--   stale approvals accumulate at the HEAD of the oldest-first approval
--   query and cause head-of-line blocking (see docs/PATCH_v4.2_action_executor_hol_fix.md).
--
-- Context:
--   On 2026-04-24 we discovered that executeActions() in action-executor.js
--   fetches the 20 oldest pending_approval actions per heartbeat. If those
--   oldest 20 all have existing records in groupme_approval_requests (zombie
--   state — sent but never answered), the guard `if (!existing)` skips all
--   of them and no new approval requests fire. 185 actions had accumulated
--   behind 20 zombies from Apr 15-17.
--
-- Recommended usage:
--   Run the "TTL MAINTENANCE" block hourly or every 30 min via n8n cron or
--   Railway scheduled job. Adjust the INTERVAL to tune how quickly unanswered
--   approvals expire.
--
-- One-time unblock run: 2026-04-24 by claude_head_of_line_unblock.
--   - Expired 14 zombie groupme_approval_requests (Apr 15-17)
--   - Rejected 20 matching pending_approval actions
--   - Expired 145 additional pending_approval actions >24h old
--   - Queue reduced from 185 stuck → 20 fresh awaiting approval
-- =====================================================================


-- ---------------------------------------------------------------------
-- TTL MAINTENANCE — run on schedule (hourly recommended)
-- ---------------------------------------------------------------------
-- Expires any groupme_approval_requests.status='pending' older than 48h
-- AND rejects the matching pending_approval agent_actions rows in one pass.
-- Tune the INTERVAL to taste (24h is more aggressive, 72h is more forgiving).
-- ---------------------------------------------------------------------

WITH expired_requests AS (
  UPDATE groupme_approval_requests
  SET status = 'expired',
      resolved_by = 'ttl_auto_expire',
      resolved_at = NOW()
  WHERE status = 'pending'
    AND requested_at < NOW() - INTERVAL '48 hours'
  RETURNING batch_id
)
UPDATE agent_actions
SET status = 'rejected',
    error_message = 'Auto-expired: pending_approval >48h without GroupMe response',
    approved_by = 'ttl_auto_expire',
    executed_at = NOW(),
    updated_at = NOW()
WHERE status = 'pending_approval'
  AND batch_id IN (SELECT batch_id FROM expired_requests);


-- ---------------------------------------------------------------------
-- STALE BACKLOG CLEANUP — run manually if the queue ever backs up again
-- ---------------------------------------------------------------------
-- Expires pending_approval actions with NO tracking record that are simply
-- too old to be relevant. Protects against future head-of-line blockage
-- even if the v4.2 code fix is not yet deployed.
-- ---------------------------------------------------------------------

-- UNCOMMENT TO RUN:
-- UPDATE agent_actions
-- SET status = 'rejected',
--     error_message = 'Auto-expired: pending_approval >24h, context too stale for current approval',
--     approved_by = 'claude_ttl_cleanup',
--     executed_at = NOW(),
--     updated_at = NOW()
-- WHERE status = 'pending_approval'
--   AND created_at < NOW() - INTERVAL '24 hours';


-- ---------------------------------------------------------------------
-- HEAD-OF-LINE DIAGNOSTIC — run ad-hoc to confirm queue health
-- ---------------------------------------------------------------------

-- Diagnostic: split pending_approval actions by whether they have a tracking record.
-- If the "has_tracking_record" count ever exceeds ~15, investigate — you are at
-- risk of head-of-line blocking again.

-- SELECT
--   CASE WHEN g.id IS NOT NULL THEN 'has_tracking_record' ELSE 'no_tracking_record' END AS state,
--   COUNT(*) AS action_count,
--   COUNT(DISTINCT a.batch_id) AS batches,
--   MIN(a.created_at) AS oldest,
--   MAX(a.created_at) AS newest
-- FROM agent_actions a
-- LEFT JOIN groupme_approval_requests g
--   ON g.batch_id = a.batch_id AND g.status = 'pending'
-- WHERE a.status = 'pending_approval'
-- GROUP BY state;
