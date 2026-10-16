/**
 * mark_invalid — src/appointments/mark-invalid.js
 *
 * The no-notification kill for a mirrored GHL estimate appointment that is bad
 * or disqualified (Mark, 2026-10-16, handoff v3.4 Fix 2 + Fix 8).
 *
 * WHY `invalid` AND NEVER `cancelled`. Five ghost Window Estimates (Gilles
 * 475840, Beilstein 466127, Stone 465486, Traina 468700, Sayre 462092) sat live
 * with reminders running until a person fixed each one by hand with exactly
 * these three steps. `invalid` is safe: the A.WE Window Estimate Handler's
 * Invalid branch only removes from itself, no LP rule listens for it, and it is
 * NOT a cancel — so no cancel / rebook / rescue path fires (A.WE-1-E Reminder
 * Exit fires only on Cancelled; that is why step 2 removes A.WE-1 directly).
 *
 * The three steps run IN THIS ORDER, enforced with not_before_seconds:
 *   1. update_appointment_status → 'invalid'
 *   2. remove_from_workflow A.WE-1 (75829de7-…)
 *   3. remove_tag the reminder tags
 *
 * Pure: builds agent_actions rows; the caller inserts them under its own rule
 * (ESTIMATE_DRIFT_FIX for Fix 8, LP_DISP_DISQUALIFIED for Fix 2).
 */

export const AWE1_WORKFLOW_ID = '75829de7-3f10-463c-b7a5-ab467ebadd4e';
export const REMINDER_TAGS = Object.freeze([
  'appt-exists', 'indoctrination-paused', 'reminder-sms-24h-sent', 'reminder-sms-48h-sent',
  'booked-estimate', 'estimate-booked', 'estimate-reminders-started', 'window-estimate-booked',
]);
const STEP_GAP_SECONDS = 20;

/**
 * @param {object} a
 * @param {string} a.contactId
 * @param {string} a.appointmentId
 * @param {string} a.rule          rule_applied for every row
 * @param {string} a.why           plain-English reason, for the rows' reasoning
 * @param {number|null} [a.eventId]
 * @returns {object[]} three agent_actions rows, in run order
 */
export function buildMarkInvalidRows({ contactId, appointmentId, rule, why, eventId = null }) {
  if (!contactId || !appointmentId) throw new Error('buildMarkInvalidRows: contactId and appointmentId are required');
  const claim = `mark-invalid:${appointmentId}`;
  const base = {
    event_id: eventId,
    target_system: 'ghl',
    target_entity: 'contact',
    target_id: contactId,
    rule_applied: rule,
    status: 'pending',
    requires_approval: false,
    priority: 30,
  };
  return [
    {
      ...base,
      action_type: 'update_appointment_status',
      target_entity: 'appointment',
      action_payload: { appointment_id: appointmentId, status: 'invalid', claim_key: `${claim}:status` },
      reasoning: `Mark appointment ${appointmentId} invalid (never cancelled — no cancel/rebook path fires): ${why}`,
    },
    {
      ...base,
      action_type: 'remove_from_workflow',
      action_payload: {
        workflow_id: AWE1_WORKFLOW_ID, canonical_name: 'A.WE-1 Window Estimate Reminders',
        claim_key: `${claim}:awe1`, not_before_seconds: STEP_GAP_SECONDS,
      },
      reasoning: `Stop the reminders for invalid appointment ${appointmentId}: ${why}`,
    },
    {
      ...base,
      action_type: 'remove_tag',
      action_payload: { tags: [...REMINDER_TAGS], claim_key: `${claim}:tags`, not_before_seconds: STEP_GAP_SECONDS * 2 },
      reasoning: `Clear the reminder tags for invalid appointment ${appointmentId}: ${why}`,
    },
  ];
}
