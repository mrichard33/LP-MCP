/**
 * DNC re-entry sweep — src/jobs/dnc-reentry-sweep.js
 *
 * Every 15 minutes: every LP lead that arrived in the last LOOKBACK_HOURS is
 * checked ONCE. If its number is blocked — our consent record, a GHL DNC tag,
 * or Five9's DNC list — and the block is older than the lead, one
 * request_dnc_lift_review is queued (rule_applied DNC_REENTRY_SWEEP) and the
 * card lands in #dnc-lift-approval. Nobody has to add `dnc-lift:request`.
 * Which leads, and the WHY: src/consent/dnc-reentry.js.
 *
 * ONCE PER LEAD
 *   Every decided lead gets a `dnc-reentry:<lp_lead_id>` row in
 *   lp_appointment_sync_marks, asked or not. A lead is never re-decided, so a
 *   STOP that arrives after the check cannot turn it into a card later.
 *
 * FAIL CLOSED
 *   Any read that fails (leads, marks, consent, tags, the opt-out-after check,
 *   Five9) ends the pass with nothing asked and nothing marked; the next pass
 *   tries again. Deciding "not blocked" on a failed Five9 read would mark the
 *   lead and lose it for good.
 *
 * MODE  DNC_REENTRY_SWEEP_MODE = off | shadow | live (default live — it only
 *   asks). shadow decides every pass and logs who it WOULD ask; it queues and
 *   marks nothing.
 */

import { runJob } from '../job-runner.js';
import {
  reentryMode, decideReentryAsks, recordBlocksFor, buildReviewAction, markKey,
  LOOKBACK_HOURS, MAX_ASKS_PER_PASS, FIVE9_DNC_DISPOSITIONS,
} from '../consent/dnc-reentry.js';
import { normalizePhone10 } from '../lead-leak-classify.js';

export const JOB_ID = 'dnc-reentry-sweep';
export const INTERVAL_MS = 15 * 60 * 1000;
const MARKS_TABLE = 'lp_appointment_sync_marks';
const CHUNK = 300;
const DNC_BATCH = 200; // five9_check_dnc caps a call at 200 numbers

const asRows = (data, what) => {
  if (!Array.isArray(data)) throw new Error(`${what}: read returned no row set`);
  return data;
};
const q = (x) => `'${String(x).replace(/'/g, "''")}'`;
const chunks = (xs, n) => { const out = []; for (let i = 0; i < xs.length; i += n) out.push(xs.slice(i, i + n)); return out; };

async function defaultDeps() {
  const [{ runSQL }, supabaseMod, { checkDncForNumbers }] = await Promise.all([
    import('../admin/supabase-admin.js'),
    import('../supabase.js'),
    import('../five9-admin.js'),
  ]);
  return { runSQL, supabase: supabaseMod.default, checkDnc: checkDncForNumbers };
}

/**
 * LP leads that arrived in the window. created_at_lp holds Eastern wall-clock
 * digits under a UTC label (src/lead-speed.js), so arrived_at reads them as
 * America/New_York — compared against consent and Five9 times, which are real
 * UTC, a raw created_at_lp would put every lead four hours early.
 */
export function buildLeadsSql(lookbackHours = LOOKBACK_HOURS) {
  return `
    SELECT lp_lead_id::text AS lp_lead_id, ghl_contact_id, phone, lead_source, lead_source_detail, disposition_code,
           ((created_at_lp AT TIME ZONE 'UTC') AT TIME ZONE 'America/New_York') AS arrived_at
      FROM lp_leads
     WHERE created_at_lp > now() - interval '${Number(lookbackHours) + 5} hours'
       AND ((created_at_lp AT TIME ZONE 'UTC') AT TIME ZONE 'America/New_York') > now() - interval '${Number(lookbackHours)} hours'
       AND lp_deleted_at IS NULL
     ORDER BY created_at_lp ASC
     LIMIT 2000`;
}

/** lp_lead_ids that saw an opt-out AFTER they arrived (consent or Five9). */
export function buildOptedOutAfterSql(leads) {
  const values = leads.map((l) => `(${q(l.lp_lead_id)}, ${q(l.ghl_contact_id || '')}, ${q(l.phone10 || '')}, ${q(l.arrived_at)}::timestamptz)`).join(',');
  const dispos = FIVE9_DNC_DISPOSITIONS.map(q).join(',');
  // The Five9 side is cut to the window's DNC dispositions once (tens of
  // rows) rather than range-scanned per lead.
  return `
    WITH v(id, cid, p, at) AS (VALUES ${values}),
         f AS MATERIALIZED (
           SELECT received_at, ani, dnis FROM five9_events_raw
            WHERE received_at > (SELECT min(at) FROM v)
              AND disposition_name IN (${dispos}))
    SELECT v.id AS lp_lead_id
      FROM v
     WHERE EXISTS (SELECT 1 FROM consent_events e
                    WHERE e.ghl_contact_id = v.cid AND v.cid <> ''
                      AND e.change IN ('revoked','dnc_full_on','carrier_stop_on')
                      AND e.created_at > v.at)
        OR EXISTS (SELECT 1 FROM f
                    WHERE f.received_at > v.at AND v.p <> ''
                      AND (f.dnis = v.p OR f.ani = v.p))`;
}

async function readMarked(db, leadIds) {
  const out = new Set();
  for (const part of chunks(leadIds, CHUNK)) {
    const { data, error } = await db.from(MARKS_TABLE).select('dedup_key').in('dedup_key', part.map(markKey));
    if (error) throw new Error(`marks read: ${error.message}`);
    for (const r of data || []) out.add(String(r.dedup_key).slice(markKey('').length));
  }
  return out;
}

async function readRecordBlocks(runSQL, contactIds) {
  const consent = new Map();
  const tags = new Map();
  for (const part of chunks(contactIds, CHUNK)) {
    const list = part.map(q).join(',');
    for (const r of asRows(await runSQL(`SELECT ghl_contact_id, phone_consent, dnc_full, sms_carrier_stop FROM contact_consent WHERE ghl_contact_id IN (${list})`), 'consent read')) {
      consent.set(String(r.ghl_contact_id), r);
    }
    for (const r of asRows(await runSQL(`SELECT ghl_contact_id, tags FROM contact_tag_snapshot WHERE ghl_contact_id IN (${list})`), 'tag snapshot read')) {
      tags.set(String(r.ghl_contact_id), r.tags);
    }
  }
  const out = new Map();
  for (const id of contactIds) {
    const b = recordBlocksFor({ consent: consent.get(id), tags: tags.get(id) });
    if (b.length) out.set(id, b);
  }
  return out;
}

async function readAlreadyAsked(runSQL, contactIds) {
  const out = new Set();
  for (const part of chunks(contactIds, CHUNK)) {
    const list = part.map(q).join(',');
    const rows = asRows(await runSQL(`
      SELECT target_id AS id FROM agent_actions
       WHERE action_type = 'request_dnc_lift_review' AND target_id IN (${list})
         AND status IN ('pending','pending_approval','approved','executing')
      UNION
      SELECT ghl_contact_id AS id FROM dnc_lift_requests
       WHERE ghl_contact_id IN (${list}) AND status <> 'failed' AND requested_at > now() - interval '24 hours'
    `), 'already-asked read');
    for (const r of rows) if (r.id) out.add(String(r.id));
  }
  return out;
}

async function readFive9Dnc(checkDnc, phones) {
  const out = new Set();
  for (const part of chunks(phones, DNC_BATCH)) {
    const res = await checkDnc(part);
    if (!res || !Array.isArray(res.on_dnc)) throw new Error('Five9 DNC check returned no on_dnc list');
    for (const p of res.on_dnc) out.add(String(p));
  }
  return out;
}

export async function runDncReentrySweep({ env = process.env, deps = {} } = {}) {
  const mode = reentryMode(env);
  if (mode === 'off') return { skipped: true, reason: 'DNC_REENTRY_SWEEP_MODE=off', mode };
  const d = { ...(deps.runSQL && deps.supabase && deps.checkDnc ? {} : await defaultDeps()), ...deps };

  const errors = [];
  const out = { mode, leads: 0, unchecked: 0, asked: 0, would_ask: 0, deferred: 0, settled: {}, errors };
  const finish = () => ({ ok: errors.length === 0, ...out });

  let decided;
  try {
    const leads = asRows(await d.runSQL(buildLeadsSql()), 'lp_leads read').map((r) => ({
      ...r,
      lp_lead_id: String(r.lp_lead_id),
      ghl_contact_id: r.ghl_contact_id ? String(r.ghl_contact_id) : null,
      phone10: normalizePhone10(r.phone),
      arrived_at: new Date(r.arrived_at).toISOString(),
    }));
    out.leads = leads.length;
    if (!leads.length) return finish();
    const marked = await readMarked(d.supabase, leads.map((l) => l.lp_lead_id));
    const fresh = leads.filter((l) => !marked.has(l.lp_lead_id));
    out.unchecked = fresh.length;
    if (!fresh.length) return finish();

    const contactIds = [...new Set(fresh.map((l) => l.ghl_contact_id).filter(Boolean))];
    const phones = [...new Set(fresh.map((l) => l.phone10).filter(Boolean))];
    const [recordBlocks, five9Dnc, alreadyAsked, optedRows] = await Promise.all([
      contactIds.length ? readRecordBlocks(d.runSQL, contactIds) : new Map(),
      phones.length ? readFive9Dnc(d.checkDnc, phones) : new Set(),
      contactIds.length ? readAlreadyAsked(d.runSQL, contactIds) : new Set(),
      Promise.all(chunks(fresh, CHUNK).map(async (part) => asRows(await d.runSQL(buildOptedOutAfterSql(part)), 'opted-out-after read'))),
    ]);
    const optedOutAfter = new Set(optedRows.flat().map((r) => String(r.lp_lead_id)));
    decided = decideReentryAsks(fresh, { marked, recordBlocks, five9Dnc, optedOutAfter, alreadyAsked, max: MAX_ASKS_PER_PASS });
  } catch (err) {
    errors.push(`read: ${err.message}`);
    return finish();
  }

  for (const r of decided.done) out.settled[r.reason] = (out.settled[r.reason] || 0) + 1;
  out.would_ask = decided.ask.length;
  out.deferred = decided.deferred.length;

  if (mode !== 'live') {
    if (decided.ask.length) {
      console.log(`[DncReentry] shadow: would ask for ${decided.ask.length} → ${decided.ask.map((l) => `${l.ghl_contact_id} (lead ${l.lp_lead_id}, ${l.blocked_in.join('+')})`).join(', ')}`);
    }
    return finish();
  }

  const now = new Date().toISOString();
  const marks = decided.done.map((l) => ({ dedup_key: markKey(l.lp_lead_id), contact_id: l.ghl_contact_id, lds_id: l.lp_lead_id, created_at: now }));
  for (const lead of decided.ask) {
    const ins = await d.supabase.from('agent_actions').insert(buildReviewAction(lead)).select('id').single();
    if (ins.error) {
      // Left unmarked: the next pass asks again.
      errors.push(`queue ${lead.ghl_contact_id} (lead ${lead.lp_lead_id}): ${ins.error.message}`);
      continue;
    }
    out.asked += 1;
    marks.push({ dedup_key: markKey(lead.lp_lead_id), contact_id: lead.ghl_contact_id, lds_id: lead.lp_lead_id, created_at: now });
    console.log(`[DncReentry] review queued for ${lead.ghl_contact_id} — LP lead ${lead.lp_lead_id}${lead.lead_source_detail ? ` (${lead.lead_source_detail})` : ''}, blocked in ${lead.blocked_in.join(' + ')} (action ${ins.data.id})`);
  }
  for (const part of chunks(marks, CHUNK)) {
    const { error } = await d.supabase.from(MARKS_TABLE).upsert(part, { onConflict: 'dedup_key' });
    // A lost "not blocked" mark only means the lead is re-checked next pass;
    // a lost "asked" mark is caught by readAlreadyAsked.
    if (error) errors.push(`marks write: ${error.message}`);
  }
  return finish();
}

/* --- scheduler ---------------------------------------------------------- */

let timer = null;
let running = false;

export function startDncReentryScheduler(env = process.env) {
  if (timer) return timer;
  if (reentryMode(env) === 'off') {
    console.log('[DncReentry] scheduler not started (DNC_REENTRY_SWEEP_MODE=off)');
    return null;
  }
  const tick = async () => {
    if (running) return; // a slow pass must not overlap itself
    running = true;
    try {
      const { value: res } = await runJob(JOB_ID, () => runDncReentrySweep());
      if (res && !res.skipped) {
        const settled = Object.entries(res.settled).map(([k, v]) => `${k}=${v}`).join(' ');
        const line = `[DncReentry] ${res.mode}: leads=${res.leads} unchecked=${res.unchecked} asked=${res.asked} would_ask=${res.would_ask} deferred=${res.deferred}${settled ? ` ${settled}` : ''}`;
        if (res.ok === false) console.warn(`${line} errors: ${res.errors.join('; ')}`);
        else console.log(line);
      }
    } catch (err) {
      console.error(`[DncReentry] pass threw: ${err.message}`);
    } finally {
      running = false;
    }
  };
  timer = setInterval(tick, INTERVAL_MS);
  if (typeof timer.unref === 'function') timer.unref();
  // First pass shortly after boot rather than 15 minutes in.
  const first = setTimeout(tick, 60 * 1000);
  if (typeof first.unref === 'function') first.unref();
  console.log(`[DncReentry] scheduler started — mode ${reentryMode(env)}, every 15m`);
  return timer;
}

export function stopDncReentryScheduler() {
  if (timer) { clearInterval(timer); timer = null; }
}
