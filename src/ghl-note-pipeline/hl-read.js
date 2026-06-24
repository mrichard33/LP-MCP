// ─── GHL / HL read helpers — src/ghl-note-pipeline/hl-read.js ────
//
// Read side of the GHL Inbound → LP Note pipeline.
//
//   • Live GHL Conversations API reads (numeric message `type`) — the
//     authoritative source for summarization. Mirrors the proven fetch
//     pattern in src/actions/handlers/workflows.js (getLastInboundMessageMs)
//     and src/send-message-handler.js, including the GHL rate limiter.
//   • HL Supabase reads (messages cache + lead_events) — used by the
//     reconciliation sweep to catch dropped webhooks and terminal
//     appointment events. Mirrors the HL client in
//     src/tools/admin/hl-fallback.js (HL_SUPABASE_URL / _SERVICE_ROLE_KEY).
//
// All reads are fail-soft: a transient error returns an empty result / null
// rather than throwing into the worker loop, except where the caller needs
// to distinguish "could not read" (the processor treats a live-read failure
// as a retryable error).

import { createClient } from '@supabase/supabase-js';
import { acquireToken, report429 } from '../ghl-rate-limiter.js';

const GHL_API_KEY = process.env.GHL_API_KEY;
const GHL_LOCATION_ID = process.env.GHL_LOCATION_ID || 'SsBG7j5KQAIP1SFP2Sca';
// Conversations API version (matches workflows.js / decision-engine.js reads).
const GHL_CONV_VERSION = '2021-04-15';

// ─── HL Supabase client (read-only, lazy) ────────────────────────
let hlClient = null;
function getHlSupabase() {
  if (hlClient) return hlClient;
  const url = process.env.HL_SUPABASE_URL;
  const key = process.env.HL_SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    throw new Error(
      'HL Supabase not configured — set HL_SUPABASE_URL and HL_SUPABASE_SERVICE_ROLE_KEY on the LP MCP service.'
    );
  }
  hlClient = createClient(url, key);
  return hlClient;
}

export function hlSupabaseConfigured() {
  return !!(process.env.HL_SUPABASE_URL && process.env.HL_SUPABASE_SERVICE_ROLE_KEY);
}

// ─── Live GHL Conversations API ──────────────────────────────────

async function ghlConvFetch(path) {
  if (!GHL_API_KEY) throw new Error('GHL_API_KEY not configured');
  await acquireToken();
  const res = await fetch(`https://services.leadconnectorhq.com${path}`, {
    headers: {
      Authorization: `Bearer ${GHL_API_KEY}`,
      Version: GHL_CONV_VERSION,
      Accept: 'application/json',
    },
    signal: AbortSignal.timeout(15000),
  });
  if (res.status === 429) {
    report429();
    const text = await res.text().catch(() => '');
    throw new Error(`GHL GET ${path} → 429: ${text.slice(0, 160)}`);
  }
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`GHL GET ${path} → ${res.status}: ${text.slice(0, 160)}`);
  }
  return res.json();
}

/**
 * List a contact's conversations, newest first. Returns an array of raw GHL
 * conversation objects (each has at least `id`). Empty array if none.
 */
export async function listConversationsByContact(contactId, limit = 20) {
  if (!contactId) return [];
  const data = await ghlConvFetch(
    `/conversations/search?contactId=${encodeURIComponent(contactId)}&locationId=${GHL_LOCATION_ID}&limit=${limit}`
  );
  const convs = Array.isArray(data) ? data : data?.conversations || [];
  return Array.isArray(convs) ? convs : [];
}

/**
 * Newest conversation id for a contact, or null. Used by the webhook to
 * resolve a missing ghl_conversation_id live.
 */
export async function resolveConversationId(contactId) {
  const convs = await listConversationsByContact(contactId, 1);
  return convs[0]?.id || null;
}

/**
 * Fetch all messages for a conversation, normalized for the summarizer.
 * Returns [{ id, direction, type:Number, messageType, body, sentAt:Date }]
 * sorted ascending by sentAt. `type` is the GHL numeric channel code.
 */
export async function getConversationMessages(conversationId, limit = 100) {
  if (!conversationId) return [];
  const data = await ghlConvFetch(
    `/conversations/${encodeURIComponent(conversationId)}/messages?limit=${limit}`
  );
  // GHL nests as { messages: { messages: [...] } }; tolerate flatter shapes.
  const raw = data?.messages?.messages || data?.messages || [];
  if (!Array.isArray(raw)) return [];

  const norm = raw.map((m) => {
    const ts = m.dateAdded ? new Date(m.dateAdded) : null;
    return {
      id: m.id || m.messageId || null,
      direction: String(m.direction || '').toLowerCase(), // 'inbound' | 'outbound'
      type: Number.isFinite(Number(m.type)) ? Number(m.type) : NaN,
      messageType: m.messageType || null,
      body: typeof m.body === 'string' ? m.body : (m.meta?.email?.subject || ''),
      sentAt: ts && !Number.isNaN(ts.getTime()) ? ts : null,
    };
  });

  return norm
    .filter((m) => m.sentAt)
    .sort((a, b) => a.sentAt - b.sentAt);
}

// ─── HL Supabase: lead_events (appointment state) ────────────────

/**
 * Current appointment state for a contact derived from HL lead_events.
 * Returns { state: 'booked'|'cancelled'|null, at: Date|null } based on the
 * most recent appointment_booked / appointment_cancelled event.
 */
export async function getApptStateFromLeadEvents(contactId) {
  if (!contactId || !hlSupabaseConfigured()) return { state: null, at: null };
  try {
    const { data, error } = await getHlSupabase()
      .from('lead_events')
      .select('event_type, event_time')
      .eq('contact_id', contactId)
      .in('event_type', ['appointment_booked', 'appointment_cancelled'])
      .order('event_time', { ascending: false })
      .limit(1);
    if (error || !data?.length) return { state: null, at: null };
    const ev = data[0];
    return {
      state: ev.event_type === 'appointment_cancelled' ? 'cancelled' : 'booked',
      at: ev.event_time ? new Date(ev.event_time) : null,
    };
  } catch (err) {
    console.warn(`[GHLNote] lead_events read failed for ${contactId}: ${err.message}`);
    return { state: null, at: null };
  }
}

/**
 * Recent appointment events (booked/cancelled) across all contacts since
 * `sinceIso`, for the reconciliation sweep. Returns
 * [{ contact_id, event_type, event_time }]. Empty on error / unconfigured.
 */
export async function getRecentAppointmentEvents(sinceIso) {
  if (!hlSupabaseConfigured()) return [];
  try {
    const { data, error } = await getHlSupabase()
      .from('lead_events')
      .select('contact_id, event_type, event_time')
      .in('event_type', ['appointment_booked', 'appointment_cancelled'])
      .gte('event_time', sinceIso)
      .order('event_time', { ascending: false })
      .limit(500);
    if (error || !data) return [];
    return data;
  } catch (err) {
    console.warn(`[GHLNote] recent appt events read failed: ${err.message}`);
    return [];
  }
}

/**
 * Inbound conversations seen in the HL messages cache since `sinceIso`, for
 * dropped-webhook reconciliation. Returns a Map keyed by ghl_conversation_id
 * → { ghl_contact_id, last_inbound_at:Date, last_message_body }.
 */
export async function getRecentInboundFromCache(sinceIso) {
  const out = new Map();
  if (!hlSupabaseConfigured()) return out;
  try {
    const { data, error } = await getHlSupabase()
      .from('messages')
      .select('ghl_conversation_id, ghl_contact_id, body, sent_at')
      .eq('direction', 'inbound')
      .gte('sent_at', sinceIso)
      .order('sent_at', { ascending: true })
      .limit(2000);
    if (error || !data) return out;
    for (const m of data) {
      if (!m.ghl_conversation_id || !m.ghl_contact_id) continue;
      const at = m.sent_at ? new Date(m.sent_at) : null;
      const prev = out.get(m.ghl_conversation_id);
      if (!prev || (at && at > prev.last_inbound_at)) {
        out.set(m.ghl_conversation_id, {
          ghl_contact_id: m.ghl_contact_id,
          last_inbound_at: at || new Date(),
          last_message_body: m.body || null,
        });
      }
    }
    return out;
  } catch (err) {
    console.warn(`[GHLNote] messages cache read failed: ${err.message}`);
    return out;
  }
}
