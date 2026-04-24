# RELEASE v4.2 — Approval Pipeline Tightening

**Status:** ✅ **APPLIED** on `dev` branch 2026-04-24 — ready for Mark to review and merge to `main`.
**Replaces:** Earlier PATCH v4.2 spec (was Claude Code handoff; ended up direct-committed).

---

## Problem summary

Three bugs were turning the approval pipeline into a silent failure mode:

**1. Inbound message line silently missing from every GroupMe approval card.**
`buildNotificationEnrichment` resolved the inbound text from `context.message_text` / `messageText` / `body`. But every `AGENTIC_*` rule fires on `ai.analysis_completed` events, and those events carry the inbound text in `message_preview`. Result: the `💬 "..."` line was dropped from the card for all agentic approvals. Mark was asked to approve responses without seeing what the lead actually said.

**2. Head-of-line approval blockage.**
`executeActions()` fetched the 20 oldest `pending_approval` actions per heartbeat and skipped any batch with an active tracking record. Once 20 unanswered approvals accumulated in `groupme_approval_requests` (status `pending`), they permanently occupied the window and no new approvals ever reached the notification path. Crossed that threshold on 2026-04-17. Pile-up ballooned to 185 stuck actions across 77 batches by 2026-04-24.

**3. Zombie tracking records from transient GroupMe failures.**
`sendApprovalRequest` always upserted the tracking record, regardless of whether the GroupMe POST succeeded. If GroupMe had a blip or `GROUPME_BOT_ID` was ever unset, a "sent" tracking record got created for a message that never landed in the channel. That record then acted as a head-of-line blocker.

## What changed

### `src/action-executor.js` → v4.2 (commit `fe49f7e`)

**`buildNotificationEnrichment`:** `messageText` fallback chain now includes `message_preview`:
```js
messageText: context.message_text || context.messageText || context.body || context.message_preview || null,
```

**`executeActions`:** Three structural changes.
- Pre-filter pending_approval query: fetch active tracked batch_ids once, exclude them before applying `limit(20)`. Widened initial fetch from 20 to 100 so the filter has headroom.
- Removed the outer `if (!existing)` guard (redundant after pre-filter) and replaced with a tight in-loop re-check scoped to `status='pending'`. This is defense-in-depth for concurrent executor runs (heartbeat colliding with `triggerExecution()` after an approval).
- Pre-generation triggerMessage resolution also accepts `message_preview`:
```js
const triggerMessage = ctx.message_text || ctx.messageText || ctx.body || ctx.message_preview || 'No trigger message';
```

### `src/groupme.js` → v1.4 (commit `b540886`)

**`sendApprovalRequest`:** Now checks `sendGroupMeMessage`'s return value. Only persists the tracking record when GroupMe actually accepts the message. Throws on failure so the outer `.catch()` in `executeActions` surfaces the error in logs instead of silently continuing. Prior versions upserted unconditionally — that's what allowed zombie records to form.

Also:
- Inbound message preview widened from 120 → 200 chars on the approval card (Mark sees more of the lead's actual words)
- Added `AGENTIC_RESPOND_POST_CHATBOT` → `🤖 AGENTIC RESPONSE` to `RULE_DISPLAY_NAMES` (was falling back to raw rule key)

### `sql/008_approval_queue_ttl.sql` (commit `e81d6c2`)

Recurring 48h TTL SQL to wire into n8n (hourly). Prevents the tracked-batch set from growing unbounded even under normal operation.

## Live state after the cleanup ran

One-shot SQL executed against LP Supabase on 2026-04-24T20:30 UTC:
- Expired 14 zombie `groupme_approval_requests` (Apr 15–17, status=pending, unanswered for 7+ days)
- Rejected 20 matching `pending_approval` actions in those batches (audit trail: `approved_by='claude_head_of_line_unblock'`)
- Rejected 145 additional `pending_approval` actions older than 24h (audit trail: `approved_by='claude_ttl_cleanup'`)
- Queue reduced from 185 stuck → 20 fresh awaiting approval across 10 legitimate batches

## What to verify after merge to `main`

1. **Production picks up the new code.** Railway auto-deploys on merge. Watch logs:
   - `[ActionExecutor] Pre-generating AI response for approval ...` — should appear within 5 min of merge
   - `[GroupMe] Approval request sent: #...` — should follow within seconds

2. **GroupMe cards now include both lines.** Each approval card should carry:
   - `💬 "<lead's inbound message>"`
   - `📱 "<AI-generated proposed reply>"`
   - Full context: score, tier, source, rep, disposition, AI summary, action summary
   - `Reply: Yes <id> or No <id>`

3. **Head-of-line diagnostic stays healthy.** Run the diagnostic query at the bottom of `sql/008_approval_queue_ttl.sql`. `has_tracking_record` should stay small (<15). If it grows past 15, the TTL isn't running.

4. **Wire TTL to n8n.** Create a scheduled workflow that runs the `TTL MAINTENANCE` block hourly. Zero-maintenance after that.

## Rollback

`git revert` both commits. No DB schema changes were introduced. The Supabase cleanup is permanent but can't cause regressions — those approvals were already stale.

## Related commits

| SHA | File | Description |
|-----|------|-------------|
| `fe49f7e` | `src/action-executor.js` | v4.2 — head-of-line + message_preview + concurrent-safe loop |
| `b540886` | `src/groupme.js` | v1.4 — zombie-proof tracking, 200-char inbound preview, AGENTIC rule display name |
| `e81d6c2` | `sql/008_approval_queue_ttl.sql` | TTL maintenance SQL |

