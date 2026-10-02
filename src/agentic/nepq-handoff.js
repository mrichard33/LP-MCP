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
 * Fail-soft: every side effect lands independently; nothing here throws.
 * Idempotent per contact, reason and day through the event key; the tag and
 * the card are cheap to repeat but the event is the record.
 */

import { CALLBACK_TAG_SALES } from '../knowledge/callback-resolver.js';

export const NEPQ_HANDOFF_TAG_PREFIX = 'nepq:handoff:';

const WHY = {
  complaint: 'The lead complained. Reach out, listen first, and make it right.',
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
    card: `🤝 NEPQ HAND-OFF (${reason.replace(/_/g, ' ')})\nContact: ${contactId}\nChannel: ${String(channel || 'sms').toUpperCase()}\nThey said: "${String(inbound || '').slice(0, 200)}"\n→ ${WHY[reason] || 'Needs a person.'} The bot told them someone from our team will reach out.`,
  };
}

/**
 * @param {{contactId, reason, channel, inbound, firstName?, nowMs?}} args
 * @param {{applyTags, addNote, emitEvent, alert}} deps
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
    Promise.resolve().then(() => deps.alert(card)),
  ]);
  const failed = results.filter(r => r.status === 'rejected');
  for (const f of failed) console.warn(`[NepqHandoff] side effect failed for ${contactId} (${reason}): ${f.reason?.message || f.reason}`);
  return { routed: true, failed: failed.length };
}
