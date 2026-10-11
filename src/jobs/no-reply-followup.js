/**
 * No-reply follow-up — src/jobs/no-reply-followup.js
 *
 * 2026-10-11 (Javier, r5hMYoAdxhAPmj9U5Mjv). His web-chat "Hi" landed at
 * 20:51:40Z; GHL's welcome SMS went at 20:51:49Z ("What are you hoping to get
 * done with your windows or doors?"); the bot answered the "Hi" at 20:52:26Z
 * with "thanks for reaching back out". He had replied to nothing.
 *
 * When the lead's message is OLDER than the welcome text and nothing came in
 * after it (discipline.reply.trigger_predates_opener), the welcome already
 * answered that greeting. In live mode the bot's reply is held and ONE row is
 * queued here; ten minutes after the welcome, if the lead is still quiet,
 * they get the one approved check-in (buildNoReplyFollowup). Mark, 2026-10-11:
 * a follow-up is good, but it must fit the situation.
 *
 * AIOS: CANON.RULE.052 (the hold is decided from typed timing fields, the copy
 * is fixed), CANON.RULE.064 (new outward behaviour ships in shadow; Mark flips
 * OPENER_HOLD_MODE=live).
 *
 * OPENER_HOLD_MODE (default shadow):
 *   off    — nothing is queued or held.
 *   shadow — the row is written with status 'shadow' and an `opener_hold`
 *            event recorded; the bot still replies. Nothing is ever sent here.
 *   live   — the reply is held, the row is 'pending', and this job sends.
 *
 * Every read of agentic_no_reply_followups tolerates the table not existing
 * yet (sql/157): one log line, then carry on. A reply never fails on it.
 */

import supabase from '../supabase.js';
import { emitEvent } from '../event-emitter.js';
import {
  buildNoReplyFollowup,
  findRepeatedOpener,
  findBookingAsks,
} from '../agentic/discovery-discipline.js';
import { mayMessage } from '../services/may-message.js';
import { matchSuppressionTags } from '../services/suppression-check.js';
import { isInQuietHours, nextSendWindowOpenAt } from '../services/quiet-hours.js';
import { appointmentOnFile } from '../agentic/booking-claim.js';

export const FOLLOWUP_RULE = 'NO_REPLY_FOLLOWUP';
const TABLE = 'agentic_no_reply_followups';
const BATCH_LIMIT = 25;
// A row we cannot read the thread or tags for is retried each tick, then
// given up an hour past due: a check-in that late no longer fits.
const UNREADABLE_GIVE_UP_MS = 60 * 60 * 1000;

export function openerHoldMode() {
  const m = String(process.env.OPENER_HOLD_MODE || 'shadow').trim().toLowerCase();
  return m === 'off' || m === 'live' ? m : 'shadow';
}

export function noReplyFollowupMinutes() {
  const n = parseInt(process.env.NO_REPLY_FOLLOWUP_MIN || '10', 10);
  return Number.isFinite(n) && n > 0 ? n : 10;
}

let tableMissingLogged = false;
function isMissingTable(error) {
  const text = `${error?.code || ''} ${error?.message || ''}`;
  return /42P01|PGRST205|does not exist|Could not find the table/i.test(text);
}
function noteMissingTable(where) {
  if (tableMissingLogged) return;
  tableMissingLogged = true;
  console.warn(`[NoReplyFollowup] ${TABLE} does not exist yet (${where}) — apply sql/157 from the dashboard; continuing without it`);
}

/**
 * Queue the one follow-up for this welcome text and record the hold.
 * Never throws: the reply path calls it inline.
 * AIOS: CANON.RULE.064 — in shadow the row is 'shadow' and nothing is sent.
 *
 * @param {object} a
 * @param {string} a.contactId
 * @param {string|null} [a.conversationId]
 * @param {object} a.discipline   buildDiscipline() output (reply + opener)
 * @param {string} a.mode         'shadow' | 'live'
 * @param {string} [a.surface]    'sms_reply' | 'pre_send' | 'live_chat'
 * @param {boolean} [a.held]      was the bot's reply actually held
 * @param {string} [a.triggerPreview]
 */
export async function enqueueNoReplyFollowup({
  contactId, conversationId = null, discipline, mode, surface = 'sms_reply', held = false, triggerPreview = '',
} = {}, deps = {}) {
  const db = deps.supabase || supabase;
  const emit = deps.emitEvent || emitEvent;
  const nowMs = deps.now ? deps.now() : Date.now();
  const reply = discipline?.reply || {};
  const openerMs = reply.opener_ms;
  if (!contactId || !Number.isFinite(openerMs)) return { queued: false, reason: 'no_opener_time' };
  const rowMode = mode === 'live' ? 'live' : 'shadow';
  const dueMs = openerMs + noReplyFollowupMinutes() * 60_000;
  const row = {
    ghl_contact_id: contactId,
    conversation_id: conversationId || null,
    opener_message_at: new Date(openerMs).toISOString(),
    trigger_message_at: Number.isFinite(reply.trigger_ms) ? new Date(reply.trigger_ms).toISOString() : null,
    due_at: new Date(dueMs).toISOString(),
    status: rowMode === 'live' ? 'pending' : 'shadow',
    mode: rowMode,
    updated_at: new Date(nowMs).toISOString(),
  };

  let queued = false;
  if (db) {
    try {
      const { data, error } = await db.from(TABLE)
        .upsert(row, { onConflict: 'ghl_contact_id,opener_message_at', ignoreDuplicates: true })
        .select('id');
      if (error) {
        if (isMissingTable(error)) noteMissingTable('enqueue');
        else console.warn(`[NoReplyFollowup] enqueue failed for ${contactId}: ${error.message}`);
      } else {
        queued = Array.isArray(data) ? data.length > 0 : !!data;
      }
    } catch (err) {
      console.warn(`[NoReplyFollowup] enqueue threw for ${contactId}: ${err.message}`);
    }
  }

  try {
    await emit({
      event_type: 'opener_hold',
      source: 'no_reply_followup',
      entity_type: 'contact',
      entity_id: String(contactId),
      ghl_contact_id: contactId,
      priority: 'low',
      bypass_filter: true,
      idempotency_key: `opener_hold_${contactId}_${openerMs}_${surface}`,
      payload: {
        contact_id: contactId,
        mode: rowMode,
        surface,
        held: !!held,
        trigger_at: row.trigger_message_at,
        opener_at: row.opener_message_at,
        due_at: row.due_at,
        opener_preview: String(discipline?.opener?.text || '').slice(0, 160),
        trigger_preview: String(triggerPreview || '').slice(0, 160),
        queued,
      },
    });
  } catch (err) {
    console.warn(`[NoReplyFollowup] opener_hold event failed for ${contactId}: ${err.message}`);
  }

  console.log(`[NoReplyFollowup] ${rowMode} ${surface} ${contactId}: lead's message predates the welcome text — ${held ? 'reply held' : 'reply not held'}, follow-up ${queued ? `queued for ${row.due_at}` : 'already queued or not written'}`);
  return { queued, row };
}

// ── the decision, pure ────────────────────────────────────────────────────

function turnMs(m) {
  const ms = Date.parse(m?.timestamp ?? m?.dateAdded ?? m?.at ?? '');
  return Number.isFinite(ms) ? ms : null;
}
function turnDirection(m) {
  const d = m?.direction;
  return d === 'inbound' || d === 1 || d === '1' ? 'inbound' : 'outbound';
}

/**
 * What to do with one due row. Pure, apart from the send gate's fire-and-forget
 * disagreement report inside matchSuppressionTags.
 *
 * @param {object} a
 * @param {object} a.row             the agentic_no_reply_followups row
 * @param {Array|null} a.conversation  thread turns ({direction, text, timestamp}); null = unreadable
 * @param {string[]|null} a.tags     contact tags; null = unreadable
 * @param {object|null} a.appointment appointmentOnFile() result
 * @param {number} a.nowMs
 * @param {boolean} a.inQuietHours
 * @param {string|null} a.nextWindowIso
 * @param {string|null} a.firstName
 * @returns {{action: 'skip'|'defer'|'wait'|'send', reason?: string, due_at?: string, text?: string}}
 */
export function decideFollowup({ row, conversation, tags, appointment = null, nowMs, inQuietHours = false, nextWindowIso = null, firstName = null }) {
  const openerMs = Date.parse(row?.opener_message_at || '');
  const dueMs = Date.parse(row?.due_at || '');
  if (!Number.isFinite(openerMs)) return { action: 'skip', reason: 'no_opener_time' };

  if (!Array.isArray(conversation) || !conversation.length || !Array.isArray(tags)) {
    if (Number.isFinite(dueMs) && nowMs - dueMs > UNREADABLE_GIVE_UP_MS) return { action: 'skip', reason: 'unreadable' };
    return { action: 'wait', reason: 'unreadable' };
  }

  const turns = conversation
    .filter(m => !/^TYPE_ACTIVITY/i.test(String(m?.messageType || '')))
    .map(m => ({ direction: turnDirection(m), ms: turnMs(m), text: String(m?.text ?? m?.body ?? '').trim() }))
    .filter(t => t.text && t.ms !== null);
  if (turns.some(t => t.direction === 'inbound' && t.ms > openerMs)) return { action: 'skip', reason: 'lead_replied' };
  if (turns.some(t => t.direction === 'outbound' && t.ms > openerMs)) return { action: 'skip', reason: 'we_sent_since' };

  const gate = mayMessage({ tags, channel: 'sms', purpose: 'outreach' });
  if (!gate.allowed && (gate.reason === 'consent_stop' || gate.reason === 'bot_stop')) return { action: 'skip', reason: 'dnd_or_opt_out' };
  if (!gate.allowed) return { action: 'skip', reason: 'suppressed' };
  if (matchSuppressionTags(tags, { channel: 'sms', route: 'no_reply_followup' })?.suppressed) return { action: 'skip', reason: 'suppressed' };

  if (appointment) return { action: 'skip', reason: 'booked' };

  if (inQuietHours && nextWindowIso) return { action: 'defer', reason: 'quiet_hours', due_at: nextWindowIso };

  const text = buildNoReplyFollowup(firstName);
  const opener = turns.find(t => t.direction === 'outbound' && t.ms === openerMs)?.text || '';
  if (findRepeatedOpener(text, opener).length || findBookingAsks(text).length) return { action: 'skip', reason: 'copy_check_failed' };
  return { action: 'send', text };
}

// ── production reads ──────────────────────────────────────────────────────

async function defaultReadContact(contactId) {
  const { buildLeadContext } = await import('../context-builder.js');
  const { fetchRecentAndUpcomingAppointments } = await import('../knowledge/contact-appointments.js');
  const context = await buildLeadContext(contactId, { includeConversation: true, skipCache: true });
  const upcoming = await fetchRecentAndUpcomingAppointments(contactId).catch(() => null);
  const conversation = Array.isArray(context?.conversation_recent) ? context.conversation_recent : null;
  const tags = Array.isArray(context?.lead?.current_tags) ? context.lead.current_tags : null;
  return {
    conversation,
    tags,
    firstName: context?.lead?.first_name || null,
    appointment: appointmentOnFile({ upcomingAppointments: upcoming, lp: context?.lp || null }),
  };
}

async function defaultQueueSend(db, row, text) {
  const { data, error } = await db.from('agent_actions').insert({
    event_id: null,
    action_type: 'send_message',
    target_system: 'ghl',
    target_entity: 'contact',
    target_id: row.ghl_contact_id,
    action_payload: {
      channel: 'sms',
      message: text,
      trigger_id: `no-reply-followup-${row.id}`,
      followup_kind: 'no_reply_followup',
      no_reply_followup_id: row.id,
    },
    reasoning: `The lead's first message came before the welcome text at ${row.opener_message_at} and they have not answered it. ` +
      'One approved check-in (Mark, 2026-10-11).',
    confidence: 1.0,
    rule_applied: FOLLOWUP_RULE,
    status: 'pending',
    requires_approval: false,
    priority: 5,
  }).select('id').single();
  if (error) throw new Error(error.message);
  return data?.id ?? null;
}

async function setRow(db, id, patch, nowMs) {
  const { error } = await db.from(TABLE).update({ ...patch, updated_at: new Date(nowMs).toISOString() }).eq('id', id);
  if (error) console.warn(`[NoReplyFollowup] row ${id} update failed: ${error.message}`);
}

/**
 * One pass. Best-effort: never throws into the heartbeat. deps is a test seam.
 */
export async function runNoReplyFollowup(deps = {}) {
  const mode = deps.mode || openerHoldMode();
  if (mode !== 'live') return { skipped: true, reason: `OPENER_HOLD_MODE=${mode}` };
  const db = deps.supabase || supabase;
  if (!db) return { skipped: true, reason: 'no_supabase' };
  const nowMs = deps.now ? deps.now() : Date.now();
  const readContact = deps.readContact || defaultReadContact;
  const queueSend = deps.queueSend || ((row, text) => defaultQueueSend(db, row, text));
  const quiet = deps.inQuietHours || ((d) => isInQuietHours(d));
  const nextWindow = deps.nextSendWindowOpenAt || ((d) => nextSendWindowOpenAt(d));

  let rows;
  try {
    const { data, error } = await db.from(TABLE)
      .select('id, ghl_contact_id, conversation_id, opener_message_at, trigger_message_at, due_at, status, mode')
      .eq('status', 'pending')
      .lte('due_at', new Date(nowMs).toISOString())
      .order('due_at', { ascending: true })
      .limit(BATCH_LIMIT);
    if (error) {
      if (isMissingTable(error)) { noteMissingTable('sweep'); return { skipped: true, reason: 'table_missing' }; }
      throw error;
    }
    rows = Array.isArray(data) ? data : [];
  } catch (err) {
    console.warn(`[NoReplyFollowup] due read failed: ${err.message}`);
    return { error: err.message };
  }

  const counts = { due: rows.length, sent: 0, skipped: 0, deferred: 0, waiting: 0, errors: 0 };
  for (const row of rows) {
    // Claim it, so two overlapping instances (a deploy) cannot both send.
    try {
      const { data: claimed, error } = await db.from(TABLE)
        .update({ status: 'sending', updated_at: new Date(nowMs).toISOString() })
        .eq('id', row.id).eq('status', 'pending').select('id');
      if (error || !Array.isArray(claimed) || !claimed.length) continue;
    } catch { continue; }

    let decision;
    try {
      const read = await readContact(row.ghl_contact_id);
      const now = new Date(nowMs);
      const inQuiet = !!quiet(now);
      decision = decideFollowup({
        row,
        conversation: read?.conversation ?? null,
        tags: read?.tags ?? null,
        appointment: read?.appointment ?? null,
        nowMs,
        inQuietHours: inQuiet,
        nextWindowIso: inQuiet ? nextWindow(now) : null,
        firstName: read?.firstName || null,
      });
    } catch (err) {
      console.warn(`[NoReplyFollowup] read failed for ${row.ghl_contact_id}: ${err.message}`);
      decision = decideFollowup({ row, conversation: null, tags: null, nowMs });
    }

    if (decision.action === 'wait') {
      counts.waiting++;
      await setRow(db, row.id, { status: 'pending' }, nowMs);
      continue;
    }
    if (decision.action === 'defer') {
      counts.deferred++;
      await setRow(db, row.id, { status: 'pending', due_at: decision.due_at }, nowMs);
      console.log(`[NoReplyFollowup] ${row.ghl_contact_id}: quiet hours — follow-up moved to ${decision.due_at}`);
      continue;
    }
    if (decision.action === 'skip') {
      counts.skipped++;
      await setRow(db, row.id, { status: 'skipped', skip_reason: decision.reason }, nowMs);
      console.log(`[NoReplyFollowup] ${row.ghl_contact_id}: skipped (${decision.reason})`);
      continue;
    }
    try {
      const actionId = await queueSend(row, decision.text);
      counts.sent++;
      await setRow(db, row.id, { status: 'sent', message_text: decision.text, sent_message_id: actionId != null ? String(actionId) : null }, nowMs);
      console.log(`[NoReplyFollowup] ${row.ghl_contact_id}: follow-up queued as send_message ${actionId} (rule ${FOLLOWUP_RULE})`);
    } catch (err) {
      counts.errors++;
      await setRow(db, row.id, { status: 'pending' }, nowMs);
      console.warn(`[NoReplyFollowup] send queue failed for ${row.ghl_contact_id}: ${err.message}`);
    }
  }
  if (rows.length) console.log(`[NoReplyFollowup] live: ${JSON.stringify(counts)}`);
  return { mode, ...counts };
}
