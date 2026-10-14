/**
 * Rehash reply digest — src/jobs/rehash-reply-digest.js
 *
 * 2026-10-14 (John Manieri, rehash team). Post-demo leads who answer the
 * rehash bot with "Thank you", "No questions at the moment", "Melody did a
 * great job" or "Thinking" used to get a real-time "📞 REHASH CALL REQUEST …
 * said yes to a call" card. Nobody asked for anything, so the cards trained the
 * team to ignore the channel. Now those replies (`ack` / `not_now` in
 * src/agentic/rehash-intent.js) post nothing when they arrive; each leaves one
 * `agentic.f0_rehash_reply_digest` event, and this job lists the previous day's
 * in ONE #contact-rehash post at 08:45 ET on weekdays. Monday covers Friday
 * through Sunday, so weekend replies are not lost. Nothing to list → no post.
 *
 * "Already posted" is the one store (src/alert-posted.js, audit
 * `rehash_reply_digest`, keyed on the date): a redeploy after the post never
 * posts it twice. Slack is the destination of record (postToSlack); a failed
 * post is one #ops-alerts line and the job reads failed.
 */

import { runJob as defaultRunJob } from '../job-runner.js';
import { todayET } from './lp-report-common.js';
import { capLines, filterNew as defaultFilterNew, recordPosted as defaultRecordPosted } from '../alert-posted.js';
import { etDay, ghlContactUrl, rehashSlackChannel } from '../agentic/rehash.js';
import { rehashIntentRoutingEnabled } from '../agentic/rehash-intent.js';

export const JOB_ID = 'rehash-reply-digest';
export const AUDIT = 'rehash_reply_digest';
export const RUN_HOUR_ET = 8;
export const RUN_MINUTE_ET = 45;
export const MAX_LINES = 40;
const DAY_MS = 86_400_000;

const etParts = (nowMs) => {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York', weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(new Date(nowMs));
  const get = (t) => parts.find((p) => p.type === t)?.value;
  return { weekday: get('weekday'), hour: Number(get('hour')) % 24, minute: Number(get('minute')) };
};

/** Is it a weekday, at or after 08:45 ET? Pure. */
export function isDigestTime(nowMs = Date.now()) {
  const { weekday, hour, minute } = etParts(nowMs);
  if (weekday === 'Sat' || weekday === 'Sun') return false;
  return hour > RUN_HOUR_ET || (hour === RUN_HOUR_ET && minute >= RUN_MINUTE_ET);
}

/**
 * The Eastern days this morning's digest covers: yesterday, or Friday through
 * Sunday on a Monday. Pure.
 */
export function digestDays(nowMs = Date.now()) {
  const back = etParts(nowMs).weekday === 'Mon' ? [3, 2, 1] : [1];
  // Noon-anchored steps never cross a day boundary on a DST change.
  const noon = Date.parse(`${etDay(nowMs)}T12:00:00Z`);
  return back.map((n) => etDay(noon - n * DAY_MS));
}

const INTENT_LABEL = { ack: 'thanks', not_now: 'still deciding' };

/**
 * The post, or null when there is nothing to list. Pure.
 * @param {Array<{ ghl_contact_id, created_at, payload }>} rows  digest events
 * @param {{ days: string[], locationId?: string|null }} o
 */
export function buildRehashDigest(rows, { days, locationId = null } = {}) {
  const want = new Set(days || []);
  const seen = new Set();
  const lines = [];
  const sorted = [...(rows || [])].sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)));
  for (const r of sorted) {
    if (!want.has(etDay(Date.parse(r.created_at)))) continue;
    const id = r.ghl_contact_id || r.payload?.contact_id;
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const p = r.payload || {};
    const who = String(p.first_name || '').trim() || 'A post-demo lead';
    const said = String(p.inbound_preview || '').replace(/\s+/g, ' ').trim().slice(0, 160);
    const label = INTENT_LABEL[p.intent] || 'reply';
    lines.push(`• ${who} (${label}): "${said}"${locationId ? ` ${ghlContactUrl(locationId, id)}` : ''}`);
  }
  if (!lines.length) return null;
  const span = days.length > 1 ? `${days[0]} to ${days[days.length - 1]}` : days[0];
  return [
    `🗂️ REHASH REPLIES (${span}): no action needed today`,
    `Post-demo leads who replied with thanks or "still thinking". Nobody asked for a call or a quote.`,
    ...capLines(lines, MAX_LINES),
  ].join('\n');
}

async function defaultDeps() {
  const [{ default: supabase }, { postToSlack }, { sendAlertMessage }, { GHL_LOCATION_ID }] = await Promise.all([
    import('../supabase.js'),
    import('../slack.js'),
    import('../alert-state.js'),
    import('../actions/constants.js'),
  ]);
  return {
    supabase, postToSlack, locationId: GHL_LOCATION_ID,
    opsAlert: (text) => sendAlertMessage(text, { channel: 'ops' }),
    readEvents: async (sinceIso) => {
      const { data, error } = await supabase.from('system_events')
        .select('ghl_contact_id, created_at, payload')
        .eq('event_type', 'agentic.f0_rehash_reply_digest')
        .gte('created_at', sinceIso)
        .order('created_at', { ascending: true })
        .limit(1000);
      if (error) throw new Error(error.message);
      return data || [];
    },
  };
}

export async function runRehashReplyDigest({ post = true, deps: depsArg, env = process.env } = {}) {
  const deps = { filterNew: defaultFilterNew, recordPosted: defaultRecordPosted, ...(depsArg?.__noDefaults ? {} : await defaultDeps()), ...(depsArg || {}) };
  const nowMs = deps.nowMs ?? Date.now();
  const today = todayET(new Date(nowMs));
  const days = digestDays(nowMs);
  // A failed read throws: runJob records the pass as failed, never as "nothing to list".
  const rows = await deps.readEvents(new Date(nowMs - 5 * DAY_MS).toISOString());
  const text = buildRehashDigest(rows, { days, locationId: deps.locationId || null });
  if (!text) {
    console.log(`[RehashDigest] ${days.join(', ')}: nothing to list — no post`);
    return { ok: true, posted: false, lines: 0, summary: 'nothing to list' };
  }
  const lines = text.split('\n').length - 2;
  if (!post) return { ok: true, posted: false, lines, text, summary: `dry run, ${lines} line(s)` };
  const item = { key: today, reason: 'posted' };
  const { fresh } = await deps.filterNew({ audit: AUDIT, items: [item], ttlDays: 7, nowMs, deps: { supabase: deps.supabase } });
  if (!fresh.length) return { ok: true, posted: false, lines, summary: 'already posted today' };
  const channel = rehashSlackChannel(env);
  const res = await deps.postToSlack(text, channel);
  if (!res?.ok) {
    await Promise.resolve(deps.opsAlert(`🚨 REHASH REPLY DIGEST NOT POSTED\nSlack said: ${res?.error || 'unknown'} (channel ${channel})${res?.error === 'not_in_channel' ? '\nFix: add the Reece Slack app to #contact-rehash.' : ''}`)).catch(() => {});
    return { ok: false, posted: false, lines, summary: `slack_${res?.error || 'failed'}` };
  }
  await deps.recordPosted({ audit: AUDIT, items: [item], nowMs, deps: { supabase: deps.supabase } });
  console.log(`[RehashDigest] posted ${lines} line(s) to ${channel} (ts ${res.ts})`);
  return { ok: true, posted: true, lines, summary: `posted ${lines} line(s)` };
}

// ── Scheduler — weekdays at 08:45 ET ──────────────────────────────────────
let timer = null;
let lastRunSlot = null;

export function startRehashReplyDigestScheduler(env = process.env) {
  if (timer) return;
  if (!rehashIntentRoutingEnabled(env)) {
    console.log('[RehashDigest] disabled (REHASH_INTENT_ROUTING=off)');
    return;
  }
  console.log('[RehashDigest] Scheduler started — weekdays at 08:45 ET');
  const checkAndRun = async () => {
    const nowMs = Date.now();
    const today = todayET(new Date(nowMs));
    if (isDigestTime(nowMs) && lastRunSlot !== today) {
      lastRunSlot = today;
      try {
        await defaultRunJob(JOB_ID, () => runRehashReplyDigest({ post: true }), { occurrence: today });
      } catch (err) {
        console.error('[RehashDigest] run failed:', err.message);
      }
    }
  };
  timer = setInterval(checkAndRun, 5 * 60 * 1000);
  timer.unref?.();
}

export function stopRehashReplyDigestScheduler() {
  if (timer) { clearInterval(timer); timer = null; }
}
