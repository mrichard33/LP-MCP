/**
 * Cooling Enrollment Helper — src/cooling-enrollment.js
 *
 * Single function: enrollContactInCooling(opts)
 *
 * Called by the Decision Engine when it decides to park a contact on a
 * cooling hold. Looks up the matching agent_rules.cooling_registry row,
 * builds the runtime payload, and inserts a pending agent_action with
 * action_type=add_to_workflow. The existing Action Executor pull-queue
 * picks it up on the next heartbeat and dispatches to
 * executeAddToWorkflow Route B (POST to the I.COOL-* inbound webhook URL).
 *
 * On natural completion of the hold (or on Contact Not Found inside the
 * GHL workflow), the workflow POSTs back to /agentic/cooling/* — see
 * src/cooling-callback-handler.js for the closing side of the loop.
 *
 * Lookup key
 * ----------
 * agent_actions.id is a bigserial in this schema, so we can't pre-generate
 * it. Instead we mint a UUID (cooling_enrollment_event_id) and:
 *   1. Embed it in the payload sent to GHL — GHL persists it on the contact
 *      via custom field op2unF2UtDMCI2glXwha and echoes it back in the
 *      callback body.
 *   2. The callback handler queries agent_actions on
 *      action_payload->'payload'->>'cooling_enrollment_event_id'
 *      to find the originating row.
 * This decouples the lookup key from the database serial, which also makes
 * orphan callbacks (no matching action) easy to detect.
 *
 * Duration codes: '1W' | '2W' | '1M' | '45D' | '3M' | '6M' | '1Y'
 *
 * v1.0 — 2026-05-11 initial.
 */

import { randomUUID } from 'node:crypto';
import supabase from './supabase.js';

const DURATION_DAYS = {
  '1W': 7,
  '2W': 14,
  '1M': 30,
  '45D': 45,
  '3M': 90,
  '6M': 180,
  '1Y': 365,
};

/**
 * Park a contact on a cooling hold.
 *
 * @param {Object} opts
 * @param {string} opts.contactId           - GHL contact ID. Required.
 * @param {string} opts.durationCode        - '1W'|'2W'|'1M'|'45D'|'3M'|'6M'|'1Y'. Required.
 * @param {string} opts.reason              - Why cooling. e.g. 'objection:price'. Required.
 * @param {string} [opts.reEntryHint]       - Workflow code agentic should consider after. e.g. 'S4.5'.
 * @param {number} [opts.eventId]           - Triggering system_events.id (for traceability).
 * @param {string} [opts.ruleApplied]       - rule_key that fired this enrollment.
 * @param {number} [opts.confidence]        - 0.0-1.0.
 * @returns {Promise<{action_id:number, cooling_enrollment_event_id:string, started_at:string, expected_end_at:string, cooling_registry_rule_key:string, canonical_code:string}>}
 */
export async function enrollContactInCooling(opts) {
  const {
    contactId, durationCode, reason,
    reEntryHint = null, eventId = null,
    ruleApplied = null, confidence = null,
  } = opts || {};

  if (!contactId) throw new Error('enrollContactInCooling: contactId required');
  if (!durationCode) throw new Error('enrollContactInCooling: durationCode required');
  if (!reason) throw new Error('enrollContactInCooling: reason required');
  if (!(durationCode in DURATION_DAYS)) {
    throw new Error(`enrollContactInCooling: unknown durationCode '${durationCode}'`);
  }

  const ruleKey = `COOL_${durationCode}`;
  const { data: rule, error: ruleErr } = await supabase
    .from('agent_rules')
    .select('rule_key, action_template, enabled')
    .eq('rule_key', ruleKey)
    .eq('category', 'cooling_registry')
    .single();

  if (ruleErr || !rule) {
    throw new Error(`enrollContactInCooling: no cooling_registry rule found for ${ruleKey}: ${ruleErr?.message || 'not found'}`);
  }
  if (!rule.enabled) {
    throw new Error(`enrollContactInCooling: cooling_registry rule ${ruleKey} is disabled`);
  }

  const params = rule.action_template?.[0]?.params || {};
  const webhookUrl = params.webhook_url;
  const workflowId = params.workflow_id;
  const canonicalCode = params.canonical_code;
  const canonicalName = params.canonical_name;
  if (!webhookUrl) throw new Error(`enrollContactInCooling: ${ruleKey} missing webhook_url`);

  // Mint the GHL-side lookup key. This becomes cooling_enrollment_event_id
  // both in the payload sent to GHL AND in the callback we'll receive
  // 7-365 days later. The callback handler joins on this.
  const enrollmentEventId = randomUUID();
  const durationDays = DURATION_DAYS[durationCode];
  const startedAt = new Date();
  const expectedEndAt = new Date(startedAt.getTime() + durationDays * 86400 * 1000);

  const actionPayload = {
    webhook_url: webhookUrl,
    workflow_id: workflowId,
    canonical_code: canonicalCode,
    canonical_name: canonicalName,
    format: 'json',
    payload: {
      contact_id: contactId,
      cooling_duration_code: durationCode,
      cooling_started_at: startedAt.toISOString(),
      cooling_expected_end_at: expectedEndAt.toISOString(),
      cooling_reason: reason,
      cooling_re_entry_hint: reEntryHint || '',
      cooling_enrollment_event_id: enrollmentEventId,
    },
  };

  const insertRow = {
    action_type: 'add_to_workflow',
    target_entity: 'contact',
    target_id: contactId,
    target_system: 'ghl',
    action_payload: actionPayload,
    status: 'pending',
    rule_applied: ruleApplied || ruleKey,
    reasoning: `Cooling enrollment: ${canonicalCode} (${durationCode}, ${durationDays}d). Reason: ${reason}. Re-entry hint: ${reEntryHint || 'none'}.`,
  };
  if (eventId !== null && eventId !== undefined) insertRow.event_id = eventId;
  if (confidence !== null && confidence !== undefined) insertRow.confidence = confidence;

  const { data: action, error: actErr } = await supabase
    .from('agent_actions')
    .insert(insertRow)
    .select()
    .single();

  if (actErr) {
    throw new Error(`enrollContactInCooling: agent_actions insert failed: ${actErr.message}`);
  }

  console.log(`[CoolingEnrollment] ✅ Enrolled ${contactId} in ${canonicalCode} (${durationDays}d). action_id=${action.id} enrollment_event_id=${enrollmentEventId} reason=${reason}`);

  return {
    action_id: action.id,
    cooling_enrollment_event_id: enrollmentEventId,
    started_at: startedAt.toISOString(),
    expected_end_at: expectedEndAt.toISOString(),
    cooling_registry_rule_key: ruleKey,
    canonical_code: canonicalCode,
  };
}

/**
 * Convenience: pick a durationCode from a known cooling reason.
 * Mirrors the legacy cooling matrix from the system docs.
 * Caller can override by passing durationCode directly to enrollContactInCooling.
 */
export function pickDurationCodeForReason(reason) {
  const r = String(reason || '').toLowerCase();
  if (r.includes('financing')) return '6M';
  if (r.includes('trust') || r.includes('diy')) return '3M';
  if (r.includes('price') || r.includes('competitor')) return '45D';
  if (r.includes('timing') || r.includes('spouse')) return '1M';
  if (r.includes('ghosted') || r.includes('unresponsive')) return '2W';
  if (r.includes('long-horizon') || r.includes('dormant')) return '1Y';
  return '3M';
}
