/**
 * Channel Integrity Invariants — src/services/validation/invariants/channel-integrity.js
 *
 * Category: CHANNEL_INTEGRITY
 * Framework: Expert Secrets Redeemable Admission discipline + Traffic
 *            Secrets H/S/O fidelity.
 *
 * Core principle: A notification or message must not claim cross-channel
 * state that isn't true. The funnel earns belief through redeemable
 * admissions ("I thought the window was the whole answer. I was wrong"),
 * not omniscient pretense. The internal operator-facing channel (GroupMe)
 * must follow the same discipline.
 *
 * Doctrine reference: docs/ANTIFRAGILE_VALIDATION_GATE_DOCTRINE.md §
 * "Category 4 — CHANNEL_INTEGRITY".
 *
 * Each check returns { passed, reason?, context_snapshot? }.
 * Fail-open on infra errors.
 */

import supabase from '../../../supabase.js';

// ─── Shared helpers ────────────────────────────────────────────────────

/**
 * Look up the originating system_event for an action. Returns null on
 * error or missing row.
 */
async function loadSourceEvent(eventId) {
  if (!supabase || !eventId) return null;
  try {
    const { data, error } = await supabase
      .from('system_events')
      .select('id, event_type, event_subtype, payload')
      .eq('id', eventId)
      .maybeSingle();
    if (error || !data) return null;
    return data;
  } catch (e) {
    console.error(`[avg:channel-integrity] event load error: ${e.message}`);
    return null;
  }
}

/**
 * Inspect the event payload for a channel marker. GHL inbound events
 * include a `channel` or `messageType` field. Returns one of:
 *   'sms' | 'email' | 'call' | 'chat' | 'unknown'
 */
function detectChannel(eventPayload) {
  if (!eventPayload || typeof eventPayload !== 'object') return 'unknown';

  const explicit = String(
    eventPayload.channel ||
    eventPayload.messageChannel ||
    eventPayload.message_channel ||
    ''
  ).toLowerCase();
  if (explicit) {
    if (explicit.includes('sms') || explicit === 'text') return 'sms';
    if (explicit.includes('email')) return 'email';
    if (explicit.includes('call') || explicit === 'phone') return 'call';
    if (explicit.includes('chat') || explicit.includes('webchat')) return 'chat';
  }

  // messageType is the GHL convention: 'TYPE_SMS', 'TYPE_EMAIL', etc.
  const mtype = String(eventPayload.messageType || eventPayload.message_type || '').toUpperCase();
  if (mtype.includes('SMS')) return 'sms';
  if (mtype.includes('EMAIL')) return 'email';
  if (mtype.includes('CALL')) return 'call';
  if (mtype.includes('CHAT') || mtype.includes('WEBCHAT')) return 'chat';

  // Last-resort: presence of body+phone vs body+email in payload
  if (eventPayload.phone && !eventPayload.email && eventPayload.body) return 'sms';
  if (eventPayload.email && !eventPayload.phone && eventPayload.body) return 'email';

  return 'unknown';
}

/**
 * Returns the set of channel-mention words present in a notification's
 * message+narrative text. Lowercased substring match on common terms.
 */
function detectChannelMentions(text) {
  const t = String(text || '').toLowerCase();
  const mentions = new Set();
  if (/\b(sms|text(ed|ing)?|texts|texted)\b/.test(t)) mentions.add('sms');
  if (/\b(email|emails|emailed|emailing|inbox)\b/.test(t)) mentions.add('email');
  if (/\b(call(ed|ing)?|calls|phone(d)?|voicemail)\b/.test(t)) mentions.add('call');
  if (/\b(chat|webchat|live[ -]chat)\b/.test(t)) mentions.add('chat');
  return mentions;
}

// ═══════════════════════════════════════════════════════════════════════
// CI-1 — notification_channel_match (WARN in v2)
// ═══════════════════════════════════════════════════════════════════════
//
// send_notification action's message or narrative mentions a channel
// ("SMS", "email"). If the action was triggered by a contact event, the
// mentioned channel must match the channel the event came in on.
//
// Why: defends against the James Davis class of narrative drift, where
// the rep-facing notification claimed "DNC due to over-messaging on SMS"
// while the contact's last outbound from us was email. Naming the wrong
// channel erodes internal trust in the agentic layer's reasoning.
//
// Shipping as WARN because outbound history isn't snapshot-tracked yet
// (we'd need a recent_outbounds table) — we can only validate against
// the source event's channel, which is a narrower check.

export async function checkNotificationChannelMatch(action, ctx = {}) {
  if (action.action_type !== 'send_notification') {
    return { passed: true, reason: 'not_applicable' };
  }

  const payload = action.action_payload || {};
  const text = `${payload.message || ''}\n${payload.narrative || ''}\n${payload.next_step || ''}`;
  const mentions = detectChannelMentions(text);
  if (mentions.size === 0) {
    return { passed: true, reason: 'no_channel_mention' };
  }

  // No source event → cannot validate. Pass open.
  if (!action.event_id) return { passed: true, reason: 'no_source_event_open' };

  const event = await loadSourceEvent(action.event_id);
  if (!event) return { passed: true, reason: 'event_not_found_open' };

  const eventChannel = detectChannel(event.payload || {});
  if (eventChannel === 'unknown') {
    return { passed: true, reason: 'event_channel_unknown_open' };
  }

  // If the notification mentions ONLY the same channel as the event,
  // no drift. If it mentions a channel OTHER than the event's, that's
  // the failure pattern.
  if (mentions.has(eventChannel) && mentions.size === 1) {
    return { passed: true, reason: 'channel_match' };
  }

  const otherMentions = [...mentions].filter((m) => m !== eventChannel);
  if (otherMentions.length === 0) {
    return { passed: true, reason: 'only_event_channel_mentioned' };
  }

  return {
    passed: false,
    reason:
      `Notification text mentions channel(s) [${otherMentions.join(', ')}] but the ` +
      `triggering event came in on channel "${eventChannel}". Naming a channel that ` +
      `doesn't match the source event risks the James Davis class of internal narrative ` +
      `drift. Either correct the notification text or confirm the cross-channel claim ` +
      `is supported by other context.`,
    context_snapshot: {
      event_channel: eventChannel,
      event_id: event.id,
      event_type: event.event_type,
      mentions_in_notification: [...mentions],
      mismatched_mentions: otherMentions,
    },
  };
}

// ═══════════════════════════════════════════════════════════════════════
// CI-2 — dnc_narrative_matches_trigger (BLOCK)
// ═══════════════════════════════════════════════════════════════════════
//
// Actions queued from a `ghl.reply_received` event with subtype `dnc` —
// the notification narrative must not claim a channel other than the one
// the DNC reply arrived on.
//
// Why: same James Davis incident. The DNC narrative said "DNC due to
// over-messaging on SMS" when the triggering reply was on email. The
// channel attribution must come from the event payload, not from rule
// defaults that assume SMS.
//
// This is the BLOCK-severity twin of CI-1 because (a) DNC narratives are
// compliance-sensitive — naming the wrong channel can mislead the rep
// into reaching out on a channel that the contact actually opted into,
// and (b) the source event payload always contains the triggering channel.

export async function checkDncNarrativeMatchesTrigger(action, ctx = {}) {
  if (action.action_type !== 'send_notification') {
    return { passed: true, reason: 'not_applicable' };
  }

  if (!action.event_id) return { passed: true, reason: 'no_source_event_open' };

  const event = await loadSourceEvent(action.event_id);
  if (!event) return { passed: true, reason: 'event_not_found_open' };

  // Only applies to DNC-triggered notifications.
  const isDnc =
    event.event_subtype === 'dnc' ||
    String(event.event_type || '').toLowerCase().includes('dnc');
  if (!isDnc) return { passed: true, reason: 'not_dnc_event' };

  const eventChannel = detectChannel(event.payload || {});
  if (eventChannel === 'unknown') {
    return { passed: true, reason: 'event_channel_unknown_open' };
  }

  const payload = action.action_payload || {};
  const text = `${payload.message || ''}\n${payload.narrative || ''}`;
  const mentions = detectChannelMentions(text);
  const conflicting = [...mentions].filter((m) => m !== eventChannel);

  if (conflicting.length === 0) {
    return { passed: true, reason: 'no_channel_conflict' };
  }

  return {
    passed: false,
    reason:
      `DNC notification narrative claims channel(s) [${conflicting.join(', ')}] but ` +
      `the DNC reply came in on "${eventChannel}". Naming the wrong channel for a ` +
      `compliance event misleads the rep about which channel the contact opted out ` +
      `of (James Davis incident). Channel must come from event.payload, not from rule ` +
      `defaults.`,
    context_snapshot: {
      event_id: event.id,
      event_subtype: event.event_subtype,
      event_channel: eventChannel,
      narrative_mentions: [...mentions],
      conflicting_mentions: conflicting,
    },
  };
}

// ═══════════════════════════════════════════════════════════════════════
// CI-3 — send_message_channel_matches_trigger (WARN)
// ═══════════════════════════════════════════════════════════════════════
//
// CI-1 and CI-2 check what a notification SAYS about a channel. CI-3 checks
// the channel a reply is actually SENT ON — the outbound selection itself,
// which nothing validated until now.
//
// Why: for the 90 days to 2026-08-13 every email inbound owned by Layer 3
// was answered by SMS. executeLayer3Dispatch copied dispatch params verbatim
// and six layer3_action_dispatch rows hardcoded "channel": "sms", so the
// action was queued claiming SMS on an email thread — four
// follow_up_scheduled replies, most recently Andrea on 2026-08-12, who
// emailed "I will decide before Monday" and got a text back. The damage was
// not only delivery: send-message-handler gates the email prompt block and
// the email generation constraints on channel === 'email', so the reply was
// WRITTEN for the wrong surface too.
//
// That defect is fixed at the source — both queue paths now stamp the
// channel from the triggering event — so this invariant is a regression
// guard, not the fix. It exists so the next path that queues a send_message
// with a contradicting channel is visible immediately rather than after
// another 90 days of wrong-channel replies.
//
// SEVERITY IS WARN, DELIBERATELY. Do not "upgrade" this to BLOCK without
// reading this paragraph. The gate runs immediately before handler dispatch,
// and a BLOCK sets status='rejected_by_validation' — the reply is DROPPED.
// Silently dropping a lead's reply is the precise failure the always-respond
// policy exists to prevent ("A reply can be late; it must never vanish"), and
// it is strictly worse for the customer than a reply arriving on the wrong
// channel. A mismatch here means a new bug in the queueing path; it should
// page the operator, not silence the lead. CI-1 ships WARN for the same
// observe-before-blocking reason.
//
// Fails OPEN on every unknown: no source event, event not found, no channel
// resolvable from either side. Only an explicit, confident contradiction
// fails.

// detectChannel (shared with CI-1/CI-2) and the send path speak different
// vocabularies: detectChannel says 'chat', the send path says 'livechat'.
// Normalize to compare. Deliberately NOT refactored into one helper —
// detectChannel also emits 'call'/'unknown', which have no meaning as a
// send_message channel, and CI-1/CI-2 depend on its current vocabulary.
function normalizeChannelForComparison(channel) {
  const c = String(channel || '').toLowerCase();
  if (c === 'livechat' || c === 'chat' || c === 'webchat') return 'chat';
  if (c === 'sms' || c === 'text') return 'sms';
  if (c === 'email') return 'email';
  return null;
}

export async function checkSendMessageChannelMatchesTrigger(action, ctx = {}) {
  if (action.action_type !== 'send_message') {
    return { passed: true, reason: 'not_applicable' };
  }

  // No channel claimed → the send handler resolves it from the inbound
  // conversation, which is the correct behavior. Nothing to contradict.
  const payloadChannel = normalizeChannelForComparison(action.action_payload?.channel);
  if (!payloadChannel) return { passed: true, reason: 'no_payload_channel_open' };

  if (!action.event_id) return { passed: true, reason: 'no_source_event_open' };

  // ctx.sourceEvent lets the branch logic be exercised without a live DB
  // (same convention as decision-engine's optional deps object). Production
  // never passes it — validateAction only supplies priorBatchResults.
  const event = ctx.sourceEvent ?? await loadSourceEvent(action.event_id);
  if (!event) return { passed: true, reason: 'event_not_found_open' };

  const eventChannel = normalizeChannelForComparison(detectChannel(event.payload || {}));
  // 'call'/'unknown' normalize to null — a voice event says nothing about
  // which channel a follow-up message belongs on.
  if (!eventChannel) return { passed: true, reason: 'event_channel_unknown_open' };

  if (payloadChannel === eventChannel) {
    return { passed: true, reason: 'channel_matches_trigger' };
  }

  return {
    passed: false,
    reason:
      `send_message is queued on "${payloadChannel}" but the triggering event arrived on ` +
      `"${eventChannel}". A reply must go back on the channel the customer used. This also ` +
      `shapes the copy: the generator applies email formatting and the email thread context ` +
      `only when the channel is email, so a mis-stamped channel produces a reply written for ` +
      `the wrong surface (no subject, no signature). Channel must come from the source event, ` +
      `not from a rule or dispatch-row default.`,
    context_snapshot: {
      event_id: event.id,
      event_type: event.event_type,
      event_channel: eventChannel,
      payload_channel: payloadChannel,
      raw_payload_channel: action.action_payload?.channel ?? null,
      rule_applied: action.rule_applied || null,
    },
  };
}

// Exported for unit tests
export const __testing = {
  loadSourceEvent,
  detectChannel,
  detectChannelMentions,
  normalizeChannelForComparison,
};
