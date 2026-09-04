/**
 * Shared alert state — src/alert-state.js
 *
 * 2026-09-04. One durable, cross-process record of "which conditions are
 * currently announced", so an operational alert fires ONCE when a condition
 * starts, stays silent while it persists, and says so once when it clears.
 *
 * WHY
 * ───
 * Every watchdog in this repo kept its "already announced" memory in a
 * process-local variable and suppressed by ELAPSED TIME:
 *
 *   executor-heartbeat.js      lastQueueAlertAt / lastLimiterAlertAt / ...
 *   decision-engine-heartbeat  lastSilenceAlertAt
 *   routes/capacityRanker.js   watchdogLastAlert Map
 *   jobs/lp-report-watchdog.js lastAlertDate Map
 *
 * Two failure modes followed. A cooldown that lapses while the condition is
 * STILL bad re-announces it — nothing distinguished "still broken" from
 * "broken again" — and any restart wiped the memory so every live condition
 * re-announced. Measured over 18h on 2026-09-03/04: the GHL limiter alert
 * fired 11x, the capacity watchdog 4x in 90min, agentic-silence 4x in 90min,
 * and LP report #134 6x. All four were ONE ongoing condition each.
 *
 * The v1.8 content dedup in groupme.js does not help: it hashes the message
 * TEXT, and every one of these bodies embeds a live counter ("queue: 3 |
 * tokens: 16/50", "answerable replies: 5", "is UNREADABLE" vs "is
 * NOT_RUNNING"), so the hash differs every sweep and never matches. The
 * capacity watchdog additionally passes noDedup:true. Content-hash is the
 * wrong key; this module keys on CONDITION IDENTITY.
 *
 * THE MECHANISM
 * ─────────────
 * One row per condition. state='firing' means it has already been announced
 * and must stay silent. Claim the firing edge by INSERT — the PRIMARY KEY is
 * what serializes concurrent sweeps and replicas, the same doctrine as the
 * v1.5 approval claim and the v1.8 dedup claim — and take every other edge by
 * a guarded UPDATE whose .select() returns rows only to the caller that won.
 * Whoever's write lands is the one that sends.
 *
 * Rows are KEPT after clearing (state='cleared') rather than deleted: the
 * second healthy sweep is then a cheap no-op instead of a second recovery
 * card, and notify_count stays queryable. notify_count > 1 on a key with no
 * reminder configured is the regression signal for this whole change.
 *
 * ACTIVE IS TRI-STATE, AND THAT IS THE LOAD-BEARING PART
 * ─────────────────────────────────────────────────────
 *   true  — I checked; the condition is bad.       → fire / remind / hold
 *   false — I checked; the condition is healthy.   → clear (recovery card)
 *   null  — I could not tell, or I am inhibited.   → touch nothing at all
 *
 * null is not a nicety. Without it every read failure and every out-of-window
 * sweep reads as "healthy" and emits a FALSE recovery card, which tells an
 * operator to stop looking at something that is still broken. The real cases:
 *
 *   - a failed read (decision-engine-heartbeat.js already says "a failed read
 *     NEVER alerts"; the same must hold for clearing)
 *   - outside the alerting window — a campaign that dies at 22:00 and is still
 *     dead at 08:00 must fire once at 08:00 and must NOT "recover" at 22:01
 *   - deliberately inhibited — capacityRanker's `c.cycling`, whose existing
 *     comment already reasons "not an alert, and not a healthy read either"
 *   - a stale or cached sample, which is not evidence of health
 *
 * FAILURE POSTURE — split by edge, because the two directions differ
 * ──────────────────────────────────────────────────────────────────
 * FIRING fails OPEN but degraded. If the claim cannot be written we cannot
 * prove the condition was already announced, and a missed page is the failure
 * mode behind the 47-hour agentic outage and the 12-hour token-starvation
 * storm. So we send — but only subject to the caller's old in-process cooldown
 * (fallbackCooldownMs). DB healthy = edge-triggered and exact; DB down =
 * exactly the pre-2026-09-04 behavior. Never an unbounded storm.
 *
 * CLEARING fails CLOSED. If the transition cannot be written, send no recovery
 * card. A missing all-clear is harmless; a false one is not.
 *
 * Killable without a redeploy via ALERT_STATE_ENABLED=false, which drops every
 * caller onto the fallback cooldown path.
 */

import supabase from './supabase.js';
import { sendGroupMeMessage } from './groupme.js';

const TABLE = 'alert_conditions';
const DETAIL_CHARS = 500;

/** Safe default, same idiom as groupme.js: only the literal 'false' disables,
 *  so an unset or mistyped var still edge-triggers. */
const ALERT_STATE_ENABLED = process.env.ALERT_STATE_ENABLED !== 'false';

/** Cleared rows older than this are pruned; a firing row is never pruned. */
const PRUNE_AFTER_DAYS = parseInt(process.env.ALERT_STATE_PRUNE_AFTER_DAYS || '30', 10);
const PRUNE_INTERVAL_MS = 60 * 60 * 1000;
let lastPruneAt = 0;

/** The degraded path: key → last fallback send. Only consulted when the DB
 *  path errors, so in normal operation this map stays empty. */
const fallbackLastSentAt = new Map();

// Test seam, same rationale as groupme.js's __setDedupClientForTests: the
// callers have no dependency injection and threading a client through all of
// them to make one backstop testable would be worse than this.
let _clientOverride = null;

/** TESTS ONLY — point this layer at a stub client. */
export function __setAlertStateClientForTests(client) {
  _clientOverride = client;
  lastPruneAt = 0;
  fallbackLastSentAt.clear();
}

/** TESTS ONLY — clear the degraded-path cooldown map. */
export function __resetAlertStateFallback() {
  fallbackLastSentAt.clear();
}

/**
 * Opportunistic prune of CLEARED rows older than PRUNE_AFTER_DAYS. Firing rows
 * are never pruned — dropping one would re-announce a live incident, which is
 * the bug this module exists to fix. Fire-and-forget, at most once per
 * process-hour, must NEVER block or fail a decision.
 */
function _maybePrune(client) {
  const now = Date.now();
  if (now - lastPruneAt < PRUNE_INTERVAL_MS) return;
  lastPruneAt = now;
  const cutoff = new Date(now - PRUNE_AFTER_DAYS * 24 * 60 * 60 * 1000).toISOString();
  Promise.resolve(
    client.from(TABLE).delete().eq('state', 'cleared').lt('cleared_at', cutoff),
  ).then(
    ({ error } = {}) => {
      if (error) console.warn(`[AlertState] prune failed (ignored): ${error.message}`);
    },
    (err) => console.warn(`[AlertState] prune threw (ignored): ${err.message}`),
  );
}

/** Resolve a string | () => string | () => Promise<string> body. */
async function _resolveText(text) {
  if (typeof text === 'function') return await text();
  return text;
}

/**
 * Report one condition's current state and send whatever that transition
 * warrants. This is the ONLY function emitters need.
 *
 * @param {object} args
 * @param {string} args.key    Condition identity — NOT the message text, and it
 *   must contain no live value: no counts, no state strings, no timestamps.
 *   'capacity_ranker:campaign_not_running:Data - Hot Leads' stays ONE key
 *   whether Five9 reports UNREADABLE, NOT_RUNNING or STOPPING. That rule alone
 *   is what turns the capacity-ranker's "4x in 90min" into one alert.
 * @param {boolean|null} args.active  Tri-state; see the module header.
 * @param {string} [args.label]   Human name, used in the default recovery card.
 * @param {string|Function} [args.text]  The alert body, or a thunk returning
 *   it. A thunk is only invoked once the transition is won, so an expensive
 *   body (an LLM call, a formatted card) costs nothing on a silent sweep.
 * @param {string|Function} [args.recoveredText]  Overrides the default card.
 * @param {string} [args.detail]  Last body/reason, stored for reading the
 *   table by eye. Never matched on.
 * @param {string} [args.channel] GroupMe channel, passed straight through.
 * @param {number} [args.remindMs=0]  Re-remind after this long while the
 *   condition persists. 0 = never, which is right for live-ops states that
 *   clear on their own. Use a long interval only where a human must act.
 * @param {boolean} [args.notifyRecovery=true]
 * @param {number} [args.fallbackCooldownMs=0]  The emitter's pre-existing
 *   cooldown, used ONLY on the DB-error path.
 * @param {Function} [args.send]    Injectable sender (tests, capacityRanker).
 * @param {object} [args.client]    Injectable supabase (tests).
 * @param {number} [args.nowMs]     Injectable clock (tests).
 *
 * @returns {Promise<{action:string, sent:boolean, reason?:string}>} action is
 *   one of 'fired' | 'reminded' | 'recovered' | 'silent' | 'idle' | 'noop' |
 *   'skipped' | 'fallback_fired' | 'fallback_silent'.
 */
export async function reportAlertCondition(args = {}) {
  const {
    key,
    active,
    label,
    text,
    recoveredText,
    detail,
    channel,
    remindMs = 0,
    notifyRecovery = true,
    fallbackCooldownMs = 0,
    send = sendGroupMeMessage,
    client: clientArg,
    nowMs,
  } = args;

  // "I could not tell." Touch nothing — not the row, not the fallback clock.
  if (active === null || active === undefined) return { action: 'noop', sent: false };
  if (!key) return { action: 'noop', sent: false, reason: 'no_key' };

  const client = clientArg ?? _clientOverride ?? supabase;
  const now = nowMs ?? Date.now();

  if (!ALERT_STATE_ENABLED || !client) {
    return active
      ? await _fallbackFire({ key, text, channel, send, now, fallbackCooldownMs, reason: 'disabled' })
      : { action: 'skipped', sent: false };
  }

  try {
    return active
      ? await _fire({ client, key, label, text, detail, channel, remindMs, send, now, fallbackCooldownMs })
      : await _clear({ client, key, label, recoveredText, channel, notifyRecovery, send, now });
  } catch (err) {
    // Clearing fails CLOSED — a false all-clear is worse than a missing one.
    if (!active) {
      console.warn(`[AlertState] ${key} clear threw (no recovery card): ${err.message}`);
      return { action: 'silent', sent: false, reason: 'clear_failed' };
    }
    console.warn(`[AlertState] ${key} threw (degrading to in-process cooldown): ${err.message}`);
    return await _fallbackFire({ key, text, channel, send, now, fallbackCooldownMs, reason: 'threw' });
  }
}

/** The condition is bad. Claim the firing edge, or stay silent if it is held. */
async function _fire({ client, key, label, text, detail, channel, remindMs, send, now, fallbackCooldownMs }) {
  const nowIso = new Date(now).toISOString();
  const trimmed = detail ? String(detail).slice(0, DETAIL_CHARS) : null;

  // Claim by INSERT. The PK collision is the whole serialization mechanism.
  const { error: insErr } = await client.from(TABLE).insert({
    alert_key: key,
    state: 'firing',
    label: label ?? null,
    first_seen_at: nowIso,
    last_seen_at: nowIso,
    last_notified_at: null,
    cleared_at: null,
    notify_count: 0,
    detail: trimmed,
  });

  if (!insErr) {
    _maybePrune(client);
    return await _sendAndStamp({ client, key, text, channel, send, now, kind: 'fired' });
  }

  if (insErr.code !== '23505') {
    console.warn(`[AlertState] ${key} claim failed (degrading to in-process cooldown): ${insErr.message}`);
    return await _fallbackFire({ key, text, channel, send, now, fallbackCooldownMs, reason: 'claim_failed' });
  }

  // A row exists. If it is CLEARED this is a fresh incident — re-arm it. The
  // guarded UPDATE is a compare-and-swap: only one caller gets a row back.
  const { data: rearmed, error: rearmErr } = await client.from(TABLE)
    .update({
      state: 'firing',
      first_seen_at: nowIso,
      last_seen_at: nowIso,
      last_notified_at: null,
      cleared_at: null,
      notify_count: 0,
      detail: trimmed,
    })
    .eq('alert_key', key)
    .eq('state', 'cleared')
    .select('alert_key');

  if (rearmErr) {
    console.warn(`[AlertState] ${key} re-arm failed (degrading to in-process cooldown): ${rearmErr.message}`);
    return await _fallbackFire({ key, text, channel, send, now, fallbackCooldownMs, reason: 'rearm_failed' });
  }
  if (rearmed && rearmed.length > 0) {
    return await _sendAndStamp({ client, key, text, channel, send, now, kind: 'fired' });
  }

  // Already firing. Refresh the observation, then decide on a reminder.
  await Promise.resolve(
    client.from(TABLE).update({ last_seen_at: nowIso, detail: trimmed }).eq('alert_key', key),
  ).catch(() => {});

  if (!remindMs) return { action: 'silent', sent: false };

  // The predicate IS the cooldown, so exactly one caller can win a reminder
  // however many replicas are sweeping.
  const cutoff = new Date(now - remindMs).toISOString();
  const { data: due, error: remErr } = await client.from(TABLE)
    .update({ last_notified_at: nowIso })
    .eq('alert_key', key)
    .eq('state', 'firing')
    .lt('last_notified_at', cutoff)
    .select('alert_key');

  if (remErr) {
    console.warn(`[AlertState] ${key} reminder check failed (staying silent): ${remErr.message}`);
    return { action: 'silent', sent: false };
  }
  if (!due || due.length === 0) return { action: 'silent', sent: false };

  return await _sendAndStamp({
    client, key, text, channel, send, now, kind: 'reminded', alreadyStamped: true, remindMs,
  });
}

/**
 * Send the card for a won transition, then record that we sent it.
 *
 * On a send failure the notify stamp is left null so the NEXT sweep retries —
 * bounded at one attempt per sweep, silent while GroupMe is down, and exactly
 * one card when it comes back.
 */
async function _sendAndStamp({ client, key, text, channel, send, now, kind, alreadyStamped = false, remindMs = 0 }) {
  let body;
  try {
    body = await _resolveText(text);
  } catch (err) {
    console.error(`[AlertState] ${key} body build failed: ${err.message}`);
    body = null;
  }
  if (!body) return { action: kind, sent: false, reason: 'no_text' };

  let sent = false;
  try {
    const res = await send(body, { channel, noDedup: true });
    sent = res?.sent !== false;
  } catch (err) {
    console.error(`[AlertState] ${key} send failed: ${err.message}`);
  }

  const nowIso = new Date(now).toISOString();
  if (sent && !alreadyStamped) {
    await Promise.resolve(
      client.from(TABLE).update({ last_notified_at: nowIso, notify_count: 1 }).eq('alert_key', key),
    ).catch((err) => console.warn(`[AlertState] ${key} notify stamp failed (ignored): ${err.message}`));
  } else if (!sent && alreadyStamped) {
    // The reminder CAS already moved the clock forward to claim the send. Wind
    // it back PAST the cutoff — not merely to now-1, which the next sweep's
    // `now - remindMs` predicate would never consider due — so a failed
    // reminder retries on the next sweep instead of waiting out another
    // full interval.
    await Promise.resolve(
      client.from(TABLE)
        .update({ last_notified_at: new Date(now - remindMs - 1000).toISOString() })
        .eq('alert_key', key),
    ).catch(() => {});
  }
  return { action: kind, sent };
}

/**
 * The condition is healthy. Take the clearing edge, and announce it ONLY if we
 * are the ones who announced the incident.
 *
 * notify_count === 0 is the guarantee that covers first deploy, kill-switch
 * toggles and any fire whose send failed: never send a recovery for an
 * incident whose alert nobody saw.
 */
async function _clear({ client, key, label, recoveredText, channel, notifyRecovery, send, now }) {
  const nowIso = new Date(now).toISOString();
  const { data, error } = await client.from(TABLE)
    .update({ state: 'cleared', cleared_at: nowIso, last_seen_at: nowIso })
    .eq('alert_key', key)
    .eq('state', 'firing')
    .select('alert_key, first_seen_at, notify_count, label');

  if (error) {
    console.warn(`[AlertState] ${key} clear failed (no recovery card): ${error.message}`);
    return { action: 'silent', sent: false, reason: 'clear_failed' };
  }
  // No row: never fired, or another replica already cleared it.
  if (!data || data.length === 0) return { action: 'idle', sent: false };

  const row = data[0];
  if (!notifyRecovery || !(row.notify_count > 0)) {
    return { action: 'recovered', sent: false, reason: 'no_alert_was_sent' };
  }

  const openedAt = row.first_seen_at ? new Date(row.first_seen_at) : null;
  let body;
  try {
    body = recoveredText
      ? await _resolveText(recoveredText)
      : formatRecovered(label ?? row.label ?? key, openedAt, now);
  } catch (err) {
    console.error(`[AlertState] ${key} recovery body failed: ${err.message}`);
    return { action: 'recovered', sent: false, reason: 'no_text' };
  }

  try {
    await send(body, { channel, noDedup: true });
    return { action: 'recovered', sent: true };
  } catch (err) {
    console.error(`[AlertState] ${key} recovery send failed: ${err.message}`);
    return { action: 'recovered', sent: false, reason: 'send_failed' };
  }
}

/**
 * The degraded path. Reached only when the state table is unusable, and it is
 * deliberately the pre-2026-09-04 behavior: a plain in-process time cooldown.
 * Worse than edge-triggering, never worse than what this change replaced.
 */
async function _fallbackFire({ key, text, channel, send, now, fallbackCooldownMs, reason }) {
  // has() rather than a 0 default: "never sent" must never read as "sent at
  // the epoch", or the FIRST degraded alert — the one that matters most,
  // because the state table is already down — gets swallowed.
  const seen = fallbackLastSentAt.has(key);
  const last = fallbackLastSentAt.get(key) ?? 0;
  if (seen && fallbackCooldownMs && now - last < fallbackCooldownMs) {
    return { action: 'fallback_silent', sent: false, reason };
  }
  fallbackLastSentAt.set(key, now);

  let body;
  try {
    body = await _resolveText(text);
  } catch (err) {
    console.error(`[AlertState] ${key} fallback body build failed: ${err.message}`);
    return { action: 'fallback_fired', sent: false, reason: 'no_text' };
  }
  if (!body) return { action: 'fallback_fired', sent: false, reason: 'no_text' };

  try {
    await send(body, { channel, noDedup: true });
    return { action: 'fallback_fired', sent: true, reason };
  } catch (err) {
    console.error(`[AlertState] ${key} fallback send failed: ${err.message}`);
    return { action: 'fallback_fired', sent: false, reason: 'send_failed' };
  }
}

/** Human-readable elapsed time. "1h 42m", "18m", "2d 3h". */
export function humanDuration(ms) {
  const s = Math.max(0, Math.round((ms ?? 0) / 1000));
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m`;
  return `${s}s`;
}

/**
 * The recovery card. Deliberately one terse line — a condition ending is good
 * news and must not read like a second incident.
 */
export function formatRecovered(label, openedAt, nowMs) {
  const now = nowMs ?? Date.now();
  const dur = openedAt instanceof Date && !Number.isNaN(openedAt.getTime())
    ? ` (was firing ${humanDuration(now - openedAt.getTime())})`
    : '';
  return `✅ RECOVERED — ${label}${dur}`;
}

export default {
  reportAlertCondition,
  formatRecovered,
  humanDuration,
  __setAlertStateClientForTests,
  __resetAlertStateFallback,
};
