/**
 * Rehash call request → #contact-rehash — src/notifications/rehash-call.js
 *
 * 2026-10-01 (Mark): when a post-demo F.0 lead says yes to a call with the
 * rehash rep (or gives a time), the rep has to be told, or the reply's
 * "<rep> will call you" is a promise nobody keeps. One card in #contact-rehash
 * (C0C5YMHNYJH, SLACK_CHANNEL_REHASH) with who, when and how to reach them.
 * The contact-center channel was ruled out: it is crowded, and a call request
 * there gets lost.
 *
 * Slack is the destination of record here, not a mirror, so the card goes
 * through postToSlack (CLAUDE.md) and its failure is visible: one #ops-alerts
 * line. A lead who repeats "yes" the same day gets one card, not two — the
 * `agentic.f0_rehash_call_requested` event is the record. When that record
 * cannot be read, the card posts anyway: a duplicate card is a small
 * annoyance, a lost call request is a lost sale.
 *
 * Fail-soft: the reply already went out. Nothing here throws.
 */

import { formatRehashCallCard, rehashCallIdempotencyKey, rehashSlackChannel, ghlContactUrl } from '../agentic/rehash.js';

async function defaultDeps() {
  const [{ postToSlack }, { emitEvent }, { sendAlertMessage }, supabaseMod, { GHL_LOCATION_ID }] = await Promise.all([
    import('../slack.js'),
    import('../event-emitter.js'),
    import('../alert-state.js'),
    import('../supabase.js'),
    import('../actions/constants.js'),
  ]);
  const supabase = supabaseMod.default;
  return {
    postToSlack,
    emitEvent,
    opsAlert: (text) => sendAlertMessage(text, { channel: 'ops' }),
    locationId: GHL_LOCATION_ID,
    // true = already posted today, false = not yet, null = could not tell.
    alreadyRequested: async (key) => {
      if (!supabase) return null;
      const { data, error } = await supabase.from('system_events').select('id').eq('idempotency_key', key).maybeSingle();
      if (error) return null;
      return !!data;
    },
  };
}

/**
 * @param {object} args
 * @param {string} args.contactId
 * @param {object} args.generated   generateResponse() output (rehash, rehash_call)
 * @param {string} args.triggerMessage  the lead's message
 * @param {{firstName?, phone?, market?}} args.contact
 * @returns {Promise<{posted: boolean, reason: string}>}
 */
export async function notifyRehashCall({ contactId, generated, triggerMessage, contact = {} }, deps = null, { env = process.env, nowMs = Date.now() } = {}) {
  try {
    if (!generated?.rehash?.active) return { posted: false, reason: 'not_rehash' };
    if (!generated?.rehash_call?.agreed) return { posted: false, reason: 'no_call_agreed' };
    const d = deps || await defaultDeps();
    const key = rehashCallIdempotencyKey(contactId, nowMs);
    const seen = await Promise.resolve(d.alreadyRequested(key)).catch(() => null);
    if (seen === true) return { posted: false, reason: 'already_posted_today' };

    const channel = rehashSlackChannel(env);
    const card = formatRehashCallCard({
      firstName: contact.firstName || null,
      phone: contact.phone || null,
      market: contact.market || null,
      repName: generated.rehash.rep_name || null,
      preferredTime: generated.rehash_call.preferred_time || null,
      lastMessage: triggerMessage || null,
      contactUrl: d.locationId ? ghlContactUrl(d.locationId, contactId) : null,
    });
    const res = await d.postToSlack(card, channel);
    if (!res?.ok) {
      console.warn(`[RehashCall] card for ${contactId} NOT posted to ${channel}: ${res?.error || 'unknown'}`);
      await Promise.resolve(d.opsAlert(`🚨 REHASH CALL REQUEST NOT POSTED\nContact: ${contactId}\nSlack said: ${res?.error || 'unknown'} (channel ${channel})\n→ ${contact.firstName || 'A post-demo lead'} said yes to a call with the rehash rep. Someone needs to pass it on.${res?.error === 'not_in_channel' ? '\nFix: add the Reece Slack app to #contact-rehash.' : ''}`)).catch(() => {});
      return { posted: false, reason: `slack_${res?.error || 'failed'}` };
    }
    console.log(`[RehashCall] card for ${contactId} posted to ${channel} (ts ${res.ts})`);
    await Promise.resolve(d.emitEvent({
      event_type: 'agentic.f0_rehash_call_requested', source: 'send_message', entity_type: 'contact', entity_id: contactId,
      ghl_contact_id: contactId, priority: 'normal', bypass_filter: true, idempotency_key: key,
      payload: { contact_id: contactId, preferred_time: generated.rehash_call.preferred_time || null, rep_name: generated.rehash.rep_name || null, slack_ts: res.ts || null, inbound_preview: String(triggerMessage || '').slice(0, 300) },
    })).catch((err) => console.warn(`[RehashCall] event for ${contactId} not recorded: ${err.message}`));
    return { posted: true, reason: 'posted' };
  } catch (err) {
    console.warn(`[RehashCall] failed for ${contactId}: ${err.message}`);
    return { posted: false, reason: `error: ${err.message}` };
  }
}
