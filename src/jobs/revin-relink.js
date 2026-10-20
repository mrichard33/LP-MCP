/**
 * Revin re-link + alerts — src/jobs/revin-relink.js (2026-10-19, every 15 min)
 *
 * The webhook (src/revin/webhook.js) stores, answers and processes. This pass
 * covers what that cannot:
 *   1. a raw row still 'pending' 5+ minutes after it arrived (a deploy cut the
 *      background run off), or 'error' with attempts left → processed again;
 *   2. contact_messages with no contact → matched again once the identity
 *      exists (mirror + lp_leads only: no GHL token per retry);
 *   3. contact merges: a matched row not checked for a day is re-resolved, and
 *      when its lead / phone now points at another contact (the survivor of a
 *      merge) every row for that lead / phone follows it;
 *   4. Slack #ops-alerts (never GroupMe), edge-triggered: any 'error' raw row
 *      in the last hour, or more than 25 'unmatched' in the last hour. A read
 *      that failed reports active:null (touch nothing).
 * Read and store only: never creates a contact or a lead, never messages anyone.
 */
import supabaseDefault from '../supabase.js';
import { runJob } from '../job-runner.js';
import { reportAlertCondition } from '../alert-state.js';
import { processRevinEvent, matchContact, defaultDeps, MAX_ATTEMPTS } from '../revin/process.js';

export const JOB_ID = 'revin-relink';
export const INTERVAL_MS = 15 * 60 * 1000;
export const PENDING_GRACE_MS = 5 * 60 * 1000;
export const BATCH = 200;
export const UNMATCHED_ALERT_PER_HOUR = 25;
export const RECHECK_AFTER_MS = 24 * 60 * 60 * 1000;
const WINDOW_DAYS = 30;

/** Pure: the two alert states from the last hour's counts (null = could not tell). */
export function revinAlertStates({ errorCount, unmatchedCount }) {
  return {
    error: errorCount == null ? null : errorCount > 0,
    unmatched: unmatchedCount == null ? null : unmatchedCount > UNMATCHED_ALERT_PER_HOUR,
  };
}

/** The lookup key a row is re-matched on: its lead, else its phone. Pure. */
export function relinkKey(row) {
  if (row.lp_lead_id) return `lead:${row.lp_lead_id}`;
  if (row.phone_e164) return `phone:${row.phone_e164}`;
  return null;
}

async function retryRawRows(db, deps, nowMs) {
  const cutoff = new Date(nowMs - PENDING_GRACE_MS).toISOString();
  const counts = { reprocessed: 0 };
  for (const status of ['pending', 'error']) {
    const { data, error } = await db.from('revin_events_raw')
      .select('id, attempts')
      .eq('process_status', status)
      .lte('received_at', cutoff)
      .order('received_at', { ascending: true })
      .limit(BATCH);
    if (error) throw new Error(`revin_events_raw ${status}: ${error.message}`);
    for (const r of data || []) {
      if ((r.attempts || 0) >= MAX_ATTEMPTS) continue;
      await deps.processRevinEvent(r.id);
      counts.reprocessed += 1;
    }
  }
  return counts;
}

/** Rows grouped by relinkKey: one lookup per lead / phone. */
function groupByKey(rows) {
  const groups = new Map();
  for (const r of rows) {
    const k = relinkKey(r);
    if (!k) continue;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(r);
  }
  return groups;
}

async function relinkUnmatched(db, deps, nowMs) {
  const since = new Date(nowMs - WINDOW_DAYS * 86_400_000).toISOString();
  const { data, error } = await db.from('contact_messages')
    .select('id, lp_lead_id, phone_e164, raw_event_id')
    .eq('source', 'revin')
    .is('ghl_contact_id', null)
    .gte('created_at', since)
    .order('created_at', { ascending: true })
    .limit(BATCH);
  if (error) throw new Error(`contact_messages unmatched: ${error.message}`);
  const counts = { linked: 0, still_unmatched: 0 };
  const rawIds = new Set();
  for (const rows of groupByKey(data || []).values()) {
    const m = await matchContact(rows[0], deps, { live: false });
    if (!m.ghl_contact_id) { counts.still_unmatched += rows.length; continue; }
    const { error: upErr } = await db.from('contact_messages')
      .update({ ghl_contact_id: m.ghl_contact_id, lp_lead_id: rows[0].lp_lead_id || m.lp_lead_id, updated_at: new Date(nowMs).toISOString() })
      .in('id', rows.map((r) => r.id));
    if (upErr) throw new Error(`contact_messages link: ${upErr.message}`);
    counts.linked += rows.length;
    for (const r of rows) if (r.raw_event_id) rawIds.add(r.raw_event_id);
  }
  // A raw event whose rows are all matched now reads 'ok'.
  for (const rawId of rawIds) {
    const { data: left, error: lErr } = await db.from('contact_messages')
      .select('id').eq('raw_event_id', rawId).is('ghl_contact_id', null).limit(1);
    if (lErr || (left && left.length)) continue;
    await db.from('revin_events_raw').update({ process_status: 'ok' }).eq('id', rawId).eq('process_status', 'unmatched');
  }
  return counts;
}

async function followMerges(db, deps, nowMs) {
  const since = new Date(nowMs - WINDOW_DAYS * 86_400_000).toISOString();
  const stale = new Date(nowMs - RECHECK_AFTER_MS).toISOString();
  const { data, error } = await db.from('contact_messages')
    .select('id, ghl_contact_id, lp_lead_id, phone_e164')
    .eq('source', 'revin')
    .not('ghl_contact_id', 'is', null)
    .gte('created_at', since)
    .lte('updated_at', stale)
    .order('updated_at', { ascending: true })
    .limit(BATCH);
  if (error) throw new Error(`contact_messages matched: ${error.message}`);
  const counts = { checked: 0, moved: 0 };
  const stamp = new Date(nowMs).toISOString();
  for (const rows of groupByKey(data || []).values()) {
    counts.checked += rows.length;
    let m;
    try { m = await matchContact(rows[0], deps, { live: false }); } catch { continue; }
    const patch = { updated_at: stamp };
    const moved = m.ghl_contact_id && rows.some((r) => r.ghl_contact_id !== m.ghl_contact_id);
    if (moved) patch.ghl_contact_id = m.ghl_contact_id;
    const { error: upErr } = await db.from('contact_messages').update(patch).in('id', rows.map((r) => r.id));
    if (upErr) throw new Error(`contact_messages merge: ${upErr.message}`);
    if (moved) counts.moved += rows.length;
  }
  return counts;
}

async function countLastHour(db, status, nowMs) {
  const since = new Date(nowMs - 3_600_000).toISOString();
  const { data, error } = await db.from('revin_events_raw')
    .select('id').eq('process_status', status).gte('received_at', since).limit(1000);
  if (error) return null;
  return (data || []).length;
}

export async function runRevinRelink({ deps = {}, nowMs = Date.now() } = {}) {
  const db = deps.supabase || supabaseDefault;
  const match = { ...defaultDeps(db), ...deps, supabase: db };
  const d = {
    ...match,
    processRevinEvent: deps.processRevinEvent || ((id) => processRevinEvent(id, { deps: match })),
    reportAlertCondition: deps.reportAlertCondition || reportAlertCondition,
  };
  const counts = {};
  let ok = true;
  for (const [name, step] of [['raw', retryRawRows], ['unmatched', relinkUnmatched], ['merges', followMerges]]) {
    try {
      Object.assign(counts, await step(db, d, nowMs));
    } catch (err) {
      ok = false;
      counts[`${name}_error`] = err.message;
      console.warn(`[Revin] relink ${name} failed: ${err.message}`);
    }
  }

  const errorCount = await countLastHour(db, 'error', nowMs);
  const unmatchedCount = await countLastHour(db, 'unmatched', nowMs);
  const states = revinAlertStates({ errorCount, unmatchedCount });
  await d.reportAlertCondition({
    key: 'revin_webhook:process_error',
    label: 'Revin webhook processing errors',
    active: states.error,
    channel: 'ops',
    text: () => `:warning: *Revin webhook*: ${errorCount} event(s) failed to process in the last hour. Stored in revin_events_raw (process_status='error', see process_error); the relink job retries each up to ${MAX_ATTEMPTS} times.`,
  });
  await d.reportAlertCondition({
    key: 'revin_webhook:unmatched_spike',
    label: 'Revin webhook unmatched events',
    active: states.unmatched,
    channel: 'ops',
    text: () => `:warning: *Revin webhook*: ${unmatchedCount} event(s) in the last hour matched no contact (over ${UNMATCHED_ALERT_PER_HOUR}). Check the phone / lead id mapping in src/revin/normalize.js.`,
  });
  counts.error_last_hour = errorCount;
  counts.unmatched_last_hour = unmatchedCount;
  return { ok, counts };
}

/* --- scheduler -------------------------------------------------------------- */

let timer = null;
let running = false;

export function startRevinRelinkScheduler() {
  if (timer) return timer;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      const { value: res } = await runJob(JOB_ID, () => runRevinRelink());
      const c = res?.counts || {};
      if (c.reprocessed || c.linked || c.moved) console.log(`[Revin] relink: ${JSON.stringify(c)}`);
    } catch (err) {
      console.error(`[Revin] relink pass threw: ${err.message}`);
    } finally {
      running = false;
    }
  };
  timer = setInterval(tick, INTERVAL_MS);
  if (typeof timer.unref === 'function') timer.unref();
  console.log('[Revin] relink scheduler started — every 15m');
  return timer;
}

export function stopRevinRelinkScheduler() {
  if (timer) { clearInterval(timer); timer = null; }
}
