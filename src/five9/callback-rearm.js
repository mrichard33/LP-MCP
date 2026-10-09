/**
 * Five9 callback re-arm — src/five9/callback-rearm.js
 *
 * A REPEAT callback request was never dialed (2026-10-09). David Strehlow
 * (Vz18oMtwqCb3FS1aRzsQ, CustID 463512) asked twice: the 10-08 push grew the
 * "Callback Request" list 59 → 60; the 10-09 push (agent_actions 563880) said
 * records_added: 1 and the list stayed 63 → 63. crmUpdateMode UPDATE_FIRST
 * updated the entry already there instead of adding one, so nothing was
 * marked call-now, and profile "Callback Request V2" rule 3 (Contact Record
 * Created newer than 48h) reads the Five9 contact's ORIGINAL create time,
 * which an update never moves. Every repeat requester aged out 48h after
 * their first record.
 *
 * Two parts:
 *   1. Before the add, remove the number's entry from the callback list, and
 *      only from that list, so the add is a fresh entry with call-now ANY.
 *      Five9 has no read for "is this number on this list" (a contact-DB read
 *      only shows f9_last_list, the last list that DIALED it), so the delete
 *      is the check: a number not on the list comes back listRecordsDeleted=0,
 *      a no-op. The delete runs to completion before the add is queued, never
 *      beside it: a delete that lands after the add removes the fresh entry.
 *   2. After the add, compare the list size Five9 reported before and after.
 *      No growth means the add updated an entry in place and the promised call
 *      is not armed. That is posted to #contact-center at once, not after the
 *      15-minute verify sweep.
 *
 * Only the list entry is removed. Contact-DB writes stay denied, and the
 * unarmed delete is welded to REARM_RULE_KEY on the callback list alone (see
 * execAutoApproved in src/actions/handlers/five9.js).
 */

import supabase from '../supabase.js';
import { callbackListName } from './callback-push.js';

/** rule_applied on the delete row. The executor's carve-out keys on it. */
export const REARM_RULE_KEY = 'LP_CALLBACK_REARM_FIVE9';

/** rule_applied on the add row lp-requeue queues (unchanged since 2026-09-04). */
export const CALLBACK_PUSH_RULE_KEY = 'LP_CALLBACK_REQUEUE_FIVE9';

/**
 * How long the delete row stays runnable. The inline run starts within
 * milliseconds of the insert; anything later is a deferred retry that could
 * land after the fresh add and remove it, so executeDeleteRecordFromList skips
 * it (approval_expires_at).
 */
const DELETE_STALE_MS = 30_000;

/**
 * The background executor must not claim the row while the inline run does
 * (same pattern as the DNC lift's runActionsNow rows). runActionsNow clears it.
 */
const BACKGROUND_HOLD_MS = 5 * 60_000;

/** Is this delete the callback re-arm, on the callback list and nothing else? Pure. */
export function isCallbackRearmDelete(action, listName = callbackListName()) {
  if (action?.action_type !== 'five9_delete_record_from_list') return false;
  if (action?.rule_applied !== REARM_RULE_KEY) return false;
  const p = action.action_payload || {};
  const lists = Array.isArray(p.list_names) && p.list_names.length
    ? p.list_names.map((l) => String(l || '').trim())
    : [String(p.list_name || '').trim()];
  const ours = String(listName || '').trim();
  // LP_ASAP is LP's own list: never an unarmed write of any kind, even if the
  // env var ever names it.
  if (!ours || ours.toUpperCase() === 'LP_ASAP') return false;
  return lists.length === 1 && lists[0] === ours;
}

/** The delete row: one number, the callback list only. Pure. */
export function buildRearmDeleteAction({ contactId, number1, listName, eventId = null, nowMs = Date.now() }) {
  return {
    event_id: eventId,
    action_type: 'five9_delete_record_from_list',
    target_system: 'five9',
    target_entity: 'list',
    target_id: String(contactId),
    action_payload: {
      list_name: listName,
      field_names: ['number1'],
      values: [number1],
      list_delete_mode: 'DELETE_ALL',
      approval_expires_at: new Date(nowMs + DELETE_STALE_MS).toISOString(),
      reason: 'callback_rearm',
    },
    reasoning:
      `Repeat callback request for ${contactId}: remove the number's existing "${listName}" entry so the push ` +
      `that follows is a fresh entry Five9 marks call-now. An add over an existing entry is an update that ` +
      `never dials (David Strehlow, 2026-10-09). List entry only; the contact record is untouched.`,
    rule_applied: REARM_RULE_KEY,
    confidence: 1.0,
    status: 'pending',
    requires_approval: false,
    priority: 90,
    retry_at: new Date(nowMs + BACKGROUND_HOLD_MS).toISOString(),
  };
}

/** listRecordsDeleted from the delete's execution result, or null. Pure. */
export function recordsDeletedFrom(run) {
  const r = run?.result || {};
  if (Number.isFinite(r.records_deleted)) return r.records_deleted;
  const hit = Array.isArray(r.per_list) ? r.per_list.find((p) => Number.isFinite(p?.deleted)) : null;
  return hit ? hit.deleted : null;
}

/**
 * Remove the number's entry from the callback list and WAIT for it.
 *
 * Never throws: the add goes out whatever happens here (a promised call beats
 * silence), and a delete that did not complete is cancelled first so it can
 * never run after the add. If the add then updates in place, the size check
 * after it raises the alert.
 *
 * @returns {Promise<{ delete_action_id: number|null, delete_status: string, records_deleted: number|null, error?: string }>}
 */
export async function rearmCallbackEntry({ contactId, number1, listName = callbackListName(), eventId = null, deps = {} }) {
  const db = deps.supabase || supabase;
  const runNow = deps.runActionsNow || (async (ids) => (await import('../actions/index.js')).runActionsNow(ids));
  let id = null;
  try {
    const { data, error } = await db.from('agent_actions')
      .insert(buildRearmDeleteAction({ contactId, number1, listName, eventId, nowMs: deps.nowMs ?? Date.now() }))
      .select('id').single();
    if (error) throw new Error(error.message);
    id = data?.id ?? null;
    if (id == null) throw new Error('insert returned no id');
  } catch (err) {
    console.warn(`[LP-REQUEUE] re-arm delete could not be queued for ${contactId}: ${err.message} — pushing without it`);
    return { delete_action_id: null, delete_status: 'not_queued', records_deleted: null, error: String(err.message || err) };
  }

  let run = null;
  try {
    [run] = await runNow([id]);
  } catch (err) {
    run = { status: 'failed', error: String(err.message || err) };
  }
  const status = run?.result?.skipped ? 'skipped' : String(run?.status || 'unknown');
  if (status === 'completed') {
    const deleted = recordsDeletedFrom(run);
    console.log(`[LP-REQUEUE] re-arm delete ${id} for ${contactId}: ${deleted === 0 ? 'not on' : `removed ${deleted ?? '?'} from`} "${listName}"`);
    return { delete_action_id: id, delete_status: 'completed', records_deleted: deleted };
  }

  // Deferred (write lock held), failed or skipped: cancel it before the add.
  // A retry that ran after the add would delete the fresh entry.
  try {
    await db.from('agent_actions')
      .update({ status: 'skipped', error_message: 'callback re-arm: did not complete before the add; cancelled so it never runs after it', retry_at: null, updated_at: new Date().toISOString() })
      .eq('id', id)
      .in('status', ['pending', 'failed']);
  } catch (err) {
    console.warn(`[LP-REQUEUE] could not cancel re-arm delete ${id}: ${err.message} (it expires on its own at approval_expires_at)`);
  }
  console.warn(`[LP-REQUEUE] re-arm delete ${id} for ${contactId} did not complete (${status}${run?.error ? `: ${run.error}` : ''}) — pushing anyway`);
  return { delete_action_id: id, delete_status: status, records_deleted: null, error: run?.error || run?.result?.reason || null };
}

/**
 * Did the add put a fresh, call-now entry on the list? Pure.
 *
 * The add reads the list size before and after itself, and it runs after the
 * delete, so "did not grow" means no new entry: Five9 updated one in place,
 * or the delete removed the entry and the add did not put it back. Either way
 * the call is not armed. Sizes Five9 did not report (dry run, a failed read)
 * are 'unknown': no alert on what we could not tell.
 */
export function rearmVerdict(addResult, rearm = null) {
  const before = addResult?.previous_state?.size;
  const after = addResult?.new_state?.size;
  const base = {
    size_before: Number.isFinite(before) ? before : null,
    size_after: Number.isFinite(after) ? after : null,
    delete_action_id: rearm?.delete_action_id ?? null,
    delete_status: rearm?.delete_status ?? null,
    records_deleted: rearm?.records_deleted ?? null,
  };
  if (addResult?.dry_run || !Number.isFinite(before) || !Number.isFinite(after)) return { status: 'unknown', ...base };
  return { status: after > before ? 'rearmed' : 'not_rearmed', ...base };
}

function fmtPhone(n) {
  const d = String(n || '').replace(/\D/g, '').slice(-10);
  return d.length === 10 ? `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}` : (n || 'unknown');
}

/** The #contact-center card. Pure. */
export function formatNotRearmedCard({ name, phone, contactId, listName, verdict, addActionId, locationId }) {
  const removed = (verdict?.records_deleted ?? 0) > 0;
  const lines = [
    '❌ CALLBACK NOT RE-ARMED — PROMISED CALL AT RISK',
    `Contact: ${name || 'name not on file'}`,
    `Phone: ${fmtPhone(phone)}`,
    `They asked for a call. The push to the Five9 "${listName}" list did not add a new entry ` +
      `(list size ${verdict?.size_before ?? '?'} → ${verdict?.size_after ?? '?'}), so Five9 will not dial it.` +
      (removed ? ' The old entry was removed first and was not put back.' : ' The number was already on the list.'),
    `Five9 action: ${addActionId ?? 'unknown'}${verdict?.delete_action_id ? ` (re-arm delete ${verdict.delete_action_id}: ${verdict.delete_status})` : ''}`,
    '→ Please call them now.',
  ];
  if (contactId) lines.push(`GHL: https://app.gohighlevel.com/v2/location/${locationId || 'SsBG7j5KQAIP1SFP2Sca'}/contacts/detail/${contactId}`);
  return lines.join('\n');
}

/**
 * Called by the Five9 write handler right after a callback push executes.
 * Returns the verdict (stored on the add row's execution_result) and, when the
 * call is not armed, posts the card at once. Never throws.
 */
export async function checkCallbackRearm(action, addResult, deps = {}) {
  try {
    if (action?.action_type !== 'five9_add_records_to_list' || action?.rule_applied !== CALLBACK_PUSH_RULE_KEY) return null;
    if (!addResult || addResult.deferred || addResult.skipped) return null;
    const p = action.action_payload || {};
    const verdict = rearmVerdict(addResult, p.rearm || null);
    if (verdict.status !== 'not_rearmed') {
      console.log(`[LP-REQUEUE] callback push ${action.id}: ${verdict.status} (list ${verdict.size_before ?? '?'} → ${verdict.size_after ?? '?'})`);
      return verdict;
    }

    const env = deps.env || process.env;
    const contactId = p.contact_id || null;
    const card = formatNotRearmedCard({
      name: p.contact_name, phone: p.number1, contactId, listName: p.list_name,
      verdict, addActionId: action.id, locationId: env.GHL_LOCATION_ID,
    });
    console.error(`[LP-REQUEUE] ⛔ callback push ${action.id} for ${contactId}: NOT re-armed (list ${verdict.size_before} → ${verdict.size_after})`);

    const emit = deps.emitEvent || (async (e) => (await import('../event-emitter.js')).emitEvent(e));
    await Promise.resolve(emit({
      event_type: 'lp.callback_not_rearmed',
      source: 'lp_mcp',
      entity_type: 'contact',
      entity_id: String(contactId || action.target_id || ''),
      ghl_contact_id: contactId,
      priority: 'high',
      payload: { five9_action_id: action.id ?? null, list: p.list_name, ...verdict },
      idempotency_key: action.id ? `lp_callback_not_rearmed_${action.id}` : null,
    })).catch(() => {});

    // A person must place the call: #contact-center, like the dial check's card.
    // No channel or a failed post falls back to #ops-alerts, never silence.
    const channel = String(env.SLACK_CHANNEL_SERVICE || '').trim();
    const post = deps.post || (async (text, id) => (await import('../slack.js')).postToSlack(text, id));
    const posted = channel
      ? await Promise.resolve(post(card, channel)).catch((err) => ({ ok: false, error: err.message }))
      : { ok: false, error: 'SLACK_CHANNEL_SERVICE unset' };
    let alerted = posted?.ok ? 'contact_center' : null;
    if (!posted?.ok) {
      const ops = deps.sendAlert || (async (text, o) => (await import('../alert-state.js')).sendAlertMessage(text, o));
      const out = await Promise.resolve(ops(`${card}\n(#contact-center post failed: ${posted?.error || 'unknown'})`, { channel: 'ops' })).catch(() => null);
      alerted = out?.sent ? 'ops' : 'none';
    }
    return { ...verdict, alerted };
  } catch (err) {
    console.warn(`[LP-REQUEUE] re-arm check failed for action ${action?.id}: ${err.message}`);
    return null;
  }
}

export default { rearmCallbackEntry, checkCallbackRearm, rearmVerdict, isCallbackRearmDelete };
