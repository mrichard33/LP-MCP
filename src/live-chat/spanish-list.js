/**
 * Spanish live-chat visitor → the Five9 Spanish list — src/live-chat/spanish-list.js
 *
 * 2026-10-19 ("Guest Visitor ugurs", P0TM5O8p0EmNJpXzgKig): a Spanish speaker
 * left a phone in the chat and nothing put the number in front of a Spanish
 * speaker on the dialer; the only trace was a Slack card. The user: the lead
 * "should also be added to our Spanish list in Five9".
 *
 * The list is a setting, `SPANISH_FIVE9_LIST` ("Spanish", built in Five9 on
 * 2026-10-19): unset = nothing is queued.
 *
 * It is a callback push (the user, 2026-10-19: the Spanish campaign runs the same
 * "Callback Request V3" profile, so "we should be sending the call back request
 * field and handling it the same way"). V3 dials on `callback_requested_at`
 * (requested in the last 48 hours), so a record without it never dials. The
 * FIRST push for a contact therefore does what lp-requeue's callback push does:
 *   1. Five9 DNC first (checkCallbackDnc): a DNC number is never dialed, so
 *      nothing is pushed and a person is asked to review a lift.
 *   2. Re-arm (rearmCallbackEntry): the number's old entry comes off THIS list
 *      and the run is awaited, so the add is a fresh call-now entry.
 *   3. The add carries callback_requested_at (Eastern wall clock) and call-now
 *      (callbackCallNowMode); checkCallbackRearm alerts #contact-center when the
 *      list did not grow.
 * A name that arrives after the first push is one more add with the name only:
 * no re-arm, no call-now, no new request time (UPDATE_FIRST puts it on the same
 * record without dialing again). Never for a contact the send gate blocks.
 */

import { mayMessage } from '../services/may-message.js';
import {
  formatFive9WriteDateTime,
  callbackCallNowMode,
  checkCallbackDnc,
  buildCallbackDncReviewAction,
} from '../five9/callback-push.js';

export const SPANISH_LIST_RULE = 'LIVE_CHAT_SPANISH_LIST';

/** The Five9 list name, or null when the push is off. */
export function spanishListName(env = process.env) {
  const v = String(env.SPANISH_FIVE9_LIST || '').trim();
  return v || null;
}

const phone10 = (p) => {
  const d = String(p || '').replace(/\D/g, '');
  const ten = d.length === 11 && d.startsWith('1') ? d.slice(1) : d;
  return ten.length === 10 ? ten : null;
};

/**
 * The agent_actions row, or null when there is no usable phone. Pure.
 * kind 'push' = the callback push; 'name_update' = the name only, onto the same record.
 */
export function buildSpanishListAction({ contactId, phone, firstName = null, lastName = null, listName, kind = 'push', lp = null, rearm = null, nowMs = Date.now() }) {
  const number1 = phone10(phone);
  if (!number1 || !listName) return null;
  const first = String(firstName || '').trim();
  const last = String(lastName || '').trim();
  const push = kind !== 'name_update';
  const requestedAt = push ? formatFive9WriteDateTime(nowMs) : null;
  const pairs = [
    ['number1', number1],
    ['first_name', first],
    ['last_name', last],
    // The screen pop opens LP by CustID when the lead is in LP already.
    ['CustID', push ? String(lp?.lp_prospect_id ?? '').trim() : ''],
    ['lead_id', push ? String(lp?.lp_lead_id ?? '').trim() : ''],
    ['call_ID', push ? String(contactId || '').trim() : ''],
    ['callback_requested_at', requestedAt || ''],
  ].filter(([, v]) => v !== '');
  const callNowMode = push ? callbackCallNowMode() : 'NONE';
  return {
    event_id: null,
    action_type: 'five9_add_records_to_list',
    target_system: 'five9',
    target_entity: 'list',
    target_id: listName,
    action_payload: {
      list_name: listName,
      field_names: pairs.map(([k]) => k),
      records: [pairs.map(([, v]) => v)],
      call_now_mode: callNowMode,
      // Read by checkCallbackRearm after the add runs (not sent to Five9).
      ...(push ? { rearm } : {}),
      contact_id: contactId,
      contact_name: [first, last].filter(Boolean).join(' ') || null,
      number1,
      spanish_key: `${contactId}:${first ? 'named' : 'unnamed'}`,
      kind,
      ...(requestedAt ? { callback_requested_at: requestedAt } : {}),
    },
    rollback_payload: { action_type: 'five9_delete_record_from_list', list_name: listName, field_names: ['number1'], values: [number1] },
    reasoning: push
      ? `Live chat: a Spanish-speaking visitor (${first || 'name not given yet'}, ${number1}) asked for help, so the number goes on "${listName}" as a callback request for a Spanish-speaking agent to call.`
      : `Live chat: the Spanish-speaking visitor at ${number1} gave their name (${first}); it goes onto the record already on "${listName}" without dialing again.`,
    rule_applied: SPANISH_LIST_RULE,
    confidence: 1.0,
    status: 'pending',
    requires_approval: false,
    priority: 75,
  };
}

/**
 * Queue the push. Best-effort: never throws.
 * deps: findExisting(spanishKey) → boolean, insertAction(row) → { id },
 *       checkDnc(number1) → { onDnc }, rearm({ contactId, number1, listName }),
 *       findLpLead(contactId) → { lp_prospect_id, lp_lead_id } | null (optional), env?, log?, nowMs?
 * @returns {Promise<{ queued: boolean, reason: string, kind?: string, actionId?: string }>}
 */
export async function queueSpanishList({ contactId, phone, firstName = null, lastName = null, tags = [] }, deps = {}) {
  const log = deps.log || ((m) => console.log(m));
  try {
    const listName = spanishListName(deps.env || process.env);
    if (!listName) return { queued: false, reason: 'no_list_configured' };
    const gate = mayMessage({ tags, channel: 'call', purpose: 'reply' });
    if (!gate.allowed) return { queued: false, reason: `send_gate:${gate.reason}` };
    const number1 = phone10(phone);
    if (!number1) return { queued: false, reason: 'no_phone' };

    const named = !!String(firstName || '').trim();
    if (named && await deps.findExisting(`${contactId}:named`)) return { queued: false, reason: 'already_queued' };
    const pushedBefore = await deps.findExisting(`${contactId}:unnamed`);
    if (pushedBefore && !named) return { queued: false, reason: 'already_queued' };

    if (pushedBefore) {
      const row = buildSpanishListAction({ contactId, phone: number1, firstName, lastName, listName, kind: 'name_update' });
      const res = await deps.insertAction(row);
      log(`[LiveChat] Spanish visitor ${contactId}: name added to the "${listName}" record (no re-dial)`);
      return { queued: true, reason: 'queued', kind: 'name_update', actionId: res?.id ?? null };
    }

    // The callback push: Five9 DNC first, then the re-arm, then the add.
    if (await deps.findExisting(`${contactId}:dnc`)) return { queued: false, reason: 'five9_dnc_review_already_requested' };
    const dnc = await (deps.checkDnc || ((n) => checkCallbackDnc(n)))(number1);
    if (dnc?.onDnc) {
      const review = buildCallbackDncReviewAction({ contactId, number1, reason: 'spanish_chat' });
      review.action_payload = { ...review.action_payload, spanish_key: `${contactId}:dnc` };
      await deps.insertAction(review);
      log(`[LiveChat] Spanish visitor ${contactId}: ${number1} is on Five9 DNC; nothing pushed, a lift review was asked for`);
      return { queued: false, reason: 'five9_dnc_review_requested' };
    }
    let lp = null;
    try { lp = deps.findLpLead ? await deps.findLpLead(contactId) : null; } catch { lp = null; }
    const rearm = deps.rearm
      ? await deps.rearm({ contactId, number1, listName })
      : await (await import('../five9/callback-rearm.js')).rearmCallbackEntry({ contactId, number1, listName });
    const row = buildSpanishListAction({ contactId, phone: number1, firstName, lastName, listName, kind: 'push', lp, rearm, nowMs: deps.nowMs ?? Date.now() });
    const res = await deps.insertAction(row);
    log(`[LiveChat] Spanish visitor ${contactId} queued for Five9 "${listName}" as a callback request (${row.action_payload.spanish_key}, re-arm ${rearm?.delete_status || 'none'})`);
    return { queued: true, reason: 'queued', kind: 'push', actionId: res?.id ?? null };
  } catch (err) {
    log(`[LiveChat] Spanish list queue failed for ${contactId}: ${err.message}`);
    return { queued: false, reason: `error: ${err.message}` };
  }
}
