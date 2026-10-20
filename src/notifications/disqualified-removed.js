/**
 * The "taken off dialing" notice — src/notifications/disqualified-removed.js
 *
 * 2026-10-19 (the user): the ND / No Demo Five9 removal (rule
 * LP_DISP_DISQUALIFIED, src/actions/handlers/disqualified-cleanup.js) runs
 * without a click now. "The updates are occurring correctly each time. However,
 * still note that the status was ND and that it was automatically removed from
 * all dialing lists." So where the approval card used to post, ONE notice with
 * no buttons says what LP said and that the number is off every list.
 *
 * Posted only after the removal really ran (never a dry run, a deferral or a
 * skip) and only for an unarmed row: an approved card already shows its own
 * outcome. Never throws; a failed post is one #ops-alerts line.
 */

import { prospectLabel, slackPhone } from '../format-helpers.js';

export const DISQUALIFIED_RULE_KEY = 'LP_DISP_DISQUALIFIED';

/** True for a disqualified removal that ran without an approval. Pure. */
export function isAutoDisqualifiedRemoval(action) {
  return action?.action_type === 'five9_delete_record_from_list'
    && action?.rule_applied === DISQUALIFIED_RULE_KEY
    && action?.requires_approval !== true;
}

/** The notice text. Pure. */
export function formatDisqualifiedRemovedNotice(action, result) {
  const p = action?.action_payload || {};
  const disp = String(p.disposition || '').trim() || 'ND / No Demo';
  const name = String(p.contact_name || '').trim() || 'This lead';
  const perList = Array.isArray(result?.per_list) ? result.per_list : [];
  const removedFrom = perList.filter((l) => l.outcome === 'deleted').map((l) => `"${l.list}"`);
  const lists = (Array.isArray(p.list_names) ? p.list_names : []).map((l) => `"${l}"`);
  const detail = removedFrom.length
    ? `Removed from ${removedFrom.join(', ')}; it was not on the others.`
    : `It was not on any of them (${lists.join(', ')}), so nothing needed removing.`;
  const contact = [name === 'This lead' ? null : name, p.phone ? slackPhone(p.phone) : null, prospectLabel(p.lp_prospect_id)]
    .filter(Boolean).join(' · ');
  return [
    `✅ Done automatically${action?.id ? ` · #${action.id}` : ''} · LP ${disp} → disqualified, off every dialing list`,
    `What happened: ${name} was dispositioned "${disp}" in LP, so the lead is disqualified.`,
    `What we did: took ${p.phone ? slackPhone(p.phone) : 'the number'} off every Five9 dialing list. ${detail}`,
    'No action needed.',
    `Contact: ${contact}`,
    `ref: ${DISQUALIFIED_RULE_KEY}`,
  ].join('\n');
}

/**
 * Called by the Five9 write handler right after the op returns.
 * deps: { post(text, channelId), channel, sendAlert(text, opts) }
 * Returns { posted: 'approvals' | 'ops' | 'none' } or null when it does not apply.
 */
export async function noticeDisqualifiedRemoval(action, result, deps = {}) {
  try {
    if (!isAutoDisqualifiedRemoval(action)) return null;
    // Only a real removal: a dry run (FIVE9_WRITES_ENABLED off), a lock deferral
    // or an expired skip did not take anyone off a list.
    if (!result || result.deferred || result.skipped || result.record_deleted !== true) return null;
    const text = formatDisqualifiedRemovedNotice(action, result);
    const channel = deps.channel !== undefined
      ? deps.channel
      : (await import('../slack.js')).approvalsChannelId();
    const post = deps.post || (async (t, id) => (await import('../slack.js')).postToSlack(t, id));
    const out = channel
      ? await Promise.resolve(post(text, channel)).catch((err) => ({ ok: false, error: err.message }))
      : { ok: false, error: 'no approvals channel' };
    if (out?.ok) {
      console.log(`[Disqualified] action ${action.id ?? '?'}: off every Five9 list, notice posted`);
      return { posted: 'approvals' };
    }
    const ops = deps.sendAlert || (async (t, o) => (await import('../alert-state.js')).sendAlertMessage(t, o));
    const sent = await Promise.resolve(ops(`${text}\n(notice post failed: ${out?.error || 'unknown'})`, { channel: 'ops' })).catch(() => null);
    return { posted: sent?.sent ? 'ops' : 'none' };
  } catch (err) {
    console.warn(`[Disqualified] notice failed for action ${action?.id}: ${err.message}`);
    return null;
  }
}

export default { noticeDisqualifiedRemoval, formatDisqualifiedRemovedNotice, isAutoDisqualifiedRemoval };
