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
 * 2026-09-05 — EDGE-TRIGGERED (follow-on to PR #845). Suppression was an
 * in-process `alerted` Map with a 6h ceiling, so a post nobody unstuck was
 * re-announced every 6 hours forever and every redeploy re-announced every
 * overdue post at once. Each post is now its own durable condition
 * ('fb_publish_overdue:<post_id>'): one card per stuck post per incident, and a
 * silent clear when it publishes or exhausts its retries. The 6h value survives
 * as the degraded-path cooldown.
 *
 * Env knobs (all optional; reuses existing Supabase + GroupMe creds):
 *   FB_WATCHDOG_ENABLED      (default 'true')
 *   FB_WATCHDOG_GRACE_MIN    (default 10)            minutes past publish_at before alerting
 *   FB_WATCHDOG_INTERVAL_MS  (default 300000 = 5min) poll cadence
 */

import supabase from './supabase.js';
import { sendGroupMeMessage } from './groupme.js';
import { claimAlertConditionSet, confirmAlertSend } from './alert-state.js';
import { runJob } from './job-runner.js';

const ENABLED = (process.env.FB_WATCHDOG_ENABLED || 'true') === 'true';
const GRACE_MIN = parseInt(process.env.FB_WATCHDOG_GRACE_MIN || '10', 10);
const INTERVAL_MS = parseInt(process.env.FB_WATCHDOG_INTERVAL_MS || '300000', 10);

// 2026-09-05: one condition per post. The overdue-ness of post A says nothing
// about post B, and a post stays overdue until somebody publishes it.
const ALERT_PREFIX = 'fb_publish_overdue:';

// Was the per-process `alerted` Map's 6h ceiling. It now paces only the
// degraded path in alert-state.js, for when the state table is unusable.
const REALERT_MS = 6 * 60 * 60 * 1000;

// Degraded path: postId -> last fallback alert. Consulted only when the state
// table is unusable, so in normal operation this stays empty.
const fallbackAlertedAt = new Map();

/** TESTS ONLY — clear the degraded-path clock. */
export function __resetFbWatchdogFallback() { fallbackAlertedAt.clear(); }

function todayInET() {
  // 'en-CA' yields YYYY-MM-DD; pin to America/New_York to match WF4's timezone.
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(new Date());
}

/**
 * Find approved, Facebook-targeted posts that should have published but
 * haven't, and alert ONCE per post per incident. Returns the count of cards
 * actually sent this sweep.
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

  // A failed query is not evidence that nothing is overdue, so it must not
  // clear anything — bail before touching alert state.
  if (error) {
    console.error('[FBWatchdog] query error:', error.message);
    return 0;
  }
  // Nothing overdue still runs the sweep below: an empty result is exactly how
  // the last stuck post resolves, and the clearing pass has to see it.
  const overdue = rows || [];

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
  const cardFor = (r) => {
    const due = r.publish_at || `${r.scheduled_date} (date-based)`;
    return (
      `🚨 SYSTEM — FB publish overdue\n` +
      `Post ${r.scheduled_date} (target ${r.target}) due ${due} is still unpublished ` +
      `— ${GRACE_MIN}m+ past, attempts ${r.publish_attempts || 0}/3. ` +
      `WF4 poller may be down or paused.` +
      (autoOff ? ' ⚠️ auto_publish is currently OFF.' : '') +
      `\nLast error: ${r.last_publish_error || 'none'} · id=${r.id}`
    );
  };
  const send = async (text) => {
    try {
      await sendGroupMeMessage(text);
      return true;
    } catch (e) {
      console.error('[FBWatchdog] alert send failed:', e.message);
      return false;
    }
  };

  // A post drops out of the query above once it publishes or exhausts its
  // retries, so "not in rows" is a real resolution and clears the condition —
  // silently, since a card announcing that a stuck post finally went out is not
  // worth waking anyone for.
  const claim = await claimAlertConditionSet({
    prefix: ALERT_PREFIX,
    activeKeys: overdue.map((r) => `${ALERT_PREFIX}${r.id}`),
    label: 'FB publish overdue',
    detail: `${overdue.length} overdue post(s)`,
  });

  // State table unusable — degrade to the pre-2026-09-05 per-process Map.
  if (!claim.ok) {
    let flagged = 0;
    for (const r of overdue) {
      if (now - (fallbackAlertedAt.get(r.id) || 0) < REALERT_MS) continue;
      fallbackAlertedAt.set(r.id, now);
      flagged++;
      await send(cardFor(r));
    }
    if (flagged) console.warn(`[FBWatchdog] alert-state unavailable (${claim.reason}) — ${flagged} alert(s) on the fallback path`);
    return flagged;
  }

  const newKeys = new Set(claim.newlyFiring);
  const sentKeys = [];
  for (const r of overdue) {
    const key = `${ALERT_PREFIX}${r.id}`;
    if (!newKeys.has(key)) continue;
    if (await send(cardFor(r))) sentKeys.push(key);
  }
  // Only stamp what actually went out. A send that failed leaves notify_count
  // at 0 on a row that is already firing, so the post is not re-announced.
  await confirmAlertSend(sentKeys);
  return sentKeys.length;
}

export function startFbPublishWatchdog() {
  if (!ENABLED) {
    console.log('[FBWatchdog] disabled (FB_WATCHDOG_ENABLED!=true)');
    return;
  }
  const tick = () =>
    runJob('fb-publish-watchdog', () => checkOverdueFbPosts())
      .then(({ value: n }) => { if (n) console.log(`[FBWatchdog] ${n} overdue post(s) flagged`); })
      .catch((e) => console.error('[FBWatchdog] tick error:', e.message));
  setTimeout(tick, 30 * 1000); // first run ~30s after boot
  setInterval(tick, INTERVAL_MS); // then on cadence
  console.log(`[FBWatchdog] started — grace ${GRACE_MIN}m, interval ${INTERVAL_MS}ms`);
}
