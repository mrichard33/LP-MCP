/**
 * Live chat summary pass — src/services/live-chat-summary-io.js
 *
 * 2026-10-15 (Mark: group a chat into one summary after the conversation ends;
 * never the same item twice). Each pass:
 *   1. reads the last 24h of LIVE_CHAT_FAST_LANE agent_actions rows,
 *   2. splits them into sessions (src/live-chat/chat-summary.js) and keeps the
 *      ones quiet for LIVE_CHAT_SUMMARY_QUIET_MIN,
 *   3. CLAIMS each new session by inserting its live_chat_summaries row first
 *      (UNIQUE contact_id + session_start): a second pass or a second replica
 *      loses the insert and does nothing, so a session gets one card, never two,
 *   4. builds the facts from code, asks a cheap model for the 2–3 lines
 *      (fn live_chat_summary; a failure uses the visitor's own words),
 *   5. a chat with nothing to act on (`worthPosting`) is stored with
 *      payload.skipped = 'nothing_to_act_on' and never posted or retried,
 *   6. shadow: stores the card's parts on the row and posts nothing.
 *      live: posts to #reece-chatbot (LIVE_CHAT_SUMMARY_CHANNEL, else
 *      SLACK_CHANNEL_DISPATCH; 2026-10-16, Mark: #ops-alerts is for system
 *      alerts). A lead who comes back gets the new summary as a THREAD REPLY
 *      under their earlier card, in that card's channel (postToSlack threadTs).
 *
 * A failed post keeps the row (error, attempts) and is retried on later passes
 * up to MAX_POST_ATTEMPTS. A failed read ends the pass: nothing is claimed on a
 * guess. Every network and database touch is a dep, so the pass runs offline.
 */

import {
  summaryMode, summaryQuietMs, toTurn, sessionize, readySessions, summarizeFacts, buildCard,
  buildSummaryPrompt, cleanSummary, fallbackSummary, openingsFromRows, worthPosting, summaryChannel,
  READ_WINDOW_MS, THREAD_WINDOW_MS, MAX_POST_ATTEMPTS,
} from '../live-chat/chat-summary.js';

export const LIVE_CHAT_RULE = 'LIVE_CHAT_FAST_LANE';
export const SUMMARY_TABLE = 'live_chat_summaries';
// Window Count / Door Count (src/agentic/job-scope.js); copied, not imported,
// so this module does not pull the whole scope rule set in.
export const WINDOW_COUNT_FIELD_ID = 'h9FJTUbmUHIuD6JKmpXv';
export const DOOR_COUNT_FIELD_ID = 'j7l1KWmDgoJqy7SINjQs';

const ms = (iso) => { const t = Date.parse(iso); return Number.isFinite(t) ? t : null; };
const iso = (t) => new Date(t).toISOString();

/** Production deps. Lazy imports keep the module loadable in tests. */
export async function defaultSummaryDeps() {
  const [{ default: supabase }, { ghlFetch }, { GHL_LOCATION_ID }, { callLLM }, { postToSlack }, { withGhlCaller }] = await Promise.all([
    import('../supabase.js'),
    import('../actions/helpers.js'),
    import('../actions/constants.js'),
    import('../llm-client.js'),
    import('../slack.js'),
    import('../ghl-caller.js'),
  ]);
  const must = (res, what) => { if (res.error) throw new Error(`${what}: ${res.error.message}`); return res.data || []; };
  return {
    readChatRows: async (sinceIso) => must(await supabase.from('agent_actions')
      .select('id, target_id, created_at, status, action_payload, execution_result')
      .eq('rule_applied', LIVE_CHAT_RULE)
      .gte('created_at', sinceIso)
      .order('created_at', { ascending: true })
      .limit(5000), 'live chat rows'),
    readSummaries: async (contactIds, sinceIso) => must(await supabase.from(SUMMARY_TABLE)
      .select('id, contact_id, session_start, last_turn_at, mode, posted_at, slack_channel, slack_ts, thread_ts, attempts, error, payload')
      .in('contact_id', contactIds)
      .gte('session_start', sinceIso), 'summary rows'),
    // The claim: insert first, and a unique-key collision means someone else has it.
    claimSession: async (row) => {
      const { data, error } = await supabase.from(SUMMARY_TABLE).insert(row).select('id').single();
      if (error) {
        if (error.code === '23505') return { claimed: false };
        throw new Error(`claim: ${error.message}`);
      }
      return { claimed: true, id: data?.id };
    },
    updateSummary: async (id, patch) => {
      const { error } = await supabase.from(SUMMARY_TABLE).update({ ...patch, updated_at: new Date().toISOString() }).eq('id', id);
      if (error) throw new Error(`update: ${error.message}`);
    },
    readOpeningsRows: async (contactId, fromIso, toIso) => must(await supabase.from('agent_actions')
      .select('action_payload, created_at')
      .eq('rule_applied', 'OPENINGS_COUNT_PERSIST')
      .eq('target_id', contactId)
      .gte('created_at', fromIso)
      .lte('created_at', toIso), 'openings rows'),
    // A STOP writes no live-chat row (the lane returns before the insert), so
    // an opt-out is read from the stored stage's change log.
    readOptedOut: async (contactId, fromIso, toIso) => {
      const rows = must(await supabase.from('lead_conversation_stage_events')
        .select('id')
        .eq('contact_id', contactId)
        .eq('to_stage', 'opted_out')
        .gte('created_at', fromIso)
        .lte('created_at', toIso)
        .limit(1), 'stage events');
      return rows.length > 0;
    },
    fetchContact: (contactId) => withGhlCaller('job:live-chat-summary', async () => {
      const res = await ghlFetch('GET', `/contacts/${contactId}`, null, { priority: 'normal' });
      const c = res?.contact || res || null;
      if (!c) return null;
      const name = [c.firstName, c.lastName].filter(Boolean).join(' ').trim() || c.contactName || c.name || null;
      return { name, phone: c.phone || null };
    }),
    summarize: async (prompt) => {
      const out = await callLLM({ fn: 'live_chat_summary', system: prompt.system, user: prompt.user, maxTokens: 300 });
      return out?.text || null;
    },
    postToSlack,
    channel: () => summaryChannel(),
    contactUrl: (id) => `https://app.gohighlevel.com/v2/location/${GHL_LOCATION_ID}/contacts/detail/${id}`,
    log: (line) => console.log(line),
    warn: (line) => console.warn(line),
  };
}

/** The earlier card of this contact to reply under, if any (the thread root). Pure. */
export function threadRootFor(contactId, summaries, nowMs) {
  const posted = (summaries || [])
    .filter((s) => s.contact_id === contactId && s.slack_ts && s.posted_at && nowMs - ms(s.posted_at) <= THREAD_WINDOW_MS)
    .sort((a, b) => ms(a.posted_at) - ms(b.posted_at));
  if (!posted.length) return null;
  const first = posted[0];
  return { thread_ts: first.thread_ts || first.slack_ts, channel: first.slack_channel || null };
}

async function buildParts(session, d) {
  const quiet = d._quietMs;
  const fromIso = session.session_start;
  const toIso = iso(ms(session.last_turn_at) + quiet);
  const [openingsRows, optedOut, contact] = await Promise.all([
    Promise.resolve(d.readOpeningsRows(session.contact_id, fromIso, toIso)).catch((err) => { d.warn(`[ChatSummary] openings read failed for ${session.contact_id}: ${err.message}`); return []; }),
    Promise.resolve(d.readOptedOut(session.contact_id, fromIso, toIso)).catch((err) => { d.warn(`[ChatSummary] stage read failed for ${session.contact_id}: ${err.message}`); return false; }),
    Promise.resolve(d.fetchContact(session.contact_id)).catch((err) => { d.warn(`[ChatSummary] contact read failed for ${session.contact_id}: ${err.message}`); return null; }),
  ]);
  const facts = summarizeFacts(session.turns, {
    openings: openingsFromRows(openingsRows, { windowFieldId: WINDOW_COUNT_FIELD_ID, doorFieldId: DOOR_COUNT_FIELD_ID }),
    optedOut,
  });
  let summary = null;
  let source = 'model';
  try {
    summary = cleanSummary(await d.summarize(buildSummaryPrompt(session.turns)));
  } catch (err) {
    d.warn(`[ChatSummary] summary model failed for ${session.contact_id}: ${err.message}`);
  }
  if (!summary) { summary = fallbackSummary(session.turns); source = 'fallback'; }
  return { facts, summary, source, contact: contact || {} };
}

async function postCard({ rowId, parts, root, attempts, session, d }) {
  const channel = root?.channel || d.channel();
  const card = buildCard({ facts: parts.facts, summary: parts.summary, contact: parts.contact, contactUrl: d.contactUrl(session.contact_id), followUp: !!root });
  if (!channel) {
    await d.updateSummary(rowId, { attempts: attempts + 1, error: 'no Slack channel (LIVE_CHAT_SUMMARY_CHANNEL unset)' });
    d.warn(`[ChatSummary] ${session.contact_id}: no Slack channel, card not posted`);
    return { posted: false };
  }
  const res = await Promise.resolve(d.postToSlack(card, channel, root ? { threadTs: root.thread_ts } : {})).catch((err) => ({ ok: false, error: err.message }));
  if (res?.ok) {
    await d.updateSummary(rowId, { posted_at: new Date(d._nowMs).toISOString(), slack_channel: res.channel || channel, slack_ts: res.ts || null, thread_ts: root?.thread_ts || null, attempts: attempts + 1, error: null });
    d.log(`[ChatSummary] card for ${session.contact_id} posted${root ? ' as a thread reply' : ''} (ts ${res.ts})`);
    return { posted: true, ts: res.ts, channel: res.channel || channel };
  }
  await d.updateSummary(rowId, { attempts: attempts + 1, error: String(res?.error || 'post failed').slice(0, 300) });
  d.warn(`[ChatSummary] card for ${session.contact_id} NOT posted: ${res?.error || 'unknown'}`);
  return { posted: false };
}

/**
 * One pass. Returns counts for the logs.
 * @param {object} o  { env, nowMs, deps }
 */
export async function runLiveChatSummaryPass({ env = process.env, nowMs = Date.now(), deps = null } = {}) {
  const mode = summaryMode(env);
  if (mode === 'off') return { ok: true, skipped: true, mode };
  const d = { log: () => {}, warn: () => {}, ...(deps || await defaultSummaryDeps()) };
  const quietMs = summaryQuietMs(env);
  d._quietMs = quietMs;
  d._nowMs = nowMs;
  const windowStartMs = nowMs - READ_WINDOW_MS;

  const rows = await d.readChatRows(iso(windowStartMs));
  const ready = readySessions(sessionize((rows || []).map(toTurn), quietMs), { nowMs, quietMs, windowStartMs })
    .sort((a, b) => ms(a.session_start) - ms(b.session_start));
  if (!ready.length) return { ok: true, mode, ready: 0, claimed: 0, posted: 0, retried: 0, skipped: 0 };

  const contacts = [...new Set(ready.map((s) => s.contact_id))];
  const summaries = [...(await d.readSummaries(contacts, iso(nowMs - THREAD_WINDOW_MS)) || [])];
  let claimed = 0;
  let posted = 0;
  let retried = 0;
  let skipped = 0;

  for (const session of ready) {
    const startMs = ms(session.session_start);
    const existing = summaries.find((s) => s.contact_id === session.contact_id && ms(s.session_start) === startMs);
    if (existing) {
      // A live row whose post failed is retried; anything else is done. A
      // skipped row has no posted_at either, so it is named here or it would
      // be "retried" into the card it was meant not to get.
      if (mode !== 'live' || existing.mode !== 'live' || existing.posted_at || existing.payload?.skipped
        || (existing.attempts || 0) >= MAX_POST_ATTEMPTS) continue;
      const parts = await buildParts(session, d);
      const root = threadRootFor(session.contact_id, summaries.filter((s) => s !== existing), nowMs);
      const out = await postCard({ rowId: existing.id, parts, root, attempts: existing.attempts || 0, session, d });
      retried++;
      if (out.posted) { posted++; Object.assign(existing, { posted_at: iso(nowMs), slack_ts: out.ts, slack_channel: out.channel, thread_ts: root?.thread_ts || null }); }
      continue;
    }
    const claim = await d.claimSession({
      contact_id: session.contact_id, session_start: session.session_start, last_turn_at: session.last_turn_at,
      turns: session.turns.length, mode, payload: {},
    });
    if (!claim?.claimed) continue;
    claimed++;
    const row = { id: claim.id, contact_id: session.contact_id, session_start: session.session_start, mode, attempts: 0 };
    summaries.push(row);
    const parts = await buildParts(session, d);
    const root = threadRootFor(session.contact_id, summaries, nowMs);
    // The facts and the summary only: no phone or email is stored on the row.
    const payload = { facts: parts.facts, summary: parts.summary, summary_source: parts.source, follow_up: !!root };
    if (!worthPosting(parts.facts, parts.contact)) {
      // In shadow too, so the shadow rows show what live would skip.
      row.payload = { ...payload, skipped: 'nothing_to_act_on' };
      await d.updateSummary(claim.id, { payload: row.payload });
      skipped++;
      d.log(`[ChatSummary] ${mode} ${session.contact_id}: nothing to act on, no card (${session.turns.length} turn(s))`);
      continue;
    }
    if (mode === 'shadow') {
      await d.updateSummary(claim.id, { payload, thread_ts: root?.thread_ts || null });
      d.log(`[ChatSummary] shadow ${session.contact_id}: ${parts.facts.outcome}, ${session.turns.length} turn(s)${root ? ', would thread' : ''}`);
      continue;
    }
    await d.updateSummary(claim.id, { payload });
    const out = await postCard({ rowId: claim.id, parts, root, attempts: 0, session, d });
    if (out.posted) { posted++; Object.assign(row, { posted_at: iso(nowMs), slack_ts: out.ts, slack_channel: out.channel, thread_ts: root?.thread_ts || null }); }
  }
  return { ok: true, mode, ready: ready.length, claimed, posted, retried, skipped };
}
