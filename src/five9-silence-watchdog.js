/**
 * Five9 ESS Silence Watchdog — src/five9-silence-watchdog.js
 *
 * Makes a silent Five9 ESS feed LOUD instead of invisible.
 *
 * The ESS subscription (Five9 Admin Console) can silently stop delivering
 * — subscription disabled, endpoint URL changed, secret rotated — and
 * nothing here would notice: five9_events_raw just stops growing. This
 * watchdog runs on an INTERNAL setInterval inside the always-on LP MCP
 * process and fires a GroupMe alert when the feed goes quiet during
 * business hours. ALERT-ONLY: it never ingests and never touches the
 * webhook path.
 *
 * Logic:
 *   - Only during business hours (Mon-Sat 09:00-18:00 America/New_York).
 *   - If five9_events_raw is EMPTY (pre-launch) → do nothing.
 *   - Else if the newest received_at is older than SILENCE_THRESHOLD (2h)
 *     → the feed is silent.
 *
 * 2026-09-05 — EDGE-TRIGGERED (follow-on to PR #845). The suppression was
 * `lastAlertMs`, a process-local variable with a 6h ceiling, so a feed that
 * stayed dead re-announced itself every 6 hours and every redeploy re-announced
 * it immediately. It is now one durable condition ('five9:ess_silent') in
 * alert_conditions: one card per outage, a daily reminder while it lasts
 * because only a human can fix a dead subscription, and a silent clear when
 * events resume. The 6h value survives as the degraded-path cooldown.
 *
 * Registered in src/index.js alongside startFbPublishWatchdog().
 *
 * Env knobs (all optional; reuses existing Supabase + GroupMe creds):
 *   FIVE9_SILENCE_WATCHDOG_ENABLED (default 'true')
 *   FIVE9_SILENCE_INTERVAL_MS      (default 3600000 = hourly) poll cadence
 *   FIVE9_SILENCE_THRESHOLD_MIN    (default 120 = 2h) silence before alert
 *   FIVE9_SILENCE_REMIND_MS        (default 86400000 = 24h) re-nag interval
 */

import supabase from './supabase.js';
import { sendGroupMeMessage } from './groupme.js';
import { reportAlertCondition } from './alert-state.js';

const ENABLED = (process.env.FIVE9_SILENCE_WATCHDOG_ENABLED || 'true') === 'true';
const INTERVAL_MS = parseInt(process.env.FIVE9_SILENCE_INTERVAL_MS || '3600000', 10);
const SILENCE_THRESHOLD_MS = parseInt(process.env.FIVE9_SILENCE_THRESHOLD_MIN || '120', 10) * 60 * 1000;
const TIMEZONE = process.env.REECE_TIMEZONE || 'America/New_York';

// 2026-09-05: the ESS feed is ONE condition, so it gets one durable row.
const ALERT_KEY = 'five9:ess_silent';

// Was the in-process throttle (`lastAlertMs`, 6h). It now only paces the
// degraded path in alert-state.js, for when the state table is unusable.
const REALERT_MS = 6 * 60 * 60 * 1000;

// A dead ESS subscription cannot fix itself — somebody has to open the Five9
// Admin Console. So unlike the self-clearing live-ops alerts, this one nags,
// once a day, until the feed comes back.
const REMIND_MS = parseInt(
  process.env.FIVE9_SILENCE_REMIND_MS || `${24 * 60 * 60 * 1000}`, 10
);

// Mon-Sat, 09:00-18:00 ET. Modeled on isWithinBusinessHours in
// src/agentic-callback-message.js (weekday set includes Sat, 9-18 window).
function isWithinFive9BusinessHours(now = new Date()) {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: TIMEZONE,
    weekday: 'short',
    hour: 'numeric',
    hour12: false,
  });
  const parts = fmt.formatToParts(now);
  const weekday = parts.find(p => p.type === 'weekday')?.value || '';
  const hour = parseInt(parts.find(p => p.type === 'hour')?.value || '0', 10);
  const isBusinessDay = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].includes(weekday);
  const isInWindow = hour >= 9 && hour < 18;
  return isBusinessDay && isInWindow;
}

/**
 * Read the feed's health as a TRI-STATE, then let alert-state.js decide.
 *
 *   true  — silent past the threshold, inside business hours.
 *   false — delivering. Clears the condition.
 *   null  — could not tell. Touches nothing.
 *
 * Three of the five exits are `null`, and that is the whole point of the shape.
 * Before 2026-09-05 they all returned a bare `false` that only meant "don't
 * alert", which was fine when nothing acted on it. Now `false` also means
 * "announce a recovery" — so an off-hours sweep would report the feed healthy
 * at 18:01 and again at 08:59, every night, for a feed that has been dead since
 * yesterday afternoon.
 */
async function readFive9FeedState() {
  // Off-hours silence is expected, and is not evidence of a working feed. A
  // feed that dies at 17:59 must page at 09:00, not "recover" at 18:01.
  if (!isWithinFive9BusinessHours()) return { active: null, reason: 'outside_business_hours' };

  const { data: latest, error } = await supabase
    .from('five9_events_raw')
    .select('received_at')
    .order('received_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) {
    console.error('[Five9Watchdog] query error:', error.message);
    return { active: null, reason: 'query_error' };
  }

  // Empty table = pre-launch. The ESS has never delivered, so there is nothing
  // to call silent and nothing to call healthy.
  if (!latest || !latest.received_at) return { active: null, reason: 'no_events_yet' };

  const ageMs = Date.now() - new Date(latest.received_at).getTime();
  if (ageMs < SILENCE_THRESHOLD_MS) return { active: false, reason: 'delivering', latest };
  return { active: true, reason: 'silent', latest };
}

/**
 * Check for a silent Five9 ESS feed. Alerts ONCE per outage (re-reminding daily
 * while it lasts), and clears silently when the feed comes back.
 * Returns true if a card was sent this sweep.
 */
export async function checkFive9Silence() {
  const { active, latest } = await readFive9FeedState();

  const res = await reportAlertCondition({
    key: ALERT_KEY,
    active,
    label: 'Five9 ESS feed silent',
    text: () =>
      `🚨 SYSTEM — Five9 ESS feed silent since ${latest?.received_at} ` +
      `— check subscription status in Five9 Admin Console.`,
    detail: latest?.received_at ? `last event ${latest.received_at}` : null,
    remindMs: REMIND_MS,
    notifyRecovery: false,
    fallbackCooldownMs: REALERT_MS,
    send: sendGroupMeMessage,
  });

  return res.sent === true;
}

export function startFive9SilenceWatchdog() {
  if (!ENABLED) {
    console.log('[Five9Watchdog] disabled (FIVE9_SILENCE_WATCHDOG_ENABLED!=true)');
    return;
  }
  const tick = () =>
    checkFive9Silence()
      .then((sent) => { if (sent) console.log('[Five9Watchdog] silence alert sent'); })
      .catch((e) => console.error('[Five9Watchdog] tick error:', e.message));
  setTimeout(tick, 30 * 1000);    // first run ~30s after boot
  setInterval(tick, INTERVAL_MS); // then on cadence
  console.log(`[Five9Watchdog] started — threshold ${SILENCE_THRESHOLD_MS / 60000}m, interval ${INTERVAL_MS}ms`);
}
