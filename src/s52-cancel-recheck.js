// S5.2 cancel recheck — src/s52-cancel-recheck.js
//
// 2026-10-02 (Maria, 0VcsATQcnXOM7jErFFY0, lead 580116). not_reschedule_inflight
// exists so an agent's own reschedule (cancel the old slot, book the new one)
// is not read as a customer cancel. But it DROPPED the event: Maria went
// Cnf → Set → CXL inside ten minutes, the CXL landed inside the 5-minute
// in-flight window, rule 271 was suppressed, and nothing ever looked again. Her
// real cancel never reached S5.2.
//
// Now a suppression by that condition, on the three cancel rules below, queues
// ONE re-check 30 minutes later (an agent_actions row held by
// not_before_seconds / retry_at, so it survives deploys). On the re-check:
//   - current lead still CXL/CCC and no lead with a live appointment
//     → re-evaluate the rule (the marker has expired) and queue its actions;
//       the S5.2 step still passes through the entry gate.
//   - anything else (a new Set, the lead re-booked, or a sibling cancel rule
//     already routed it) → s52.reschedule_confirmed.
// It runs once. A failed read is logged and stops; it is never re-queued.
import { pickCurrentLead } from './current-lead.js';
import { isLiveAppointmentLead } from './s52-entry-gate.js';

export const RECHECK_RULE_KEYS = Object.freeze([
  'LP_DISP_CANCEL_COLD_TO_S5_2',      // 271
  'GHL_APPT_CANCELLED_REBOOK_COLD',   // 171
  'GHL_APPT_CANCELLED_REBOOK',        // 107
]);
// Any of these on the contact since the suppression means the cancel was
// already routed. The marker that suppressed us is often the LP→GHL CXL
// reconciler's own (lp-ghl-appointment-reconciler.js), set precisely so the
// GHL cancel webhook does not make 171/107 fire again after 271 handled the
// LP cancel — the re-check must not undo that.
export const CANCEL_ROUTING_RULE_KEYS = Object.freeze([...RECHECK_RULE_KEYS, 'LP_DISP_CXL_TO_CANCELLED']);
export const RECHECK_DELAY_SECONDS = 30 * 60;
export const RECHECK_RULE_APPLIED = 'S52_CANCEL_RECHECK';
const CANCEL_DISPOSITIONS = ['CXL', 'CCC'];

let _deps = null;
async function defaultDeps() {
  if (_deps) return _deps;
  const [{ default: supabase }, { emitEvent }] = await Promise.all([
    import('./supabase.js'),
    import('./event-emitter.js'),
  ]);
  _deps = { supabase, emitEvent };
  return _deps;
}

/**
 * Queue the one re-check for (event, rule). Never throws; returns what it did.
 */
export async function queueS52CancelRecheck(event, ruleKey, deps = {}) {
  if (!RECHECK_RULE_KEYS.includes(ruleKey) || !event?.id || !event?.ghl_contact_id) return { queued: false, reason: 'not_applicable' };
  const d = { ...(await defaultDeps().catch(() => ({}))), ...deps };
  try {
    // One per event + rule, and one PENDING per contact: an LP CXL (271) and
    // GHL's cancel webhook (171) for the same cancel both get suppressed, and
    // two re-checks firing together could route it twice.
    const { data: existing, error: readErr } = await d.supabase.from('agent_actions')
      .select('id')
      .eq('event_id', event.id)
      .eq('rule_applied', RECHECK_RULE_APPLIED)
      .contains('action_payload', { rule_key: ruleKey })
      .limit(1);
    if (readErr) throw new Error(readErr.message);
    if (existing?.length) return { queued: false, reason: 'already_queued', action_id: existing[0].id };
    const { data: pending, error: pendErr } = await d.supabase.from('agent_actions')
      .select('id')
      .eq('target_id', String(event.ghl_contact_id))
      .eq('rule_applied', RECHECK_RULE_APPLIED)
      .eq('status', 'pending')
      .limit(1);
    if (pendErr) throw new Error(pendErr.message);
    if (pending?.length) return { queued: false, reason: 'contact_recheck_pending', action_id: pending[0].id };

    const nowMs = d.nowMs ?? Date.now();
    const { data, error } = await d.supabase.from('agent_actions').insert({
      event_id: event.id,
      action_type: 's52_cancel_recheck',
      target_system: 'lp',
      target_entity: 'contact',
      target_id: String(event.ghl_contact_id),
      action_payload: { rule_key: ruleKey, source_event_id: event.id, not_before_seconds: RECHECK_DELAY_SECONDS },
      reasoning: `${ruleKey} suppressed by not_reschedule_inflight — re-check in 30 min so a real cancel is not dropped`,
      confidence: 1.0,
      rule_applied: RECHECK_RULE_APPLIED,
      status: 'pending',
      requires_approval: false,
      priority: 50,
      retry_at: new Date(nowMs + RECHECK_DELAY_SECONDS * 1000).toISOString(),
    }).select('id').single();
    if (error) throw new Error(error.message);
    console.log(`[S52Recheck] queued #${data?.id} for ${ruleKey} on event ${event.id} (contact ${event.ghl_contact_id})`);
    return { queued: true, action_id: data?.id ?? null };
  } catch (err) {
    console.warn(`[S52Recheck] could not queue re-check for ${ruleKey} on event ${event.id}: ${err.message}`);
    return { queued: false, reason: 'error', error: err.message };
  }
}

/**
 * Pure. A cancel rule dropped by its dedup GROUP because a DIFFERENT rule fired
 * inside the window (LP_DISP_SET minutes before LP_DISP_CANCEL_COLD_TO_S5_2)
 * gets the re-check. An exact repeat of the same rule does not.
 * `dup` is hasDuplicatePendingActions' result: { blockedBy, group } or false.
 */
export function shouldRecheckOnDedup(ruleKey, dup) {
  return !!(dup && dup.group && dup.blockedBy && dup.blockedBy !== ruleKey && RECHECK_RULE_KEYS.includes(ruleKey));
}

/**
 * Pure: should the cancel go ahead now?
 * @returns {{ run: boolean, reason: string }}
 */
export function decideRecheck({ leads, nowMs = Date.now() } = {}) {
  const rows = Array.isArray(leads) ? leads : [];
  const live = rows.find((l) => isLiveAppointmentLead(l, nowMs));
  if (live) return { run: false, reason: `live_appointment:${live.lp_lead_id ?? '?'}:${live.disposition_code}` };
  const current = pickCurrentLead(rows);
  const disp = String(current?.disposition_code ?? '').trim();
  if (!CANCEL_DISPOSITIONS.includes(disp)) return { run: false, reason: `current_lead_${disp || 'none'}` };
  return { run: true, reason: `current_lead_${disp}` };
}

/** Action handler for action_type 's52_cancel_recheck'. */
export async function executeS52CancelRecheck(action, deps = {}) {
  const d = { ...(await defaultDeps().catch(() => ({}))), ...deps };
  const contactId = action.target_id;
  const { rule_key: ruleKey, source_event_id: eventId } = action.action_payload || {};
  const loadInputs = d.loadS52GateInputs || (await import('./s52-entry-gate.js')).loadS52GateInputs;
  const recheckRule = d.recheckRuleForEvent || (await import('./decision-engine.js')).recheckRuleForEvent;

  const emit = (event_type, payload) => d.emitEvent({
    event_type,
    source: 's52_cancel_recheck',
    entity_type: 'contact',
    entity_id: String(contactId),
    ghl_contact_id: String(contactId),
    payload: { rule_key: ruleKey, source_event_id: eventId, action_id: action.id ?? null, ...payload },
    priority: 'low',
    bypass_filter: true,
    idempotency_key: `${event_type}_${action.id ?? `${eventId}_${ruleKey}`}`,
  }).catch((err) => console.warn(`[S52Recheck] ${event_type} emit failed: ${err.message}`));

  // Already routed by a sibling cancel rule since the suppression → stop.
  try {
    const sinceMs = (Date.parse(action.created_at) || ((d.nowMs ?? Date.now()) - RECHECK_DELAY_SECONDS * 1000)) - 10 * 60 * 1000;
    const { data: routed, error } = await d.supabase.from('agent_actions')
      .select('id, rule_applied')
      .eq('target_id', String(contactId))
      .in('rule_applied', CANCEL_ROUTING_RULE_KEYS)
      .gte('created_at', new Date(sinceMs).toISOString())
      .limit(1);
    if (error) throw new Error(error.message);
    if (routed?.length) {
      await emit('s52.reschedule_confirmed', { reason: `already_routed_by:${routed[0].rule_applied}` });
      return { action: 's52_cancel_recheck', outcome: 'already_routed', reason: routed[0].rule_applied };
    }
  } catch (err) {
    await emit('s52.cancel_recheck_failed', { reason: 'read_failed:agent_actions', detail: err.message });
    return { skipped: true, action: 's52_cancel_recheck', outcome: 'read_failed', reason: 'read_failed:agent_actions' };
  }

  const inputs = await loadInputs(contactId, d);
  if (inputs.error) {
    await emit('s52.cancel_recheck_failed', { reason: inputs.error, detail: inputs.detail });
    return { skipped: true, action: 's52_cancel_recheck', outcome: 'read_failed', reason: inputs.error };
  }

  const decision = decideRecheck({ leads: inputs.leads, nowMs: d.nowMs ?? Date.now() });
  if (!decision.run) {
    console.log(`[S52Recheck] ${contactId} ${ruleKey}: reschedule confirmed (${decision.reason}) — no cancel routing`);
    await emit('s52.reschedule_confirmed', { reason: decision.reason });
    return { action: 's52_cancel_recheck', outcome: 'reschedule_confirmed', reason: decision.reason };
  }

  const res = await recheckRule(eventId, ruleKey);
  console.log(`[S52Recheck] ${contactId} ${ruleKey}: still cancelled — ${res.fired ? `queued ${res.created_action_ids.length} action(s)` : `rule did not pass (${res.reason})`}`);
  await emit('s52.cancel_recheck_ran', { reason: decision.reason, fired: !!res.fired, rule_result: res.reason, created_action_ids: res.created_action_ids || [] });
  return { action: 's52_cancel_recheck', outcome: res.fired ? 'cancel_routed' : 'rule_not_passed', reason: res.reason, created_action_ids: res.created_action_ids || [] };
}
