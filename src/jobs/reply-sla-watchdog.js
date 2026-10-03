/**
 * Reply SLA Watchdog — src/jobs/reply-sla-watchdog.js
 *
 * 2026-09-02 (Jacqueline Branham, gpPQYhCsqdGy10wU14Rp). The one guarantee
 * that does not depend on WHICH internal path broke: a reply the bot owns
 * that has no completed send after REPLY_SLA_MINUTES pages a human.
 *
 * Every existing alarm watches a proxy — analyzer output (agentic-silence-
 * alerts.js, 6h aggregate), backstop outcome (reply_unanswered:
 * backstop_matched_zero_actions), responder outcome (responder_created_no_send,
 * no consumer). None of them see the case that hit this contact: analyzed,
 * dispatched, send queued, and then 22 minutes of queue wait plus a watchdog
 * timeout. This job watches the OUTPUT per contact.
 *
 * Classification per reply (pure, tested):
 *   silenced        action_taken starts with `bot_silenced:` / `skipped:` —
 *                   the bot was deliberately quiet (stop-bot, DNC, dedup).
 *   not_agentic     contact does not carry agentic-active.
 *   consent_blocked contact carries stop-bot or a consent/DNC tag.
 *   unknown         no tag snapshot — "I couldn't tell" must NOT page.
 *   answered        a completed send_message exists at/after the reply.
 *   unanswered      everything else → emit agentic.reply_unanswered.
 *
 * MODE (REPLY_SLA_WATCHDOG_MODE, default shadow):
 *   off    — no-op.
 *   shadow — emits reason `no_send_within_sla_shadow` (no consuming rule;
 *            queryable in system_events) and logs. Ship in this mode.
 *   live   — emits reason `no_send_within_sla`, which
 *            AGENTIC_REPLY_SLA_ALERT (sql/seeds/2026-09-02_...) turns into a
 *            priority GroupMe page + GHL task. Flip after a clean shadow week.
 *
 * Idempotent per source event (idempotency_key reply_sla_<event id>), so
 * flipping shadow → live never re-flags replies already recorded.
 *
 * 2026-10-03 (Mark: "the bot needs to always respond"). A text the bot dropped
 * by mistake ("Well we have hurricane shutters now.", burst-yield.js) waited
 * the full 10 minutes for this backstop. The SLA is now 3 minutes. A reply
 * that is still being written (a send_message row pending/approved/executing,
 * younger than the send path's own budget) is `in_flight`, not unanswered,
 * so a slow 60–100s reply is waited for and never answered twice.
 */

import supabase from '../supabase.js';
import { emitEvent } from '../event-emitter.js';

const MODE = String(process.env.REPLY_SLA_WATCHDOG_MODE || 'shadow').toLowerCase();
const SLA_MINUTES = Math.max(1, parseInt(process.env.REPLY_SLA_MINUTES || '3', 10));
const LOOKBACK_HOURS = Math.max(1, parseInt(process.env.REPLY_SLA_LOOKBACK_HOURS || '24', 10));

// Mirrors guardrail #8 (always-respond policy): a direct reply is blocked ONLY
// by stop-bot and the consent/DNC family. Operational suppressors are NOT here.
export const CONSENT_BLOCK_TAGS = new Set([
  'stop-bot', 'dnc', 'dnc-sms', 'do-not-contact', 'stage:dnc', 'unsubscribed',
]);

function normTags(tags) {
  return Array.isArray(tags) ? tags.map((t) => String(t).trim().toLowerCase()) : null;
}

/**
 * Pure classifier. `tags` = null means the snapshot was unreadable.
 */
export function classifyReply({ actionTaken, tags, hasCompletedSend, hasInFlightSend = false }) {
  const at = typeof actionTaken === 'string' ? actionTaken : '';
  if (at.startsWith('bot_silenced:') || at.startsWith('skipped:')) return 'silenced';
  if (hasCompletedSend) return 'answered';
  if (hasInFlightSend) return 'in_flight';
  const t = normTags(tags);
  if (t === null) return 'unknown';
  if (!t.includes('agentic-active')) return 'not_agentic';
  if (t.some((x) => CONSENT_BLOCK_TAGS.has(x))) return 'consent_blocked';
  return 'unanswered';
}

export function slaReason(mode = MODE) {
  return mode === 'live' ? 'no_send_within_sla' : 'no_send_within_sla_shadow';
}

async function readTags(db, contactId) {
  try {
    const { data, error } = await db
      .from('contact_tag_snapshot')
      .select('tags')
      .eq('ghl_contact_id', contactId)
      .maybeSingle();
    if (error || !data || !Array.isArray(data.tags)) return null;
    return data.tags;
  } catch {
    return null;
  }
}

const IN_FLIGHT_STATUSES = new Set(['pending', 'approved', 'executing']);

/**
 * Pure: from the contact's send_message rows since the reply, was it answered,
 * or is a reply still being written? A row older than `inFlightMs` is stuck,
 * not in flight (the reaper owns it), so it no longer holds the backstop off.
 */
export function sendStateFromRows(rows, { now, inFlightMs }) {
  const list = Array.isArray(rows) ? rows : [];
  const hasCompletedSend = list.some((r) => r?.status === 'completed');
  const hasInFlightSend = !hasCompletedSend && list.some((r) => IN_FLIGHT_STATUSES.has(r?.status)
    && Number.isFinite(Date.parse(r?.created_at)) && (now - Date.parse(r.created_at)) < inFlightMs);
  return { hasCompletedSend, hasInFlightSend };
}

async function sendRowsSince(db, contactId, sinceIso) {
  const { data, error } = await db
    .from('agent_actions')
    .select('id, status, created_at')
    .eq('target_id', contactId)
    .eq('action_type', 'send_message')
    .gte('created_at', sinceIso)
    .order('created_at', { ascending: false })
    .limit(10);
  if (error) throw new Error(`agent_actions read failed: ${error.message}`);
  return Array.isArray(data) ? data : [];
}

// The send path's own ceiling (the executor's send_message watchdog derives
// from the same budget). Loaded lazily: only a pass that finds an unfinished
// row needs it, and the module is heavy.
async function defaultInFlightMs() {
  const fromEnv = parseInt(process.env.REPLY_SLA_IN_FLIGHT_MS || '', 10);
  if (Number.isFinite(fromEnv) && fromEnv > 0) return fromEnv;
  const { sendMessageBudgetMs } = await import('../send-message-handler.js');
  return Math.max(120_000, sendMessageBudgetMs());
}

/**
 * One pass. Best-effort: a read failure is logged and returns { error }, never
 * throws into the heartbeat. deps is a test seam only.
 */
export async function runReplySlaWatchdog(deps = {}) {
  const mode = deps.mode || MODE;
  if (mode === 'off') return { skipped: true, reason: 'REPLY_SLA_WATCHDOG_MODE=off' };
  const db = deps.supabase || supabase;
  const emit = deps.emitEvent || emitEvent;
  const now = deps.now ? deps.now() : Date.now();
  if (!db) return { skipped: true, reason: 'no_supabase' };

  const since = new Date(now - LOOKBACK_HOURS * 3600_000).toISOString();
  const cutoff = new Date(now - SLA_MINUTES * 60_000).toISOString();

  let replies;
  try {
    const { data, error } = await db
      .from('system_events')
      .select('id, ghl_contact_id, created_at, action_taken, payload')
      .eq('event_type', 'ghl.reply_received')
      .eq('event_subtype', 'pending_analysis')
      .gte('created_at', since)
      .lte('created_at', cutoff)
      .order('created_at', { ascending: true })
      .limit(500);
    if (error) throw error;
    replies = Array.isArray(data) ? data : [];
  } catch (err) {
    console.warn(`[ReplySLA] reply read failed: ${err.message}`);
    return { error: err.message };
  }

  const counts = { scanned: replies.length, answered: 0, in_flight: 0, silenced: 0, not_agentic: 0, consent_blocked: 0, unknown: 0, unanswered: 0, emitted: 0 };
  let inFlightMs = deps.inFlightMs || null;
  const flagged = [];

  for (const r of replies) {
    const contactId = r.ghl_contact_id || null;
    if (!contactId) { counts.unknown++; continue; }
    let state;
    try {
      const rows = await sendRowsSince(db, contactId, r.created_at);
      if (!inFlightMs && rows.some((x) => IN_FLIGHT_STATUSES.has(x?.status))) inFlightMs = await defaultInFlightMs();
      state = sendStateFromRows(rows, { now, inFlightMs: inFlightMs || 0 });
    } catch (err) {
      console.warn(`[ReplySLA] send read failed for ${contactId}: ${err.message}`);
      counts.unknown++;
      continue;
    }
    const tags = (state.hasCompletedSend || state.hasInFlightSend) ? [] : await readTags(db, contactId);
    const cls = classifyReply({ actionTaken: r.action_taken, tags, ...state });
    counts[cls]++;
    if (cls !== 'unanswered') continue;

    const ageMin = Math.round((now - Date.parse(r.created_at)) / 60_000);
    flagged.push({ event_id: r.id, contact_id: contactId, age_min: ageMin });
    try {
      const res = await emit({
        event_type: 'agentic.reply_unanswered',
        source: 'reply_sla_watchdog',
        entity_type: 'contact',
        entity_id: String(contactId),
        ghl_contact_id: contactId,
        priority: 'high',
        bypass_filter: true,
        payload: {
          source_event_id: r.id,
          reason: slaReason(mode),
          sla_minutes: SLA_MINUTES,
          age_minutes: ageMin,
          contact_id: contactId,
          message_preview: String(r.payload?.message_text || '').slice(0, 100),
          // 2026-09-21 — the self-heal rules read these. message_preview alone
          // could not drive payload_message_matches (100 chars truncates an
          // opt-out mid-sentence: "…please take me o"), and without inbound_at
          // a recovery reply cannot tell whether a rep already answered.
          // All three come from the row this loop already selected — no extra
          // read. Capped at 1000 chars: long enough for any opt-out wording,
          // short enough that system_events.payload stays a payload.
          message_text: String(r.payload?.message_text || '').slice(0, 1000),
          channel: r.payload?.channel || null,
          inbound_at: r.created_at,
        },
        idempotency_key: `reply_sla_${r.id}`,
      });
      if (res?.id) counts.emitted++;
    } catch (err) {
      console.warn(`[ReplySLA] emit failed for event ${r.id}: ${err.message}`);
    }
  }

  if (counts.unanswered > 0) {
    console.error(
      `[ReplySLA] ${mode.toUpperCase()}: ${counts.unanswered} reply(ies) past ${SLA_MINUTES}m with no completed send — ` +
      flagged.map((f) => `${f.contact_id} (evt ${f.event_id}, ${f.age_min}m)`).join('; ')
    );
  } else {
    console.log(`[ReplySLA] ${mode}: ${counts.scanned} scanned, 0 unanswered (answered=${counts.answered}, in_flight=${counts.in_flight}, silenced=${counts.silenced}, not_agentic=${counts.not_agentic}, consent=${counts.consent_blocked}, unknown=${counts.unknown})`);
  }
  return { mode, sla_minutes: SLA_MINUTES, ...counts, flagged };
}
