# PATCH v4.2 — Action Executor Head-of-Line Fix

**Target file:** `src/action-executor.js`
**Current base SHA:** `b16a61ba4b1c5442256d579aaded77a214e7fc08` (identical on `dev` and `main` at time of writing)
**Branch to apply on:** `dev`
**Reason for Claude Code handoff:** file is 60KB — exceeds the ~40KB safe limit for direct MCP file commits per working-patterns memory.

---

## Problem

`executeActions()` queries the 20 oldest `pending_approval` actions per heartbeat, then for each batch checks `groupme_approval_requests` for an existing tracking record. If a record exists, the batch is skipped — but the skipped batch is NOT transitioned out of `pending_approval` status and continues to appear at the head of the query on subsequent heartbeats.

Once 20+ unanswered approvals accumulate in `groupme_approval_requests` (status `pending`), they permanently occupy the `limit(20)` window and **no new approval requests ever fire**. On 2026-04-24, this manifested as 185 pending_approval actions across 77 batches sitting without GroupMe notification, some up to 7 days old. The 20 oldest all had existing tracking records from Apr 15–17.

## Fix

Pre-filter the `agent_actions` query to exclude any batch that already has a tracking record. Widen the initial fetch to 100 so the filter does not starve. Keep `limit(20)` as the final batch cap so GroupMe isn't flooded per heartbeat.

## Exact replacement

Locate this line inside `executeActions()`:

```js
  const { data: approvalActions } = await supabase.from('agent_actions').select('*').eq('status', 'pending_approval').order('created_at', { ascending: true }).limit(20);
```

Replace with:

```js
  // v4.2 — Head-of-line fix. Exclude batches that already have a tracking
  // record in groupme_approval_requests so stale unanswered approvals do not
  // block new ones from reaching the notification path. A recurring TTL SQL
  // (sql/008_approval_queue_ttl.sql) auto-expires unanswered approvals >48h
  // so the tracked-batch set stays bounded.
  const { data: trackedBatches } = await supabase
    .from('groupme_approval_requests')
    .select('batch_id');
  const trackedSet = new Set((trackedBatches || []).map(r => r.batch_id).filter(Boolean));

  const { data: rawApprovalActions } = await supabase.from('agent_actions')
    .select('*')
    .eq('status', 'pending_approval')
    .order('created_at', { ascending: true })
    .limit(100);

  const approvalActions = (rawApprovalActions || [])
    .filter(a => !trackedSet.has(a.batch_id || `s_${a.id}`))
    .slice(0, 20);
```

## Optional header-comment bump

Add a v4.2 note at the top of the file, directly above the existing v4.1 comment block:

```js
 * v4.2 — Head-of-line fix for approval queue.
 *   executeActions() now excludes batches with existing tracking records
 *   before applying the oldest-first limit(20). Prevents unanswered approvals
 *   from zombie-blocking the notification path. Paired with TTL cleanup in
 *   sql/008_approval_queue_ttl.sql.
 *
```

## Verification after deploy

Run this query after the first heartbeat post-deploy. `has_tracking_record` should only contain approvals whose GroupMe message was sent in the same cycle — typically 0 during normal operation, bounded by the number of approvals currently awaiting response.

```sql
SELECT
  CASE WHEN g.id IS NOT NULL THEN 'has_tracking_record' ELSE 'no_tracking_record' END AS state,
  COUNT(*) AS action_count
FROM agent_actions a
LEFT JOIN groupme_approval_requests g
  ON g.batch_id = a.batch_id AND g.status = 'pending'
WHERE a.status = 'pending_approval'
GROUP BY state;
```

Railway logs should show `[ActionExecutor] Pre-generating AI response for approval ...` and `[GroupMe] Approval request sent: #...` entries again.

## Dependencies

- None new. Uses existing `supabase` client, same query patterns already in the file.

## Rollback

Revert the single-line change; prior behavior returns. No DB schema changes are required by this patch.

## Deploy order

1. Apply patch on `dev`.
2. Confirm local syntax check (`node --check src/action-executor.js`).
3. Merge `dev` → `main`. Railway auto-deploys on merge to main.
4. Watch Railway logs for `[ActionExecutor] Pre-generating AI response` — should appear within 5 minutes (next heartbeat).
5. Confirm first real approval request arrives in the GroupMe approvals channel.
6. Wire `sql/008_approval_queue_ttl.sql` TTL MAINTENANCE block to an n8n scheduled workflow (hourly recommended).

## Related commits

- Queue unblock + stale backlog cleanup executed via Supabase on 2026-04-24T20:30 UTC by `claude_head_of_line_unblock` / `claude_ttl_cleanup`. Queue reduced from 185 stuck → 20 fresh awaiting approval.
- TTL maintenance SQL committed in same PR as this patch: `sql/008_approval_queue_ttl.sql`.
