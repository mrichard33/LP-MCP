/**
 * disqualified_cleanup — src/actions/handlers/disqualified-cleanup.js
 *
 * ND and No Demo = disqualified (Mark, 2026-10-16, handoff v3.4 Fix 2). An END
 * state: no S5.2, no rebook or rescue texts, no Five9 calls, no F.0, no nurture,
 * no booking.
 *
 * WHY. Avila (LP 583486, ND: "we don't service this type of project") was routed
 * by GHL_APPT_CANCELLED_REBOOK_COLD and the S5.2 v2 workflow started (blocked
 * late, by lp_note_dq). LP_DISP_NO_DEMO tagged 138 No Demo contacts in 30 days
 * lp-route:rebook-group2 with a time-lapse tier — a rebook route for a lead we
 * cannot run. Rule LP_DISP_DISQUALIFIED replaces it and queues this action.
 *
 * WHAT IT DOES, re-reading the contact's CURRENT lead first (a later lead that
 * is no longer ND / No Demo does nothing):
 *   - every open GHL estimate appointment → mark_invalid (status `invalid`,
 *     off A.WE-1, reminder tags off). NEVER `cancelled`: that fires the
 *     cancel / rebook / rescue paths this ruling exists to stop.
 *   - out of the sending sequences its active-* tags name (S5.x, S4.5,
 *     W-series: rebook and nurture), the same resolution dq_hard_stop uses;
 *   - tag lp-disqualified;
 *   - the P1 opportunity to the existing P3 "Hard Disqualified" stage
 *     (abandoned) — the stage the S1.3 hard-DQ lane already uses; none created;
 *   - Five9: one five9_delete_record_from_list for the phone over every
 *     outbound dialing list. Five9 has no read that lists every list holding a
 *     number (findContactInOtherLists never worked, see CLAUDE.md), and a list
 *     the number is not on is left as is, so the row names all of them.
 *     2026-10-20: the names are READ LIVE from getListsInfo at queue time
 *     rather than hardcoded. The frozen array this replaces still carried
 *     'Data - Hot', a list split into Data - Hot - Unmapped plus seven market
 *     lists some time before 2026-10-16; Five9 fails the WHOLE call on an
 *     unknown list name, so every removal under this rule errored with
 *     `List "Data - Hot" doesn't exist` — 8 of them in the 24h to 2026-10-19,
 *     including all three Mark approved by hand, leaving disqualified
 *     homeowners live on the dialer. A frozen array cannot track a list
 *     inventory the dialer team edits; DISQUALIFIED_FIVE9_LISTS below is now
 *     only the fallback for a failed read. Runs unarmed by default since
 *     2026-10-19 (the user: "automate these approvals"), with a no-button
 *     notice (src/notifications/disqualified-removed.js);
 *     DISQUALIFIED_FIVE9_AUTO_REMOVE=false puts the approval card back
 *     (src/actions/handlers/five9.js).
 *
 * All I/O through deps; idempotent per appointment / contact through claim keys.
 */

import { buildMarkInvalidRows } from '../../appointments/mark-invalid.js';
import { isDisqualifiedDisposition } from '../../lp-disposition-classes.js';
import { workflowCodesToLeave } from '../../services/dq-hard-stop.js';
import { ESTIMATE_CALENDAR_IDS } from '../../services/lp-ghl-appointment-reconciler.js';
import { prospectLabel } from '../../format-helpers.js';

export const DISQUALIFIED_RULE = 'LP_DISP_DISQUALIFIED';
export const DISQUALIFIED_TAG = 'lp-disqualified';

/**
 * FALLBACK ONLY — used when the live getListsInfo read fails (SOAP fault,
 * creds, a locked list). Live resolution is resolveDisqualifiedFive9Lists().
 * Kept in sync by hand with the dialing inventory as a floor, NOT as truth:
 * a name in here that Five9 has dropped fails the whole delete call, so
 * prefer dropping a name over keeping a dead one. Corrected 2026-10-20 —
 * 'Data - Hot' removed (it no longer exists), its eight successors added.
 */
export const DISQUALIFIED_FIVE9_LISTS = Object.freeze([
  'LP_ASAP', 'Reece Chatbot', 'Direct Lead Entry', 'After DIAL ASAP', 'Conf - Next Day', 'Conf - 2nd Day',
  'Data - Hot - Unmapped',
  'Data - Hot - FTL less than 7', 'Data - Hot - STP less than 7', 'Data - Hot - SAR less than 7',
  'Data - Hot - JAX less than 7', 'Data - Hot - ORL less than 7', 'Data - Hot - FTM less than 7',
  'Data - Hot - LKE less than 7',
]);

/**
 * Lists the live inventory carries that this action must NOT touch. The ruling
 * is "no Five9 CALLS": a texting list is a different consent surface and a
 * different opt-out, and the inbound queue is not dialed at all. Everything
 * else in the inventory is an outbound dialing list and is named.
 */
export const NON_DIAL_LIST_RX = /^simpletext|^inbound queue$/i;

// The estimate pool: Window Estimate, Measurement Verification, Home Protection Assessment.
const ESTIMATE_POOL = ESTIMATE_CALENDAR_IDS;
const DEAD_STATUSES = new Set(['cancelled', 'canceled', 'no_show', 'noshow', 'no-show', 'invalid']);

export function disqualifiedAutoRemove(env = process.env) {
  return String(env.DISQUALIFIED_FIVE9_AUTO_REMOVE || '').trim().toLowerCase() !== 'false';
}

const digits10 = (p) => String(p || '').replace(/\D/g, '').slice(-10);

/** Pure: the dialing-list names in a getListsInfo payload. */
export function dialListNames(listsInfo) {
  return (listsInfo?.lists || [])
    .map((l) => String(l?.name || '').trim())
    .filter((n) => n && !NON_DIAL_LIST_RX.test(n));
}

/**
 * Every outbound dialing list, live. Never throws: the removal is worth more
 * than its completeness, so a failed read falls back to the frozen floor and
 * says so in the log rather than failing the whole cleanup.
 * @returns {Promise<{names: string[], source: 'live'|'fallback', error: string|null}>}
 */
export async function resolveDisqualifiedFive9Lists(getListsInfo) {
  try {
    const read = getListsInfo || (await import('../../five9-admin.js')).getListsInfo;
    const names = dialListNames(await read());
    if (names.length) return { names, source: 'live', error: null };
    return { names: [...DISQUALIFIED_FIVE9_LISTS], source: 'fallback', error: 'live read returned no lists' };
  } catch (e) {
    console.warn(`[Disqualified] live Five9 list read failed (${e.message}); using the ${DISQUALIFIED_FIVE9_LISTS.length}-name fallback`);
    return { names: [...DISQUALIFIED_FIVE9_LISTS], source: 'fallback', error: e.message };
  }
}

/** Pure: the open estimate appointments among a contact's upcoming ones. */
export function openEstimateAppointments(upcoming) {
  return (Array.isArray(upcoming) ? upcoming : []).filter((a) =>
    ESTIMATE_POOL.has(a?.calendar_id) && !DEAD_STATUSES.has(String(a?.status || '').toLowerCase()));
}

/**
 * Pure: every row this cleanup queues.
 * @param {string[]} [five9Lists] resolved dialing-list names; the frozen
 *   fallback when a caller does not resolve them live.
 * @returns {object[]} agent_actions rows
 */
export function planDisqualifiedCleanup({ contactId, lead, appointments, tags, phone, workflowIds = {}, autoRemove, eventId = null, nowMs = Date.now(), five9Lists = DISQUALIFIED_FIVE9_LISTS, five9ListSource = 'fallback' }) {
  const disp = String(lead?.disposition_code || '').trim();
  // The prospect, never the lead id: this text is the approval card's reason (the user, 2026-10-16).
  const why = `LP ${prospectLabel(lead?.lp_prospect_id)} is ${disp} (disqualified)`;
  const rows = [];
  for (const appt of openEstimateAppointments(appointments)) {
    rows.push(...buildMarkInvalidRows({ contactId, appointmentId: appt.appointment_id, rule: DISQUALIFIED_RULE, why, eventId }));
  }
  const base = {
    event_id: eventId, target_system: 'ghl', target_entity: 'contact', target_id: contactId,
    rule_applied: DISQUALIFIED_RULE, status: 'pending', requires_approval: false, priority: 30,
  };
  const codes = workflowCodesToLeave(tags);
  const unresolved = [];
  for (const code of codes) {
    const workflowId = workflowIds[code];
    if (workflowId) {
      rows.push({ ...base, action_type: 'remove_from_workflow',
        action_payload: { workflow_id: workflowId, canonical_code: code, claim_key: `disqualified:${contactId}:${code}` },
        reasoning: `${why}: leaves ${code}` });
    } else unresolved.push(code);
  }
  if (unresolved.length) {
    rows.push({ ...base, action_type: 'remove_from_workflow',
      action_payload: { remove_all: true, claim_key: `disqualified:${contactId}:remove-all` },
      reasoning: `${why}: leaves ${unresolved.join(', ')} (Remove All Marketing; codes the registry cannot resolve)` });
  }
  const lowerTags = new Set((Array.isArray(tags) ? tags : []).map((t) => String(t).toLowerCase()));
  if (!lowerTags.has(DISQUALIFIED_TAG)) {
    rows.push({ ...base, action_type: 'add_tag', action_payload: { tag: DISQUALIFIED_TAG }, reasoning: `${why}: tag ${DISQUALIFIED_TAG}` });
  }
  rows.push({ ...base, action_type: 'move_opportunity', target_entity: 'opportunity',
    action_payload: { pipeline: 'P3', stage: 'Hard Disqualified', status: 'abandoned', claim_key: `disqualified:${contactId}:opp` },
    reasoning: `${why}: opportunity to P3 Hard Disqualified` });
  const ph = digits10(phone);
  if (ph.length === 10) {
    rows.push({
      event_id: eventId, action_type: 'five9_delete_record_from_list', target_system: 'five9', target_entity: 'list',
      target_id: contactId,
      action_payload: {
        list_names: [...five9Lists], field_names: ['number1'], values: [ph], list_delete_mode: 'DELETE_ALL',
        list_source: five9ListSource,
        phone: ph, contact_name: [lead?.first_name, lead?.last_name].filter(Boolean).join(' ') || null,
        lp_lead_id: lead?.lp_lead_id || null, lp_prospect_id: lead?.lp_prospect_id || null, reason: 'disqualified', disposition: disp,
        queued_at: new Date(nowMs).toISOString(),
      },
      reasoning: `${why}: a disqualified lead is never dialed again, so it comes off every outbound list. A list the number is not on is left as is.`,
      rule_applied: DISQUALIFIED_RULE, confidence: 1.0,
      status: autoRemove ? 'pending' : 'pending_approval', requires_approval: !autoRemove, priority: 70,
    });
  }
  return rows;
}

/**
 * The disqualified_cleanup action handler.
 * deps: { supabase, ghlFetch, fetchUpcomingAppointments, resolveWorkflowId, getListsInfo, env }
 */
export async function executeDisqualifiedCleanup(action, _context = {}, deps = {}) {
  const contactId = action.target_id;
  if (!contactId) throw new Error('disqualified_cleanup: missing target_id');
  const { data: lead, error } = await deps.supabase.from('lp_leads')
    .select('lp_lead_id, lp_prospect_id, disposition_code, first_name, last_name, phone')
    .eq('ghl_contact_id', contactId).is('lp_deleted_at', null)
    .order('created_at_lp', { ascending: false }).limit(1).maybeSingle();
  if (error) throw new Error(`disqualified_cleanup: lp_leads read failed: ${error.message}`);
  if (!lead || !isDisqualifiedDisposition(lead.disposition_code)) {
    return { action: 'disqualified_cleanup_skipped', reason: 'current_lead_not_disqualified', contact_id: contactId, disposition: lead?.disposition_code || null };
  }
  // Fail closed on the appointment read: invalidating blind could miss a live
  // reminder chain; the executor retries a throw.
  const upcoming = await deps.fetchUpcomingAppointments(contactId);
  if (!Array.isArray(upcoming)) throw new Error(`disqualified_cleanup: appointment lookup failed for ${contactId}`);
  const res = await deps.ghlFetch('GET', `/contacts/${contactId}`);
  const contact = res?.contact || res || {};
  const tags = contact.tags || [];
  const workflowIds = {};
  for (const code of workflowCodesToLeave(tags)) {
    try { workflowIds[code] = await deps.resolveWorkflowId?.(code); } catch { /* unresolved → remove_all */ }
  }
  // Live, at queue time: the approval card and the executor both read these
  // names, and a name Five9 has dropped fails the whole delete call.
  const five9 = await resolveDisqualifiedFive9Lists(deps.getListsInfo);
  const rows = planDisqualifiedCleanup({
    contactId, lead, appointments: upcoming, tags, phone: contact.phone || lead.phone, workflowIds,
    autoRemove: disqualifiedAutoRemove(deps.env || process.env), eventId: action.event_id ?? null,
    five9Lists: five9.names, five9ListSource: five9.source,
  });
  if (rows.length) {
    const { error: insErr } = await deps.supabase.from('agent_actions').insert(rows);
    if (insErr) throw new Error(`disqualified_cleanup: queue failed: ${insErr.message}`);
  }
  const invalidated = openEstimateAppointments(upcoming).map((a) => a.appointment_id);
  console.log(`[Disqualified] ${contactId} (LP ${lead.lp_lead_id}, ${lead.disposition_code}): queued ${rows.length} rows; invalid ${invalidated.join(', ') || 'none'}; five9 lists ${five9.names.length} (${five9.source})`);
  return {
    action: 'disqualified_cleanup_queued', contact_id: contactId, lp_lead_id: lead.lp_lead_id,
    disposition: lead.disposition_code, invalidated_appointments: invalidated, rows_queued: rows.length,
    five9_auto_remove: disqualifiedAutoRemove(deps.env || process.env),
    five9_lists: five9.names.length, five9_list_source: five9.source,
  };
}
