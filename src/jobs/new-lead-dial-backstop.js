// ─── New-lead dial backstop — src/jobs/new-lead-dial-backstop.js ─────────────
//
// Every 5 minutes, around the clock (2026-10-06; it ran 8:00–19:45 ET until
// then), find LP leads from the last 72 hours that are imported, never called,
// and not on a Five9 list that is dialing them, and put them on the right list
// ourselves. The WHY and every rule live in src/new-lead-dial-backstop.js; this
// file only reads, claims and writes.
//
// MODES — NEW_LEAD_DIAL_BACKSTOP_MODE, default `shadow`
//   off     do nothing.
//   shadow  read and decide everything; log "would push". No Five9 write, no
//           marks, no Slack (the user, 2026-10-05: no unnecessary notifications).
//   live    claim, push, and post ONE #contact-center card per pass that pushed
//           something. A push made while the dialer is closed (19:45–8:00 ET)
//           is held by Five9 until the campaign opens; its card goes out ONCE,
//           in the first pass after 8:00 ET. Going live is the user's decision.
//   Anything unrecognised is `shadow`: a typo must not start dialing.
//
// TWO SOURCES (2026-10-06)
//   LP's inbound queue (GetInboundLeadInfo) is the main one. lp_leads rows
//   created in the window are the second: a lead the queue read did not return
//   is decided from its lp_leads row. The queue read once silently dropped ~300
//   leads (a 199-row page read as "last page"); never again silently.
//
// EVERY DECISION IS LOGGED
//   job_runs.detail.by_reason maps each reason (called, killed, no_phone, sold,
//   pushed, …) to the LP lead ids it applied to, for every lead < 72h old, so a
//   lead's skip reason is one query away. `decisions` keeps the detail of the
//   leads that reached Five9 (capped).
//
// THE WATCHDOG
//   A lead > 30 min past the moment Five9 could first dial it (arrival, or
//   8:00 ET overnight) that ended a pass with no call, no push and no recorded
//   reason (a wait, a deferral, a failed push) is named in ONE #ops card per
//   pass, each lead once (audit_posted_items, 'dial_backstop_unhandled').
//
// FAIL CLOSED ON READS
//   A failed LP read, call-history, lp_leads, sold, callback or marks read
//   ends the pass with nothing pushed — "could not read" must never become
//   "not called" — and raises the ops alarm. A failed DNC read or Five9 contact
//   lookup leaves those leads unmarked for the next pass (and the watchdog
//   names them if it lasts).
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
import { utcToLpStoredIso } from '../lp-dates.js';
import {
  backstopMode, backstopConfig, normalizeInboundRow, rowFromLead, prefilter, finalDecision,
  buildBackstopRecord, formatPushedCard, pushedLine, markKey, phoneDayKey, etDateKey, phone10,
  unhandledLeads, formatUnhandledCard, MISSED_CALL_DISPOSITIONS,
} from '../new-lead-dial-backstop.js';

export const JOB_ID = 'new-lead-dial-backstop';
export const RULE_KEY = 'NEW_LEAD_DIAL_BACKSTOP';
export const INTERVAL_MS = 5 * 60 * 1000;
const MARKS_TABLE = 'lp_appointment_sync_marks';
const PAGE_SIZE = 200;
// 72h is ~5 pages today; the read starts at midnight of the first day, so 20
// pages leaves room for a busy week without ever accepting a partial read.
const MAX_PAGES = 20;
const DNC_BATCH = 200;
const ALERT_KEY = 'new-lead-dial-backstop';
const WATCHDOG_AUDIT = 'dial_backstop_unhandled';
const CALLBACK_LOOKBACK_MS = 72 * 3600_000;

const q = (x) => `'${String(x).replace(/'/g, "''")}'`;
const chunks = (xs, n) => { const out = []; for (let i = 0; i < xs.length; i += n) out.push(xs.slice(i, i + n)); return out; };
const idOf = (row) => row.ldsId || `in1:${row.in1}`;
// The expression idx_lp_leads_phone10 is built on — keep it byte-identical.
const PHONE10_SQL = `right(regexp_replace(COALESCE(phone, ''::text), '[^0-9]'::text, ''::text, 'g'::text), 10)`;
export const overnightCardKey = (etDate) => `dial-backstop-overnight-card:${etDate}`;

async function defaultDeps() {
  const [{ runSQL }, supabaseMod, five9, lp, slack, alertState, alertPosted] = await Promise.all([
    import('../admin/supabase-admin.js'),
    import('../supabase.js'),
    import('../five9-admin.js'),
    import('../lp-client.js'),
    import('../slack.js'),
    import('../alert-state.js'),
    import('../alert-posted.js'),
  ]);
  return {
    runSQL,
    supabase: supabaseMod.default,
    checkDnc: five9.checkDncForNumbers,
    getContactRecords: five9.getContactRecords,
    listInboundLeads: lp.listInboundLeads,
    postToSlack: slack.postToSlack,
    reportAlertCondition: alertState.reportAlertCondition,
    sendAlertMessage: alertState.sendAlertMessage,
    filterNew: alertPosted.filterNew,
    recordPosted: alertPosted.recordPosted,
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

/**
 * Every inbound row in [start, end]. StartIndex is a PAGE number, and LP pages
 * by BLOCKS OF ids: a block with a missing id comes back short (page 3 of
 * 10/3–10/7 held 199 rows). Only an EMPTY page ends the read — treating a short
 * page as the last one hid every newer lead for a day (2026-10-06).
 */
export async function readInboundRows(listInboundLeads, nowMs, lookbackHours) {
  const startdate = lpDay(nowMs - lookbackHours * 3600_000);
  const enddate = lpDay(nowMs + 86_400_000);
  const rows = [];
  for (let page = 1; page <= MAX_PAGES; page += 1) {
    const res = await listInboundLeads({ startdate, enddate, page, pageSize: PAGE_SIZE });
    const batch = Array.isArray(res) ? res : (res?.data || res?.leads || []);
    if (!Array.isArray(batch)) throw new Error('LP inbound read returned no row list');
    if (!batch.length) return rows;
    rows.push(...batch);
  }
  throw new Error(`LP inbound read: still returning rows after ${MAX_PAGES} pages — refusing a partial read`);
}

/** Five9 calls to (dnis) or real conversations from (ani) each phone, since sinceMs. */
async function readCalls(runSQL, phones, sinceMs) {
  if (!phones.length) return [];
  const rows = [];
  for (const part of chunks(phones, 500)) {
    const list = part.map(q).join(',');
    const got = await runSQL(`
      SELECT right(regexp_replace(coalesce(dnis,''),'\\D','','g'),10) AS dnis,
             right(regexp_replace(coalesce(ani,''),'\\D','','g'),10) AS ani,
             disposition_name, received_at
        FROM five9_events_raw
       WHERE received_at >= ${q(new Date(sinceMs).toISOString())}
         AND (right(regexp_replace(coalesce(dnis,''),'\\D','','g'),10) IN (${list})
           OR right(regexp_replace(coalesce(ani,''),'\\D','','g'),10) IN (${list}))`);
    if (!Array.isArray(got)) throw new Error('call history read returned no row set');
    rows.push(...got);
  }
  return rows;
}

/**
 * Did Five9 call this number, or talk to it, at/after it arrived (1 min slack)?
 * An outbound call matches on dnis whatever its outcome; an inbound call FROM
 * the lead (ani) counts only when somebody spoke to them.
 */
export function wasCalled(calls, phone, receivedMs) {
  return calls.some((c) => {
    const at = Date.parse(c.received_at);
    if (!Number.isFinite(at) || at < receivedMs - 60_000) return false;
    if (c.dnis === phone) return true;
    return c.ani === phone && !MISSED_CALL_DISPOSITIONS.has(String(c.disposition_name ?? '').trim());
  });
}

const LEAD_COLS = `lp_lead_id, lp_prospect_id, disposition_code, appointment_date::text AS appointment_date,
  address, city, state, zip, ghl_contact_id, first_name, last_name, phone, email, lead_source, lead_source_detail,
  created_at_lp::text AS created_at_lp, raw_lp_data->>'in1_id' AS in1_id,
  raw_lp_data->>'datereceived' AS datereceived, raw_lp_data->>'lognumber' AS lognumber`;

/** lp_leads created in the window — the second source of candidates. */
async function readLeadsSince(runSQL, sinceMs) {
  const rows = await runSQL(`SELECT ${LEAD_COLS} FROM lp_leads WHERE created_at_lp >= ${q(utcToLpStoredIso(sinceMs))}`);
  if (!Array.isArray(rows)) throw new Error('lp_leads window read returned no row set');
  return rows;
}

async function readLeads(runSQL, ldsIds) {
  const byId = new Map();
  for (const part of chunks(ldsIds, 300)) {
    const rows = await runSQL(`SELECT ${LEAD_COLS} FROM lp_leads WHERE lp_lead_id IN (${part.map(q).join(',')})`);
    if (!Array.isArray(rows)) throw new Error('lp_leads read returned no row set');
    for (const r of rows) byId.set(String(r.lp_lead_id), r);
  }
  return byId;
}

/** Phones with a sold (closed_won) LP lead, any age. */
async function readSoldPhones(runSQL, phones) {
  const sold = new Set();
  for (const part of chunks(phones, 500)) {
    const rows = await runSQL(`
      SELECT DISTINCT ${PHONE10_SQL} AS phone10 FROM lp_leads
       WHERE closed_won = true AND ${PHONE10_SQL} IN (${part.map(q).join(',')})`);
    if (!Array.isArray(rows)) throw new Error('sold read returned no row set');
    for (const r of rows) sold.add(String(r.phone10));
  }
  return sold;
}

/**
 * Who the callback path owns: an lp_callback_requeue row for the GHL contact,
 * or a Callback Request push by anything but this job (its number1 found in
 * the payload), in the last 72h. A refused or failed row owns nobody.
 */
async function readCallbackRequests(runSQL, contactIds, callbackList, sinceMs) {
  const ids = contactIds.length ? contactIds.map(q).join(',') : `''`;
  const rows = await runSQL(`
    SELECT action_type, target_id, action_payload::text AS payload
      FROM agent_actions
     WHERE created_at >= ${q(new Date(sinceMs).toISOString())}
       AND status NOT IN ('failed', 'rejected', 'cancelled', 'skipped')
       AND ((action_type = 'lp_callback_requeue' AND target_id IN (${ids}))
         OR (action_type = 'five9_add_records_to_list' AND target_id = ${q(callbackList)}
             AND coalesce(rule_applied, '') <> ${q(RULE_KEY)}))`);
  if (!Array.isArray(rows)) throw new Error('callback read returned no row set');
  const contacts = new Set();
  const phones = new Set();
  for (const r of rows) {
    if (r.action_type === 'lp_callback_requeue') contacts.add(String(r.target_id));
    else for (const m of String(r.payload ?? '').match(/\d{10,11}/g) || []) { const p = phone10(m); if (p) phones.add(p); }
  }
  return { contacts, phones };
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
async function claim(db, key, { contactId = null, ldsId = null, apptDate = null } = {}) {
  const { data, error } = await db.from(MARKS_TABLE).upsert({
    dedup_key: key,
    contact_id: contactId,
    lds_id: ldsId,
    appt_date: apptDate,
    created_at: new Date().toISOString(),
  }, { onConflict: 'dedup_key', ignoreDuplicates: true }).select('dedup_key');
  if (error) throw new Error(`claim ${key}: ${error.message}`);
  return Array.isArray(data) && data.length > 0;
}

function buildAction(row, record, list, reason, callNowMode, { cardLine, held }) {
  return {
    event_id: null,
    action_type: 'five9_add_records_to_list',
    target_system: 'five9',
    target_entity: 'list',
    target_id: list,
    // card_line / card_held are read back by the 8 AM card; the executor ignores them.
    action_payload: {
      list_name: list, field_names: record.fieldNames, records: [record.values], call_now_mode: callNowMode,
      card_line: cardLine, card_held: held,
    },
    rollback_payload: { action_type: 'five9_delete_record_from_list', list_name: list, field_names: ['number1'], records: [[record.number1]] },
    reasoning:
      `New-lead dial backstop: LP lead ${row.ldsId} (inbound ${row.in1}) arrived ${new Date(row.receivedMs).toISOString()} ` +
      `and Five9 has not called it (${reason}). Nothing had it on a dial list, so it is queued to "${list}" (2026-10-06 routing).`,
    rule_applied: RULE_KEY,
    confidence: 1.0,
    status: 'pending',
    requires_approval: false,
    priority: 80,
  };
}

/** Lines of the overnight pushes not yet announced (live, inside the window). */
async function readHeldLines(runSQL, nowMs) {
  const rows = await runSQL(`
    SELECT action_payload->>'card_line' AS line
      FROM agent_actions
     WHERE action_type = 'five9_add_records_to_list' AND rule_applied = ${q(RULE_KEY)}
       AND created_at >= ${q(new Date(nowMs - 86_400_000).toISOString())}
       AND action_payload->>'card_held' = 'true'
     ORDER BY created_at`);
  if (!Array.isArray(rows)) throw new Error('held-card read returned no row set');
  return rows.map((r) => r.line).filter(Boolean);
}

/* --- the pass ------------------------------------------------------------- */

export async function runNewLeadDialBackstop({ env = process.env, nowMs = Date.now(), deps: depsIn = {} } = {}) {
  const mode = backstopMode(env);
  if (mode === 'off') return { skipped: true, reason: 'NEW_LEAD_DIAL_BACKSTOP_MODE=off', mode };

  const d = { ...(depsIn.runSQL && depsIn.supabase ? {} : await defaultDeps()), ...depsIn };
  const cfg = backstopConfig(env);
  const dialOpen = inDialWindow(nowMs);
  const counts = {};
  const byReason = {};
  const decisions = [];
  const outcomes = [];
  const errors = [];
  const pushed = [];
  let unhandled = [];
  const record = (row, action, result, extra = null) => {
    counts[result] = (counts[result] || 0) + 1;
    (byReason[result] ||= []).push(idOf(row));
    outcomes.push({ row, action, result });
    if (extra) decisions.push({ in1: row.in1, lds: row.ldsId, phone4: row.phone?.slice(-4), result, ...extra });
  };
  const finish = (extra = {}) => ({
    ok: errors.length === 0, mode, dial_window_open: dialOpen, counts, pushed: pushed.length,
    unhandled: unhandled.length, by_reason: byReason, decisions: decisions.slice(0, 100), errors, ...extra,
  });
  const alarm = async () => {
    if (mode !== 'live') return;
    await Promise.resolve(d.reportAlertCondition({
      key: ALERT_KEY,
      active: errors.length > 0,
      label: 'New-lead dial backstop',
      text: `⚠️ New-lead dial backstop is failing — new LP leads may not reach a Five9 list.\n${errors.slice(0, 5).join('\n')}`,
      recoveredText: '✅ New-lead dial backstop is running cleanly again.',
      channel: 'ops',
    })).catch((err) => console.warn(`[NewLeadBackstop] alert state: ${err.message}`));
  };

  // 1. Reads that must all succeed.
  let rows; let calls; let leads; let marks; let sold; let callbacks;
  try {
    const lookbackMs = cfg.lookbackHours * 3600_000;
    const inbound = (await readInboundRows(d.listInboundLeads, nowMs, cfg.lookbackHours)).map(normalizeInboundRow);
    const windowLeads = await readLeadsSince(d.runSQL, nowMs - lookbackMs);

    // One row per inbound id; then every lp_leads lead the queue read missed.
    rows = [];
    const seenIn1 = new Set();
    const seenLds = new Set();
    for (const r of inbound) {
      if (r.in1 && seenIn1.has(r.in1)) continue;
      if (r.in1) seenIn1.add(r.in1);
      if (r.ldsId) seenLds.add(r.ldsId);
      rows.push(r);
    }
    let fromLeads = 0;
    for (const l of windowLeads) {
      const r = rowFromLead(l);
      // Inbound-queue leads only. A lead a person typed into LP has no in1 (and
      // is usually already Set by that person); LP feeds its Conf lists itself,
      // and it was never this job's scope. In1 is also half of the dedup key.
      if (!r.in1 || !r.ldsId || seenLds.has(r.ldsId) || seenIn1.has(r.in1)) continue;
      seenLds.add(r.ldsId);
      rows.push(r);
      fromLeads += 1;
    }
    if (fromLeads) counts.from_lp_leads = fromLeads;

    const inWindow = rows.filter((r) => Number.isFinite(r.receivedMs) && nowMs - r.receivedMs <= lookbackMs);
    const phones = [...new Set(inWindow.map((r) => r.phone).filter(Boolean))];
    const since = Math.min(...inWindow.map((r) => r.receivedMs), nowMs) - 60_000;
    calls = await readCalls(d.runSQL, phones, since);
    leads = new Map(windowLeads.map((l) => [String(l.lp_lead_id), l]));
    const missing = [...new Set(inWindow.map((r) => r.ldsId).filter((id) => id && !leads.has(id)))];
    for (const [k, v] of await readLeads(d.runSQL, missing)) leads.set(k, v);
    sold = await readSoldPhones(d.runSQL, phones);
    const contactIds = [...new Set(inWindow.flatMap((r) => [r.lognumber, leads.get(r.ldsId)?.ghl_contact_id])
      .filter((id) => /^[A-Za-z0-9]{20}$/.test(String(id ?? ''))))];
    callbacks = await readCallbackRequests(d.runSQL, contactIds, cfg.lists.noAppt, nowMs - CALLBACK_LOOKBACK_MS);
    const keys = [];
    const today = etDateKey(nowMs);
    for (const r of inWindow) {
      if (!r.in1 || !r.phone) continue;
      for (const l of Object.values(cfg.lists)) keys.push(markKey(r.in1, l));
      keys.push(phoneDayKey(r.phone, today));
    }
    keys.push(overnightCardKey(today));
    marks = await readMarks(d.supabase, [...new Set(keys)]);
  } catch (err) {
    errors.push(`read: ${err.message}`);
    await alarm();
    return finish({ insufficient_evidence: true });
  }

  // 2. Decide without Five9; one candidate per phone (newest row wins).
  const candidates = new Map();
  for (const row of rows) {
    const lead = row.ldsId ? leads.get(row.ldsId) || null : null;
    const called = row.phone && Number.isFinite(row.receivedMs) ? wasCalled(calls, row.phone, row.receivedMs) : false;
    const contactId = [row.lognumber, lead?.ghl_contact_id].find((id) => /^[A-Za-z0-9]{20}$/.test(String(id ?? '')));
    const pre = prefilter({
      row, lead, called, marks, nowMs, cfg,
      sold: Boolean(row.phone && sold.has(row.phone)),
      callbackRequested: Boolean((contactId && callbacks.contacts.has(contactId)) || (row.phone && callbacks.phones.has(row.phone))),
    });
    if (pre.reason === 'out_of_window') continue; // older than 72h: not this job's
    if (pre.action !== 'candidate') { record(row, pre.action, pre.reason); continue; }
    const prev = candidates.get(row.phone);
    if (prev && prev.row.receivedMs >= row.receivedMs) { record(row, 'skip', 'newer_row_same_phone'); continue; }
    if (prev) record(prev.row, 'skip', 'newer_row_same_phone');
    candidates.set(row.phone, { row, lead, pre });
  }

  const list = [...candidates.values()];

  // 3. Five9 DNC (one batched read) and per-number contact lookups (capped).
  let onDnc = null;
  if (list.length) {
    try {
      onDnc = await readDnc(d.checkDnc, list.map((c) => c.row.phone));
    } catch (err) {
      errors.push(`dnc: ${err.message}`);
    }
  }

  let lookups = 0;
  for (const c of list) {
    let contact;
    if (onDnc && !onDnc.has(c.row.phone)) {
      if (lookups >= cfg.maxLookups) { record(c.row, 'deferred', 'deferred'); continue; }
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
      pre: c.pre, row: c.row, lead: c.lead, onDnc: onDnc ? onDnc.has(c.row.phone) : null, contact, nowMs, cfg,
    });
    const note = { list: fin.list || c.pre.list, why: fin.why || c.pre.reason, source: c.row.origin };
    if (fin.action !== 'push') { record(c.row, fin.action, fin.reason, note); continue; }
    if (pushed.length >= cfg.maxPushes) { record(c.row, 'deferred', 'deferred', note); continue; }
    const p = { ...c, list: fin.list, state: c.pre.state, reason: fin.reason };

    if (mode === 'shadow') {
      record(c.row, 'push', 'would_push', { ...note, detail: fin.reason });
      pushed.push(p);
      console.log(`[NewLeadBackstop] shadow: would push LP lead ${c.row.ldsId} (inbound ${c.row.in1}, …${c.row.phone.slice(-4)}) → "${fin.list}" (${fin.why}; ${fin.reason})`);
      continue;
    }

    // live: claim both keys, then write the action row.
    const keys = [markKey(c.row.in1, fin.list), phoneDayKey(c.row.phone, etDateKey(nowMs))];
    const won = [];
    try {
      for (const k of keys) {
        if (!(await claim(d.supabase, k, { contactId: c.row.lognumber || null, ldsId: c.row.ldsId, apptDate: c.pre.state?.apptDateEt || null }))) break;
        won.push(k);
      }
      if (won.length !== keys.length) {
        if (won.length) await d.supabase.from(MARKS_TABLE).delete().in('dedup_key', won);
        record(c.row, 'skip', 'already_pushed', note);
        continue;
      }
      const rec = buildBackstopRecord(c.row, c.lead);
      const ins = await d.supabase.from('agent_actions')
        .insert(buildAction(c.row, rec, fin.list, fin.reason, cfg.callNowMode, { cardLine: pushedLine(p), held: !dialOpen }))
        .select('id').single();
      if (ins.error) throw new Error(ins.error.message);
      record(c.row, 'push', 'pushed', { ...note, detail: fin.reason, action_id: ins.data?.id ?? null });
      pushed.push(p);
      console.log(`[NewLeadBackstop] pushed LP lead ${c.row.ldsId} (inbound ${c.row.in1}) → "${fin.list}" as agent_action ${ins.data?.id} (${fin.why}; ${fin.reason})`);
    } catch (err) {
      if (won.length) await Promise.resolve(d.supabase.from(MARKS_TABLE).delete().in('dedup_key', won)).catch(() => {});
      errors.push(`push ${c.row.in1}: ${err.message}`);
      record(c.row, 'failed', 'push_failed', note);
    }
  }

  // 4. Live only: the cards, the watchdog and the failure alarm.
  if (mode === 'live') {
    const channel = String(env.SLACK_CHANNEL_SERVICE || '').trim();
    const post = async (text) => (channel
      ? Promise.resolve(d.postToSlack(text, channel)).catch((err) => ({ ok: false, error: err.message }))
      : { ok: false, error: 'SLACK_CHANNEL_SERVICE unset' });

    // While the dialer is closed the pushes wait in Five9, and so does their card.
    if (dialOpen && pushed.length) {
      const res = await post(formatPushedCard(pushed));
      if (!res?.ok) errors.push(`#contact-center card: ${res?.error || 'post failed'}`);
    }
    // The overnight card: once, in the first pass after 8:00 ET.
    const cardKey = overnightCardKey(etDateKey(nowMs));
    if (dialOpen && !marks.has(cardKey)) {
      try {
        const lines = await readHeldLines(d.runSQL, nowMs);
        if (await claim(d.supabase, cardKey) && lines.length) {
          const res = await post(formatPushedCard(lines, { overnight: true }));
          if (!res?.ok) {
            await Promise.resolve(d.supabase.from(MARKS_TABLE).delete().in('dedup_key', [cardKey])).catch(() => {});
            errors.push(`#contact-center overnight card: ${res?.error || 'post failed'}`);
          }
        }
      } catch (err) {
        errors.push(`overnight card: ${err.message}`);
      }
    }

    unhandled = unhandledLeads(outcomes, { nowMs, cfg });
    if (unhandled.length) {
      const items = unhandled.map((u) => ({ ...u, key: idOf(u.row), reason: 'unhandled' }));
      const { fresh } = await d.filterNew({ audit: WATCHDOG_AUDIT, items, ttlDays: 3, nowMs, deps: { supabase: d.supabase } });
      if (fresh.length) {
        const sent = await Promise.resolve(d.sendAlertMessage(formatUnhandledCard(fresh, nowMs), { channel: 'ops' }))
          .catch((err) => ({ sent: false, reason: err.message }));
        if (sent?.sent) await d.recordPosted({ audit: WATCHDOG_AUDIT, items: fresh, nowMs, deps: { supabase: d.supabase } });
        else errors.push(`#ops unhandled-leads card: ${sent?.reason || 'post failed'}`);
      }
    }
    await alarm();
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
    if (running) return; // wrap the work, not the tick
    running = true;
    try {
      const { value: res } = await runJob(JOB_ID, () => runNewLeadDialBackstop());
      if (res && res.ok === false) console.warn(`[NewLeadBackstop] pass finished with errors: ${res.errors.join('; ')}`);
      else if (res && !res.skipped && (res.pushed || res.unhandled)) console.log(`[NewLeadBackstop] ${res.mode}: ${JSON.stringify(res.counts)}`);
    } catch (err) {
      console.error(`[NewLeadBackstop] pass threw: ${err.message}`);
    } finally {
      running = false;
    }
  };
  timer = setInterval(tick, INTERVAL_MS);
  if (typeof timer.unref === 'function') timer.unref();
  console.log(`[NewLeadBackstop] scheduler started — mode ${backstopMode(env)}, every 5m, 24/7`);
  return timer;
}

export function stopNewLeadDialBackstopScheduler() {
  if (timer) { clearInterval(timer); timer = null; }
}
