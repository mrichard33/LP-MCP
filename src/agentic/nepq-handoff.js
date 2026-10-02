/**
 * NEPQ hand-off to a person — src/agentic/nepq-handoff.js
 *
 * 2026-10-02 (Mark): a person takes over when a lead complains, insists on a
 * price after one ask, says "no" twice, or repeats an objection. The bot's
 * reply (a fixed line from nepq-planner.js) says someone from our team will
 * reach out; this module makes that true. Same shape as the decision-maker
 * hand-off in send-message-handler.js: the sales callback tag (I.HDL-1 queues
 * the call), a rep note, one event, and an #ops-alerts card. The bot keeps
 * answering later messages: only an opt-out silences it (CLAUDE.md).
 *
 * Where the card goes (Mark, 2026-10-02): #contact-center (SLACK_CHANNEL_SERVICE)
 * for every hand-off, and #dispatch too for a complaint (a missed visit is
 * dispatch's to fix) or a time the bot could not book. Slack is the
 * destination of record, so a failed post is an #ops-alerts line, never
 * silent (CLAUDE.md: postToSlack, not the mirror).
 *
 * Fail-soft: every side effect lands independently; nothing here throws.
 * Idempotent per contact, reason and day through the event key; the tag and
 * the card are cheap to repeat but the event is the record.
 */

import { CALLBACK_TAG_SALES } from '../knowledge/callback-resolver.js';
import { GHL_LOCATION_ID } from '../actions/constants.js';

/** #dispatch's live channel; SLACK_CHANNEL_DISPATCH overrides (same default as the cancel cards). */
export const DISPATCH_CHANNEL_DEFAULT = 'C0C19GRS8FJ';
const DISPATCH_REASONS = new Set(['complaint', 'booking_request']);

/** The Slack channels a hand-off card goes to. Pure. */
export function handoffSlackChannels(reason, env = process.env) {
  const service = String(env.SLACK_CHANNEL_SERVICE || '').trim();
  const dispatch = String(env.SLACK_CHANNEL_DISPATCH || DISPATCH_CHANNEL_DEFAULT).trim();
  const out = [service ? { name: 'contact-center', id: service } : null];
  if (DISPATCH_REASONS.has(reason)) out.push(dispatch ? { name: 'dispatch', id: dispatch } : null);
  return out.filter(Boolean).filter((c, i, a) => a.findIndex(x => x.id === c.id) === i);
}

export const NEPQ_HANDOFF_TAG_PREFIX = 'nepq:handoff:';

const WHY = {
  complaint: 'The lead complained (often a missed visit). Reach out, listen first, and make it right.',
  price_insist: 'The lead asked for a price again after the bot explained every home is different. Call to talk it through; exact pricing comes from the visit.',
  two_nos: 'The lead said no twice. Check in once, personally; do not push.',
  repeat_objection: 'The lead raised the same objection again. Call so they get a straight answer.',
  booking_request: 'The lead picked a time in the website chat, but the bot could not book it (usually a missing address). Call to confirm the details and book that time.',
};

/** The rep note and the card body. Pure. */
export function formatNepqHandoff({ reason, channel, inbound, contactId, firstName }) {
  const who = firstName || 'A lead';
  return {
    note: `[AGENT TASK] ${who} needs a person (NEPQ hand-off: ${reason}).\nThey said: "${String(inbound || '').slice(0, 400)}"\n${WHY[reason] || ''}`,
    card: `🤝 A PERSON IS NEEDED (${reason.replace(/_/g, ' ')})\nContact: ${firstName || 'name not given yet'}\nChannel: ${channel === 'livechat' ? 'WEBSITE CHAT' : String(channel || 'sms').toUpperCase()}\nThey said: "${String(inbound || '').slice(0, 200)}"\n→ ${WHY[reason] || 'Needs a person.'} The bot told them someone from our team will reach out.\nGHL: https://app.gohighlevel.com/v2/location/${GHL_LOCATION_ID}/contacts/detail/${contactId}`,
  };
}

/**
 * @param {{contactId, reason, channel, inbound, firstName?, nowMs?}} args
 * @param {{applyTags, addNote, emitEvent, post?, opsAlert?, alert?, env?}} deps
 *   post(text, channelId) → {ok, error}: postToSlack. Without it, the card
 *   goes through deps.alert (the old #ops-alerts path).
 */
export async function routeNepqHandoff({ contactId, reason, channel, inbound, firstName = null, nowMs = Date.now() }, deps) {
  if (!contactId || !reason) return { routed: false };
  const { note, card } = formatNepqHandoff({ reason, channel, inbound, contactId, firstName });
  const day = new Date(nowMs).toISOString().slice(0, 10);
  const results = await Promise.allSettled([
    Promise.resolve().then(() => deps.applyTags(contactId, [CALLBACK_TAG_SALES, `${NEPQ_HANDOFF_TAG_PREFIX}${reason}`])),
    Promise.resolve().then(() => deps.addNote(contactId, note)),
    Promise.resolve().then(() => deps.emitEvent({
      event_type: 'agentic.nepq_handoff', source: 'nepq_backbone', entity_type: 'contact', entity_id: contactId, ghl_contact_id: contactId,
      priority: 'high', bypass_filter: true, idempotency_key: `nepq_handoff_${contactId}_${reason}_${day}`,
      payload: { contact_id: contactId, reason, channel, inbound_preview: String(inbound || '').slice(0, 300) },
    })),
    Promise.resolve().then(() => postCard({ card, reason, contactId }, deps)),
  ]);
  const failed = results.filter(r => r.status === 'rejected');
  for (const f of failed) console.warn(`[NepqHandoff] side effect failed for ${contactId} (${reason}): ${f.reason?.message || f.reason}`);
  return { routed: true, failed: failed.length };
}

/** The card to #contact-center (and #dispatch); a failed post is an #ops-alerts line. */
async function postCard({ card, reason, contactId }, deps) {
  if (!deps.post) return deps.alert?.(card);
  const channels = handoffSlackChannels(reason, deps.env || process.env);
  if (!channels.length) {
    await deps.opsAlert?.(`🚨 HAND-OFF CARD HAS NO CHANNEL (SLACK_CHANNEL_SERVICE unset)\n\n${card}`);
    return;
  }
  for (const ch of channels) {
    const res = await Promise.resolve(deps.post(card, ch.id)).catch(err => ({ ok: false, error: err.message }));
    if (res?.ok) { console.log(`[NepqHandoff] ${contactId} (${reason}) card posted to #${ch.name}`); continue; }
    console.warn(`[NepqHandoff] ${contactId} (${reason}) card NOT posted to #${ch.name}: ${res?.error || 'unknown'}`);
    await Promise.resolve(deps.opsAlert?.(`🚨 HAND-OFF CARD NOT POSTED TO #${ch.name}\nSlack said: ${res?.error || 'unknown'}${res?.error === 'not_in_channel' ? `\nFix: add the Reece Slack app to #${ch.name}.` : ''}\n\n${card}`)).catch(() => {});
  }
}
