/**
 * Spanish live-chat visitor → the Five9 Spanish list — src/live-chat/spanish-list.js
 *
 * 2026-10-19 ("Guest Visitor ugurs", P0TM5O8p0EmNJpXzgKig): a Spanish speaker
 * left a phone in the chat and nothing put the number in front of a Spanish
 * speaker on the dialer; the only trace was a Slack card. The user: the lead
 * "should also be added to our Spanish list in Five9".
 *
 * Five9 has a "Spanish" skill but, on 2026-10-19, no Spanish list or campaign
 * (agents' "Spanish - Send data to Spanish list" disposition only stops the
 * dial). So the list is a setting, `SPANISH_FIVE9_LIST`: unset = nothing is
 * queued. Set it to the list's exact Five9 name once the list exists and a
 * campaign with the Spanish skill dials it.
 *
 * One five9_add_records_to_list row (the auto-approved add carve-out, #1057;
 * still behind FIVE9_WRITES_ENABLED) per contact once the phone is known, and
 * one more when the name arrives later: Five9's UPDATE_FIRST then puts the name
 * on the same record. Keyed on number1. Never for a contact the send gate
 * blocks (an opt-out or stop-bot).
 */

import { mayMessage } from '../services/may-message.js';

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

/** The agent_actions row, or null when there is no usable phone. Pure. */
export function buildSpanishListAction({ contactId, phone, firstName = null, listName }) {
  const number1 = phone10(phone);
  if (!number1 || !listName) return null;
  const first = String(firstName || '').trim();
  const pairs = [['number1', number1], ['first_name', first]].filter(([, v]) => v !== '');
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
      contact_id: contactId,
      spanish_key: `${contactId}:${first ? 'named' : 'unnamed'}`,
    },
    rollback_payload: { action_type: 'five9_delete_record_from_list', list_name: listName, field_names: ['number1'], values: [number1] },
    reasoning: `Live chat: a Spanish-speaking visitor (${first || 'name not given yet'}, ${number1}) asked for help, so the number goes on "${listName}" for a Spanish-speaking agent to call.`,
    rule_applied: SPANISH_LIST_RULE,
    confidence: 1.0,
    status: 'pending',
    requires_approval: false,
    priority: 75,
  };
}

/**
 * Queue the add. Best-effort: never throws.
 * deps: findExisting(spanishKey) → boolean, insertAction(row) → { id }, env?, log?
 * @returns {Promise<{ queued: boolean, reason: string, actionId?: string }>}
 */
export async function queueSpanishList({ contactId, phone, firstName = null, tags = [] }, deps = {}) {
  const log = deps.log || ((m) => console.log(m));
  try {
    const listName = spanishListName(deps.env || process.env);
    if (!listName) return { queued: false, reason: 'no_list_configured' };
    const gate = mayMessage({ tags, channel: 'call', purpose: 'reply' });
    if (!gate.allowed) return { queued: false, reason: `send_gate:${gate.reason}` };
    const row = buildSpanishListAction({ contactId, phone, firstName, listName });
    if (!row) return { queued: false, reason: 'no_phone' };
    if (await deps.findExisting(row.action_payload.spanish_key)) return { queued: false, reason: 'already_queued' };
    const res = await deps.insertAction(row);
    log(`[LiveChat] Spanish visitor ${contactId} queued for Five9 "${listName}" (${row.action_payload.spanish_key})`);
    return { queued: true, reason: 'queued', actionId: res?.id ?? null };
  } catch (err) {
    log(`[LiveChat] Spanish list queue failed for ${contactId}: ${err.message}`);
    return { queued: false, reason: `error: ${err.message}` };
  }
}
