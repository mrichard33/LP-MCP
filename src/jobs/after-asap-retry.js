// ─── After DIAL ASAP retry backstop: the job — src/jobs/after-asap-retry.js ───
//
// Every 15 minutes: find phones whose last Five9 call was a no-contact on DIAL
// ASAP or Simpletext outbound with no follow-up since, and put the matching
// Five9 record on "After DIAL ASAP" where the connector did not. Why, and every
// rule: src/after-asap-retry.js.
//
// MODE — AFTER_ASAP_RETRY_MODE: off | shadow (default) | live. Shadow decides
// every pass and records would_push in job_runs.detail; live writes one
// five9_add_records_to_list agent action per lead (no approval, like the
// new-lead dial backstop). No Slack card for the pushes (Mark, 2026-10-07:
// never post "we fixed it").

import { runJob } from '../job-runner.js';
import {
  retryMode, retryConfig, pickCandidates, recordForCall, decide, buildRetryRecord, attemptsOf, AFTER_LIST,
} from '../after-asap-retry.js';

export const JOB_ID = 'after-asap-retry';
export const RULE_KEY = 'AFTER_ASAP_RETRY_BACKSTOP';
export const INTERVAL_MS = 15 * 60 * 1000;
const MARKS_TABLE = 'lp_appointment_sync_marks';
const PHONE10_SQL = `right(regexp_replace(COALESCE(phone, ''::text), '[^0-9]'::text, ''::text, 'g'::text), 10)`;
const q = (x) => `'${String(x).replace(/'/g, "''")}'`;
const chunks = (xs, n) => { const out = []; for (let i = 0; i < xs.length; i += n) out.push(xs.slice(i, i + n)); return out; };

async function defaultDeps() {
  const [{ runSQL }, supabaseMod, five9] = await Promise.all([
    import('../admin/supabase-admin.js'),
    import('../supabase.js'),
    import('../five9-admin.js'),
  ]);
  return {
    runSQL,
    supabase: supabaseMod.default,
    getContactRecords: five9.getContactRecords,
    checkDnc: five9.checkDncForNumbers,
  };
}

/** Five9 dispositions since `sinceMs`, without the payload (five9_events_raw is ~850 MB). */
async function readEvents(runSQL, sinceMs) {
  const rows = await runSQL(`
    SELECT dnis, ani, campaign, disposition_name AS d, lp_rec_key, coalesce(call_start_at, received_at) AS t
      FROM five9_events_raw
     WHERE event_type = 'disposition' AND received_at >= ${q(new Date(sinceMs).toISOString())}`);
  if (!Array.isArray(rows)) throw new Error('five9 events: no row set');
  return rows;
}

/** Newest LP lead's disposition per phone. Expression matches idx_lp_leads_phone10. */
async function readLpDispos(runSQL, phones) {
  const out = new Map();
  for (const part of chunks(phones, 400)) {
    const rows = await runSQL(`
      SELECT DISTINCT ON (${PHONE10_SQL}) ${PHONE10_SQL} AS phone10, disposition_code
        FROM lp_leads
       WHERE ${PHONE10_SQL} IN (${part.map(q).join(',')})
       ORDER BY ${PHONE10_SQL}, created_at_lp DESC`);
    if (!Array.isArray(rows)) throw new Error('lp dispositions: no row set');
    for (const r of rows) out.set(String(r.phone10), r.disposition_code ?? null);
  }
  return out;
}

export async function runAfterAsapRetry({ env = process.env, nowMs = Date.now(), deps: depsIn = {} } = {}) {
  const mode = retryMode(env);
  if (mode === 'off') return { skipped: true, reason: 'AFTER_ASAP_RETRY_MODE=off', mode };
  const d = { ...(depsIn.runSQL && depsIn.supabase ? {} : await defaultDeps()), ...depsIn };
  const cfg = retryConfig(env);
  const counts = {};
  const decisions = [];
  const errors = [];
  const note = (cand, reason, extra = {}) => {
    counts[reason] = (counts[reason] || 0) + 1;
    decisions.push({ phone4: cand.phone.slice(-4), key: cand.lpRecKey, campaign: cand.campaign, dispo: cand.dispo, reason, ...extra });
  };

  let events;
  try {
    events = await readEvents(d.runSQL, nowMs - cfg.lookbackHours * 3600_000);
  } catch (err) {
    // Could not tell: unknown, never "0 owed".
    return { checked: false, readFailed: true, mode, reason: err.message };
  }
  const cands = pickCandidates(events, { nowMs, cfg });
  if (!cands.length) return { ok: true, mode, candidates: 0, counts, decisions };

  const phones = cands.map((c) => c.phone);
  let dispos = null;
  try { dispos = await readLpDispos(d.runSQL, phones); } catch (err) { errors.push(err.message); }
  let onDnc = null;
  try {
    onDnc = new Set();
    for (const part of chunks(phones, 200)) {
      const res = await d.checkDnc(part);
      for (const n of res?.on_dnc || []) onDnc.add(String(n).replace(/\D/g, '').slice(-10));
    }
  } catch (err) {
    onDnc = null;
    errors.push(`dnc: ${err.message}`);
  }
  // A failed LP or DNC read must not dial blind: skip the pass, log why.
  if (!dispos || !onDnc) return { ok: false, mode, candidates: cands.length, errors };

  let lookups = 0;
  let pushes = 0;
  for (const cand of cands) {
    if (lookups >= cfg.maxLookups) { note(cand, 'over_lookup_cap'); continue; }
    // Cheap skips first, before spending a Five9 lookup.
    const pre = decide({ cand, rec: { row: { f9_last_list: '', CustID: 'x' }, total: 1 }, lpDispo: dispos.get(cand.phone), onDnc: onDnc.has(cand.phone) });
    if (pre.action === 'skip') { note(cand, pre.reason); continue; }
    lookups += 1;
    let rec;
    try {
      rec = recordForCall(await d.getContactRecords([{ field: 'number1', value: cand.phone }]), cand.lpRecKey);
    } catch {
      rec = 'error';
    }
    const fin = decide({ cand, rec, lpDispo: dispos.get(cand.phone), onDnc: onDnc.has(cand.phone) });
    if (fin.action !== 'push') { note(cand, fin.reason); continue; }
    if (pushes >= cfg.maxPushes) { note(cand, 'deferred'); continue; }
    const record = buildRetryRecord(rec.row);
    const extra = { records_for_phone: rec.total, attempts: attemptsOf(rec.row), last_list: rec.row.f9_last_list || null };
    if (mode === 'shadow') {
      note(cand, 'would_push', { detail: fin.reason, ...extra });
      pushes += 1;
      console.log(`[AfterAsapRetry] shadow: would add …${cand.phone.slice(-4)} (${cand.lpRecKey}) to "${AFTER_LIST}" — ${fin.reason}`);
      continue;
    }
    // live: one claim per call record key, so a lead is re-queued once.
    const key = `after_asap_retry:${cand.lpRecKey}:${cand.lastMs}`;
    try {
      const { data, error } = await d.supabase.from(MARKS_TABLE).upsert(
        { dedup_key: key, contact_id: null, lds_id: rec.row.lead_id || null, appt_date: null, created_at: new Date(nowMs).toISOString() },
        { onConflict: 'dedup_key', ignoreDuplicates: true },
      ).select('dedup_key');
      if (error) throw new Error(error.message);
      if (!data?.length) { note(cand, 'already_pushed'); continue; }
      const ins = await d.supabase.from('agent_actions').insert({
        event_id: null,
        action_type: 'five9_add_records_to_list',
        target_system: 'five9',
        target_entity: 'list',
        target_id: AFTER_LIST,
        action_payload: {
          list_name: AFTER_LIST, field_names: record.fieldNames, records: [record.values],
          call_now_mode: cfg.callNowMode, key_fields: ['number1', 'LPRecKey'],
        },
        rollback_payload: { action_type: 'five9_delete_record_from_list', list_name: AFTER_LIST, field_names: ['number1'], records: [[cand.phone]] },
        reasoning: `After DIAL ASAP retry backstop: ${cand.lpRecKey} got "${cand.dispo}" on ${cand.campaign} `
          + `${new Date(cand.lastMs).toISOString()} and nothing since; Five9's connector did not put it on "${AFTER_LIST}" `
          + `(${fin.reason}, ${rec.total} record(s) for the phone). Added with keys number1 + LPRecKey (2026-10-14).`,
        rule_applied: RULE_KEY,
        confidence: 1.0,
        status: 'pending',
        requires_approval: false,
        priority: 70,
      }).select('id').single();
      if (ins.error) {
        await Promise.resolve(d.supabase.from(MARKS_TABLE).delete().in('dedup_key', [key])).catch(() => {});
        throw new Error(ins.error.message);
      }
      pushes += 1;
      note(cand, 'pushed', { detail: fin.reason, action_id: ins.data?.id ?? null, ...extra });
    } catch (err) {
      errors.push(`push ${cand.lpRecKey}: ${err.message}`);
      note(cand, 'push_failed');
    }
  }
  return { ok: errors.length === 0, mode, candidates: cands.length, pushed: pushes, counts, decisions: decisions.slice(0, 100), errors };
}

/* --- scheduler -------------------------------------------------------------- */

let timer = null;
let running = false;

export function startAfterAsapRetryScheduler(env = process.env) {
  if (timer) return timer;
  if (retryMode(env) === 'off') {
    console.log('[AfterAsapRetry] scheduler not started (AFTER_ASAP_RETRY_MODE=off)');
    return null;
  }
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      const { value: res } = await runJob(JOB_ID, () => runAfterAsapRetry());
      if (res && !res.skipped && Object.keys(res.counts || {}).length) console.log(`[AfterAsapRetry] ${res.mode}: ${JSON.stringify(res.counts)}`);
    } catch (err) {
      console.error(`[AfterAsapRetry] pass threw: ${err.message}`);
    } finally {
      running = false;
    }
  };
  timer = setInterval(tick, INTERVAL_MS);
  if (typeof timer.unref === 'function') timer.unref();
  console.log(`[AfterAsapRetry] scheduler started — mode ${retryMode(env)}, every 15m`);
  return timer;
}

export function stopAfterAsapRetryScheduler() {
  if (timer) { clearInterval(timer); timer = null; }
}
