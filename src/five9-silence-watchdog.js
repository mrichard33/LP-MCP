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
 *     → send one GroupMe alert. Suppress repeats to at most 1 per 6h.
 *
 * Mirrors src/fb-publish-watchdog.js (in-process throttle, GroupMe send
 * with no opts → immediate). Registered in src/index.js alongside
 * startFbPublishWatchdog().
 *
 * Env knobs (all optional; reuses existing Supabase + GroupMe creds):
 *   FIVE9_SILENCE_WATCHDOG_ENABLED (default 'true')
 *   FIVE9_SILENCE_INTERVAL_MS      (default 3600000 = hourly) poll cadence
 *   FIVE9_SILENCE_THRESHOLD_MIN    (default 120 = 2h) silence before alert
 */

import supabase from './supabase.js';
import { sendGroupMeMessage } from './groupme.js';

const ENABLED = (process.env.FIVE9_SILENCE_WATCHDOG_ENABLED || 'true') === 'true';
const INTERVAL_MS = parseInt(process.env.FIVE9_SILENCE_INTERVAL_MS || '3600000', 10);
const SILENCE_THRESHOLD_MS = parseInt(process.env.FIVE9_SILENCE_THRESHOLD_MIN || '120', 10) * 60 * 1000;
const REALERT_MS = 6 * 60 * 60 * 1000; // suppress repeat alerts to ≤1 per 6h
const TIMEZONE = process.env.REECE_TIMEZONE || 'America/New_York';

// In-process throttle. Resets on restart (a restart is exactly when we'd
// want to re-check), with a 6h re-alert ceiling so a persistently-silent
// feed can't spam the channel.
let lastAlertMs = 0;

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
 * Check for a silent Five9 ESS feed and alert once (per 6h) if silent.
 * Returns true if an alert was sent, false otherwise.
 */
export async function checkFive9Silence() {
  // Only alert during business hours — off-hours silence is expected.
  if (!isWithinFive9BusinessHours()) return false;

  const { data: latest, error } = await supabase
    .from('five9_events_raw')
    .select('received_at')
    .order('received_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) {
    console.error('[Five9Watchdog] query error:', error.message);
    return false;
  }

  // Empty table = pre-launch. Do nothing until the ESS has ever delivered.
  if (!latest || !latest.received_at) return false;

  const ageMs = Date.now() - new Date(latest.received_at).getTime();
  if (ageMs < SILENCE_THRESHOLD_MS) return false;

  // Silent past threshold — throttle to ≤1 alert per 6h.
  if (Date.now() - lastAlertMs < REALERT_MS) return false;
  lastAlertMs = Date.now();

  const text =
    `🚨 SYSTEM — Five9 ESS feed silent since ${latest.received_at} ` +
    `— check subscription status in Five9 Admin Console.`;
  try {
    await sendGroupMeMessage(text);
  } catch (e) {
    console.error('[Five9Watchdog] alert send failed:', e.message);
  }
  return true;
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
