/**
 * Missed inbound sweep — src/jobs/missed-inbound-sweep.js
 *
 * Every 60 seconds: find an inbound SMS or email that GHL never POSTed to
 * /webhook/ghl/reply, and run it through the reply pipeline itself. Selection
 * and the WHY live in src/agentic/missed-inbound.js (Jeff Clark, 2026-10-14:
 * "Please include a copy of your warranty as well. Thanks" got no reply because
 * GHL workflow I.L3-IN's webhook never arrived).
 *
 * THE SOURCES. The HL mirror's `messages` (HL-MCP writes each inbound within
 * seconds of GHL's marketplace webhook, a different delivery than I.L3-IN) and
 * LP's own `ghl.reply_received` / `ghl.reply_channel_excluded` events, plus the
 * bot's own `send_message` rows (a message the bot already answered is never
 * missed, Shawn Eastman 2026-10-15). A read that fails ends the pass: no
 * re-drive on a guess.
 *
 * ONCE PER MESSAGE. Each re-drive is claimed in agentic_consumed_messages as
 * `inbound_sweep_<ghl message id>` before it runs, so a message is re-driven at
 * most once whatever the passes do. The re-drive goes through
 * processInboundReply (src/behavioral-emitter.js), so every gate the webhook
 * has still applies: the DNC check (a dropped STOP is honored), the channel
 * gate, the ownership stamp, the trivial filter, the reply buffer and claim,
 * the analyzer's stop-bot / suppression skips and the send gate.
 *
 * NO SLACK. The system fixed it (Mark, 2026-10-07: #contact-center gets only
 * what a person must act on). Each re-drive logs `[InboundSweep] re-drove` and
 * emits `agentic.missed_inbound_redriven`.
 *
 * NOT IN job-registry.js, ON PURPOSE: a 60-second tick would file ~1,440
 * job_runs rows a day with no signal, the same reason the live-chat sweep is
 * exempt.
 *
 * MODE  MISSED_INBOUND_SWEEP_MODE = live (default, the user 2026-10-15) |
 * shadow (logs what it would re-drive, claims nothing) | off.
 */

import { planMissedInbound, sweepMessageKey, LOOKBACK_MS, AFTER_MS, ANSWERED_AFTER_MS } from '../agentic/missed-inbound.js';

export const INTERVAL_MS = 60 * 1000;

export function sweepMode(env = process.env) {
  const v = String(env.MISSED_INBOUND_SWEEP_MODE || 'live').trim().toLowerCase();
  return v === 'off' || v === 'shadow' ? v : 'live';
}

const sqlList = (xs) => xs.map((x) => `'${String(x).replace(/'/g, "''")}'`).join(',');

/** An email body from the mirror may be HTML; the reply pipeline reads text. Pure. */
export function bodyText(body) {
  const s = String(body ?? '');
  if (!/<[a-z][\s\S]*>/i.test(s)) return s.trim();
  return s
    .replace(/<(style|script)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<br\s*\/?>|<\/(p|div|tr|li)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#39;|&apos;/g, "'").replace(/&quot;/g, '"')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s*\n+/g, '\n')
    .trim();
}

async function defaultDeps() {
  const [{ runSQL }, { hlRunSQL }, { claimConsumedMessages }, { processInboundReply }, { emitEvent }] = await Promise.all([
    import('../admin/supabase-admin.js'),
    import('../admin/hl-client.js'),
    import('../services/consumed-messages.js'),
    import('../behavioral-emitter.js'),
    import('../event-emitter.js'),
  ]);
  return { runSQL, hlRunSQL, claim: claimConsumedMessages, processInboundReply, emitEvent };
}

/** LP's run_sql returns rows either bare or as [{ json_agg }]. */
function rowsOf(data) {
  if (!Array.isArray(data)) return null;
  if (data.length === 1 && data[0] && 'json_agg' in data[0]) return data[0].json_agg || [];
  return data;
}

export async function runMissedInboundSweep({ env = process.env, nowMs = Date.now(), deps = null } = {}) {
  const mode = sweepMode(env);
  if (mode === 'off') return { skipped: true, mode };
  const d = deps || await defaultDeps();
  const log = d.log || console;
  const minutes = Math.round(LOOKBACK_MS / 60000);

  const messages = await d.hlRunSQL(`
    SELECT ghl_message_id, ghl_contact_id, ghl_conversation_id, type, body, sent_at
      FROM messages
     WHERE direction = 'inbound'
       AND type IN ('2', '3')
       AND deleted_at IS NULL
       AND sent_at > now() - interval '${minutes} minutes'
     ORDER BY sent_at
  `);
  if (!Array.isArray(messages)) throw new Error('mirror messages: read returned no row set');
  const contacts = [...new Set(messages.map((m) => m.ghl_contact_id).filter(Boolean))];
  if (!contacts.length) return { ok: true, mode, checked: 0, redriven: 0 };

  const received = rowsOf(await d.runSQL(`
    SELECT json_agg(row_to_json(s)) FROM (
      SELECT ghl_contact_id, created_at, payload->>'message_text' AS message_text
        FROM system_events
       WHERE event_type IN ('ghl.reply_received', 'ghl.reply_channel_excluded')
         AND ghl_contact_id IN (${sqlList(contacts)})
         AND created_at > now() - interval '${minutes + Math.ceil(AFTER_MS / 60000) + 2} minutes'
    ) s
  `));
  if (!Array.isArray(received)) throw new Error('reply events: read returned no row set');

  // The bot's own sends. A skipped / failed / cancelled send is not an answer.
  const outbound = rowsOf(await d.runSQL(`
    SELECT json_agg(row_to_json(s)) FROM (
      SELECT target_id AS ghl_contact_id, coalesce(executed_at, created_at) AS created_at
        FROM agent_actions
       WHERE action_type = 'send_message'
         AND status IN ('pending', 'approved', 'executing', 'completed')
         AND target_id IN (${sqlList(contacts)})
         AND created_at > now() - interval '${minutes + Math.ceil(ANSWERED_AFTER_MS / 60000) + 2} minutes'
    ) s
  `));
  if (!Array.isArray(outbound)) throw new Error('bot sends: read returned no row set');

  const plan = planMissedInbound({ messages, received, outbound, nowMs });
  let redriven = 0;
  for (const item of plan) {
    const key = sweepMessageKey(item.messageId);
    if (mode === 'shadow') {
      log.log?.(`[InboundSweep] shadow — would re-drive ${item.messageType} ${item.messageId} for ${item.contactId}: "${item.body.slice(0, 60)}"`);
      continue;
    }
    // The claim fails open on a database error; the in-process set keeps a
    // failing claim table from re-driving the same message every pass.
    if (d._done?.has(key)) continue;
    const claim = await d.claim(item.contactId, [key]);
    if (!claim?.fresh?.includes(key)) continue;
    d._done?.add(key);
    const out = await d.processInboundReply({
      contactId: item.contactId,
      body: bodyText(item.body),
      messageType: item.messageType,
      messageId: item.messageId,
      direction: 'inbound',
      dateAdded: item.sentAt,
    }, { source: 'missed_inbound_sweep' });
    redriven++;
    const classification = out?.response?.classification || null;
    log.log?.(`[InboundSweep] re-drove ${item.messageType} ${item.messageId} for ${item.contactId} (sent ${item.sentAt}): ${classification || 'unknown'}`);
    await Promise.resolve(d.emitEvent?.({
      event_type: 'agentic.missed_inbound_redriven',
      source: 'missed_inbound_sweep',
      entity_type: 'contact',
      entity_id: item.contactId,
      ghl_contact_id: item.contactId,
      priority: 'normal',
      bypass_filter: true,
      payload: { message_id: item.messageId, message_type: item.messageType, sent_at: item.sentAt, classification },
      idempotency_key: `missed_inbound_${item.messageId}`,
    })).catch(() => {});
  }
  return { ok: true, mode, checked: plan.length, redriven };
}

let timer = null;
let running = false;
let liveDeps = null;

export function startMissedInboundScheduler(env = process.env) {
  if (timer) return timer;
  if (sweepMode(env) === 'off') {
    console.log('[InboundSweep] scheduler not started (MISSED_INBOUND_SWEEP_MODE=off)');
    return null;
  }
  const tick = async () => {
    if (running) return; // a slow pass must not overlap itself
    running = true;
    try {
      liveDeps ||= { ...(await defaultDeps()), _done: new Set() };
      if (liveDeps._done.size > 5000) liveDeps._done.clear();
      await runMissedInboundSweep({ deps: liveDeps });
    } catch (err) {
      console.warn(`[InboundSweep] pass failed: ${err.message}`);
    } finally {
      running = false;
    }
  };
  timer = setInterval(tick, INTERVAL_MS);
  if (typeof timer.unref === 'function') timer.unref();
  console.log(`[InboundSweep] scheduler started — every ${INTERVAL_MS / 1000}s (${sweepMode(env)})`);
  return timer;
}

export function stopMissedInboundScheduler() {
  if (timer) { clearInterval(timer); timer = null; }
}
