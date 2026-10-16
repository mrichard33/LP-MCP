/**
 * Siro poll backstop — src/jobs/siro-recording-sync.js (2026-10-16, Siro PR 1)
 *
 * Every 10 minutes (Siro's own suggested cadence, docs/siro-reference.md §3
 * option B): page GET /core/recordings?updatedAt:gte=<watermark> on the
 * org-wide API, and run each new or newer recording through the same
 * processRecording the webhook uses, so a lost webhook (or one Siro never
 * sent) still lands. The watermark (siro_sync_state.recordings_watermark,
 * first run now − 7 days) moves only after a FULL pass: a pass that stops
 * part-way is re-read next time, and processRecording is idempotent.
 *
 * SIRO_SYNC_MODE off | shadow (default: store only) | live. Every decision is
 * in job_runs.detail.by_reason.
 */
import supabaseDefault from '../supabase.js';
import { runJob } from '../job-runner.js';
import * as siroDefault from '../siro/client.js';
import { listRows, nextCursor } from '../siro/client.js';
import { processRecording } from '../siro/ingest.js';
import { siroModes } from '../siro/config.js';

export const JOB_ID = 'siro-recording-sync';
export const WATERMARK_KEY = 'recordings_watermark';
const INTERVAL_MS = 10 * 60_000;
const FIRST_RUN_LOOKBACK_MS = 7 * 86_400_000;
const MAX_PAGES = 50;

export function syncMode(env = process.env) { return siroModes(env).sync; }

async function readWatermark(supabase) {
  const { data, error } = await supabase.from('siro_sync_state').select('value').eq('key', WATERMARK_KEY).maybeSingle();
  if (error) throw new Error(`watermark read failed: ${error.message}`);
  return data?.value || null;
}

/**
 * @param {{since?: string, dryRun?: boolean, env?: object, deps?: object, nowMs?: number}} o
 *   dryRun lists what the pass would process and writes nothing.
 */
/**
 * Matched recordings stored before their LP lead had a GHL contact id never
 * got one (58 of the first 118, 2026-10-16), so they could never get a demo
 * note. Database only: re-read lp_leads for them and fill it in.
 */
export async function refreshMissingContacts(supabase, { limit = 200 } = {}) {
  const { data: rows, error } = await supabase.from('siro_recordings')
    .select('recording_id, lp_lead_id').is('ghl_contact_id', null).not('lp_lead_id', 'is', null).limit(limit);
  if (error) throw new Error(`siro_recordings read failed: ${error.message}`);
  const ids = [...new Set((rows || []).map(r => String(r.lp_lead_id)))];
  if (!ids.length) return 0;
  const { data: leads, error: lErr } = await supabase.from('lp_leads').select('lp_lead_id, ghl_contact_id').in('lp_lead_id', ids);
  if (lErr) throw new Error(`lp_leads read failed: ${lErr.message}`);
  const contactOf = new Map((leads || []).filter(l => l.ghl_contact_id).map(l => [String(l.lp_lead_id), l.ghl_contact_id]));
  let filled = 0;
  for (const r of rows || []) {
    const c = contactOf.get(String(r.lp_lead_id));
    if (!c) continue;
    const { error: uErr } = await supabase.from('siro_recordings').update({ ghl_contact_id: c })
      .eq('recording_id', r.recording_id).is('ghl_contact_id', null);
    if (!uErr) filled++;
  }
  return filled;
}

export async function runSiroRecordingSync({ since = null, dryRun = false, reprocess = false, env = process.env, deps = {}, nowMs = Date.now() } = {}) {
  const supabase = deps.supabase || supabaseDefault;
  const siro = deps.siro || siroDefault;
  const mode = syncMode(env);
  if (mode === 'off' && !dryRun) return { ok: true, skipped: true, mode };
  const startedIso = new Date(nowMs).toISOString();
  const from = since || (await readWatermark(supabase)) || new Date(nowMs - FIRST_RUN_LOOKBACK_MS).toISOString();

  const byReason = {};
  const counts = {};
  const note = (reason, id) => { (byReason[reason] ||= []).push(id); counts[reason] = (counts[reason] || 0) + 1; };
  let cursor = null;
  let pages = 0;
  let complete = false;
  const errors = [];
  let maxUpdated = null;

  while (pages < MAX_PAGES) {
    const res = await siro.listRecordingsUpdatedSince(from, { cursor, limit: 100 });
    pages++;
    if (!res.ok) { errors.push(`list page ${pages}: ${res.error}`); break; }
    const rows = listRows(res.data);
    for (const raw of rows) {
      const id = String(raw?.id || '');
      if (!id) continue;
      if (raw.updatedAt && (!maxUpdated || raw.updatedAt > maxUpdated)) maxUpdated = raw.updatedAt;
      if (dryRun) { note('would_process', id); continue; }
      try {
        // A reprocess pass re-normalizes what we hold; it never emits or notes.
        const out = await processRecording(id, { source: 'poll', mode: reprocess ? 'shadow' : mode, raw, onlyIfNewer: true, reprocess, env, deps });
        note(out.result, id);
      } catch (err) {
        errors.push(`${id}: ${err.message}`);
        note('threw', id);
      }
    }
    cursor = nextCursor(res.data);
    if (!cursor || !rows.length) { complete = true; break; }
  }

  if (!dryRun) {
    try {
      const filled = await refreshMissingContacts(supabase);
      if (filled) counts.contact_refreshed = filled;
    } catch (err) {
      errors.push(`contact refresh: ${err.message}`);
    }
  }

  // Only a full pass moves the watermark. The newest updatedAt seen is the
  // next start (an equal updatedAt is re-read, not skipped: gte).
  let watermark = from;
  if (complete && !dryRun && !reprocess) {
    watermark = maxUpdated || startedIso;
    const { error } = await supabase.from('siro_sync_state')
      .upsert({ key: WATERMARK_KEY, value: watermark, updated_at: startedIso }, { onConflict: 'key' });
    if (error) errors.push(`watermark write: ${error.message}`);
  }
  return {
    ok: errors.length === 0, mode, dry_run: dryRun, reprocess, from, watermark, complete, pages,
    counts, by_reason: byReason, errors: errors.slice(0, 20),
    summary: `${mode}${dryRun ? ' dry run' : ''}: ${Object.entries(counts).map(([k, v]) => `${k}=${v}`).join(' ') || 'nothing new'}`,
  };
}

let timer = null;
let running = false;

export function startSiroRecordingSyncScheduler(env = process.env) {
  if (timer) return timer;
  if (syncMode(env) === 'off') {
    console.log('[SiroSync] scheduler not started (SIRO_SYNC_MODE=off)');
    return null;
  }
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      const { value } = await runJob(JOB_ID, () => runSiroRecordingSync());
      if (value?.summary) console.log(`[SiroSync] ${value.summary}`);
    } catch (err) {
      console.error(`[SiroSync] pass threw: ${err.message}`);
    } finally {
      running = false;
    }
  };
  timer = setInterval(tick, INTERVAL_MS);
  timer.unref?.();
  console.log(`[SiroSync] scheduler started — every 10m, mode ${syncMode(env)}`);
  return timer;
}
