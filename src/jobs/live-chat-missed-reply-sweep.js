/**
 * Live chat missed-reply sweep — src/jobs/live-chat-missed-reply-sweep.js
 *
 * Every 30 seconds while the live chat lane is on: find a visitor message in a
 * chat the lane is answering that GHL never sent us, and answer it through the
 * lane itself. Selection and the WHY live in src/live-chat/missed-replies.js
 * (a merged contact on 2026-10-01: the visitor's phone number got no reply).
 *
 * THE CONTACT. A merge deletes the contact the chat started on. The mirror
 * usually already carries the surviving contact id; otherwise the chat's
 * earlier contacts are tried, then a GHL search on the phone in the message
 * (src/services/ghl-contact-resolve.js: last-10-digit match, never a guess).
 * Nothing found → one #ops-alerts line, because a person has to pick it up.
 *
 * ONCE PER MESSAGE. The lane's own claim (consumed messages) is keyed on
 * `livechat_sweep_<ghl message id>`, so a message is re-driven at most once
 * whatever the passes do. The re-drive goes through processInbound, so every
 * gate the webhook has (opt-out, suppression tags, reply lock, the lane mode)
 * still applies, and shadow mode drafts without sending.
 *
 * NOT IN job-registry.js, ON PURPOSE: a 30-second tick would file ~2,900
 * job_runs rows a day with no signal, the same reason the two 60-second
 * heartbeats are exempt. Each re-drive logs `[LiveChatSweep] re-drove`.
 *
 * MODE  LIVE_CHAT_MISSED_SWEEP_MODE = on (default) | off. It also does nothing
 * while LIVE_CHAT_FAST_LANE_MODE is off.
 */

import { planMissedReplies, phoneFromText, sweepMessageKey, LOOKBACK_MS } from '../live-chat/missed-replies.js';
import { liveChatMode, LIVE_CHAT_RULE } from '../live-chat/fast-lane.js';

export const INTERVAL_MS = 30 * 1000;

export function sweepMode(env = process.env) {
  return String(env.LIVE_CHAT_MISSED_SWEEP_MODE || 'on').trim().toLowerCase() === 'off' ? 'off' : 'on';
}

const sqlList = (xs) => xs.map((x) => `'${String(x).replace(/'/g, "''")}'`).join(',');

async function defaultDeps() {
  const [{ runSQL }, { hlRunSQL }, { ghlFetch }, { searchByPhone }, { buildProductionLane }, { sendAlertMessage }] = await Promise.all([
    import('../admin/supabase-admin.js'),
    import('../admin/hl-client.js'),
    import('../actions/helpers.js'),
    import('../services/ghl-contact-resolve.js'),
    import('../live-chat/index.js'),
    import('../alert-state.js'),
  ]);
  return {
    runSQL,
    hlRunSQL,
    fetchContact: async (id) => {
      const res = await ghlFetch('GET', `/contacts/${id}`, null, { priority: 'high', maxWaitMs: 1500 });
      return res?.contact || res || null;
    },
    searchByPhone: (digits) => searchByPhone(digits, { priority: 'high' }),
    lane: buildProductionLane(),
    opsAlert: (text) => sendAlertMessage(text, { channel: 'ops' }),
  };
}

/** The contact the chat lives on now, or null. Never throws. */
export async function resolveChatContact({ candidates, body }, deps) {
  for (const id of candidates) {
    try {
      const c = await deps.fetchContact(id);
      if (c && (c.id || c.contact?.id)) return { contactId: c.id || c.contact.id, via: 'contact' };
    } catch { /* deleted by a merge, or unreadable: try the next */ }
  }
  const digits = phoneFromText(body);
  if (digits) {
    try {
      const c = await deps.searchByPhone(digits);
      if (c?.id) return { contactId: c.id, via: 'phone' };
    } catch { /* fall through */ }
  }
  return null;
}

export async function runLiveChatMissedReplySweep({ env = process.env, nowMs = Date.now(), deps = null } = {}) {
  if (sweepMode(env) === 'off' || liveChatMode(env) === 'off') return { skipped: true };
  const d = deps || await defaultDeps();
  const log = d.log || console;

  const rows = await d.runSQL(`
    SELECT target_id,
           coalesce(action_payload->>'conversation_id', execution_result->>'conversation_id') AS conversation_id,
           created_at
      FROM agent_actions
     WHERE rule_applied = '${LIVE_CHAT_RULE}'
       AND created_at > now() - interval '${Math.round(LOOKBACK_MS / 60000)} minutes'
  `);
  if (!Array.isArray(rows)) throw new Error('fast-lane rows: read returned no row set');
  const convs = [...new Set(rows.map((r) => r.conversation_id).filter(Boolean))];
  if (!convs.length) return { ok: true, checked: 0, redriven: 0 };

  const messages = await d.hlRunSQL(`
    SELECT ghl_message_id, ghl_conversation_id, ghl_contact_id, body, sent_at
      FROM messages
     WHERE direction = 'inbound'
       AND ghl_conversation_id IN (${sqlList(convs)})
       AND sent_at > now() - interval '${Math.round(LOOKBACK_MS / 60000)} minutes'
     ORDER BY sent_at
  `);
  if (!Array.isArray(messages)) throw new Error('mirror messages: read returned no row set');

  const plan = planMissedReplies({ rows, messages, nowMs });
  let redriven = 0;
  const unresolved = [];
  for (const item of plan) {
    const { message } = item;
    const who = await resolveChatContact({ candidates: item.contactCandidates, body: message.body }, d);
    if (!who) { unresolved.push(item); continue; }
    const out = await d.lane.processInbound({
      contactId: who.contactId,
      // A merge moves the chat to the surviving contact's conversation; let
      // the lane look it up rather than reply into the deleted one.
      conversationId: item.rowContacts.includes(who.contactId) ? item.conversationId : null,
      messageId: sweepMessageKey(message.ghl_message_id),
      body: String(message.body).trim(),
      dateAdded: message.sent_at,
    });
    if (out?.outcome !== 'duplicate') {
      redriven++;
      log.log?.(`[LiveChatSweep] re-drove message ${message.ghl_message_id} (conversation ${item.conversationId}) for contact ${who.contactId} via ${who.via}: ${out?.outcome || 'unknown'}`);
    }
  }
  for (const item of unresolved) {
    const key = sweepMessageKey(item.message.ghl_message_id);
    if (d._alerted?.has(key)) continue;
    d._alerted?.add(key);
    log.warn?.(`[LiveChatSweep] no contact for missed message ${item.message.ghl_message_id} (conversation ${item.conversationId})`);
    await Promise.resolve(d.opsAlert?.(`💬 LIVE CHAT — A VISITOR MESSAGE GOT NO REPLY\nConversation: ${item.conversationId}\nThey said: "${String(item.message.body).slice(0, 200)}"\n→ GHL never sent it to us and the contact could not be found. A person needs to answer this chat.`)).catch(() => {});
  }
  return { ok: true, checked: plan.length, redriven, unresolved: unresolved.length };
}

let timer = null;
let running = false;
let liveDeps = null;

export function startLiveChatMissedReplyScheduler(env = process.env) {
  if (timer) return timer;
  if (sweepMode(env) === 'off') {
    console.log('[LiveChatSweep] scheduler not started (LIVE_CHAT_MISSED_SWEEP_MODE=off)');
    return null;
  }
  const tick = async () => {
    if (running) return; // a slow pass must not overlap itself
    running = true;
    try {
      if (liveChatMode() === 'off') return;
      liveDeps ||= { ...(await defaultDeps()), _alerted: new Set() };
      await runLiveChatMissedReplySweep({ deps: liveDeps });
    } catch (err) {
      console.warn(`[LiveChatSweep] pass failed: ${err.message}`);
    } finally {
      running = false;
    }
  };
  timer = setInterval(tick, INTERVAL_MS);
  if (typeof timer.unref === 'function') timer.unref();
  console.log(`[LiveChatSweep] scheduler started — every ${INTERVAL_MS / 1000}s while the live chat lane is on`);
  return timer;
}

export function stopLiveChatMissedReplyScheduler() {
  if (timer) { clearInterval(timer); timer = null; }
}
