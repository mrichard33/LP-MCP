/**
 * Channel inference — src/channel-inference.js
 *
 * Single source of truth for deriving 'sms' | 'email' | 'livechat' | null from
 * a system_events row's payload. Reads payload.channel first (set by
 * message-analyzer v1.6+), then falls back to payload.message_type (GHL's
 * native field on ghl.reply_received). Returns null when neither resolves
 * cleanly, in which case the caller's template value wins.
 *
 * Lives in its own module (rather than in decision-engine.js, where it was
 * defined until 2026-08-13) because BOTH queue-time paths need it and they sit
 * on opposite sides of an import cycle:
 *
 *   decision-engine.createActionsFromRule   — the rule-template path
 *   actions/index.executeLayer3Dispatch     — the Layer 3 fan-out path
 *
 * decision-engine.js already imports actions/index.js (via the
 * action-executor.js shim), so importing decision-engine.js back from
 * actions/index.js would close a cycle. This module is pure and dependency-free,
 * so both can import it safely.
 *
 * Why both paths need it: the Layer 3 fan-out used to copy dispatch params
 * verbatim, and six layer3_action_dispatch rows hardcoded "channel": "sms".
 * Every email inbound classified follow_up_scheduled was therefore answered by
 * SMS — SMS-shaped, no subject, no signature (Andrea, 2026-08-12). Channel is
 * now stamped from the triggering event on both paths, by construction.
 */

/**
 * @param {{payload?: Record<string, any>}} event  a system_events row
 * @returns {'sms'|'email'|'livechat'|null}
 */
export function inferChannelFromEvent(event) {
  if (!event?.payload) return null;
  const explicit = event.payload.channel;
  if (typeof explicit === 'string') {
    const c = explicit.toLowerCase();
    if (c === 'sms' || c === 'email' || c === 'livechat') return c;
  }
  const mt = event.payload.message_type;
  if (typeof mt === 'string') {
    const m = mt.toLowerCase();
    if (m === 'sms' || m === 'email' || m === 'livechat') return m;
    if (m === 'type_sms') return 'sms';
    if (m === 'type_email') return 'email';
    // 2026-07-03 — livechat no longer collapses to null (which defaulted to
    // 'sms' at send time and answered widget chats over SMS, Steve Nkzhm
    // incident). The send handler inherits the final channel from the
    // inbound conversation; this keeps the payload signal honest.
    if (m === 'type_live_chat' || m === 'type_webchat' || m.includes('live_chat') || m.includes('livechat') || m.includes('webchat')) return 'livechat';
  }
  return null;
}
