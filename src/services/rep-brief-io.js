/**
 * Rep Brief — production wiring for src/services/rep-brief.js (2026-10-05).
 *
 * Everything that reaches GHL, Supabase or the model lives here, imported
 * lazily, so the pure builder and its tests load nothing.
 */

import { buildRepBrief, repBriefMode } from './rep-brief.js';

// GHL fails a webhook step at 60s and the LP forward itself is allowed
// LP_ADDLEAD_TIMEOUT_MS (30s), so the whole brief (contact read + thread read +
// model) gets at most 20s before the proxy gives up on it. The model's share is
// derived from llmBudgetMs('rep_brief') (CLAUDE.md: never a bare literal around
// an LLM call) and then bounded by what is left: a slow model costs the AI
// sentences, never the lead, because fixed sentences replace them.
export const REP_BRIEF_TOTAL_MS = Number(process.env.LP_REP_BRIEF_TIMEOUT_MS || 20000);
const READS_RESERVE_MS = 6000;
const THREAD_LIMIT = 40;

async function aiTimeoutMs() {
  const { llmBudgetMs } = await import('../llm-client.js');
  return Math.max(3000, Math.min(llmBudgetMs('rep_brief'), REP_BRIEF_TOTAL_MS - READS_RESERVE_MS));
}

/**
 * Both sides of the conversation, oldest first. GHL's thread first (texts and
 * the website chat both land there, the bot's replies included); when GHL has
 * nothing yet — a new live chat is often not searchable (CLAUDE.md, 44 of 68
 * turns in two days) — our own LIVE_CHAT_FAST_LANE rows instead.
 */
export async function readThread(contactId) {
  if (!contactId) return [];
  let thread = [];
  try {
    const [{ ghlFetch }, { GHL_LOCATION_ID }, { normalizeThread }] = await Promise.all([
      import('../actions/helpers.js'),
      import('../actions/constants.js'),
      import('../live-chat/fast-lane.js'),
    ]);
    const search = await ghlFetch('GET', `/conversations/search?locationId=${GHL_LOCATION_ID}&contactId=${contactId}`, null, { maxWaitMs: 2000 });
    const conversations = Array.isArray(search) ? search : (search?.conversations || []);
    const conversationId = conversations[0]?.id;
    if (conversationId) {
      const msgs = await ghlFetch('GET', `/conversations/${conversationId}/messages?limit=${THREAD_LIMIT}`, null, { maxWaitMs: 2000 });
      thread = normalizeThread(msgs, THREAD_LIMIT);
    }
  } catch (err) {
    console.warn(`[REP-BRIEF] ${contactId} GHL thread read failed: ${err.message}`);
  }
  if (thread.length >= 2) return thread;

  try {
    const [{ default: supabase }, { turnsFromRows }] = await Promise.all([
      import('../supabase.js'),
      import('../live-chat/index.js'),
    ]);
    if (!supabase) return thread;
    const { data, error } = await supabase.from('agent_actions')
      .select('created_at,status,action_payload,execution_result')
      .eq('rule_applied', 'LIVE_CHAT_FAST_LANE').eq('target_id', contactId)
      .order('created_at', { ascending: false }).limit(THREAD_LIMIT);
    if (error) throw new Error(error.message);
    const own = turnsFromRows((data || []).slice().reverse());
    return own.length > thread.length ? own : thread;
  } catch (err) {
    console.warn(`[REP-BRIEF] ${contactId} live-chat rows read failed: ${err.message}`);
    return thread;
  }
}

export async function productionDeps() {
  const [{ callLLM }, { stripUnicodeTags }] = await Promise.all([
    import('../llm-client.js'),
    import('../text-sanitize.js'),
  ]);
  return {
    callLLM,
    readThread,
    sanitize: (t) => stripUnicodeTags(String(t ?? '')),
    aiTimeoutMs: await aiTimeoutMs(),
  };
}

/**
 * Fetch the contact (unless given) and build the brief. Returns
 * { notes, source } or null on any failure — callers keep whatever note they
 * already had. Never throws.
 *
 * opts: { contact, body, hasAppointment }
 */
export async function fetchAndBuildRepBrief(contactId, opts = {}, deps = {}) {
  if (!contactId && !opts.contact) return null;
  try {
    const d = { ...(await productionDeps()), ...deps };
    let contact = opts.contact || null;
    if (!contact) {
      const getContact = d.getContact || (await import('../ghl.js')).getGHLContact;
      contact = await getContact(contactId);
    }
    if (!contact) return null;
    const out = await buildRepBrief({
      contact, contactId, body: opts.body || {}, hasAppointment: opts.hasAppointment,
    }, d);
    return out?.notes ? out : null;
  } catch (err) {
    console.warn(`[REP-BRIEF] build failed for ${contactId}: ${err.message}`);
    return null;
  }
}

export { repBriefMode };
