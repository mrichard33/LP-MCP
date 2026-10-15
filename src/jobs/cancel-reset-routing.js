// ─── Cancelled leads → "Resets-Hot": the job — src/jobs/cancel-reset-routing.js ───
//
// Every 15 minutes: find LP leads cancelled (CXL / CCC) in the last two weeks
// that no Reset campaign has dialed since, and add each to Five9's "Resets-Hot"
// list once. Why, and every rule: src/cancel-reset-routing.js.
//
// MODE — CANCEL_RESET_ROUTING_MODE: off | shadow | live (default live, the
// user's ruling of 2026-10-15). Shadow decides every pass and records
// would_push in job_runs.detail; live writes one five9_add_records_to_list
// agent action per lead (the auto-approved Five9 add, like the new-lead dial
// backstop). No Slack card (Mark, 2026-10-07: never post "we fixed it").

import { runJob } from '../job-runner.js';
import {
  cancelResetMode, cancelResetConfig, decideCancelReset, buildResetRecord, markKey,
  CANCEL_DISPOSITIONS, RESET_CAMPAIGN_RX,
} from '../cancel-reset-routing.js';
import { lpLocalToUtcMs } from '../lead-speed.js';

export const JOB_ID = 'cancel-reset-routing';
export const RULE_KEY = 'CANCEL_RESET_ROUTING';
export const INTERVAL_MS = 15 * 60 * 1000;
const MARKS_TABLE = 'lp_appointment_sync_marks';
const PHONE10_SQL = `right(regexp_replace(COALESCE(phone, ''::text), '[^0-9]'::text, ''::text, 'g'::text), 10)`;
const DNIS10_SQL = `right(regexp_replace(coalesce(dnis, ''), '[^0-9]', '', 'g'), 10)`;
const q = (x) => `'${String(x).replace(/'/g, "''")}'`;
const chunks = (xs, n) => { const out = []; for (let i = 0; i < xs.length; i += n) out.push(xs.slice(i, i + n)); return out; };
const rowsOf = (x, what) => { if (!Array.isArray(x)) throw new Error(`${what}: no row set`); return x; };

async function defaultDeps() {
  const [{ runSQL }, supabaseMod, five9] = await Promise.all([
    import('../admin/supabase-admin.js'),
    import('../supabase.js'),
    import('../five9-admin.js'),
  ]);
  return { runSQL, supabase: supabaseMod.default, checkDnc: five9.checkDncForNumbers };
}

/** Leads cancelled in the window. LP's times are Eastern wall clock tagged +00:00. */
async function readCancelled(runSQL, lookbackDays) {
  return rowsOf(await runSQL(`
    SELECT lp_lead_id, lp_prospect_id, first_name, last_name, disposition_code, ${PHONE10_SQL} AS phone10,
           to_char(updated_at_lp AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS') AS updated_wall
      FROM lp_leads
     WHERE disposition_code IN (${[...CANCEL_DISPOSITIONS].map(q).join(',')})
       AND updated_at_lp >= now() - interval '${Number(lookbackDays) + 1} days'`), 'cancelled leads');
}

/** Per phone: the newest LP lead, and whether any lead on it was sold. */
async function readPhones(runSQL, phones) {
  const newest = new Map();
  const sold = new Set();
  for (const part of chunks(phones, 400)) {
    const rows = rowsOf(await runSQL(`
      SELECT ${PHONE10_SQL} AS phone10,
             (array_agg(lp_lead_id ORDER BY created_at_lp DESC))[1] AS newest_id,
             bool_or(coalesce(closed_won, false)) AS sold
        FROM lp_leads
       WHERE ${PHONE10_SQL} IN (${part.map(q).join(',')})
       GROUP BY 1`), 'phones');
    for (const r of rows) {
      newest.set(String(r.phone10), String(r.newest_id));
      if (r.sold) sold.add(String(r.phone10));
    }
  }
  return { newest, sold };
}

/** Reset-campaign dials per phone since `sinceIso` (pre-aggregated, no join). */
async function readResetCalls(runSQL, phones, sinceIso) {
  const out = new Map();
  for (const part of chunks(phones, 300)) {
    const rows = rowsOf(await runSQL(`
      SELECT ${DNIS10_SQL} AS phone10, campaign, max(received_at) AS last_at
        FROM five9_events_raw
       WHERE event_type = 'disposition' AND received_at >= ${q(sinceIso)}
         AND ${DNIS10_SQL} IN (${part.map(q).join(',')})
       GROUP BY 1, 2`), 'reset calls');
    for (const r of rows) {
      if (!RESET_CAMPAIGN_RX.test(String(r.campaign || ''))) continue;
      const ms = Date.parse(r.last_at);
      const p = String(r.phone10);
      if (Number.isFinite(ms) && ms > (out.get(p) ?? 0)) out.set(p, ms);
    }
  }
  return out;
}

/**
 * Lead ids whose consent says no calls (phone revoked, or a full DNC). A consent
 * row is keyed by lead OR by prospect, so both are matched.
 */
async function readOptOuts(runSQL, leads) {
  const out = new Set();
  for (const part of chunks(leads, 300)) {
    const leadIds = part.map((l) => String(l.lp_lead_id));
    const prospectIds = part.map((l) => String(l.lp_prospect_id || '')).filter(Boolean);
    const rows = rowsOf(await runSQL(`
      SELECT lp_lead_id::text AS lead_id, lp_prospect_id::text AS prospect_id FROM contact_consent
       WHERE (lp_lead_id::text IN (${leadIds.map(q).join(',')})
              ${prospectIds.length ? `OR lp_prospect_id::text IN (${prospectIds.map(q).join(',')})` : ''})
         AND (phone_consent = 'revoked' OR coalesce(dnc_full, false))`), 'consent');
    for (const r of rows) {
      for (const l of part) {
        if (String(l.lp_lead_id) === r.lead_id || (l.lp_prospect_id && String(l.lp_prospect_id) === r.prospect_id)) out.add(String(l.lp_lead_id));
      }
    }
  }
  return out;
}

async function readMarks(supabase, keys) {
  const seen = new Set();
  for (const part of chunks(keys, 300)) {
    const { data, error } = await supabase.from(MARKS_TABLE).select('dedup_key').in('dedup_key', part);
    if (error) throw new Error(`marks read: ${error.message}`);
    for (const r of data || []) seen.add(r.dedup_key);
  }
  return seen;
}

export async function runCancelResetRouting({ env = process.env, nowMs = Date.now(), deps: depsIn = {} } = {}) {
  const mode = cancelResetMode(env);
  if (mode === 'off') return { skipped: true, reason: 'CANCEL_RESET_ROUTING_MODE=off', mode };
  const d = { ...(depsIn.runSQL && depsIn.supabase ? {} : await defaultDeps()), ...depsIn };
  const cfg = cancelResetConfig(env);
  const counts = {};
  const decisions = [];
  const errors = [];
  const note = (lead, reason, extra = {}) => {
    counts[reason] = (counts[reason] || 0) + 1;
    decisions.push({ lp_lead_id: String(lead.lp_lead_id), dispo: lead.disposition_code, reason, ...extra });
  };

  let leads;
  let phoneInfo;
  let resetCalls;
  let marks;
  try {
    leads = (await readCancelled(d.runSQL, cfg.lookbackDays)).filter((l) => String(l.phone10 || '').length === 10);
    if (!leads.length) return { ok: true, mode, candidates: 0, counts, decisions };
    const phones = [...new Set(leads.map((l) => String(l.phone10)))];
    phoneInfo = await readPhones(d.runSQL, phones);
    resetCalls = await readResetCalls(d.runSQL, phones, new Date(nowMs - (cfg.lookbackDays + 1) * 86_400_000).toISOString());
    marks = await readMarks(d.supabase, leads.map((l) => markKey(l.lp_lead_id, l.updated_wall)));
  } catch (err) {
    // Could not tell: never "nothing owed".
    return { checked: false, readFailed: true, mode, reason: err.message };
  }

  // Only the leads that could be pushed spend a DNC / consent read.
  const pre = leads.map((lead) => {
    const phone = String(lead.phone10);
    const cancelledMs = lpLocalToUtcMs(lead.updated_wall);
    const last = resetCalls.get(phone);
    return {
      lead,
      args: {
        lead, newestLeadId: phoneInfo.newest.get(phone) || null, sold: phoneInfo.sold.has(phone),
        resetCalled: Number.isFinite(last) && cancelledMs != null && last > cancelledMs,
        marked: marks.has(markKey(lead.lp_lead_id, lead.updated_wall)), nowMs, cfg,
      },
    };
  });
  const open = pre.filter((p) => decideCancelReset({ ...p.args, onDnc: false, optedOut: false }).action === 'push');

  let onDnc = null;
  let optOuts = null;
  if (open.length) {
    try {
      onDnc = new Set();
      for (const part of chunks([...new Set(open.map((p) => String(p.lead.phone10)))], 200)) {
        const res = await d.checkDnc(part);
        for (const n of res?.on_dnc || []) onDnc.add(String(n).replace(/\D/g, '').slice(-10));
      }
    } catch (err) {
      onDnc = null;
      errors.push(`dnc: ${err.message}`);
    }
    try {
      optOuts = await readOptOuts(d.runSQL, open.map((p) => p.lead));
    } catch (err) {
      optOuts = null;
      errors.push(`consent: ${err.message}`);
    }
  }

  let pushes = 0;
  for (const p of pre) {
    const { lead } = p;
    const fin = decideCancelReset({
      ...p.args,
      onDnc: onDnc ? onDnc.has(String(lead.phone10)) : (open.includes(p) ? null : false),
      optedOut: optOuts ? optOuts.has(String(lead.lp_lead_id)) : (open.includes(p) ? null : false),
    });
    if (fin.action !== 'push') { note(lead, fin.reason); continue; }
    if (pushes >= cfg.maxPushes) { note(lead, 'deferred'); continue; }
    if (mode === 'shadow') {
      pushes += 1;
      note(lead, 'would_push');
      continue;
    }
    const key = markKey(lead.lp_lead_id, lead.updated_wall);
    try {
      const { data, error } = await d.supabase.from(MARKS_TABLE).upsert(
        { dedup_key: key, contact_id: null, lds_id: String(lead.lp_lead_id), appt_date: null, created_at: new Date(nowMs).toISOString() },
        { onConflict: 'dedup_key', ignoreDuplicates: true },
      ).select('dedup_key');
      if (error) throw new Error(error.message);
      if (!data?.length) { note(lead, 'already_pushed'); continue; }
      const record = buildResetRecord(lead);
      const ins = await d.supabase.from('agent_actions').insert({
        event_id: null,
        action_type: 'five9_add_records_to_list',
        target_system: 'five9',
        target_entity: 'list',
        target_id: cfg.list,
        // Keyed on number1 alone ON PURPOSE: profile "Resets V2" dials records
        // created 25+ hours ago, so the phone's existing record is the one to add.
        action_payload: { list_name: cfg.list, field_names: record.fieldNames, records: [record.values] },
        rollback_payload: { action_type: 'five9_delete_record_from_list', list_name: cfg.list, field_names: ['number1'], records: [[String(lead.phone10)]] },
        reasoning: `Cancelled lead → ${cfg.list} (the user, 2026-10-15): LP lead ${lead.lp_lead_id} is ${lead.disposition_code} `
          + `since ${lead.updated_wall} ET and no Reset campaign has called it since. Not sold, not on Five9 DNC, no opt-out.`,
        rule_applied: RULE_KEY,
        confidence: 1.0,
        status: 'pending',
        requires_approval: false,
        priority: 80,
      }).select('id').single();
      if (ins.error) {
        await Promise.resolve(d.supabase.from(MARKS_TABLE).delete().in('dedup_key', [key])).catch(() => {});
        throw new Error(ins.error.message);
      }
      pushes += 1;
      note(lead, 'pushed', { action_id: ins.data?.id ?? null });
    } catch (err) {
      errors.push(`push ${lead.lp_lead_id}: ${err.message}`);
      note(lead, 'push_failed');
    }
  }
  return { ok: errors.length === 0, mode, candidates: leads.length, pushed: pushes, counts, decisions: decisions.slice(0, 200), errors };
}

/* --- scheduler -------------------------------------------------------------- */

let timer = null;
let running = false;

export function startCancelResetRoutingScheduler(env = process.env) {
  if (timer) return timer;
  if (cancelResetMode(env) === 'off') {
    console.log('[CancelReset] scheduler not started (CANCEL_RESET_ROUTING_MODE=off)');
    return null;
  }
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      const { value: res } = await runJob(JOB_ID, () => runCancelResetRouting());
      if (res && !res.skipped && Object.keys(res.counts || {}).length) console.log(`[CancelReset] ${res.mode}: ${JSON.stringify(res.counts)}`);
    } catch (err) {
      console.error(`[CancelReset] pass threw: ${err.message}`);
    } finally {
      running = false;
    }
  };
  timer = setInterval(tick, INTERVAL_MS);
  if (typeof timer.unref === 'function') timer.unref();
  console.log(`[CancelReset] scheduler started — mode ${cancelResetMode(env)}, every 15m`);
  return timer;
}

export function stopCancelResetRoutingScheduler() {
  if (timer) { clearInterval(timer); timer = null; }
}
