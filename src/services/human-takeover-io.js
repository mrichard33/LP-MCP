/**
 * human-takeover-io — src/services/human-takeover-io.js (Mark, 2026-10-19, ruling 5)
 *
 * The one read behind src/agentic/human-takeover.js: the newest MANUAL
 * outbound text to a contact after a boundary (the inbound being answered, or
 * for a proactive send the lead's last inbound).
 *
 * Source: HL-MCP's contact.outbound_message events in system_events (one per
 * outbound "app" message; preflight 2026-10-20: median 3.0s, p90 4.4s after
 * the send, each with a messageId and a userId but no body). Our own sends are
 * recognised by message id (agent_actions.execution_result.message_id /
 * email_message_id, as the promised-callback sweep reads them); an event we
 * cannot match by id has its body read once from GHL and compared by text
 * (isOurText). Everything goes through `deps`.
 *
 * Three answers, never a guess:
 *   { at, message_id, user_id }  a person texted after the boundary
 *   null                          nobody did
 *   undefined                     we could not tell (a read failed, or one of
 *                                 our sends is still in flight): the bot sends.
 */
import supabaseDefault from '../supabase.js';
import { isManualOutbound } from '../agentic/human-takeover.js';
import { aiSenderUserId } from '../agentic/ai-sender.js';

const EVENT_LIMIT = 20;
const BOT_LOOKBACK_MS = 60 * 60 * 1000;
const IN_FLIGHT_MS = 2 * 60 * 1000;

async function defaultGhlFetch(method, path) {
  const { ghlFetch } = await import('../actions/helpers.js');
  return ghlFetch(method, path);
}

/** Our own sends to this contact around the boundary: ids, bodies, and whether one is still in flight. */
export async function readOurSends(contactId, afterIso, { supabase = supabaseDefault, nowMs = Date.now(), excludeActionId = null } = {}) {
  const since = new Date((Date.parse(afterIso) || nowMs) - BOT_LOOKBACK_MS).toISOString();
  const { data, error } = await supabase.from('agent_actions')
    .select('id, status, created_at, execution_result')
    .eq('action_type', 'send_message').eq('target_id', contactId)
    .gte('created_at', since).order('created_at', { ascending: false }).limit(200);
  if (error) throw new Error(`agent_actions: ${error.message}`);
  const ids = new Set();
  const bodies = [];
  let inFlight = false;
  for (const r of data || []) {
    // The send asking the question is itself "executing": it is not in flight
    // against itself (without this, every check would read unknown).
    if (excludeActionId != null && String(r.id) === String(excludeActionId)) continue;
    const ex = r.execution_result || {};
    if (ex.message_id) ids.add(String(ex.message_id));
    if (ex.email_message_id) ids.add(String(ex.email_message_id));
    if (ex.sent_body) bodies.push(String(ex.sent_body));
    if (r.status === 'executing' && nowMs - (Date.parse(r.created_at) || 0) < IN_FLIGHT_MS) inFlight = true;
  }
  return { ids, bodies, inFlight };
}

/**
 * @param {string} contactId
 * @param {string} afterIso   the boundary (ISO time)
 * @param {{supabase?, ghlFetch?, env?, nowMs?, excludeActionId?}} deps  excludeActionId: the
 *   send asking (its own row is "executing" and must not count as in flight)
 * @returns {Promise<{at: string, message_id: string|null, user_id: string|null}|null|undefined>}
 */
export async function newestManualOutbound(contactId, afterIso, deps = {}) {
  const supabase = deps.supabase || supabaseDefault;
  const ghlFetch = deps.ghlFetch || defaultGhlFetch;
  const env = deps.env || process.env;
  const nowMs = deps.nowMs || Date.now();
  if (!supabase || !contactId || !Number.isFinite(Date.parse(afterIso || ''))) return undefined;
  try {
    const { data: events, error } = await supabase.from('system_events')
      .select('id, created_at, payload')
      .eq('event_type', 'contact.outbound_message').eq('ghl_contact_id', contactId)
      .gt('created_at', new Date(Date.parse(afterIso)).toISOString())
      .order('created_at', { ascending: false }).limit(EVENT_LIMIT);
    if (error) throw new Error(`system_events: ${error.message}`);
    if (!events?.length) return null;
    const ours = await readOurSends(contactId, afterIso, { supabase, nowMs, excludeActionId: deps.excludeActionId ?? null });
    let unknown = false;
    for (const ev of events) {
      const p = { ...(ev.payload || {}) };
      const id = String(p.messageId ?? p.message_id ?? '').trim();
      if (id && ours.ids.has(id)) continue;
      if (p.body == null && id) {
        try {
          const msg = await ghlFetch('GET', `/conversations/messages/${encodeURIComponent(id)}`);
          const m = msg?.message || msg || {};
          if (typeof m.body === 'string') p.body = m.body;
        } catch { /* body unread: unknown below */ }
      }
      const manual = isManualOutbound({ payload: p, botMessageIds: ours.ids, botBodies: ours.bodies, aiSenderUserId: aiSenderUserId(env) });
      if (manual === true) {
        // One of our sends still in flight could be this very message (its id
        // not recorded yet): we cannot tell, so the bot sends.
        if (ours.inFlight) return undefined;
        return { at: ev.created_at, message_id: id || null, user_id: p.userId || null };
      }
      if (manual === null) unknown = true;
    }
    return unknown ? undefined : null;
  } catch (err) {
    (deps.log || console.warn)(`[HumanTakeover] ${contactId} read failed: ${String(err?.message || err).slice(0, 160)}`);
    return undefined;
  }
}

/** The lead's last inbound time (a proactive send's boundary), or null. */
export async function lastInboundAt(contactId, { supabase = supabaseDefault } = {}) {
  const { data, error } = await supabase.from('system_events')
    .select('created_at').eq('event_type', 'ghl.reply_received').eq('ghl_contact_id', contactId)
    .order('created_at', { ascending: false }).limit(1);
  if (error) throw new Error(`system_events: ${error.message}`);
  return data?.[0]?.created_at || null;
}
