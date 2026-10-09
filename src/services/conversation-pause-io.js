/**
 * conversation-pause-io — src/services/conversation-pause-io.js
 *
 * The reads and writes behind src/agentic/conversation-pause.js (2026-10-08).
 * Everything goes through `deps` so the pass unit-tests without a database.
 *
 * Reads are CHUNKED per contact list. The old sweep read "every add_tag in 30
 * days" in one query and PostgREST handed back only the newest 1,000 rows, so
 * it never saw a pause old enough to release. Never read an unbounded table
 * slice and filter it in memory here.
 */

import { PAUSE_TAG, isConversationOutbound } from '../agentic/conversation-pause.js';

export const PAUSE_RULE = 'CONVERSATION_PAUSE';
export const RELEASE_RULE = 'CONVERSATION_PAUSE_RELEASE';
const CHUNK = 50;
const LOOKBACK_DAYS = 60;

function chunks(list, n = CHUNK) {
  const out = [];
  for (let i = 0; i < list.length; i += n) out.push(list.slice(i, i + n));
  return out;
}

const newest = (map, id, iso) => {
  const ms = Date.parse(iso || '');
  if (!id || !Number.isFinite(ms)) return;
  if (!map.has(id) || map.get(id) < ms) map.set(id, ms);
};

/** Contacts carrying pause-workflow, from the tag snapshot. [{ id, tags }] */
export async function readPausedContacts({ supabase }) {
  const out = [];
  for (let from = 0; from < 20000; from += 1000) {
    const { data, error } = await supabase.from('contact_tag_snapshot')
      .select('ghl_contact_id, tags')
      .contains('tags', [PAUSE_TAG])
      .range(from, from + 999);
    if (error) throw new Error(`contact_tag_snapshot: ${error.message}`);
    for (const r of data || []) out.push({ id: r.ghl_contact_id, tags: r.tags || [] });
    if (!data || data.length < 1000) break;
  }
  return out;
}

/**
 * Per contact: when we last paused it, the newest conversational text either
 * way, and whether a promised call is still open.
 * @returns {Map<string, {pausedAtMs: number|null, lastActivityMs: number|null, openPromise: boolean}>}
 */
export async function readActivity(contactIds, { supabase, nowMs = Date.now() }) {
  const since = new Date(nowMs - LOOKBACK_DAYS * 86400000).toISOString();
  const paused = new Map();
  const activity = new Map();
  const promises = new Set();
  for (const ids of chunks([...new Set(contactIds)].filter(Boolean))) {
    const [pauses, sends, replies, outbound, open] = await Promise.all([
      supabase.from('agent_actions').select('target_id, created_at')
        .in('target_id', ids).eq('action_type', 'add_tag').eq('status', 'completed')
        .contains('action_payload', { tag: PAUSE_TAG })
        .order('created_at', { ascending: false }).limit(1000),
      supabase.from('agent_actions').select('target_id, created_at')
        .in('target_id', ids).eq('action_type', 'send_message').eq('status', 'completed')
        .gte('created_at', since).order('created_at', { ascending: false }).limit(1000),
      supabase.from('lead_intelligence').select('ghl_contact_id, last_reply_at').in('ghl_contact_id', ids),
      supabase.from('system_events').select('ghl_contact_id, created_at, payload')
        .in('ghl_contact_id', ids).eq('event_type', 'contact.outbound_message')
        .gte('created_at', since).order('created_at', { ascending: false }).limit(1000),
      supabase.from('promised_callbacks').select('ghl_contact_id').in('ghl_contact_id', ids).eq('status', 'open'),
    ]);
    if (pauses.error) throw new Error(`agent_actions pauses: ${pauses.error.message}`);
    if (sends.error) throw new Error(`agent_actions sends: ${sends.error.message}`);
    if (replies.error) throw new Error(`lead_intelligence: ${replies.error.message}`);
    for (const r of pauses.data || []) newest(paused, r.target_id, r.created_at);
    for (const r of sends.data || []) newest(activity, r.target_id, r.created_at);
    for (const r of replies.data || []) newest(activity, r.ghl_contact_id, r.last_reply_at);
    // Optional sources: HL-MCP's outbound event (new) and promised_callbacks
    // (sql/150) may be missing; a missing source counts nothing.
    if (!outbound.error) for (const r of outbound.data || []) if (isConversationOutbound(r.payload)) newest(activity, r.ghl_contact_id, r.created_at);
    if (!open.error) for (const r of open.data || []) promises.add(r.ghl_contact_id);
  }
  const out = new Map();
  for (const id of contactIds) {
    out.set(id, { pausedAtMs: paused.get(id) ?? null, lastActivityMs: activity.get(id) ?? null, openPromise: promises.has(id) });
  }
  return out;
}

/** Conversational outbound texts since a time: [{ contactId, at }]. */
export async function readRecentOutbound(sinceIso, { supabase }) {
  const { data, error } = await supabase.from('system_events')
    .select('ghl_contact_id, created_at, payload')
    .eq('event_type', 'contact.outbound_message')
    .gt('created_at', sinceIso)
    .order('created_at', { ascending: true })
    .limit(1000);
  if (error) return [];
  return (data || []).filter(r => r.ghl_contact_id && isConversationOutbound(r.payload))
    .map(r => ({ contactId: r.ghl_contact_id, at: r.created_at }));
}

/** Current tags for some contacts, from the snapshot. Map<id, string[]> */
export async function readSnapshotTags(contactIds, { supabase }) {
  const out = new Map();
  for (const ids of chunks([...new Set(contactIds)].filter(Boolean))) {
    const { data, error } = await supabase.from('contact_tag_snapshot').select('ghl_contact_id, tags').in('ghl_contact_id', ids);
    if (error) continue;
    for (const r of data || []) out.set(r.ghl_contact_id, r.tags || []);
  }
  return out;
}

/** Queue the pause through the executor (mutation gate, snapshot write-through). */
export async function queuePause(contactId, why, { supabase }) {
  const { error } = await supabase.from('agent_actions').insert({
    action_type: 'add_tag',
    target_system: 'ghl',
    target_entity: 'contact',
    target_id: contactId,
    action_payload: { tag: PAUSE_TAG },
    reasoning: `Live conversation (${why}): drips pause until 24 quiet hours (src/agentic/conversation-pause.js)`,
    rule_applied: PAUSE_RULE,
    status: 'pending',
    requires_approval: false,
    priority: 40,
  });
  if (error) throw new Error(error.message);
  return true;
}
