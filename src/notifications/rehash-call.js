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

import { formatRehashCallCard, rehashCallIdempotencyKey, rehashSlackChannel, ghlContactUrl, formatRehashQuoteCard, formatRehashConcernCard, formatRehashChangeCard, rehashReplyIdempotencyKey } from '../agentic/rehash.js';
import { classifyRehashReply, rehashIntentRoutingEnabled } from '../agentic/rehash-intent.js';
import { rehashOwnedMode } from '../agentic/rehash-owned.js';

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
export async function notifyRehashCall({ contactId, generated, triggerMessage, contact = {}, booked = null }, deps = null, { env = process.env, nowMs = Date.now() } = {}) {
  try {
    if (!generated?.rehash?.active) return { posted: false, reason: 'not_rehash' };
    // 2026-10-11: a call booked on Rehash Call (`booked`: { slot_label,
    // assignee_name }) is a yes too, whatever the model's rehash_call said.
    if (!booked && !generated?.rehash_call?.agreed) return { posted: false, reason: 'no_call_agreed' };
    const d = deps || await defaultDeps();
    // A booked call has its own key: an earlier "yes" card today must not hide it.
    const key = rehashCallIdempotencyKey(contactId, nowMs, { booked: !!booked });
    const seen = await Promise.resolve(d.alreadyRequested(key)).catch(() => null);
    if (seen === true) return { posted: false, reason: 'already_posted_today' };

    const channel = rehashSlackChannel(env);
    const card = formatRehashCallCard({
      firstName: contact.firstName || null,
      phone: contact.phone || null,
      market: contact.market || null,
      repName: generated.rehash.rep_name || null,
      preferredTime: generated.rehash_call?.preferred_time || null,
      bookedSlot: booked?.slot_label || null,
      assigneeName: booked?.assignee_name || null,
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
      payload: { contact_id: contactId, preferred_time: generated.rehash_call?.preferred_time || null, booked_slot: booked?.slot_label || null, booked_start: booked?.start_time || null, assignee_name: booked?.assignee_name || null, rep_name: generated.rehash.rep_name || null, slack_ts: res.ts || null, inbound_preview: String(triggerMessage || '').slice(0, 300) },
    })).catch((err) => console.warn(`[RehashCall] event for ${contactId} not recorded: ${err.message}`));
    return { posted: true, reason: 'posted' };
  } catch (err) {
    console.warn(`[RehashCall] failed for ${contactId}: ${err.message}`);
    return { posted: false, reason: `error: ${err.message}` };
  }
}

// ── 2026-10-14: the card follows what the lead actually said ─────────────────
// John Manieri (rehash team): "there are no answers on any of these bot call
// backs… most of these are not actual call backs, they're looking for emailed
// quotes the salespeople promised and never delivered." All 14 "said yes to a
// call" cards of 10-10..10-14 came from lp-requeue.js's rehash branch, which
// passed a hard-coded `agreed: true`; 0 of the 14 leads had agreed to a call.
// routeRehashReply classifies the lead's words (src/agentic/rehash-intent.js):
//   call_request  → the call card (same daily key as the model path, no double)
//   quote_request → 📄 QUOTE REQUEST
//   complaint     → ⚠️ POST-DEMO CONCERN
//   ack / not_now → no card; one `agentic.f0_rehash_reply_digest` event, listed
//                   in the 08:45 ET weekday digest (src/jobs/rehash-reply-digest.js)
// The model's own `rehash_call.agreed` (send-message-handler.js) still posts the
// call card on its own: that is the real "yes".

const REPLY_CARDS = {
  quote: {
    format: formatRehashQuoteCard,
    eventType: 'agentic.f0_rehash_quote_requested',
    title: 'REHASH QUOTE REQUEST',
    lost: (who) => `${who} asked for their quote. Someone needs to send it.`,
  },
  // 2026-10-23 (Kim Turko review): an owned lead asked to move or cancel.
  change: {
    format: formatRehashChangeCard,
    eventType: 'agentic.f0_rehash_change_requested',
    title: 'REHASH CALL CHANGE REQUEST',
    lost: (who) => `${who} asked to move or cancel their Rehash Call. Someone on the rehash team needs to reach out.`,
  },
  concern: {
    format: formatRehashConcernCard,
    eventType: 'agentic.f0_rehash_concern',
    title: 'POST-DEMO CONCERN',
    lost: (who) => `${who} sounds unhappy after the demo. Someone on the rehash team needs to reach out.`,
  },
};

async function postReplyCard(kind, { contactId, text, contact = {}, repName = null }, deps, { env, nowMs }) {
  const spec = REPLY_CARDS[kind];
  const d = deps || await defaultDeps();
  const key = rehashReplyIdempotencyKey(kind, contactId, nowMs);
  const seen = await Promise.resolve(d.alreadyRequested(key)).catch(() => null);
  if (seen === true) return { posted: false, reason: 'already_posted_today' };
  const channel = rehashSlackChannel(env);
  const card = spec.format({
    firstName: contact.firstName || null,
    phone: contact.phone || null,
    repName,
    lastMessage: text || null,
    contactUrl: d.locationId ? ghlContactUrl(d.locationId, contactId) : null,
  });
  const res = await d.postToSlack(card, channel);
  if (!res?.ok) {
    console.warn(`[RehashCall] ${kind} card for ${contactId} NOT posted to ${channel}: ${res?.error || 'unknown'}`);
    await Promise.resolve(d.opsAlert(`🚨 ${spec.title} NOT POSTED\nContact: ${contactId}\nSlack said: ${res?.error || 'unknown'} (channel ${channel})\n→ ${spec.lost(contact.firstName || 'A post-demo lead')}${res?.error === 'not_in_channel' ? '\nFix: add the Reece Slack app to #contact-rehash.' : ''}`)).catch(() => {});
    return { posted: false, reason: `slack_${res?.error || 'failed'}` };
  }
  console.log(`[RehashCall] ${kind} card for ${contactId} posted to ${channel} (ts ${res.ts})`);
  await Promise.resolve(d.emitEvent({
    event_type: spec.eventType, source: 'lp_requeue', entity_type: 'contact', entity_id: contactId,
    ghl_contact_id: contactId, priority: 'normal', bypass_filter: true, idempotency_key: key,
    payload: { contact_id: contactId, rep_name: repName, slack_ts: res.ts || null, inbound_preview: String(text || '').slice(0, 300) },
  })).catch((err) => console.warn(`[RehashCall] ${kind} event for ${contactId} not recorded: ${err.message}`));
  return { posted: true, reason: 'posted' };
}

/** 📄 QUOTE REQUEST → #contact-rehash. Fail-soft, never throws. */
export async function notifyRehashQuoteRequest(args, deps = null, { env = process.env, nowMs = Date.now() } = {}) {
  try { return await postReplyCard('quote', args, deps, { env, nowMs }); } catch (err) {
    console.warn(`[RehashCall] quote card failed for ${args?.contactId}: ${err.message}`);
    return { posted: false, reason: `error: ${err.message}` };
  }
}

/** 🔁 REHASH CALL CHANGE REQUEST → #contact-rehash. Fail-soft, never throws. */
export async function notifyRehashChangeRequest(args, deps = null, { env = process.env, nowMs = Date.now() } = {}) {
  try { return await postReplyCard('change', args, deps, { env, nowMs }); } catch (err) {
    console.warn(`[RehashCall] change card failed for ${args?.contactId}: ${err.message}`);
    return { posted: false, reason: `error: ${err.message}` };
  }
}

/** ⚠️ POST-DEMO CONCERN → #contact-rehash. Fail-soft, never throws. */
export async function notifyRehashConcern(args, deps = null, { env = process.env, nowMs = Date.now() } = {}) {
  try { return await postReplyCard('concern', args, deps, { env, nowMs }); } catch (err) {
    console.warn(`[RehashCall] concern card failed for ${args?.contactId}: ${err.message}`);
    return { posted: false, reason: `error: ${err.message}` };
  }
}

/**
 * Pick the rehash team's card for a rehash lead's reply, and send it.
 * @param {object} a
 * @param {string} a.contactId
 * @param {string} a.text          the lead's own words ('' when unreadable)
 * @param {string|null} [a.lastOutbound]  our last message (a bare "yes" needs a call offer)
 * @param {{firstName?, phone?}} [a.contact]
 * @param {string|null} [a.repName]
 * @param {string|null} [a.preferredTime]
 * @param {object|null} deps  { postToSlack, emitEvent, opsAlert, locationId, alreadyRequested }
 * @returns {Promise<{ rehash_card: 'call_request'|'quote_request'|'concern'|'digest'|'none', intent: string|null, reason: string }>}
 */
export async function routeRehashReply({ contactId, text = '', lastOutbound = null, contact = {}, repName = null, preferredTime = null }, deps = null, { env = process.env, nowMs = Date.now() } = {}) {
  const callCard = async (intent) => {
    const r = await notifyRehashCall({
      contactId,
      generated: { rehash: { active: true, rep_name: repName }, rehash_call: { agreed: true, preferred_time: preferredTime } },
      triggerMessage: text || null,
      contact,
    }, deps, { env, nowMs });
    return { rehash_card: 'call_request', intent, reason: r.reason };
  };
  try {
    // 2026-10-21 (Mark): John owns the lead (a Rehash Call booked, LP's visit
    // set, or the rehash-owned tag): he is already on it, so no card.
    if (rehashOwnedMode(env) === 'live') {
      const readOwned = deps?.readOwned || (async (id) => (await import('../services/rehash-gate-io.js')).readRehashOwnership(id));
      const owned = await readOwned(contactId).catch(() => null);
      if (owned?.owned === true) {
        console.log(`[RehashCall] ${contactId}: rehash-owned (${owned.reason}) — no card`);
        return { rehash_card: 'none', intent: null, reason: 'rehash_owned' };
      }
    }
    // The rollback: every rehash requeue posts the call card, as before 2026-10-14.
    if (!rehashIntentRoutingEnabled(env)) return await callCard(null);
    const said = String(text || '').trim();
    if (!said) {
      console.log(`[RehashCall] ${contactId}: no lead text to read — no card`);
      return { rehash_card: 'none', intent: null, reason: 'no_text' };
    }
    const intent = classifyRehashReply(said, { lastOutbound });
    if (intent === 'call_request') return await callCard(intent);
    if (intent === 'quote_request') {
      const r = await notifyRehashQuoteRequest({ contactId, text: said, contact, repName }, deps, { env, nowMs });
      return { rehash_card: 'quote_request', intent, reason: r.reason };
    }
    if (intent === 'complaint') {
      const r = await notifyRehashConcern({ contactId, text: said, contact, repName }, deps, { env, nowMs });
      return { rehash_card: 'concern', intent, reason: r.reason };
    }
    // ack / not_now: nobody needs to act now. One digest line tomorrow morning.
    const d = deps || await defaultDeps();
    const key = rehashReplyIdempotencyKey('digest', contactId, nowMs);
    await Promise.resolve(d.emitEvent({
      event_type: 'agentic.f0_rehash_reply_digest', source: 'lp_requeue', entity_type: 'contact', entity_id: contactId,
      ghl_contact_id: contactId, priority: 'low', bypass_filter: true, idempotency_key: key,
      payload: { contact_id: contactId, intent, first_name: contact.firstName || null, phone: contact.phone || null, inbound_preview: said.slice(0, 300) },
    })).catch((err) => console.warn(`[RehashCall] digest event for ${contactId} not recorded: ${err.message}`));
    console.log(`[RehashCall] ${contactId}: ${intent} — no card, listed in the morning digest`);
    return { rehash_card: 'digest', intent, reason: 'digest' };
  } catch (err) {
    console.warn(`[RehashCall] route failed for ${contactId}: ${err.message}`);
    return { rehash_card: 'none', intent: null, reason: `error: ${err.message}` };
  }
}
