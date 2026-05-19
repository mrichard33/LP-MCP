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

// Exported for unit tests
export const __testing = {
  loadSourceEvent,
  detectChannel,
  detectChannelMentions,
};
