/**
 * src/agentic/burst-yield.js
 *
 * 2026-10-02 (Mark): "when a lead rapidly fires multiple messages
 * consecutively, the bot responds to each message. The reply should actually
 * be combined." The SMS reply buffer (REPLY_DEBOUNCE_MS, behavioral-emitter.js)
 * combines messages that land inside its window, but a message that lands
 * after the window fired starts its own buffer, analysis and reply job. The
 * old send-time yield only looked when GHL's thread already showed the newer
 * message (GHL lags 30-60s) and compared against the analysis event's time,
 * which is ~35s after the batch, so both replies went out.
 *
 * This answers one question from our own event log: did the lead send a
 * newer message, after the last one this reply answers, that has its OWN
 * reply job coming? If so this draft is not sent; that job reads the whole
 * thread (everything since our last reply) and answers all of it.
 *
 * Never yields to:
 *   - a `trivial` event (no job is coming for it: behavioral-emitter's
 *     non-owned trivial path), or a bare acknowledgement ("ok", "thanks"),
 *     which may well get no reply and would leave the real question unanswered;
 *   - a retry of a message already in this batch (same message id).
 * Fails open: an error or a missing boundary returns null (send as before).
 *
 * 2026-10-03 (Mark: "the bot stopped responding … this cannot ever happen").
 * "Well we have hurricane shutters now." got no reply: this check dropped the
 * draft for a "newer" message that was the lead's "Huh?" from four minutes
 * EARLIER. The boundary was read as Number(payload.last_inbound_event_id), and
 * Number(null) is 0, a finite number, so the query became "any reply with
 * id > 0" and the oldest real message in the thread won. The boundary is null
 * whenever the analysis came from routePendingReply or the pending-replies
 * poller rather than the reply buffer. Both now carry it (inboundFromReplyEvent
 * below), and a boundary is only ever a positive id or a real timestamp; with
 * none, the reply is sent. The reply SLA watchdog (3 min) is the backstop.
 */

import { normalizeText } from './missed-inbound.js';

const ACK_ONLY_RX = /^\s*(?:ok(?:ay)?|k|kk|thanks?(?:\s+you)?|thx|ty|cool|great|lol|ha(?:ha)?|👍|🙏|\.)\s*[.!]*\s*$/i;

/**
 * @param {object} args
 * @param {string} args.contactId
 * @param {object} args.payload  the ai.analysis_completed payload
 * @param {object} deps          { supabase }
 * @returns {Promise<{ id, message_text } | null>}
 */
export async function findNewerInbound({ contactId, payload = {} } = {}, deps = {}) {
  // A positive id or a real timestamp, never Number(null) === 0 (see header).
  const lastId = positiveId(payload?.last_inbound_event_id) ?? positiveId(payload?.inbound_event_id);
  const lastAt = validIso(payload?.last_inbound_event_created_at) ?? validIso(payload?.inbound_event_created_at);
  const ownId = positiveId(payload?.inbound_event_id);
  if (!contactId || !deps.supabase || (lastId == null && lastAt == null)) return null;
  const batchKeys = new Set((Array.isArray(payload?.inbound_message_keys) ? payload.inbound_message_keys : []).map(String));
  if (payload?.message_id) batchKeys.add(String(payload.message_id));
  try {
    let q = deps.supabase
      .from('system_events')
      .select('id, event_subtype, created_at, payload')
      .eq('ghl_contact_id', contactId)
      .eq('event_type', 'ghl.reply_received');
    q = lastId != null ? q.gt('id', lastId) : q.gt('created_at', lastAt);
    const { data, error } = await q.order('id', { ascending: true }).limit(10);
    if (error || !Array.isArray(data)) return null;
    const hit = data.find((e) => {
      if (String(e?.event_subtype || '').toLowerCase() === 'trivial') return false;
      const text = String(e?.payload?.message_text || '').trim();
      if (!text || ACK_ONLY_RX.test(text)) return false;
      // The message this reply answers, or anything before it, is never newer.
      if (ownId != null && Number(e?.id) <= ownId) return false;
      const mid = e?.payload?.message_id;
      return !(mid && batchKeys.has(String(mid)));
    });
    return hit ? { id: hit.id, message_text: String(hit.payload?.message_text || '').slice(0, 200) } : null;
  } catch {
    return null;
  }
}

/**
 * 2026-10-17 (Shawn Eastman, refs 590695 @14:06 and 590865 @14:17): ONE text
 * of his reached us as two ghl.reply_received events whose bodies differed only
 * by "\\n\\n" vs a real newline, and each got its own, different reply. The
 * message_ref dedupe cannot see it (two refs). This answers: did an EARLIER
 * inbound from this contact, in the last 15 minutes, carry the same text once
 * normalized (normalizeText: escapes and whitespace read as spaces, lowercase),
 * and has a reply (send_message, any live status, not this action) already
 * been queued or sent after it? Then this reply is a duplicate.
 * Fails open: an error, no text or no boundary returns null (send as before).
 *
 * @param {{ contactId: string, payload: object, actionId?: string|number }} args
 * @param {{ supabase: object, nowMs?: number }} deps
 * @returns {Promise<{ earlier_event_id, answered_by_action_id } | null>}
 */
export async function findAnsweredDuplicateInbound({ contactId, payload = {}, actionId = null } = {}, deps = {}) {
  const text = normalizeText(payload?.message_text);
  const ownId = positiveId(payload?.inbound_event_id) ?? positiveId(payload?.last_inbound_event_id);
  const ownAt = validIso(payload?.inbound_event_created_at) ?? validIso(payload?.last_inbound_event_created_at);
  if (!contactId || !deps.supabase || !text || (ownId == null && ownAt == null)) return null;
  const batchKeys = new Set((Array.isArray(payload?.inbound_message_keys) ? payload.inbound_message_keys : []).map(String));
  if (payload?.message_id) batchKeys.add(String(payload.message_id));
  const nowMs = Number.isFinite(deps.nowMs) ? deps.nowMs : Date.now();
  const since = new Date((ownAt ? Date.parse(ownAt) : nowMs) - DUPLICATE_WINDOW_MS).toISOString();
  try {
    let q = deps.supabase
      .from('system_events')
      .select('id, created_at, payload')
      .eq('ghl_contact_id', contactId)
      .eq('event_type', 'ghl.reply_received')
      .gte('created_at', since);
    q = ownId != null ? q.lt('id', ownId) : q.lt('created_at', ownAt);
    const { data, error } = await q.order('id', { ascending: false }).limit(20);
    if (error || !Array.isArray(data)) return null;
    const earlier = data.find((e) => {
      const mid = e?.payload?.message_id;
      if (mid && batchKeys.has(String(mid))) return false;
      return normalizeText(e?.payload?.message_text) === text;
    });
    if (!earlier?.created_at) return null;
    let a = deps.supabase
      .from('agent_actions')
      .select('id, status, created_at')
      .eq('target_id', contactId)
      .eq('action_type', 'send_message')
      .in('status', ['pending', 'approved', 'executing', 'completed'])
      .gt('created_at', earlier.created_at);
    if (actionId != null) a = a.neq('id', actionId);
    const { data: sends, error: sendErr } = await a.order('created_at', { ascending: true }).limit(1);
    if (sendErr || !Array.isArray(sends) || !sends.length) return null;
    return { earlier_event_id: earlier.id, answered_by_action_id: sends[0].id };
  } catch {
    return null;
  }
}

const DUPLICATE_WINDOW_MS = 15 * 60 * 1000;

function positiveId(v) {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? n : null;
}

function validIso(v) {
  if (typeof v !== 'string' || !v.trim()) return null;
  return Number.isFinite(Date.parse(v)) ? v : null;
}

/**
 * The `inbound` object analyzeMessage carries onto ai.analysis_completed, for
 * ONE ghl.reply_received event (routePendingReply and the pending-replies
 * poller). The reply buffer builds the multi-message version itself
 * (behavioral-emitter.js). Without last_event_id the yield above had no
 * boundary (2026-10-03).
 */
export function inboundFromReplyEvent(event) {
  if (!event) return null;
  const key = event.payload?.message_id || null;
  return {
    event_id: event.id ?? null,
    received_at: event.payload?.inbound_at || null,
    webhook_received_at: event.payload?.webhook_received_at || null,
    event_created_at: event.created_at || null,
    last_event_id: event.id ?? null,
    last_event_created_at: event.created_at || null,
    message_keys: key ? [key] : [],
  };
}
