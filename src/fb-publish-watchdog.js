/**
 * FB Publish Watchdog — src/fb-publish-watchdog.js
 *
 * Makes a missed WF4 publish window LOUD instead of silent.
 *
 * WF4 (n8n, jpk9cLbvvvZxMMFi) polls every 2 min and publishes any approved
 * FB post whose publish_at has passed. If the self-hosted n8n instance is
 * down / asleep, or its schedule trigger de-registers after a restart, a post
 * can sit past its publish_at with publish_attempts=0 and last_publish_error
 * null — completely invisible (this is exactly what happened 2026-06-13).
 *
 * This watchdog runs on an INTERNAL setInterval inside the always-on LP MCP
 * process (NOT an n8n cron — that would share the same failure mode) and
 * fires a GroupMe alert when an approved FB post is overdue and still
 * unpublished. ALERT-ONLY: it never publishes and never touches WF4.
 *
 * Env knobs (all optional; reuses existing Supabase + GroupMe creds):
 *   FB_WATCHDOG_ENABLED      (default 'true')
 *   FB_WATCHDOG_GRACE_MIN    (default 10)            minutes past publish_at before alerting
 *   FB_WATCHDOG_INTERVAL_MS  (default 300000 = 5min) poll cadence
 */

import supabase from './supabase.js';
import { sendGroupMeMessage } from './groupme.js';

const ENABLED = (process.env.FB_WATCHDOG_ENABLED || 'true') === 'true';
const GRACE_MIN = parseInt(process.env.FB_WATCHDOG_GRACE_MIN || '10', 10);
const INTERVAL_MS = parseInt(process.env.FB_WATCHDOG_INTERVAL_MS || '300000', 10);
const REALERT_MS = 6 * 60 * 60 * 1000; // re-alert a still-stuck post at most every 6h

// Per-process dedup: postId -> last alert epoch ms. Resets on restart (a
// restart is exactly when we'd want to re-check), with a 6h re-alert cap so a
// genuinely-stuck post can't spam the channel.
const alerted = new Map();

function todayInET() {
  // 'en-CA' yields YYYY-MM-DD; pin to America/New_York to match WF4's timezone.
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(new Date());
}

/**
 * Find approved, Facebook-targeted posts that should have published but
 * haven't, and alert once per post (per 6h). Returns the count newly flagged.
 */
export async function checkOverdueFbPosts() {
  const cutoffIso = new Date(Date.now() - GRACE_MIN * 60 * 1000).toISOString();
  const todayET = todayInET();

  // Overdue = approved, target page/both, not yet posted, under the retry cap,
  // and EITHER its timed publish_at is GRACE_MIN+ in the past, OR it is a
  // date-only post whose scheduled_date is before today (ET). Mirrors WF4's
  // own eligibility query plus the grace window.
  const { data: rows, error } = await supabase
    .from('fb_posts')
    .select('id, scheduled_date, publish_at, target, publish_attempts, last_publish_error')
    .eq('status', 'approved')
    .in('target', ['page', 'both'])
    .is('page_posted_at', null)
    .lt('publish_attempts', 3)
    .or(`publish_at.lte.${cutoffIso},and(publish_at.is.null,scheduled_date.lt.${todayET})`);

  if (error) {
    console.error('[FBWatchdog] query error:', error.message);
    return 0;
  }
  if (!rows || rows.length === 0) return 0;

  // Context only: note in the alert if auto-publish happens to be OFF (a
  // plausible secondary cause of a stuck post). Non-fatal if it fails.
  let autoOff = false;
  try {
    const { data: s } = await supabase
      .from('fb_settings')
      .select('auto_publish_enabled')
      .eq('id', 1)
      .maybeSingle();
    autoOff = !!(s && s.auto_publish_enabled === false);
  } catch (e) {
    /* alert without the settings note */
  }

  const now = Date.now();
  let flagged = 0;
  for (const r of rows) {
    if (now - (alerted.get(r.id) || 0) < REALERT_MS) continue;
    alerted.set(r.id, now);
    flagged++;
    const due = r.publish_at || `${r.scheduled_date} (date-based)`;
    const text =
      `🚨 SYSTEM — FB publish overdue\n` +
      `Post ${r.scheduled_date} (target ${r.target}) due ${due} is still unpublished ` +
      `— ${GRACE_MIN}m+ past, attempts ${r.publish_attempts || 0}/3. ` +
      `WF4 poller may be down or paused.` +
      (autoOff ? ' ⚠️ auto_publish is currently OFF.' : '') +
      `\nLast error: ${r.last_publish_error || 'none'} · id=${r.id}`;
    try {
      await sendGroupMeMessage(text);
    } catch (e) {
      console.error('[FBWatchdog] alert send failed:', e.message);
    }
  }
  return flagged;
}

export function startFbPublishWatchdog() {
  if (!ENABLED) {
    console.log('[FBWatchdog] disabled (FB_WATCHDOG_ENABLED!=true)');
    return;
  }
  const tick = () =>
    checkOverdueFbPosts()
      .then((n) => { if (n) console.log(`[FBWatchdog] ${n} overdue post(s) flagged`); })
      .catch((e) => console.error('[FBWatchdog] tick error:', e.message));
  setTimeout(tick, 30 * 1000); // first run ~30s after boot
  setInterval(tick, INTERVAL_MS); // then on cadence
  console.log(`[FBWatchdog] started — grace ${GRACE_MIN}m, interval ${INTERVAL_MS}ms`);
}
