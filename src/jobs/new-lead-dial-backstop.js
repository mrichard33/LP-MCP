// ─── New-lead dial backstop — src/jobs/new-lead-dial-backstop.js ─────────────
//
// Every 5 minutes inside the Five9 dial window (8:00–19:45 ET), find LP leads
// from the last 72 hours that are imported, never called, and not on a Five9
// list that is dialing them, and put them on the right list ourselves. The
// WHY and every rule live in src/new-lead-dial-backstop.js; this file only
// reads, claims and writes.
//
// MODES — NEW_LEAD_DIAL_BACKSTOP_MODE, default `shadow`
//   off     do nothing.
//   shadow  read and decide everything; log "would push". No Five9 write, no
//           marks, no Slack (the user, 2026-10-05: no unnecessary notifications).
//   live    claim, push, and post ONE #contact-center card per pass that pushed
//           something. Going live is the user's decision.
//   Anything unrecognised is `shadow`: a typo must not start dialing.
//
// FAIL CLOSED ON READS
//   A failed LP read, call-history read, lp_leads read or marks read ends the
//   pass with nothing pushed — "could not read" must never become "not called".
//   A failed DNC read leaves those rows unmarked for the next pass. A failed
//   per-number contact lookup pushes anyway (noted): an extra list membership
//   is an annoyance, a lead nobody calls is the failure this job exists for.
//
// CLAIM, THEN PUSH
//   Both dedup keys (row+list, phone+day) are claimed in
//   lp_appointment_sync_marks (unique dedup_key, ignoreDuplicates) BEFORE the
//   five9_add_records_to_list action row is written; a lost claim pushes
//   nothing, and a failed insert releases the claims so the next pass retries.
//   The action row is the existing auto-approved carve-out the executor runs
//   (src/five9/admin-writes.js executeAddRecordsToList, FIVE9_WRITES_ENABLED).

import { runJob } from '../job-runner.js';
import { summarizeContactRecord } from '../lead-leak-classify.js';
import { dialWindowStartMs } from '../five9/callback-dial-check.js';
import {
  backstopMode, backstopConfig, normalizeInboundRow, prefilter, finalDecision,
  buildBackstopRecord, formatPushedCard, markKey, phoneDayKey, etDateKey,
  MISSED_CALL_DISPOSITIONS,
} from '../new-lead-dial-backstop.js';

export const JOB_ID = 'new-lead-dial-backstop';
export const RULE_KEY = 'NEW_LEAD_DIAL_BACKSTOP';
export const INTERVAL_MS = 5 * 60 * 1000;
const MARKS_TABLE = 'lp_appointment_sync_marks';
const PAGE_SIZE = 200;
const MAX_PAGES = 10;
const DNC_BATCH = 200;
const ALERT_KEY = 'new-lead-dial-backstop';

const q = (x) => `'${String(x).replace(/'/g, "''")}'`;
const chunks = (xs, n) => { const out = []; for (let i = 0; i < xs.length; i += n) out.push(xs.slice(i, i + n)); return out; };

async function defaultDeps() {
  const [{ runSQL }, supabaseMod, five9, lp, slack, alertState] = await Promise.all([
    import('../admin/supabase-admin.js'),
    import('../supabase.js'),
    import('../five9-admin.js'),
    import('../lp-client.js'),
    import('../slack.js'),
    import('../alert-state.js'),
  ]);
  return {
    runSQL,
    supabase: supabaseMod.default,
    checkDnc: five9.checkDncForNumbers,
    getContactRecords: five9.getContactRecords,
    listInboundLeads: lp.listInboundLeads,
    postToSlack: slack.postToSlack,
    reportAlertCondition: alertState.reportAlertCondition,
  };
}

/** Inside the window Five9 dials in (the next record filed now would dial now). */
export function inDialWindow(nowMs) {
  return dialWindowStartMs(nowMs) === nowMs;
}

const lpDay = (ms) => {
  const [y, m, d] = etDateKey(ms).split('-');
  return `${m}/${d}/${y}`;
};

/** Every inbound row in [start, end], page by page (StartIndex is a PAGE number). */
async function readInboundRows(listInboundLeads, nowMs, lookbackHours) {
  const startdate = lpDay(nowMs - lookbackHours * 3600_000);
  const enddate = lpDay(nowMs + 86_400_000);
  const rows = [];
  for (let page = 1; page <= MAX_PAGES; page += 1) {
    const res = await listInboundLeads({ startdate, enddate, page, pageSize: PAGE_SIZE });
    const batch = Array.isArray(res) ? res : (res?.data || res?.leads || []);
    if (!Array.isArray(batch)) throw new Error('LP inbound read returned no row list');
    rows.push(...batch);
    if (batch.length < PAGE_SIZE) return rows;
  }
  throw new Error(`LP inbound read: more than ${MAX_PAGES * PAGE_SIZE} rows in ${lookbackHours}h — refusing a partial read`);
}

/** Five9 calls to (dnis) or real conversations from (ani) each phone, since sinceMs. */
async function readCalls(runSQL, phones, sinceMs) {
  if (!phones.length) return [];
  const list = phones.map(q).join(',');
  const rows = await runSQL(`
    SELECT right(regexp_replace(coalesce(dnis,''),'\\D','','g'),10) AS dnis,
           right(regexp_replace(coalesce(ani,''),'\\D','','g'),10) AS ani,
           disposition_name, received_at
      FROM five9_events_raw
     WHERE received_at >= ${q(new Date(sinceMs).toISOString())}
       AND (right(regexp_replace(coalesce(dnis,''),'\\D','','g'),10) IN (${list})
         OR right(regexp_replace(coalesce(ani,''),'\\D','','g'),10) IN (${list}))`);
  if (!Array.isArray(rows)) throw new Error('call history read returned no row set');
  return rows;
}

/** Did Five9 call this number, or talk to it, at/after it arrived (1 min slack)? */
export function wasCalled(calls, phone, receivedMs) {
  return calls.some((c) => {
    const at = Date.parse(c.received_at);
    if (!Number.isFinite(at) || at < receivedMs - 60_000) return false;
    if (c.dnis === phone) return true;
    return c.ani === phone && !MISSED_CALL_DISPOSITIONS.has(String(c.disposition_name ?? '').trim());
  });
}

async function readLeads(runSQL, ldsIds) {
  const byId = new Map();
  for (const part of chunks(ldsIds, 300)) {
    const rows = await runSQL(`
      SELECT lp_lead_id, lp_prospect_id, disposition_code, appointment_date::text AS appointment_date,
             address, city, state, zip, ghl_contact_id
        FROM lp_leads WHERE lp_lead_id IN (${part.map(q).join(',')})`);
    if (!Array.isArray(rows)) throw new Error('lp_leads read returned no row set');
    for (const r of rows) byId.set(String(r.lp_lead_id), r);
  }
  return byId;
}

async function readMarks(db, keys) {
  const seen = new Set();
  for (const part of chunks(keys, 300)) {
    const { data, error } = await db.from(MARKS_TABLE).select('dedup_key').in('dedup_key', part);
    if (error) throw new Error(`marks read: ${error.message}`);
    for (const r of data || []) seen.add(r.dedup_key);
  }
  return seen;
}

async function readDnc(checkDnc, numbers) {
  const onDnc = new Set();
  for (const part of chunks(numbers, DNC_BATCH)) {
    const res = await checkDnc(part);
    for (const n of res?.on_dnc || []) onDnc.add(String(n).replace(/\D/g, '').slice(-10));
  }
  return onDnc;
}

/** Claim a key. True only for the caller that inserted it. */
async function claim(db, row, key, apptDate) {
  const { data, error } = await db.from(MARKS_TABLE).upsert({
    dedup_key: key,
    contact_id: row.lognumber || null,
    lds_id: row.ldsId,
    appt_date: apptDate || null,
    created_at: new Date().toISOString(),
  }, { onConflict: 'dedup_key', ignoreDuplicates: true }).select('dedup_key');
  if (error) throw new Error(`claim ${key}: ${error.message}`);
  return Array.isArray(data) && data.length > 0;
}

function buildAction(row, record, list, reason, callNowMode) {
  return {
    event_id: null,
    action_type: 'five9_add_records_to_list',
    target_system: 'five9',
    target_entity: 'list',
    target_id: list,
    action_payload: { list_name: list, field_names: record.fieldNames, records: [record.values], call_now_mode: callNowMode },
    rollback_payload: { action_type: 'five9_delete_record_from_list', list_name: list, field_names: ['number1'], records: [[record.number1]] },
    reasoning:
      `New-lead dial backstop: LP lead ${row.ldsId} (inbound ${row.in1}) arrived ${new Date(row.receivedMs).toISOString()} ` +
      `and Five9 has not called it (${reason}). LP did not push it to a dial list, so it is queued to "${list}" (2026-10-05).`,
    rule_applied: RULE_KEY,
    confidence: 1.0,
    status: 'pending',
    requires_approval: false,
    priority: 80,
  };
}

/* --- the pass ------------------------------------------------------------- */

export async function runNewLeadDialBackstop({ env = process.env, nowMs = Date.now(), deps: depsIn = {} } = {}) {
  const mode = backstopMode(env);
  if (mode === 'off') return { skipped: true, reason: 'NEW_LEAD_DIAL_BACKSTOP_MODE=off', mode };
  if (!depsIn.ignoreWindow && !inDialWindow(nowMs)) return { skipped: true, reason: 'outside the dial window', mode };

  const d = { ...(depsIn.runSQL && depsIn.supabase ? {} : await defaultDeps()), ...depsIn };
  const cfg = backstopConfig(env);
  const counts = {};
  const bump = (k) => { counts[k] = (counts[k] || 0) + 1; };
  const decisions = [];
  const errors = [];
  const pushed = [];
  const finish = (extra = {}) => ({
    ok: errors.length === 0, mode, counts, pushed: pushed.length,
    decisions: decisions.slice(0, 100), errors, ...extra,
  });

  // 1. Reads that must all succeed.
  let rows; let calls; let leads; let marks;
  try {
    rows = (await readInboundRows(d.listInboundLeads, nowMs, cfg.lookbackHours)).map(normalizeInboundRow);
    const inWindow = rows.filter((r) => Number.isFinite(r.receivedMs) && nowMs - r.receivedMs <= cfg.lookbackHours * 3600_000);
    const phones = [...new Set(inWindow.map((r) => r.phone).filter(Boolean))];
    const since = Math.min(...inWindow.map((r) => r.receivedMs), nowMs) - 60_000;
    calls = await readCalls(d.runSQL, phones, since);
    leads = await readLeads(d.runSQL, [...new Set(inWindow.map((r) => r.ldsId).filter(Boolean))]);
    const keys = [];
    const today = etDateKey(nowMs);
    for (const r of inWindow) {
      if (!r.in1 || !r.phone) continue;
      for (const l of Object.values(cfg.lists)) keys.push(markKey(r.in1, l));
      keys.push(phoneDayKey(r.phone, today));
    }
    marks = await readMarks(d.supabase, [...new Set(keys)]);
  } catch (err) {
    errors.push(`read: ${err.message}`);
    return finish({ insufficient_evidence: true });
  }

  // 2. Decide without Five9; one candidate per phone (newest row wins).
  const candidates = new Map();
  for (const row of rows) {
    const lead = row.ldsId ? leads.get(row.ldsId) || null : null;
    const called = row.phone && Number.isFinite(row.receivedMs) ? wasCalled(calls, row.phone, row.receivedMs) : false;
    const pre = prefilter({ row, lead, called, marks, nowMs, cfg });
    if (pre.action !== 'candidate') {
      if (pre.reason !== 'out_of_window') bump(pre.reason);
      if (!['out_of_window', 'called', 'killed', 'no_phone'].includes(pre.reason)) {
        decisions.push({ in1: row.in1, lds: row.ldsId, phone4: row.phone?.slice(-4), result: pre.reason });
      }
      continue;
    }
    const prev = candidates.get(row.phone);
    if (!prev || row.receivedMs > prev.row.receivedMs) candidates.set(row.phone, { row, lead, pre });
  }

  const list = [...candidates.values()];
  if (!list.length) return finish();

  // 3. Five9 DNC (one batched read) and per-number contact lookups (capped).
  let onDnc = null;
  try {
    onDnc = await readDnc(d.checkDnc, list.map((c) => c.row.phone));
  } catch (err) {
    errors.push(`dnc: ${err.message}`);
  }

  let lookups = 0;
  for (const c of list) {
    let contact;
    if (onDnc && !onDnc.has(c.row.phone)) {
      if (lookups >= cfg.maxLookups) { bump('deferred'); continue; }
      lookups += 1;
      try {
        contact = summarizeContactRecord(
          await d.getContactRecords({ criteria: [{ field: 'number1', value: c.row.phone }] }), c.row.ldsId,
        );
      } catch {
        contact = 'error';
      }
    }
    const fin = finalDecision({
      pre: c.pre, row: c.row, onDnc: onDnc ? onDnc.has(c.row.phone) : null, contact, nowMs, cfg,
    });
    const note = { in1: c.row.in1, lds: c.row.ldsId, phone4: c.row.phone.slice(-4), list: c.pre.list, result: fin.reason };
    if (fin.action !== 'push') { bump(fin.reason); decisions.push(note); continue; }
    if (pushed.length >= cfg.maxPushes) { bump('deferred'); continue; }

    if (mode === 'shadow') {
      bump('would_push');
      decisions.push({ ...note, result: `would_push:${fin.reason}` });
      pushed.push({ ...c, list: c.pre.list, state: c.pre.state, reason: fin.reason });
      console.log(`[NewLeadBackstop] shadow: would push LP lead ${c.row.ldsId} (inbound ${c.row.in1}, …${c.row.phone.slice(-4)}) → "${c.pre.list}" (${fin.reason})`);
      continue;
    }

    // live: claim both keys, then write the action row.
    const keys = [markKey(c.row.in1, c.pre.list), phoneDayKey(c.row.phone, etDateKey(nowMs))];
    const won = [];
    try {
      for (const k of keys) {
        if (!(await claim(d.supabase, c.row, k, c.pre.state?.apptDateEt))) break;
        won.push(k);
      }
      if (won.length !== keys.length) {
        if (won.length) await d.supabase.from(MARKS_TABLE).delete().in('dedup_key', won);
        bump('already_pushed');
        continue;
      }
      const record = buildBackstopRecord(c.row, c.lead);
      const ins = await d.supabase.from('agent_actions')
        .insert(buildAction(c.row, record, c.pre.list, fin.reason, cfg.callNowMode)).select('id').single();
      if (ins.error) throw new Error(ins.error.message);
      bump('pushed');
      decisions.push({ ...note, result: `pushed:${fin.reason}`, action_id: ins.data?.id ?? null });
      pushed.push({ ...c, list: c.pre.list, state: c.pre.state, reason: fin.reason });
      console.log(`[NewLeadBackstop] pushed LP lead ${c.row.ldsId} (inbound ${c.row.in1}) → "${c.pre.list}" as agent_action ${ins.data?.id} (${fin.reason})`);
    } catch (err) {
      if (won.length) await Promise.resolve(d.supabase.from(MARKS_TABLE).delete().in('dedup_key', won)).catch(() => {});
      errors.push(`push ${c.row.in1}: ${err.message}`);
    }
  }

  // 4. Live only: one card when something was pushed, and the failure alarm.
  if (mode === 'live') {
    if (pushed.length) {
      const channel = String(env.SLACK_CHANNEL_SERVICE || '').trim();
      const res = channel
        ? await Promise.resolve(d.postToSlack(formatPushedCard(pushed), channel)).catch((err) => ({ ok: false, error: err.message }))
        : { ok: false, error: 'SLACK_CHANNEL_SERVICE unset' };
      if (!res?.ok) errors.push(`#contact-center card: ${res?.error || 'post failed'}`);
    }
    await Promise.resolve(d.reportAlertCondition({
      key: ALERT_KEY,
      active: errors.length > 0,
      label: 'New-lead dial backstop',
      text: `⚠️ New-lead dial backstop is failing — new LP leads may not reach a Five9 list.\n${errors.slice(0, 5).join('\n')}`,
      recoveredText: '✅ New-lead dial backstop is running cleanly again.',
      channel: 'ops',
    })).catch((err) => console.warn(`[NewLeadBackstop] alert state: ${err.message}`));
  }

  return finish();
}

/* --- scheduler -------------------------------------------------------------- */

let timer = null;
let running = false;

export function startNewLeadDialBackstopScheduler(env = process.env) {
  if (timer) return timer;
  if (backstopMode(env) === 'off') {
    console.log('[NewLeadBackstop] scheduler not started (NEW_LEAD_DIAL_BACKSTOP_MODE=off)');
    return null;
  }
  const tick = async () => {
    if (running || !inDialWindow(Date.now())) return; // wrap the work, not the tick
    running = true;
    try {
      const { value: res } = await runJob(JOB_ID, () => runNewLeadDialBackstop());
      if (res && res.ok === false) console.warn(`[NewLeadBackstop] pass finished with errors: ${res.errors.join('; ')}`);
      else if (res && !res.skipped && res.pushed) console.log(`[NewLeadBackstop] ${res.mode}: ${JSON.stringify(res.counts)}`);
    } catch (err) {
      console.error(`[NewLeadBackstop] pass threw: ${err.message}`);
    } finally {
      running = false;
    }
  };
  timer = setInterval(tick, INTERVAL_MS);
  if (typeof timer.unref === 'function') timer.unref();
  console.log(`[NewLeadBackstop] scheduler started — mode ${backstopMode(env)}, every 5m in the dial window`);
  return timer;
}

export function stopNewLeadDialBackstopScheduler() {
  if (timer) { clearInterval(timer); timer = null; }
}
