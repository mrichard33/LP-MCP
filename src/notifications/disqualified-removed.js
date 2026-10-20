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
 * outcome. One per lead, after its last chunk (2026-10-20). Never throws; a
 * failed post is one #ops-alerts line.
 */

import { prospectLabel, slackPhone } from '../format-helpers.js';

export const DISQUALIFIED_RULE_KEY = 'LP_DISP_DISQUALIFIED';

/** True for a disqualified removal that ran without an approval. Pure. */
export function isAutoDisqualifiedRemoval(action) {
  return action?.action_type === 'five9_delete_record_from_list'
    && action?.rule_applied === DISQUALIFIED_RULE_KEY
    && action?.requires_approval !== true;
}

/** The notice text. Pure. `result.per_list` holds every chunk's lists for a split removal. */
export function formatDisqualifiedRemovedNotice(action, result) {
  const p = action?.action_payload || {};
  const disp = String(p.disposition || '').trim() || 'ND / No Demo';
  const name = String(p.contact_name || '').trim() || 'This lead';
  const perList = Array.isArray(result?.per_list) ? result.per_list : [];
  const removedFrom = perList.filter((l) => l.outcome === 'deleted').map((l) => `"${l.list}"`);
  const checked = perList.filter((l) => l.outcome !== 'list_missing').length;
  const others = checked - removedFrom.length;
  const detail = removedFrom.length
    ? `Removed from ${removedFrom.join(', ')}${others > 0 ? `; it was not on the other ${others} list${others === 1 ? '' : 's'}` : ''}.`
    : `It was not on any of the ${checked} lists, so nothing needed removing.`;
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

export const NOTICE_AUDIT = 'disqualified_five9_notice';

// 2026-10-20 — the removal is split into rows of 10 lists (src/actions/handlers/
// disqualified-cleanup.js). The lead gets ONE notice: the chunk that finishes
// last (every sibling already completed) posts it with all chunks' lists. Five9
// writes run one at a time under the write lock, so the siblings' rows are
// settled by then. A sibling that failed means no notice; the 08:00 digest
// names the failure instead.
async function defaultReadGroup(group, selfId) {
  const supabase = (await import('../supabase.js')).default;
  let q = supabase.from('agent_actions').select('id, status, execution_result')
    .eq('action_type', 'five9_delete_record_from_list').eq('rule_applied', DISQUALIFIED_RULE_KEY)
    .eq('action_payload->>group', group);
  if (selfId != null) q = q.neq('id', selfId);
  const { data, error } = await q;
  if (error) throw new Error(error.message);
  return data || [];
}

/**
 * Called by the Five9 write handler right after the op returns.
 * deps: { post(text, channelId), channel, sendAlert(text, opts), readGroup(group, selfId), filterNew, recordPosted }
 * Returns { posted: 'approvals' | 'ops' | 'none' | 'waiting' | 'already' } or null when it does not apply.
 */
export async function noticeDisqualifiedRemoval(action, result, deps = {}) {
  try {
    if (!isAutoDisqualifiedRemoval(action)) return null;
    // Only a real removal: a dry run (FIVE9_WRITES_ENABLED off), a lock deferral
    // or an expired skip did not take anyone off a list.
    if (!result || result.deferred || result.skipped || result.record_deleted !== true) return null;
    const p = action.action_payload || {};
    let combined = result;
    const group = typeof p.group === 'string' && p.group ? p.group : null;
    if (group && Number(p.chunk?.of) > 1) {
      const siblings = await (deps.readGroup || defaultReadGroup)(group, action.id ?? null);
      if (siblings.some((r) => r.status !== 'completed')) return { posted: 'waiting' };
      combined = { ...result, per_list: [...siblings.flatMap((r) => r.execution_result?.per_list || []), ...(result.per_list || [])] };
    }
    const key = group || String(action.id ?? '');
    const items = [{ key, reason: 'posted' }];
    const filterNew = deps.filterNew || (async (o) => (await import('../alert-posted.js')).filterNew(o));
    const recordPosted = deps.recordPosted || (async (o) => (await import('../alert-posted.js')).recordPosted(o));
    if (key) {
      const { fresh } = await filterNew({ audit: NOTICE_AUDIT, items, ttlDays: 30 });
      if (!fresh.length) return { posted: 'already' };
    }
    const text = formatDisqualifiedRemovedNotice(action, combined);
    const channel = deps.channel !== undefined
      ? deps.channel
      : (await import('../slack.js')).approvalsChannelId();
    const post = deps.post || (async (t, id) => (await import('../slack.js')).postToSlack(t, id));
    const out = channel
      ? await Promise.resolve(post(text, channel)).catch((err) => ({ ok: false, error: err.message }))
      : { ok: false, error: 'no approvals channel' };
    if (out?.ok) {
      if (key) await recordPosted({ audit: NOTICE_AUDIT, items, permanent: true });
      console.log(`[Disqualified] action ${action.id ?? '?'}: off every Five9 list, notice posted`);
      return { posted: 'approvals' };
    }
    const ops = deps.sendAlert || (async (t, o) => (await import('../alert-state.js')).sendAlertMessage(t, o));
    const sent = await Promise.resolve(ops(`${text}\n(notice post failed: ${out?.error || 'unknown'})`, { channel: 'ops' })).catch(() => null);
    if (sent?.sent && key) await recordPosted({ audit: NOTICE_AUDIT, items, permanent: true });
    return { posted: sent?.sent ? 'ops' : 'none' };
  } catch (err) {
    console.warn(`[Disqualified] notice failed for action ${action?.id}: ${err.message}`);
    return null;
  }
}

export default { noticeDisqualifiedRemoval, formatDisqualifiedRemovedNotice, isAutoDisqualifiedRemoval };
