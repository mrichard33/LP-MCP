/**
 * GroupMe Integration — src/groupme.js
 *
 * Two-way GroupMe integration for the agentic system:
 *   1. OUTBOUND: Send notifications and approval requests to GroupMe
 *   2. INBOUND:  Receive replies via callback webhook, match to pending actions
 *
 * Approval flow (v1.6):
 *   - Action created with requires_approval=true
 *   - Bot posts approval request with action ID
 *   - User replies with one of:
 *       "Yes 1234"          → approve & queue execution
 *       "No 1234"           → reject
 *       "Edit 1234 <desc>"  → AI rewrites with the description as guidance
 *
 * v1.8 — CONTENT DEDUP BACKSTOP (2026-08-27).
 *   PROBLEM: the v1.7 debounce below only consolidates messages that carry a
 *   contactId and are not flushNow. Everything else — every operator card,
 *   every system event, and BOTH "LP Appointment Set" emitters
 *   (actions/handlers/lp-appointment.js and lp-appointment-sync.js, which call
 *   sendGroupMeMessage(text) with no opts) — takes the immediate path, which
 *   had no dedup at all. Byte-identical cards therefore always sent. On
 *   2026-08-26 one GHL appointment produced two system_events, two LP writes
 *   and two identical cards.
 *
 *   FIX: a sha256 of `${channel}|${text.trim()}` is claimed in
 *   groupme_notification_marks immediately before every POST. An in-window
 *   collision suppresses the send and returns
 *   { sent: false, reason: 'duplicate_suppressed' }. The channel is in the
 *   hash, so the same text still reaches a different audience. Suppression is
 *   windowed (GROUPME_DEDUP_WINDOW_MIN, default 60), never permanent.
 *
 *   FAIL-OPEN everywhere: a missing table, a DB error or a throw sends the
 *   card. Approval cards opt out entirely via opts.noDedup. Kill without a
 *   redeploy with GROUPME_DEDUP_ENABLED=false.
 *
 *   This is a BACKSTOP, not the fix — it catches the third identical card and
 *   every future emitter. The duplicate producers are removed at source.
 *
 * v1.7 — DEBOUNCED CONSOLIDATION (2026-05-14).
 *   PROBLEM: When the action executor fires multiple actions for the same
 *   contact within seconds (e.g. one inbound message triggering
 *   send_message + create_task("HOT WINDOW") + create_task("Objection") +
 *   behavioral hyperactive), each handler independently called
 *   sendGroupMeMessage(). Mark's GroupMe inbox got 3-5 separate cards for
 *   one contact in <2 seconds, fragmenting visibility.
 *
 *   FIX: sendGroupMeMessage now accepts opts = { contactId, contactName,
 *   flushNow }. When contactId is provided AND flushNow is falsy, the
 *   message is queued in an in-memory buffer keyed by contactId for
 *   GROUPME_DEBOUNCE_MS (default 5000ms). All messages for the same
 *   contact within that window emit as ONE consolidated card with the
 *   count, contact display name, and a horizontal-rule separator between
 *   entries.
 *
 *   Callers WITHOUT contactId (system events, sync alerts) or WITH
 *   flushNow:true (approval cards, error cards, immediate operator
 *   notifications) fire immediately as before. The 5s window starts on
 *   the FIRST queued message and is NOT reset by subsequent additions —
 *   the buffer flushes at most 5s after the first event.
 *
 *   Backward-compat: sendGroupMeMessage(text) without opts behaves
 *   exactly as before (immediate send). No callers break by omission.
 *
 *   Buffer cap: MAX_CONSOLIDATED_LINES (20) per contact; once reached,
 *   the buffer flushes immediately and a new one opens for the same
 *   contact. Protects against runaway behavioral firing.
 *
 *   Process restart: buffer is in-memory only. On Railway redeploy or
 *   crash, up to 5s of routine notifications could be lost. Approval
 *   cards (sendApprovalRequest) are NOT affected — they use the durable
 *   groupme_approval_requests table for dedup and don't pass through the
 *   debounce queue.
 *
 * v1.6.1 — TRIGGER RECOVERY BUGFIX (2026-04-29).
 *   Fixes two bugs in v1.6's resolveTriggerMessage that broke the Edit X
 *   command in nearly every real-world case:
 *     1. Queried the `event_data` column, which doesn't exist — the
 *        actual column on system_events is `payload` (jsonb). Every
 *        invocation hit a SQL error and returned null.
 *     2. Even after the column-name fix, the action's event_id usually
 *        points at an `ai.analysis_completed` event whose payload only
 *        carries a 200-char truncated `message_preview` — not the full
 *        inbound. The full `message_text` lives on the upstream
 *        `ghl.reply_received` event fired moments earlier.
 *   Replaced with recoverTriggerMessage(eventId, contactIdHint), which:
 *     - reads from `payload` (correct column)
 *     - returns the event's own payload.message_text if present (direct
 *       reply_received case)
 *     - otherwise traces back to the most recent ghl.reply_received for
 *       the same ghl_contact_id at-or-before the action's event timestamp
 *       and returns its full message_text
 *     - falls back to payload.message_preview only as a last resort
 *     - returns { text, source } so the log line can record which path
 *       was taken
 *   Edit X is now actually usable.
 *
 * v1.6 — EDIT X COMMAND + IN-CONTEXT LEARNING LOOP (2026-04-29).
 *   New third option on every approval card: `Edit <ref> <description>`.
 *   When fired:
 *     1. Look up the pending approval and its send_message action
 *     2. Pull the original triggerMessage from the system_events row
 *     3. Call generateResponse() with opts.editInstruction + opts.previousMessage
 *        — response-generator v2.7.4 injects a HUMAN CORRECTION block into
 *        the user prompt so the model rewrites with the correction applied
 *     4. UPDATE the agent_actions row's payload.message with the new text
 *     5. INSERT into agent_response_edits — this row becomes a future
 *        in-context learning example for ALL responses with the same
 *        intent_class. Continuous self-improvement, no fine-tuning.
 *     6. Archive the old groupme_approval_requests row (suffix the
 *        short_ref to free it) and send a fresh approval card with the
 *        original short_ref. Mark can keep editing (recursive) or approve.
 *
 *   The footer line on every approval card now reads:
 *     Reply: Yes 1234  •  No 1234  •  Edit 1234 <describe change>
 *
 * v1.5 — INSERT-FIRST DEDUP (2026-04-29).
 *   Closes the parallel-card race surfaced on action #28144. The
 *   tracking record is now claimed BEFORE the GroupMe send, using the
 *   unique constraint on short_ref to serialize concurrent workers.
 *
 * v1.4 — Zombie-proof tracking (superseded by v1.5).
 * v1.3 — Auto-execute after approval.
 * v1.2 — Enriched approval requests with full decision context.
 * v1.1 — Fix: rejection uses status='rejected' (was 'cancelled').
 *
 * Routes:
 *   POST /webhook/groupme — Callback URL for GroupMe bot
 *   POST /groupme/send    — Manual send (for testing)
 *   GET  /groupme/pending — View pending approval requests
 *   GET  /groupme/queue-state — View in-flight debounce buffers (v1.7)
 */

import { createHash } from 'node:crypto';
import supabase from './supabase.js';
import { generateResponse } from './response-generator.js';

const GROUPME_BOT_ID = process.env.GROUPME_BOT_ID || '';
const GROUPME_GROUP_ID = process.env.GROUPME_GROUP_ID || '';
// Per-purpose bot for the dedicated "Canvassing — SMS Confirmed" group.
// Canvass-channel cards (SMS-CONFIRMED, TIME CHANGE, intake alerts) route
// here; everything else stays on the main bot.
const GROUPME_CANVASS_BOT_ID = process.env.GROUPME_CANVASS_BOT_ID || '';
// Per-purpose bot for low-volume OPERATIONAL alarms — feed-freshness and the
// like, where being seen matters more than being near the lead traffic.
//
// Added 2026-08-12. Report 134 stopped ingesting for six days; the watchdog
// alerted correctly every morning into the main channel, which carries
// hundreds of per-lead cards plus a repeating queue-backlog ping, and the
// alarm was never seen. The outage surfaced when a person read a stale date
// on a dashboard. Unset until a group exists — and unset is harmless, because
// the fallback below keeps every message on the main bot.
const GROUPME_OPS_BOT_ID = process.env.GROUPME_OPS_BOT_ID || '';
const SELF_BASE_URL = `http://localhost:${process.env.PORT || 8080}`;

let warnedCanvassFallback = false;
let warnedOpsFallback = false;

/**
 * Resolve a logical channel name to a GroupMe bot ID. Unknown/absent
 * channel → main bot. A configured channel whose env var is unset falls
 * back to the main bot (warn once) so no message is ever dropped.
 */
function _resolveBotId(channel) {
  if (channel === 'canvass') {
    if (GROUPME_CANVASS_BOT_ID) return GROUPME_CANVASS_BOT_ID;
    if (!warnedCanvassFallback) {
      console.warn('[GroupMe] GROUPME_CANVASS_BOT_ID unset — canvass-channel messages fall back to the main bot');
      warnedCanvassFallback = true;
    }
  }
  if (channel === 'ops') {
    if (GROUPME_OPS_BOT_ID) return GROUPME_OPS_BOT_ID;
    if (!warnedOpsFallback) {
      console.warn('[GroupMe] GROUPME_OPS_BOT_ID unset — ops-channel messages fall back to the main bot');
      warnedOpsFallback = true;
    }
  }
  return GROUPME_BOT_ID;
}

// ═══════════════════════════════════════════════════════════════════
// v1.7: DEBOUNCED CONSOLIDATION CONFIG + STATE
// ═══════════════════════════════════════════════════════════════════
//
// In-memory buffer keyed by contactId. Each entry:
//   {
//     contactId:        string  — the contact this buffer is for
//     contactName:      string|null — display name if any caller provided one
//     lines:            string[]    — queued message texts in arrival order
//     firstQueuedAt:    number      — Date.now() of the first line (timer anchor)
//     timer:            Timeout     — handle to the flush setTimeout
//   }
//
// Single-process Node = single shared Map. No cross-process coordination
// needed; the LP MCP runs as one Railway service instance. If we ever
// scale horizontally, this would need a Redis or DB-backed queue.

const NOTIFICATION_DEBOUNCE_MS = parseInt(
  process.env.GROUPME_DEBOUNCE_MS || '5000',
  10
);
const MAX_CONSOLIDATED_LINES = 20;
const MAX_CARD_CHARS = 950; // leave headroom under GroupMe's 1000-char hard limit

const pendingNotifications = new Map();

console.log(`[GroupMe] v1.7 debounce config: window=${NOTIFICATION_DEBOUNCE_MS}ms max_lines=${MAX_CONSOLIDATED_LINES} max_chars=${MAX_CARD_CHARS}`);

// ═══════════════════════════════════════════════════════════════════
// v1.8: CONTENT DEDUP BACKSTOP (2026-08-27)
// ═══════════════════════════════════════════════════════════════════
//
// The debounce layer above only consolidates messages that carry a contactId
// and are not flushNow. Every operator card, every system event and both "LP
// Appointment Set" emitters take the IMMEDIATE path, so byte-identical cards
// always sent. This is the last line of defence: a content hash claimed in
// groupme_notification_marks, so the SECOND identical card inside the window
// never reaches GroupMe — whichever emitter produced it, including ones that
// do not exist yet.
//
// It is a backstop, not the fix. The duplicate PRODUCERS are removed in the
// same branch (canvassing intake claim; one system_event per appointment).
//
// Safe default ON: only the literal 'false' disables it, so an unset or
// mistyped var still dedups. Killable without a redeploy.
const GROUPME_DEDUP_ENABLED = String(process.env.GROUPME_DEDUP_ENABLED ?? 'true') !== 'false';
const GROUPME_DEDUP_WINDOW_MIN = Math.max(
  1,
  parseInt(process.env.GROUPME_DEDUP_WINDOW_MIN || '60', 10) || 60,
);
const DEDUP_SAMPLE_CHARS = 200;
const DEDUP_PRUNE_INTERVAL_MS = 60 * 60 * 1000; // once per process-hour
const DEDUP_PRUNE_AFTER_DAYS = 7;

let lastDedupPruneAt = 0;

// Test seam. sendGroupMeMessage is called from ~40 sites with no dependency
// injection of any kind, and adding a client parameter to all of them to make
// one backstop testable would be worse than this. null = use the imported
// supabase singleton, which is what production always does.
let _dedupClientOverride = null;

/**
 * TESTS ONLY — point the dedup layer at a stub client. Production never calls
 * this; the module-level supabase import is the real client.
 */
export function __setDedupClientForTests(client) {
  _dedupClientOverride = client;
  lastDedupPruneAt = 0;
}

console.log(`[GroupMe] v1.8 dedup config: enabled=${GROUPME_DEDUP_ENABLED} window_min=${GROUPME_DEDUP_WINDOW_MIN}`);

/**
 * Opportunistic prune of dedup rows older than 7 days. Fire-and-forget and at
 * most once per process-hour — this must NEVER block or fail a send.
 */
function _maybePruneDedupMarks(client) {
  const now = Date.now();
  if (now - lastDedupPruneAt < DEDUP_PRUNE_INTERVAL_MS) return;
  lastDedupPruneAt = now;
  const cutoff = new Date(now - DEDUP_PRUNE_AFTER_DAYS * 24 * 60 * 60 * 1000).toISOString();
  Promise.resolve(
    client.from('groupme_notification_marks').delete().lt('first_sent_at', cutoff),
  ).then(
    ({ error } = {}) => {
      if (error) console.warn(`[GroupMe] dedup prune failed (ignored): ${error.message}`);
    },
    (err) => console.warn(`[GroupMe] dedup prune threw (ignored): ${err.message}`),
  );
}

/**
 * Is this exact card, on this exact channel, a duplicate of one sent inside the
 * window? Claims the hash by INSERT — the unique PK is what serializes two
 * concurrent emitters, the same doctrine as the v1.5 approval claim.
 *
 * The channel is part of the hash on purpose: the same text to a DIFFERENT
 * channel is two audiences and two legitimate cards.
 *
 * FAIL-OPEN on every error path — a card is never dropped because the dedup
 * table is missing, slow or unhappy. Returns true ONLY on a proven, in-window
 * duplicate.
 *
 * @returns {Promise<boolean>} true = suppress this send.
 */
async function _isDuplicateCard(text, channel, opts = {}) {
  const client = opts.client ?? _dedupClientOverride ?? supabase;
  if (!GROUPME_DEDUP_ENABLED) return false;
  if (!client || !text) return false;

  const chan = channel || 'main';
  const hash = createHash('sha256').update(`${chan}|${String(text).trim()}`).digest('hex');

  try {
    const { error: insErr } = await client.from('groupme_notification_marks').insert({
      dedup_hash: hash,
      channel: chan,
      sample: String(text).trim().slice(0, DEDUP_SAMPLE_CHARS),
      first_sent_at: new Date().toISOString(),
      hit_count: 1,
    });

    // No row existed — this card is new. Send it.
    if (!insErr) {
      _maybePruneDedupMarks(client);
      return false;
    }
    // Anything other than a PK collision is an infra problem, not a duplicate.
    if (insErr.code !== '23505') {
      console.warn(`[GroupMe] dedup insert failed (fail-open, sending): ${insErr.message}`);
      return false;
    }

    // Collision — decide by age, not by existence, so a card that recurs
    // tomorrow is news again.
    const { data: existing, error: selErr } = await client
      .from('groupme_notification_marks')
      .select('first_sent_at, hit_count')
      .eq('dedup_hash', hash)
      .maybeSingle();

    if (selErr || !existing) {
      console.warn(`[GroupMe] dedup lookup after collision failed (fail-open, sending): ${selErr?.message || 'row vanished'}`);
      return false;
    }

    const ageMs = Date.now() - new Date(existing.first_sent_at).getTime();
    if (Number.isNaN(ageMs)) return false;

    if (ageMs < GROUPME_DEDUP_WINDOW_MIN * 60000) {
      const { error: updErr } = await client
        .from('groupme_notification_marks')
        .update({ hit_count: (existing.hit_count || 1) + 1 })
        .eq('dedup_hash', hash);
      if (updErr) console.warn(`[GroupMe] dedup hit_count bump failed (ignored): ${updErr.message}`);
      console.log(`[GroupMe] duplicate suppressed hash=${hash.slice(0, 12)} channel=${chan} age_s=${Math.round(ageMs / 1000)}`);
      return true;
    }

    // Older than the window — reopen it and let this one through.
    const { error: reopenErr } = await client
      .from('groupme_notification_marks')
      .update({ first_sent_at: new Date().toISOString(), hit_count: 1 })
      .eq('dedup_hash', hash);
    if (reopenErr) console.warn(`[GroupMe] dedup window reopen failed (ignored, sending): ${reopenErr.message}`);
    _maybePruneDedupMarks(client);
    return false;
  } catch (err) {
    console.warn(`[GroupMe] dedup threw (fail-open, sending): ${err.message}`);
    return false;
  }
}

// ═══════════════════════════════════════════════════════════════════
// OUTBOUND: Send messages to GroupMe
// ═══════════════════════════════════════════════════════════════════

/**
 * v1.7 — Extended signature. Backward-compatible: legacy callers passing
 * just (text) continue to fire immediately.
 *
 * @param {string} text — the message body
 * @param {object} [opts]
 * @param {string} [opts.contactId]   — GHL contact ID. When present, the
 *   message is queued for consolidation with other queued messages for
 *   the same contact within NOTIFICATION_DEBOUNCE_MS.
 * @param {string} [opts.contactName] — Display name for the consolidated
 *   card header. Optional; first non-null name wins for the buffer.
 * @param {boolean} [opts.flushNow]   — Force immediate send even if
 *   contactId is provided. Use for urgent operator-facing cards.
 * @param {string} [opts.channel]     — Logical destination channel.
 *   'canvass' → GROUPME_CANVASS_BOT_ID (falls back to the main bot with a
 *   one-time warning when unset). Omitted/unknown → main bot.
 * @param {boolean} [opts.noDedup]    — v1.8: skip the content-dedup backstop.
 *   For cards that must send even when byte-identical to a recent one
 *   (approval cards — time-sensitive operator decisions).
 * @returns {Promise<{sent: boolean, reason?: string, queue_size?: number}>}
 *   sent=true: fired immediately. sent=false with reason='queued': buffered.
 *   sent=false with reason='duplicate_suppressed': identical card already sent
 *   to this channel inside the dedup window. sent=false with other reason:
 *   send failed.
 */
export async function sendGroupMeMessage(text, opts = {}) {
  const { contactId, contactName, flushNow, channel, noDedup } = opts || {};
  const botId = _resolveBotId(channel);

  if (!botId) {
    console.log('[GroupMe] No BOT_ID — message logged only:', text.slice(0, 100));
    return { sent: false, reason: 'no_bot_id' };
  }

  // Immediate path: no contactId (system event) OR explicit flushNow
  // (approval/error/operator card). This is the v1.6-and-earlier behavior.
  if (!contactId || flushNow) {
    // v1.8: content dedup immediately before the POST. This is the path both
    // "LP Appointment Set" emitters take, and the one with no other guard.
    if (!noDedup && await _isDuplicateCard(text, channel)) {
      return { sent: false, reason: 'duplicate_suppressed' };
    }
    return await _sendRawGroupMeMessage(text, botId);
  }

  // Debounced path: queue for consolidation.
  return _queueForConsolidation(contactId, contactName || null, text, channel);
}

/**
 * Internal: raw POST to GroupMe with no queueing logic. Called by the
 * immediate-send path of sendGroupMeMessage AND by the debounce flusher
 * when a buffer's timer fires. Approval-card senders also call this
 * indirectly via sendGroupMeMessage(text) (no opts → immediate path).
 */
async function _sendRawGroupMeMessage(text, botId = GROUPME_BOT_ID) {
  try {
    const res = await fetch('https://api.groupme.com/v3/bots/post', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ bot_id: botId, text: text.slice(0, 1000) }),
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      console.error(`[GroupMe] POST failed: ${res.status} ${body.slice(0, 200)}`);
      return { sent: false, reason: `http_${res.status}` };
    }
    return { sent: true };
  } catch (err) {
    console.error('[GroupMe] Send failed:', err.message);
    return { sent: false, reason: err.message };
  }
}

// ═══════════════════════════════════════════════════════════════════
// v1.7: DEBOUNCE QUEUE INTERNALS
// ═══════════════════════════════════════════════════════════════════

function _queueForConsolidation(contactId, contactName, text, channel) {
  // Buffers are keyed per channel+contact: canvass and main cards for the
  // same contact are different operator streams and must flush to their
  // own bots, never consolidate into one card.
  const bufferKey = `${channel || 'main'}:${contactId}`;
  const existing = pendingNotifications.get(bufferKey);

  if (existing) {
    // Buffer cap check — flush immediately if full, then open a new one
    // with this line so the current call's content isn't lost.
    if (existing.lines.length >= MAX_CONSOLIDATED_LINES) {
      console.log(`[GroupMe] queue cap hit for contact=${contactId} (${MAX_CONSOLIDATED_LINES} lines), flushing early`);
      clearTimeout(existing.timer);
      pendingNotifications.delete(bufferKey);
      // Don't await — fire-and-forget so the new buffer opens promptly
      _flushBuffer(existing).catch(err =>
        console.warn(`[GroupMe] early-cap flush failed for ${contactId}: ${err.message}`)
      );
      // fall through to open a new buffer below
    } else {
      // Normal append: keep the existing buffer + timer (5s window is from
      // the FIRST queued message, not reset by subsequent adds).
      existing.lines.push(text);
      // First non-null contactName wins
      if (!existing.contactName && contactName) {
        existing.contactName = contactName;
      }
      console.log(`[GroupMe] queued contact=${contactId} queue_size=${existing.lines.length}`);
      return { sent: false, reason: 'queued', queue_size: existing.lines.length };
    }
  }

  // First call for this contact (or post-cap reset above): open buffer +
  // schedule flush.
  const buf = {
    contactId,
    contactName: contactName || null,
    channel: channel || null,
    lines: [text],
    firstQueuedAt: Date.now(),
    timer: null,
  };
  pendingNotifications.set(bufferKey, buf);
  buf.timer = setTimeout(() => {
    _flushContact(bufferKey).catch(err =>
      console.warn(`[GroupMe] flush timer failed for ${contactId}: ${err.message}`)
    );
  }, NOTIFICATION_DEBOUNCE_MS);
  console.log(`[GroupMe] queued contact=${contactId} queue_size=1 (first-in-window, flush in ${NOTIFICATION_DEBOUNCE_MS}ms)`);
  return { sent: false, reason: 'queued', queue_size: 1 };
}

async function _flushContact(bufferKey) {
  const buf = pendingNotifications.get(bufferKey);
  if (!buf) return; // already flushed by a cap-hit path
  pendingNotifications.delete(bufferKey);
  await _flushBuffer(buf);
}

async function _flushBuffer(buf) {
  const elapsed = Date.now() - buf.firstQueuedAt;
  // Resolve the bot at flush time so env fallback behavior matches the
  // immediate-send path.
  const botId = _resolveBotId(buf.channel);

  if (buf.lines.length === 1) {
    // Single message — send as-is, no consolidation header. Caller still
    // gets the 5s delay (cost of opt-in), but the message format is
    // identical to what they passed in.
    // v1.8: dedup on the exact text that is about to be POSTed.
    if (await _isDuplicateCard(buf.lines[0], buf.channel)) {
      console.log(`[GroupMe] flushed contact=${buf.contactId} lines=1 elapsed_ms=${elapsed} — duplicate suppressed`);
      return { sent: false, reason: 'duplicate_suppressed' };
    }
    console.log(`[GroupMe] flushed contact=${buf.contactId} lines=1 elapsed_ms=${elapsed} (single, no header)`);
    return await _sendRawGroupMeMessage(buf.lines[0], botId);
  }

  const consolidated = _buildConsolidatedCard(buf);
  // v1.8: the consolidated card carries a live "Ns window" header, so two
  // consolidations are byte-identical only when their timing matches too —
  // narrower than the single-line case by nature, but the guard belongs on
  // every path that POSTs.
  if (await _isDuplicateCard(consolidated, buf.channel)) {
    console.log(`[GroupMe] flushed contact=${buf.contactId} lines=${buf.lines.length} elapsed_ms=${elapsed} — duplicate suppressed`);
    return { sent: false, reason: 'duplicate_suppressed' };
  }
  console.log(`[GroupMe] flushed contact=${buf.contactId} lines=${buf.lines.length} elapsed_ms=${elapsed} consolidated_chars=${consolidated.length}`);
  return await _sendRawGroupMeMessage(consolidated, botId);
}

function _buildConsolidatedCard(buf) {
  const displayName = buf.contactName || buf.contactId;
  const windowSec = Math.round((Date.now() - buf.firstQueuedAt) / 100) / 10;
  const header = `🔔 ${buf.lines.length} alerts · ${displayName} · ${windowSec}s window`;
  const separator = '\n━━━━━━━━━━━━━━━━━━━━━━━━━━\n';

  let card = `${header}\n\n${buf.lines.join(separator)}`;

  // If over the 950-char budget, trim each line proportionally. We try to
  // preserve as much per-line content as possible while staying under
  // GroupMe's 1000-char hard limit (so _sendRawGroupMeMessage's slice(0,
  // 1000) doesn't chop content mid-word).
  if (card.length > MAX_CARD_CHARS) {
    const fixedOverhead = header.length + 2 + (separator.length * (buf.lines.length - 1));
    const budget = MAX_CARD_CHARS - fixedOverhead;
    const perLineBudget = Math.max(80, Math.floor(budget / buf.lines.length));
    const trimmed = buf.lines.map(line =>
      line.length > perLineBudget
        ? line.slice(0, perLineBudget - 14) + '… [truncated]'
        : line
    );
    card = `${header}\n\n${trimmed.join(separator)}`;
    // Final hard cap — should never trip with proportional trim above,
    // but defense in depth.
    if (card.length > 999) card = card.slice(0, 996) + '…';
  }

  return card;
}

/**
 * Diagnostic helper — current in-flight buffers. Exposed via GET
 * /groupme/queue-state route for operational visibility.
 */
function snapshotPendingQueue() {
  const out = [];
  for (const [, buf] of pendingNotifications.entries()) {
    out.push({
      contact_id: buf.contactId,
      contact_name: buf.contactName,
      channel: buf.channel || 'main',
      lines: buf.lines.length,
      first_queued_at: new Date(buf.firstQueuedAt).toISOString(),
      ms_in_buffer: Date.now() - buf.firstQueuedAt,
      ms_until_flush: Math.max(0, NOTIFICATION_DEBOUNCE_MS - (Date.now() - buf.firstQueuedAt)),
    });
  }
  return out;
}

// ═══════════════════════════════════════════════════════════════════
// v1.3: AUTO-EXECUTE AFTER APPROVAL
// ═══════════════════════════════════════════════════════════════════

async function triggerExecution() {
  try {
    const res = await fetch(`${SELF_BASE_URL}/n8n/decision-engine/execute`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ limit: 10 }),
      signal: AbortSignal.timeout(60000),
    });
    if (res.ok) {
      const data = await res.json();
      console.log(`[GroupMe] Auto-execute after approval: ${data.actions_executed || 0} executed, ${data.completed || 0} completed (${data.elapsed_ms || 0}ms)`);
    } else {
      console.warn(`[GroupMe] Auto-execute failed: HTTP ${res.status}`);
    }
  } catch (err) {
    console.warn(`[GroupMe] Auto-execute error: ${err.message}`);
  }
}

// ═══════════════════════════════════════════════════════════════════
// ENRICHED APPROVAL REQUEST FORMAT (v1.2)
// ═══════════════════════════════════════════════════════════════════

const RULE_DISPLAY_NAMES = {
  'BEHAVIORAL_FAST_TRACK':        '🔥 AI FAST-TRACK',
  'BEHAVIORAL_SPOUSE_OBJECTION':  '💑 SPOUSE OBJECTION',
  'BEHAVIORAL_PRICE_OBJECTION':   '💰 PRICE OBJECTION',
  'BEHAVIORAL_TIMING_OBJECTION':  '⏰ TIMING OBJECTION',
  'BEHAVIORAL_TRUST_OBJECTION':   '🛡️ TRUST OBJECTION',
  'BEHAVIORAL_COMPETITOR_OBJECTION': '⚔️ COMPETITOR OBJECTION',
  'BEHAVIORAL_DIY_OBJECTION':     '🔧 DIY OBJECTION',
  'BEHAVIORAL_DISENGAGEMENT':     '📉 DISENGAGEMENT',
  'BEHAVIORAL_ESCALATE_REP':      '🚨 REP ESCALATION',
  'BEHAVIORAL_DNC_REPLY':         '🚫 DNC REPLY',
  'AGENTIC_RESPOND_POST_CHATBOT': '🤖 AGENTIC RESPONSE',
};

function formatActionSummary(actions) {
  const parts = [];
  for (const a of actions) {
    if (a.action_type === 'add_tag') parts.push(`Tag: ${a.action_payload?.tag}`);
    else if (a.action_type === 'remove_tag') {
      const tags = a.action_payload?.tags || [a.action_payload?.tag];
      parts.push(`Remove: ${tags.join(', ')}`);
    }
    else if (a.action_type === 'move_opportunity') parts.push(`Pipeline → ${a.action_payload?.pipeline} ${a.action_payload?.stage}`);
    else if (a.action_type === 'remove_from_workflow') parts.push('Remove from workflow');
    else if (a.action_type === 'create_task') parts.push(`Task: ${(a.action_payload?.title || '').slice(0, 60)}`);
    else if (a.action_type === 'send_notification') parts.push('Notify');
    else if (a.action_type === 'send_message') parts.push(`send_message: ${(a.action_payload?.channel || 'SMS').toUpperCase()} reply`);
    else parts.push(a.action_type);
  }
  return parts.join(' | ');
}

// v1.6: standardized footer line so all approval cards advertise the
// Yes / No / Edit options consistently.
function approvalFooter(shortRef) {
  return `Reply: Yes ${shortRef}  •  No ${shortRef}  •  Edit ${shortRef} <describe change>`;
}

/**
 * v1.5 — Insert-first dedup. Claim the batch by inserting the tracking
 * record BEFORE sending the GroupMe message.
 * v1.6 — Footer line now advertises Edit X option.
 *
 * NOTE: Approval cards intentionally DO NOT pass through the v1.7
 * debounce layer. They use sendGroupMeMessage(msg) without opts so they
 * fire immediately — approvals are time-sensitive operator decisions and
 * should never be delayed or consolidated.
 */
export async function sendApprovalRequest(batchActions, contactName, contactPhone, enrichment = {}) {
  if (!batchActions?.length) return;

  const first = batchActions[0];
  const batchId = first.batch_id || `s_${first.id}`;
  const shortRef = String(first.id);

  const ruleName = RULE_DISPLAY_NAMES[first.rule_applied] || first.rule_applied;
  const actionSummary = formatActionSummary(batchActions);

  const lines = [];
  lines.push(`🔔 APPROVAL [#${shortRef}]`);
  lines.push(`${ruleName}`);
  lines.push(`👤 ${contactName || 'Unknown'}${contactPhone ? ` (${contactPhone})` : ''}`);

  if (enrichment.messageText) {
    const msg = enrichment.messageText.slice(0, 200);
    lines.push(`💬 "${msg}"${enrichment.messageType ? ` [${enrichment.messageType}]` : ''}`);
  }

  const lpParts = [];
  if (enrichment.lpSource) lpParts.push(`Src: ${enrichment.lpSource}`);
  if (enrichment.repName) lpParts.push(`Rep: ${enrichment.repName}`);
  if (enrichment.disposition) lpParts.push(`Disp: ${enrichment.disposition}`);
  if (enrichment.prospectId && enrichment.prospectId !== 'Not in LP') lpParts.push(`Prospect: ${enrichment.prospectId}`);
  if (lpParts.length > 0) lines.push(`📋 ${lpParts.join(' | ')}`);

  if (enrichment.score || enrichment.tier) {
    const intentParts = [];
    if (enrichment.score) intentParts.push(`Score: ${enrichment.score}`);
    if (enrichment.tier) intentParts.push(`Tier: ${enrichment.tier}`);
    if (enrichment.barrier) intentParts.push(`Barrier: ${enrichment.barrier}`);
    lines.push(`📊 ${intentParts.join(' | ')}`);
  }

  if (enrichment.aiSummary) {
    lines.push(`🤖 ${enrichment.aiSummary.slice(0, 150)}`);
  }

  lines.push(`🎯 ${actionSummary}`);

  if (enrichment.generatedMessage) {
    lines.push(`📱 "${enrichment.generatedMessage}"`);
  } else if (enrichment.aiGenerationError) {
    lines.push(`⚠️ AI generation failed: ${enrichment.aiGenerationError.slice(0, 100)}`);
  }

  lines.push('');
  lines.push(approvalFooter(shortRef));

  const msg = lines.join('\n');

  // v1.5: INSERT-FIRST DEDUP
  const { error: claimErr } = await supabase
    .from('groupme_approval_requests')
    .insert({
      short_ref: shortRef,
      batch_id: batchId,
      action_ids: batchActions.map(a => a.id),
      rule_applied: first.rule_applied,
      target_id: first.target_id,
      contact_name: contactName || null,
      status: 'pending',
      requested_at: new Date().toISOString(),
    });

  if (claimErr) {
    if (claimErr.code === '23505') {
      console.log(`[GroupMe] Batch ${batchId} (#${shortRef}) already claimed by another worker — skipping duplicate send`);
      return;
    }
    throw new Error(`Failed to claim approval batch ${batchId}: ${claimErr.message}`);
  }

  // v1.7: approval cards bypass debounce (immediate send).
  // v1.8: and bypass content dedup. The body carries a unique short_ref so two
  // approval cards would never collide anyway — but an approval is a
  // time-sensitive operator decision, and it must not depend on that staying
  // true. The v1.5 insert-first claim above is already this path's dedup.
  const sendResult = await sendGroupMeMessage(msg, { noDedup: true });
  if (!sendResult?.sent) {
    await supabase
      .from('groupme_approval_requests')
      .delete()
      .eq('short_ref', shortRef)
      .catch(err => {
        console.warn(`[GroupMe] Failed to release claim for ${shortRef} after send failure: ${err.message}`);
      });
    throw new Error(`GroupMe delivery failed: ${sendResult?.reason || 'unknown'} — claim released, batch ${batchId} can retry next heartbeat`);
  }

  console.log(`[GroupMe] Approval request sent: #${shortRef} (${first.rule_applied}, ${batchActions.length} actions)`);
}

// ═══════════════════════════════════════════════════════════════════
// v1.6 — EDIT HANDLER + REGENERATED CARD SENDER
// ═══════════════════════════════════════════════════════════════════

/**
 * v1.6.1 — Recover the inbound text the bot was responding to.
 *
 * The agent_action's event_id usually points at an `ai.analysis_completed`
 * event whose payload only has a 200-char `message_preview`. The canonical
 * full text lives on the upstream `ghl.reply_received` event for the same
 * contact, fired moments before. We try the action's event first (works
 * for direct reply_received-triggered actions), then fall back to the
 * most-recent ghl.reply_received for that contact at-or-before the
 * action's event timestamp.
 *
 * Returns { text, source } or null if nothing recoverable. The `source`
 * tag indicates which path produced the text:
 *   - `event_<id>_direct`            — event itself was a reply_received
 *   - `event_<id>_traceback`         — found via ghl.reply_received lookup
 *   - `event_<id>_preview_fallback`  — last resort, truncated preview
 */
async function recoverTriggerMessage(eventId, contactIdHint) {
  if (!eventId) return null;

  const { data: ev, error: evErr } = await supabase
    .from('system_events')
    .select('id, event_type, payload, ghl_contact_id, created_at')
    .eq('id', eventId)
    .maybeSingle();

  if (evErr || !ev) {
    console.warn(`[GroupMe] recoverTriggerMessage: lookup of event ${eventId} failed: ${evErr?.message || 'not found'}`);
    return null;
  }

  // Direct hit: the event itself is a reply_received with full text
  if (ev.payload?.message_text) {
    return { text: ev.payload.message_text, source: `event_${ev.id}_direct` };
  }

  // Traceback: search for the most recent reply_received for the same
  // contact at-or-before this event's timestamp
  const cid = contactIdHint || ev.ghl_contact_id;
  if (cid) {
    const { data: replies, error: repErr } = await supabase
      .from('system_events')
      .select('id, payload, created_at')
      .eq('ghl_contact_id', cid)
      .eq('event_type', 'ghl.reply_received')
      .lte('created_at', ev.created_at)
      .order('id', { ascending: false })
      .limit(1);

    if (repErr) {
      console.warn(`[GroupMe] recoverTriggerMessage: reply_received lookup failed: ${repErr.message}`);
    }

    const reply = replies?.[0];
    if (reply?.payload?.message_text) {
      return { text: reply.payload.message_text, source: `event_${reply.id}_traceback` };
    }
  }

  // Last-resort: truncated preview from the analysis event
  if (ev.payload?.message_preview) {
    return { text: ev.payload.message_preview, source: `event_${ev.id}_preview_fallback` };
  }

  return null;
}

/**
 * Send a fresh approval card AFTER an Edit X regeneration. Uses the same
 * short_ref as the original card (caller must have already archived the
 * old groupme_approval_requests row, freeing the short_ref). Inserts a
 * new tracking row using the v1.5 INSERT-FIRST pattern.
 *
 * v1.7: Like sendApprovalRequest, this bypasses the debounce layer
 * (sendGroupMeMessage call with no opts → immediate).
 */
async function sendRegeneratedApprovalCard({
  request, batchActions, newMessage, editInstruction, senderName, shortRef,
}) {
  const ruleName = RULE_DISPLAY_NAMES[request.rule_applied] || request.rule_applied;
  const actionSummary = formatActionSummary(batchActions);

  const lines = [];
  lines.push(`🔄 EDITED [#${shortRef}] (by ${senderName})`);
  lines.push(`${ruleName}`);
  lines.push(`👤 ${request.contact_name || 'Unknown'}`);
  lines.push(`✏️ Edit: "${editInstruction.slice(0, 200)}"`);
  lines.push(`🎯 ${actionSummary}`);
  lines.push(`📱 "${newMessage}"`);
  lines.push('');
  lines.push(approvalFooter(shortRef));

  const msg = lines.join('\n');

  // v1.5 INSERT-FIRST claim (caller already freed the original short_ref)
  const { error: claimErr } = await supabase
    .from('groupme_approval_requests')
    .insert({
      short_ref: shortRef,
      batch_id: request.batch_id,
      action_ids: request.action_ids,
      rule_applied: request.rule_applied,
      target_id: request.target_id,
      contact_name: request.contact_name,
      status: 'pending',
      requested_at: new Date().toISOString(),
    });

  if (claimErr) {
    if (claimErr.code === '23505') {
      console.warn(`[GroupMe] Edit re-card: short_ref ${shortRef} unexpectedly already claimed — archive may have failed. Skipping.`);
      return false;
    }
    throw new Error(`Failed to claim regenerated approval ${shortRef}: ${claimErr.message}`);
  }

  // v1.8: noDedup for the same reason as sendApprovalRequest — an operator
  // decision card must never be suppressed by a content match.
  const sendResult = await sendGroupMeMessage(msg, { noDedup: true });
  if (!sendResult?.sent) {
    await supabase.from('groupme_approval_requests').delete().eq('short_ref', shortRef).catch(() => {});
    throw new Error(`Edit GroupMe send failed: ${sendResult?.reason || 'unknown'}`);
  }

  return true;
}

/**
 * Handle "Edit <shortRef> <description>" command.
 *
 * Flow:
 *   1. Look up pending approval by short_ref
 *   2. Find the send_message action and its current payload
 *   3. Resolve the original triggerMessage from system_events
 *   4. Call generateResponse with opts.editInstruction + opts.previousMessage
 *   5. Update agent_actions.action_payload with the new message
 *   6. Insert into agent_response_edits (continuous self-improvement loop)
 *   7. Archive the old approval row (suffix short_ref) so the original
 *      short_ref is free
 *   8. Send a fresh "🔄 EDITED" card with the original short_ref
 *
 * Mark can edit again (recursive) or Yes/No the new card.
 */
async function editApprovalRequest(shortRef, editInstruction, senderName) {
  // 1. Look up the pending approval
  const { data: request, error: reqErr } = await supabase
    .from('groupme_approval_requests')
    .select('*')
    .eq('short_ref', shortRef)
    .eq('status', 'pending')
    .maybeSingle();

  if (reqErr) {
    console.error(`[GroupMe] Edit lookup failed for #${shortRef}: ${reqErr.message}`);
    await sendGroupMeMessage(`❌ Edit error for #${shortRef}: ${reqErr.message.slice(0, 120)}`);
    return { handled: true, action: 'lookup_error', error: reqErr.message };
  }

  if (!request) {
    await sendGroupMeMessage(`❓ No pending approval for #${shortRef}. It may already be approved/rejected.`);
    return { handled: true, action: 'not_found', shortRef };
  }

  const actionIds = request.action_ids || [];

  // 2. Find the send_message action
  const { data: actions, error: actErr } = await supabase
    .from('agent_actions')
    // context_snapshot (2026-07-29): decision-time state for the regeneration —
    // an Edit-X regen runs long after the fan-out that may have rewritten the
    // contact's stage, so it must generate from the snapshot, not live state.
    .select('id, action_type, action_payload, target_id, event_id, rule_applied, batch_id, context_snapshot')
    .in('id', actionIds);

  if (actErr) {
    console.error(`[GroupMe] Edit action fetch failed for #${shortRef}: ${actErr.message}`);
    await sendGroupMeMessage(`❌ Edit error for #${shortRef}: ${actErr.message.slice(0, 120)}`);
    return { handled: true, action: 'action_fetch_error', error: actErr.message };
  }

  const sendMsgAction = (actions || []).find(a => a.action_type === 'send_message');
  if (!sendMsgAction) {
    await sendGroupMeMessage(`❌ #${shortRef} has no send_message action to edit.`);
    return { handled: true, action: 'no_send_message' };
  }

  const previousMessage = sendMsgAction.action_payload?.message;
  const channel = String(sendMsgAction.action_payload?.channel || 'sms').toLowerCase();
  const contactId = sendMsgAction.target_id;

  if (!previousMessage) {
    await sendGroupMeMessage(`❌ #${shortRef} has no message to edit (action_payload.message is empty).`);
    return { handled: true, action: 'no_message' };
  }

  // 3. Resolve the original trigger message (v1.6.1: traceback to
  //    ghl.reply_received for full text, not the truncated 200-char preview)
  const recovered = await recoverTriggerMessage(sendMsgAction.event_id, contactId);
  if (!recovered?.text) {
    await sendGroupMeMessage(`❌ Couldn't find the original inbound message for #${shortRef} (event_id ${sendMsgAction.event_id}). Reject and ask the lead to message again, or send manually.`);
    return { handled: true, action: 'no_trigger_message' };
  }
  const triggerMessage = recovered.text;

  // 4. Regenerate via response-generator v2.7.4 with edit context
  let regenerated;
  try {
    regenerated = await generateResponse(contactId, channel, triggerMessage, {
      editInstruction,
      previousMessage,
      contextSnapshot: sendMsgAction.context_snapshot || null,
    });
  } catch (err) {
    console.error(`[GroupMe] Edit regenerate failed for #${shortRef}: ${err.message}`);
    await sendGroupMeMessage(`❌ Edit failed for #${shortRef}: ${err.message.slice(0, 200)}`);
    return { handled: true, action: 'regenerate_failed', error: err.message };
  }

  if (!regenerated || !regenerated.message) {
    await sendGroupMeMessage(`❌ Edit failed for #${shortRef}: regenerator returned no message.`);
    return { handled: true, action: 'no_regenerated_message' };
  }

  // 5. Update the agent_actions row's payload with the new message
  const newPayload = { ...sendMsgAction.action_payload, message: regenerated.message };
  const { error: updErr } = await supabase
    .from('agent_actions')
    .update({ action_payload: newPayload, updated_at: new Date().toISOString() })
    .eq('id', sendMsgAction.id);

  if (updErr) {
    console.error(`[GroupMe] Edit save failed for action ${sendMsgAction.id}: ${updErr.message}`);
    await sendGroupMeMessage(`❌ Edit generated but save failed for #${shortRef}: ${updErr.message.slice(0, 120)}`);
    return { handled: true, action: 'save_failed', error: updErr.message };
  }

  // 6. INSERT into agent_response_edits (continuous self-improvement)
  // Fire-and-forget — failure here doesn't break the flow
  supabase
    .from('agent_response_edits')
    .insert({
      action_id: sendMsgAction.id,
      ghl_contact_id: contactId,
      intent_class: regenerated.intent_class || null,
      classification_method: regenerated.classification_method || null,
      channel,
      buyer_stage: regenerated.buyer_stage || null,
      trigger_message: String(triggerMessage).slice(0, 2000),
      original_message: String(previousMessage).slice(0, 2000),
      edit_instruction: String(editInstruction).slice(0, 2000),
      final_message: String(regenerated.message).slice(0, 2000),
      booking_policy: regenerated.booking_policy || null,
      active_entry_tag: regenerated.active_entry_tag || null,
      edited_by: senderName,
    })
    .then(({ error }) => {
      if (error) {
        console.warn(`[GroupMe] Failed to log edit to agent_response_edits: ${error.message}`);
      } else {
        console.log(`[GroupMe] Logged edit for action ${sendMsgAction.id} to agent_response_edits (intent=${regenerated.intent_class})`);
      }
    });

  // 7. Archive old approval row — suffix short_ref to free the original
  const archivedShortRef = `${shortRef}_v${request.id}`;
  const { error: archErr } = await supabase
    .from('groupme_approval_requests')
    .update({
      short_ref: archivedShortRef,
      status: 'edited',
      resolved_by: senderName,
      resolved_at: new Date().toISOString(),
    })
    .eq('id', request.id);

  if (archErr) {
    console.error(`[GroupMe] Edit archive failed for #${shortRef}: ${archErr.message}`);
    await sendGroupMeMessage(`⚠️ Edit applied to action but couldn't archive old card for #${shortRef}: ${archErr.message.slice(0, 100)}. Action payload was updated; please reject manually if the card is stale.`);
    return { handled: true, action: 'archive_failed', error: archErr.message };
  }

  // 8. Send the new card with the original short_ref (now free)
  try {
    await sendRegeneratedApprovalCard({
      request,
      batchActions: actions || [],
      newMessage: regenerated.message,
      editInstruction,
      senderName,
      shortRef,
    });
  } catch (err) {
    console.error(`[GroupMe] Edit re-card send failed for #${shortRef}: ${err.message}`);
    await sendGroupMeMessage(`⚠️ Edit applied but re-card send failed for #${shortRef}: ${err.message.slice(0, 120)}. The action payload was updated; check /groupme/pending.`);
    return { handled: true, action: 'recard_failed', error: err.message };
  }

  console.log(`[GroupMe] ✏️ Edit applied for #${shortRef} by ${senderName}: action=${sendMsgAction.id}, intent=${regenerated.intent_class}, trigger_source=${recovered.source}, ${regenerated.message.length} chars, edits_in_prompt=${regenerated.edits_used_in_prompt || 0}`);
  return {
    handled: true,
    action: 'edited',
    shortRef,
    actionCount: actionIds.length,
    intent: regenerated.intent_class,
    editsInPrompt: regenerated.edits_used_in_prompt || 0,
  };
}

// ═══════════════════════════════════════════════════════════════════
// INBOUND: Handle GroupMe callback webhook
// ═══════════════════════════════════════════════════════════════════

async function handleGroupMeCallback(payload) {
  if (payload.sender_type === 'bot') return { handled: false, reason: 'bot_message' };

  if (GROUPME_GROUP_ID && String(payload.group_id) !== GROUPME_GROUP_ID) {
    return { handled: false, reason: 'wrong_group' };
  }

  const text = (payload.text || '').trim();
  const senderName = payload.name || 'Unknown';

  // v1.6: Edit pattern checked FIRST (before approval pattern). Format:
  //   "Edit 1234 propose specific times not just days"
  // The description after the ID is captured greedily.
  const editMatch = text.match(/^edit\s+(\d+)\s+(.+)$/is);
  if (editMatch) {
    const shortRef = editMatch[1];
    const editInstruction = editMatch[2].trim();
    if (!editInstruction) {
      await sendGroupMeMessage(`❓ Edit ${shortRef} requires a description. Format: Edit ${shortRef} <describe what to change>`);
      return { handled: true, action: 'edit_no_description' };
    }
    console.log(`[GroupMe] Edit command for #${shortRef} by ${senderName}: "${editInstruction.slice(0, 100)}"`);
    return await editApprovalRequest(shortRef, editInstruction, senderName);
  }

  // Standard Yes/No approval pattern
  const approvalMatch = text.match(/^(yes|no|approve|reject|deny)\s+(\d+)\s*$/i);
  if (!approvalMatch) {
    console.log(`[GroupMe] Non-approval message from ${senderName}: "${text.slice(0, 50)}"`);
    return { handled: false, reason: 'not_approval_command' };
  }

  const decision = approvalMatch[1].toLowerCase();
  const shortRef = approvalMatch[2];
  const isApproved = ['yes', 'approve'].includes(decision);

  console.log(`[GroupMe] Approval ${isApproved ? 'YES' : 'NO'} for #${shortRef} by ${senderName}`);

  const { data: request } = await supabase
    .from('groupme_approval_requests')
    .select('*')
    .eq('short_ref', shortRef)
    .eq('status', 'pending')
    .maybeSingle();

  if (!request) {
    await sendGroupMeMessage(`❓ No pending approval found for #${shortRef}. It may have already been processed.`);
    return { handled: true, action: 'not_found', shortRef };
  }

  const actionIds = request.action_ids || [];

  if (isApproved) {
    const { error } = await supabase
      .from('agent_actions')
      .update({
        status: 'pending',
        approved_by: senderName.toLowerCase(),
        updated_at: new Date().toISOString(),
      })
      .in('id', actionIds)
      .eq('status', 'pending_approval');

    if (error) {
      console.error('[GroupMe] Approval update failed:', error.message);
      await sendGroupMeMessage(`❌ Error approving #${shortRef}: ${error.message}`);
      return { handled: true, action: 'error', error: error.message };
    }

    await supabase
      .from('groupme_approval_requests')
      .update({ status: 'approved', resolved_by: senderName, resolved_at: new Date().toISOString() })
      .eq('short_ref', shortRef);

    // v1.6: also retroactively mark any agent_response_edits rows for these
    // actions as approval_outcome='approved' so the in-context-learning
    // retrieval can prefer confirmed-good corrections.
    supabase
      .from('agent_response_edits')
      .update({
        approval_outcome: 'approved',
        approved_at: new Date().toISOString(),
      })
      .in('action_id', actionIds)
      .is('approval_outcome', null)
      .then(({ error: updErr }) => {
        if (updErr) console.warn(`[GroupMe] Failed to mark edits approved: ${updErr.message}`);
      });

    await sendGroupMeMessage(`✅ Approved #${shortRef} (${request.rule_applied}). ${actionIds.length} actions queued for execution.`);

    console.log(`[GroupMe] ✅ Batch approved: #${shortRef} — ${actionIds.length} actions by ${senderName}`);

    triggerExecution().catch(err => {
      console.warn(`[GroupMe] Auto-execute failed after approval: ${err.message}`);
    });

    return { handled: true, action: 'approved', shortRef, actionCount: actionIds.length };

  } else {
    const { error } = await supabase
      .from('agent_actions')
      .update({
        status: 'rejected',
        approved_by: senderName.toLowerCase(),
        error_message: `Rejected via GroupMe by ${senderName}`,
        updated_at: new Date().toISOString(),
      })
      .in('id', actionIds)
      .eq('status', 'pending_approval');

    if (error) {
      console.error('[GroupMe] Rejection update failed:', error.message);
      await sendGroupMeMessage(`❌ Error rejecting #${shortRef}: ${error.message}`);
      return { handled: true, action: 'error', error: error.message };
    }

    await supabase
      .from('groupme_approval_requests')
      .update({ status: 'rejected', resolved_by: senderName, resolved_at: new Date().toISOString() })
      .eq('short_ref', shortRef);

    // v1.6: mark related edits as rejected so they don't pollute the
    // in-context-learning corpus with corrections that were ultimately
    // judged wrong.
    supabase
      .from('agent_response_edits')
      .update({
        approval_outcome: 'rejected',
        approved_at: new Date().toISOString(),
      })
      .in('action_id', actionIds)
      .is('approval_outcome', null)
      .then(({ error: updErr }) => {
        if (updErr) console.warn(`[GroupMe] Failed to mark edits rejected: ${updErr.message}`);
      });

    await sendGroupMeMessage(`🚫 Rejected #${shortRef} (${request.rule_applied}). ${actionIds.length} actions cancelled.`);

    console.log(`[GroupMe] 🚫 Batch rejected: #${shortRef} — ${actionIds.length} actions by ${senderName}`);
    return { handled: true, action: 'rejected', shortRef, actionCount: actionIds.length };
  }
}

// ═══════════════════════════════════════════════════════════════════
// EXPRESS ROUTES
// ═══════════════════════════════════════════════════════════════════

export function registerGroupMeRoutes(app) {

  app.post('/webhook/groupme', async (req, res) => {
    res.status(200).json({ ok: true });
    try {
      await handleGroupMeCallback(req.body);
    } catch (err) {
      console.error('[GroupMe] Webhook error:', err.message);
    }
  });

  app.post('/groupme/send', async (req, res) => {
    const { message } = req.body || {};
    if (!message) return res.status(400).json({ error: 'message required' });
    const result = await sendGroupMeMessage(message);
    res.json(result);
  });

  app.get('/groupme/pending', async (req, res) => {
    try {
      const { data, error } = await supabase
        .from('groupme_approval_requests')
        .select('*')
        .eq('status', 'pending')
        .order('requested_at', { ascending: false })
        .limit(20);
      if (error) return res.status(500).json({ error: error.message });
      res.json({ count: data?.length || 0, requests: data || [] });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // v1.7: in-flight debounce buffer snapshot — operational visibility
  app.get('/groupme/queue-state', (req, res) => {
    const snapshot = snapshotPendingQueue();
    res.json({
      window_ms: NOTIFICATION_DEBOUNCE_MS,
      max_lines_per_buffer: MAX_CONSOLIDATED_LINES,
      max_card_chars: MAX_CARD_CHARS,
      buffer_count: snapshot.length,
      buffers: snapshot,
      // v1.8 — is the content-dedup backstop live, and how wide is its window?
      dedup: {
        enabled: GROUPME_DEDUP_ENABLED,
        window_min: GROUPME_DEDUP_WINDOW_MIN,
      },
    });
  });

  console.log('[GroupMe] Registered: POST /webhook/groupme | POST /groupme/send | GET /groupme/pending | GET /groupme/queue-state');
}
