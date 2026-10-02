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
 */

const ACK_ONLY_RX = /^\s*(?:ok(?:ay)?|k|kk|thanks?(?:\s+you)?|thx|ty|cool|great|lol|ha(?:ha)?|👍|🙏|\.)\s*[.!]*\s*$/i;

/**
 * @param {object} args
 * @param {string} args.contactId
 * @param {object} args.payload  the ai.analysis_completed payload
 * @param {object} deps          { supabase }
 * @returns {Promise<{ id, message_text } | null>}
 */
export async function findNewerInbound({ contactId, payload = {} } = {}, deps = {}) {
  const lastId = Number(payload?.last_inbound_event_id);
  const lastAt = payload?.last_inbound_event_created_at || null;
  if (!contactId || !deps.supabase || (!Number.isFinite(lastId) && !lastAt)) return null;
  const batchKeys = new Set((Array.isArray(payload?.inbound_message_keys) ? payload.inbound_message_keys : []).map(String));
  if (payload?.message_id) batchKeys.add(String(payload.message_id));
  try {
    let q = deps.supabase
      .from('system_events')
      .select('id, event_subtype, created_at, payload')
      .eq('ghl_contact_id', contactId)
      .eq('event_type', 'ghl.reply_received');
    q = Number.isFinite(lastId) ? q.gt('id', lastId) : q.gt('created_at', lastAt);
    const { data, error } = await q.order('id', { ascending: true }).limit(10);
    if (error || !Array.isArray(data)) return null;
    const hit = data.find((e) => {
      if (String(e?.event_subtype || '').toLowerCase() === 'trivial') return false;
      const text = String(e?.payload?.message_text || '').trim();
      if (!text || ACK_ONLY_RX.test(text)) return false;
      const mid = e?.payload?.message_id;
      return !(mid && batchKeys.has(String(mid)));
    });
    return hit ? { id: hit.id, message_text: String(hit.payload?.message_text || '').slice(0, 200) } : null;
  } catch {
    return null;
  }
}
