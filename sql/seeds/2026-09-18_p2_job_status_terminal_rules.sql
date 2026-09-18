-- ════════════════════════════════════════════════════════════════════
-- P2_JOB_TERMINAL_LOST / P2_JOB_TERMINAL_WON — close the P2 opportunity
-- when the LP job reaches a terminal status
-- 2026-09-18
--
-- ⚠️  NOT APPLIED BY THE PR THAT ADDED THIS FILE. Mark applies it by hand,
--    AFTER the emitter has deployed and he has confirmed a real
--    lp.job_status_changed event landed in system_events. See ORDER OF
--    OPERATIONS below.
--
-- WHAT: two new contextual rules on a brand-new event type,
--   lp.job_status_changed. Both queue a single update_opportunity against P2:
--   one closes it lost on a dead job status, one closes it won on a collected
--   one. Both ship requires_approval = true.
--
-- WHY: LP job STATUS changes reached nothing. Milestones have fired
--   lp.milestone_completed ~1,200x/week since v7.1 and the P2_MILESTONE_* family
--   moves opportunities on them, but a job going 'Awaiting Product' ->
--   'Cancelled' emitted no event at all — confirmed by repo search: no
--   lp.job_status_changed anywhere, and no such event_type in system_events.
--
--   So a cancellation in LP never reached GHL and the opportunity stayed open
--   forever. Measured 2026-09-18: 241 of a 249-job sample of DEAD LP jobs were
--   still sitting OPEN in P2. scripts/reconcile-p2-stages.js repairs that
--   backlog once (89 stage moves, 1,186 wins, ~515 losses); these two rules are
--   what stop it refilling.
--
-- DEPENDENCY — the emitter AND the intake-filter entry must be live first.
--   Both ship in the same PR:
--     src/sync-children.js                  emits on an actual status change
--     src/services/job-status-change.js     the pure decision + event shape
--     src/services/event-intake-filter.js   'lp.job_status_changed' in
--                                           ALLOWED_EVENT_TYPES
--   That allowlist is DEFAULT-DROP. Without the entry the emitter works, every
--   event lands in system_events_filtered with reason
--   event_type_not_in_allowlist, and both rules below are dead in total
--   silence. Applying this file before that deploy does no harm, but the rules
--   will never fire and it will look like a broken emitter.
--
-- WHY requires_approval = true ON BOTH.
--   Lost is irreversible: GHL keeps no history that walks a lost reason back,
--   and the value lands in close-rate and loss-reason reporting permanently.
--   Won moves REPORTED REVENUE — it feeds close-rate and the Scorecard.
--   Neither should run unattended on a brand-new event on its first week. The
--   actions queue for human approval until a week has been reviewed; only then
--   is requires_approval = false a decision anyone can make with evidence.
--
-- WHY 'Installed & Unpaid' IS NOT IN THE WON LIST.
--   The work is done, the money is not collected. Counting it won overstates
--   revenue. It derives a stage from its milestones and stays open until a
--   collected status is reached. Same call the reconciler makes — see
--   WON_JOB_STATUSES in scripts/reconcile-p2-stages.js.
--
-- WHY 'Credit Decline' IS IN THE LOST LIST (2026-09-18, Mark).
--   Previously excluded because nobody had measured how often a declined deal
--   is reworked and recovered, and marking lost is irreversible. Resolved by
--   giving it its OWN lost reason — "Financing Denied"
--   (69cd48077ac164325a355e36) — rather than folding it in with cancellations,
--   so recovery rate becomes measurable after the fact by querying lost
--   opportunities by reason. ~345 jobs / ~179 contacts.
--
--   It remains OUT of CANCELLED_JOB_STATUSES in src/lp-job-value.js, so a
--   declined job still carries pipeline value and can still be the job an
--   opportunity tracks. Only the verdict changed.
--
-- HOW THE LOST REASON IS SET. Not by this template — it cannot be. The rule
--   fires on five statuses that map to four different reasons, and
--   action_template is static config. The executor derives it: the
--   update_opportunity wrapper in src/actions/index.js reads the source event's
--   event_subtype (which IS the new job status) and maps it through
--   JOB_STATUS_LOST_REASON in src/lp-lost-reasons.js — the same table
--   scripts/reconcile-p2-stages.js checks its --lost-reason-id pairing against.
--
--     Cancelled         -> Customer Cancelled      6aad8dc01f2de24d878ec356
--     Cancelled By Mgt  -> Customer Cancelled      6aad8dc01f2de24d878ec356
--     Dead Deal         -> Ghosted / Unresponsive  69cd4807e4ce65bc76877f98
--     Sent To Attorney  -> Collections / Attorney  6aad8dc0f4cad9983ac319ce
--     Credit Decline    -> Financing Denied        69cd48077ac164325a355e36
--
--   If a status ever reaches the executor with no mapping, the action FAILS
--   loudly rather than writing a reasonless loss. The event_subtype_in list
--   below and that table's keys are the same five statuses — keep them in step.
--
-- INVARIANT — event_subtype_in is implemented and FAILS CLOSED
--   (src/decision-engine.js). An absent or unlisted subtype blocks the rule.
--   Verified against the live engine 2026-09-18, because an unimplemented
--   condition operator short-circuits silently and the rule would simply never
--   fire — the EMAIL_ENRICH_FROM_LP failure mode, dead for 1,970 evaluations.
--
-- INVARIANT — conditions is NULL and all logic lives in context_conditions,
--   per the Decision Engine convention: the engine evaluates the merge
--   { ...conditions, ...context_conditions }.
--
-- ORDER OF OPERATIONS:
--   1. Confirm the PR is merged and Railway has deployed it.
--   2. Confirm a real event has landed — DO NOT SKIP:
--        SELECT json_agg(row_to_json(s)) FROM (
--          SELECT event_type, event_subtype, created_at, payload
--            FROM system_events
--           WHERE event_type = 'lp.job_status_changed'
--           ORDER BY created_at DESC LIMIT 10
--        ) s;
--      Zero rows after a sync cycle means the allowlist entry did not deploy.
--      Check system_events_filtered before applying anything.
--   3. Run this file.
--   4. POST https://lp-mcp-production.up.railway.app/n8n/decision-engine/reload-rules
--      and assert rules_loaded = 289 (287 enabled today + 2). A rule change is
--      database config and takes effect only after the reload.
--   5. Watch the approval queue for a week. Then decide on requires_approval.
-- ════════════════════════════════════════════════════════════════════

BEGIN;

INSERT INTO agent_rules
  (rule_key, rule_name, category, event_pattern, conditions, context_conditions,
   action_template, requires_approval, enabled, priority, rule_type, notes, created_by)
VALUES
('P2_JOB_TERMINAL_LOST',
 'LP job reached a terminal dead status -> mark P2 opportunity lost',
 'integration',
 '{"event_type": "lp.job_status_changed"}'::jsonb,
 NULL,
 '{"event_subtype_in": ["Cancelled","Cancelled By Mgt","Dead Deal","Sent To Attorney","Credit Decline"]}'::jsonb,
 '[{"action_type":"update_opportunity","target_system":"ghl","target_entity":"opportunity",
    "params":{"pipeline":"P2","status":"lost"},"priority":5}]'::jsonb,
 true, true, 95, 'contextual',
 'Closes the gap where LP cancellations never reached GHL. Lost reason is set per status by the executor via the shared mapping (src/lp-lost-reasons.js). Credit Decline maps to Financing Denied so recovery rate stays measurable. requires_approval true until a week of queued actions has been reviewed.',
 'claude'),

('P2_JOB_TERMINAL_WON',
 'LP job reached a collected status -> mark P2 opportunity won',
 'integration',
 '{"event_type": "lp.job_status_changed"}'::jsonb,
 NULL,
 '{"event_subtype_in": ["Paid In Full","PIF Survey Ready","PIF NO Survey","Assumed Complete"]}'::jsonb,
 '[{"action_type":"update_opportunity","target_system":"ghl","target_entity":"opportunity",
    "params":{"pipeline":"P2","status":"won"},"priority":5}]'::jsonb,
 true, true, 95, 'contextual',
 'Installed & Unpaid deliberately excluded - work done, money not collected. requires_approval true because won status feeds close-rate and Scorecard reporting.',
 'claude');

COMMIT;

-- Verification (expect 2 rows, both enabled, both requires_approval true,
-- both conditions NULL):
SELECT json_agg(row_to_json(s)) FROM (
  SELECT rule_key, enabled, requires_approval, priority, rule_type,
         conditions, context_conditions, event_pattern
    FROM agent_rules
   WHERE rule_key IN ('P2_JOB_TERMINAL_LOST', 'P2_JOB_TERMINAL_WON')
   ORDER BY rule_key
) s;

-- Reload required after apply:
--   POST https://lp-mcp-production.up.railway.app/n8n/decision-engine/reload-rules
--   assert rules_loaded = 289

-- Confirms the rules are actually firing (run after a day; expect > 0 once a
-- terminal status has moved). Before claiming a rule never fires, check here —
-- one previously flagged as dead had fired 47 times.
SELECT json_agg(row_to_json(s)) FROM (
  SELECT rule_applied, status, count(*) AS n
    FROM agent_actions
   WHERE rule_applied IN ('P2_JOB_TERMINAL_LOST', 'P2_JOB_TERMINAL_WON')
   GROUP BY rule_applied, status
   ORDER BY rule_applied, status
) s;

-- Rollback — removes both rules. Safe: they queue for approval, so nothing has
-- been written to GHL that was not approved by hand. Any actions already
-- APPROVED and EXECUTED are not undone by this; a wrongly-closed opportunity is
-- reopened in the GHL UI, and a wrongly-set lost reason cannot be walked back at
-- all. A reload is required after rollback, same endpoint, asserting 287.
--
-- BEGIN;
-- DELETE FROM agent_rules
--  WHERE rule_key IN ('P2_JOB_TERMINAL_LOST', 'P2_JOB_TERMINAL_WON');
-- COMMIT;
