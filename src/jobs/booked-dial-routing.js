// ─── Booked-lead routing — src/jobs/booked-dial-routing.js ───────────────────
//
// Runs right after each inbound-checkout-watch pass (every 5 min, 24/7): find
// leads with a future appointment, put them on the matching Five9
// Confirmation list, then — once that add has completed — queue their removal
// from the setter (DIAL ASAP) lists. Decision #2669. The WHY and every rule
// live in src/booked-dial-routing.js; this file reads, claims and writes.
//
// MODES — BOOKED_DIAL_ROUTING_MODE, default `shadow`
//   off     do nothing.
//   shadow  read and decide; write would_add / would_remove rows to
//           booked_dial_routing_log (our own audit table) and job_runs. No
//           Five9 action rows, no marks, no Slack.
//   live    claim, then queue: the Confirmation add (auto-approved carve-out,
//           #1057) and, on a later pass once it completed, the removal
//           (automatic, Mark's standing exception; BOOKED_ROUTING_AUTO_REMOVE=false
//           puts it back behind approval).
//   Anything unrecognised is `shadow`.
//
// FAIL CLOSED ON READS
//   A failed inbound, lp_leads, sold, add-history or marks read ends the pass
//   with nothing queued, and (live) raises the #ops alarm. A failed DNC read
//   or Five9 contact lookup leaves those leads for the next pass.
//
// CLAIM, THEN QUEUE
//   booked-conf:<phone>:<appt>:<list> before the add row; booked-remove:
//   <phone>:<appt>:<ET date> before the removal row (per day, so LP's 6 AM
//   re-add is looked at again each morning). A lost claim queues nothing; a
//   failed insert releases the claim.

import { runJob } from '../job-runner.js';
import { summarizeContactRecord } from '../lead-leak-classify.js';
import { insertSoft, isMissingTable } from '../lp-inbound-queue.js';
import { normalizeInboundRow, rowFromLead, buildBackstopRecord, etDateKey, phone10 } from '../new-lead-dial-backstop.js';
import { readInboundRows, readLeadsSince, readLeadsByAppointment, readSoldPhones, readDnc } from './new-lead-dial-backstop.js';
import {
  routingMode, routingConfig, buildCandidate, onePerPhone, prefilter, decide, addState, addKey, removeKey,
  priorRemoveKeys, buildAddAction, buildRemovalAction, approvalExpired, RULE_KEY, lookupPriority,
  failedAddCount, retryKey, moveKey, confMoveDue, formatAddFailedCard,
} from '../booked-dial-routing.js';

export const JOB_ID = 'booked-dial-routing';
const MARKS_TABLE = 'lp_appointment_sync_marks';
const LOG_TABLE = 'booked_dial_routing_log';
const ALERT_KEY = 'booked-dial-routing';
export const ADD_FAILED_AUDIT = 'booked_conf_add_failed';

const q = (x) => `'${String(x).replace(/'/g, "''")}'`;
const addDaysKey = (day, n) => new Date(Date.parse(`${day}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

async function defaultDeps() {
  const [{ runSQL }, supabaseMod, five9, lp, alertState, slack, alertPosted] = await Promise.all([
    import('../admin/supabase-admin.js'),
    import('../supabase.js'),
    import('../five9-admin.js'),
    import('../lp-client.js'),
    import('../alert-state.js'),
    import('../slack.js'),
    import('../alert-posted.js'),
  ]);
  return {
    runSQL,
    supabase: supabaseMod.default,
    checkDnc: five9.checkDncForNumbers,
    getContactRecords: five9.getContactRecords,
    listInboundLeads: lp.listInboundLeads,
    reportAlertCondition: alertState.reportAlertCondition,
    postToSlack: slack.postToSlack,
    filterNew: alertPosted.filterNew,
    recordPosted: alertPosted.recordPosted,
  };
}

/**
 * Booked inquiries from the lp_inbound_queue mirror (the watch refreshed it
 * moments ago). Missing table → LP live read, so routing never depends on
 * sql/149. Returns normalizeInboundRow rows.
 */
async function readBookedInbound(d, nowMs, cfg) {
  const sinceIso = new Date(nowMs - cfg.lookbackHours * 3600_000).toISOString();
  const { data, error } = await d.supabase.from('lp_inbound_queue').select('raw')
    .gte('received_at_lp', sinceIso).gte('appt_date', etDateKey(nowMs));
  if (!error) return { rows: (data || []).map((r) => normalizeInboundRow(r.raw || {})), source: 'mirror' };
  if (!isMissingTable(error)) throw new Error(`lp_inbound_queue read: ${error.message}`);
  const raw = await readInboundRows(d.listInboundLeads, nowMs, cfg.lookbackHours);
  return { rows: raw.map(normalizeInboundRow).filter((r) => r.apptDate), source: 'lp_live' };
}

/**
 * Confirmation adds already queued for these phones, by ANY rule (ours or the
 * new-lead dial backstop's), in the last 7 days. phone → [{ list, status }].
 */
async function readConfAdds(runSQL, confLists, nowMs) {
  const rows = await runSQL(`
    SELECT id, status, target_id, action_payload::text AS payload
      FROM agent_actions
     WHERE action_type = 'five9_add_records_to_list'
       AND target_id IN (${confLists.map(q).join(',')})
       AND created_at >= ${q(new Date(nowMs - 7 * 86_400_000).toISOString())}`);
  if (!Array.isArray(rows)) throw new Error('confirmation-add read returned no row set');
  const byPhone = new Map();
  for (const r of rows) {
    // number1 is the first value of the record; any 10-digit run in the payload
    // that is a real phone counts (the record carries only one phone).
    const phones = new Set((String(r.payload ?? '').match(/\d{10,11}/g) || []).map(phone10).filter(Boolean));
    for (const p of phones) {
      if (!byPhone.has(p)) byPhone.set(p, []);
      byPhone.get(p).push({ id: r.id, list: r.target_id, status: String(r.status || '') });
    }
  }
  return byPhone;
}

/**
 * Every booked-routing claim from the last MARKS_LOOKBACK_DAYS, in one paged
 * read by prefix and age (2026-10-06). The first version asked for each key by
 * name — ~11 per lead, ~3,000 a pass, 300 per `.in()` — and every request URL
 * came out around 20 KB, so each one died as "TypeError: fetch failed" and the
 * job never got past its reads. Everything decide() checks (today's and the
 * last 7 days' removal claims, the add / retry / move claims made at most a
 * few days before a visit) falls inside the window. Uses the created_at index.
 */
export const MARKS_LOOKBACK_DAYS = 14;
const MARKS_PAGE = 1000;
export async function readBookedMarks(db, nowMs) {
  const since = new Date(nowMs - MARKS_LOOKBACK_DAYS * 86_400_000).toISOString();
  const seen = new Set();
  for (let from = 0; ; from += MARKS_PAGE) {
    const { data, error } = await db.from(MARKS_TABLE).select('dedup_key')
      .like('dedup_key', 'booked-%').gte('created_at', since)
      .order('dedup_key').range(from, from + MARKS_PAGE - 1);
    if (error) throw new Error(`marks read: ${error.message}`);
    for (const r of data || []) seen.add(r.dedup_key);
    if (!data || data.length < MARKS_PAGE) return seen;
  }
}

async function claim(db, key, { contactId = null, ldsId = null, apptDate = null } = {}) {
  const { data, error } = await db.from(MARKS_TABLE).upsert({
    dedup_key: key, contact_id: contactId, lds_id: ldsId, appt_date: apptDate, created_at: new Date().toISOString(),
  }, { onConflict: 'dedup_key', ignoreDuplicates: true }).select('dedup_key');
  if (error) throw new Error(`claim ${key}: ${error.message}`);
  return Array.isArray(data) && data.length > 0;
}
const release = (db, key) => Promise.resolve(db.from(MARKS_TABLE).delete().in('dedup_key', [key])).catch(() => {});

/**
 * Removals still waiting for a person whose appointment has passed: marked
 * `skipped` so they leave the queue. The executor refuses them anyway
 * (approval_expires_at) — this just tidies the queue. Never throws.
 */
async function expireStaleApprovals(db, nowMs) {
  try {
    const { data, error } = await db.from('agent_actions').select('id, action_payload')
      .eq('rule_applied', RULE_KEY).eq('status', 'pending_approval').limit(500);
    if (error) return { expired: 0, error: error.message };
    const ids = (data || []).filter((a) => approvalExpired(a, nowMs)).map((a) => a.id);
    if (!ids.length) return { expired: 0, rows: [] };
    const upd = await db.from('agent_actions')
      .update({ status: 'skipped', error_message: 'approval expired: the appointment time passed before anyone approved' })
      .in('id', ids).eq('status', 'pending_approval');
    if (upd?.error) return { expired: 0, error: upd.error.message };
    return { expired: ids.length, rows: (data || []).filter((a) => ids.includes(a.id)) };
  } catch (err) {
    return { expired: 0, error: err.message };
  }
}

// Shadow / skip decisions are logged once per lead, decision and ET day per
// process; live actions are once by their claims. Keeps the audit table from
// growing a row per lead every five minutes.
const loggedToday = new Set();
export function __resetLoggedForTests() { loggedToday.clear(); }

export async function runBookedDialRouting({ env = process.env, nowMs = Date.now(), deps: depsIn = {} } = {}) {
  const mode = routingMode(env);
  if (mode === 'off') return { skipped: true, reason: 'BOOKED_DIAL_ROUTING_MODE=off', mode };

  const d = { ...(depsIn.runSQL && depsIn.supabase ? {} : await defaultDeps()), ...depsIn };
  const cfg = routingConfig(env);
  const today = etDateKey(nowMs);
  const counts = {};
  const byReason = {};
  const decisions = [];
  const errors = [];
  const logRows = [];
  let lpReadded = 0;
  let addsQueued = 0;
  let removalsQueued = 0;
  const note = (c, action, reason, extra = {}) => {
    counts[action] = (counts[action] || 0) + 1;
    (byReason[reason] ||= []).push(c.ldsId || (c.in1 ? `in1:${c.in1}` : c.phone));
    if (decisions.length < 100) decisions.push({ phone4: c.phone?.slice(-4), lds: c.ldsId, in1: c.in1, appt: c.apptDate, action, reason, ...extra });
    const k = `${c.phone}|${c.apptDate}|${action}|${extra.list || ''}|${today}`;
    if (extra.agent_action_id || !loggedToday.has(k)) {
      loggedToday.add(k);
      logRows.push({
        phone10: c.phone, in1_id: c.in1, lds_id: c.ldsId, ghl_contact_id: c.contactId, appt_date: c.apptDate, appt_time: c.apptTime,
        action, list_name: extra.list || null, agent_action_id: extra.agent_action_id || null, mode, reason,
      });
    }
  };
  const finish = async (extra = {}) => {
    const logged = await insertSoft(d.supabase, LOG_TABLE, logRows);
    return {
      ok: errors.length === 0, mode, counts, adds_queued: addsQueued, removals_queued: removalsQueued, lp_readded: lpReadded,
      auto_remove: cfg.autoRemove, by_reason: byReason, decisions, errors,
      audit_log: logged.missing ? 'table_missing' : (logged.ok ? logged.inserted : `failed: ${logged.error}`), ...extra,
    };
  };
  const alarm = async () => {
    if (mode !== 'live') return;
    await Promise.resolve(d.reportAlertCondition({
      key: ALERT_KEY,
      active: errors.length > 0,
      label: 'Booked-lead dial routing',
      text: `⚠️ Booked-lead dial routing is failing — booked leads may stay on the setter lists.\n${errors.slice(0, 5).join('\n')}`,
      recoveredText: '✅ Booked-lead dial routing is running cleanly again.',
      channel: 'ops',
    })).catch((err) => console.warn(`[BookedRouting] alert state: ${err.message}`));
  };

  // 0. Tidy expired approvals (live only).
  let expired = { expired: 0 };
  if (mode === 'live') {
    expired = await expireStaleApprovals(d.supabase, nowMs);
    for (const a of expired.rows || []) {
      const p = a.action_payload || {};
      logRows.push({ phone10: p.phone || null, in1_id: p.in1_id || null, lds_id: p.lp_lead_id || null, appt_date: p.appointment?.date || null,
        appt_time: p.appointment?.time || null, action: 'expired', agent_action_id: a.id, mode, reason: 'approval_expired' });
    }
  }

  // 1. Reads that must all succeed.
  let candidates; let sold; let adds; let marks; let inboundSource;
  try {
    const inbound = await readBookedInbound(d, nowMs, cfg);
    inboundSource = inbound.source;
    const windowLeads = await readLeadsSince(d.runSQL, nowMs - cfg.lookbackHours * 3600_000);
    const leadsById = new Map(windowLeads.map((l) => [String(l.lp_lead_id), l]));
    const all = [];
    const seenLds = new Set();
    for (const r of inbound.rows) {
      const lead = r.ldsId ? leadsById.get(r.ldsId) || null : null;
      if (r.ldsId) seenLds.add(r.ldsId);
      all.push(buildCandidate(r, lead));
    }
    // 2026-10-13: every visit for today .. today+2 too, whatever the lead's age
    // (readLeadsByAppointment). The 72h window alone missed older leads.
    const apptLeads = await readLeadsByAppointment(d.runSQL, today, addDaysKey(today, 2));
    for (const l of [...windowLeads, ...apptLeads]) {
      const id = String(l.lp_lead_id);
      if (seenLds.has(id)) continue;
      seenLds.add(id);
      const c = buildCandidate(rowFromLead(l), l);
      if (c.apptDate && c.booked) all.push(c);
    }
    const { winners, dropped } = onePerPhone(all.filter((c) => c.booked || c.apptDate));
    for (const c of dropped) if (c.phone) note(c, 'skip', 'newer_row_same_phone');
    candidates = winners;
    const phones = candidates.map((c) => c.phone).filter(Boolean);
    sold = await readSoldPhones(d.runSQL, phones);
    adds = await readConfAdds(d.runSQL, Object.values(cfg.conf), nowMs);
    marks = await readBookedMarks(d.supabase, nowMs);
  } catch (err) {
    errors.push(`read: ${err.message}`);
    await alarm();
    return finish({ insufficient_evidence: true });
  }

  // 2. Decide without Five9.
  const live = [];
  for (const c of candidates) {
    const pre = prefilter(c, { nowMs, cfg, sold: Boolean(c.phone && sold.has(c.phone)) });
    if (pre.action === 'skip') { note(c, 'skipped', pre.reason); continue; }
    if (pre.action === 'hold') { note(c, 'held', pre.reason); continue; }
    live.push({ c, pre });
  }

  // 3. Five9: one DNC read, then capped contact lookups.
  let onDnc = null;
  if (live.length) {
    try { onDnc = await readDnc(d.checkDnc, live.map((x) => x.c.phone)); } catch (err) { errors.push(`dnc: ${err.message}`); }
  }
  let lookups = 0;
  const addFailed = [];
  // Adds before removal re-checks, soonest visit first (lookupPriority).
  live.sort((a, b) => lookupPriority(
    { needsAdd: Boolean(a.pre.route.addList) && addState(adds.get(a.c.phone), a.pre.route.addList) !== 'done', c: a.c },
    { needsAdd: Boolean(b.pre.route.addList) && addState(adds.get(b.c.phone), b.pre.route.addList) !== 'done', c: b.c },
  ));
  for (const { c, pre } of live) {
    const list = pre.route.addList;
    const removedBefore = priorRemoveKeys(c.phone, c.apptDate, nowMs, cfg.readdLookbackDays).some((k) => marks.has(k));
    const addRows = adds.get(c.phone);
    // The Five9 record is read only when a decision needs it (2026-10-06): to
    // skip an add the record already has (an add still to do) or to see LP's
    // re-add (a removal on a later day). A removal-only lead (Cnf, Issue, 3+
    // days, an add already done) needs none; spending the per-pass lookup cap
    // on those deferred 121 leads a pass in the first clean shadow runs.
    const needsRecord = (list && addState(addRows, list) !== 'done') || removedBefore;
    let contact;
    if (needsRecord && onDnc && !onDnc.has(c.phone)) {
      if (lookups >= cfg.maxLookups) { note(c, 'deferred', 'lookup_cap'); continue; }
      lookups += 1;
      try {
        contact = summarizeContactRecord(await d.getContactRecords({ criteria: [{ field: 'number1', value: c.phone }] }), c.ldsId);
      } catch {
        contact = 'error';
      }
    }
    const dec = decide({
      pre, contact, cfg,
      onDnc: onDnc ? onDnc.has(c.phone) : null,
      adds: addState(addRows, list),
      removedToday: marks.has(removeKey(c.phone, c.apptDate, today)),
      removedBefore,
      addClaimed: list ? marks.has(addKey(c.phone, c.apptDate, list)) : false,
      failedAdds: list ? failedAddCount(addRows, list) : 0,
      retryClaimed: list ? marks.has(retryKey(c.phone, c.apptDate, list)) : false,
    });
    if (dec.readded) lpReadded += 1;
    // 2026-10-06 follow-up: moved from "2nd Day" to "Next Day" → off "2nd Day" too.
    const dncKnownClear = Boolean(onDnc && !onDnc.has(c.phone));
    const moveDue = dncKnownClear && confMoveDue({ route: pre.route, addRows, moveClaimed: marks.has(moveKey(c.phone, c.apptDate)), cfg });

    if (dec.alert) {
      addFailed.push({ c, list, key: `${c.phone}:${c.apptDate}`, reason: 'add_failed_twice' });
      note(c, 'add_failed', dec.reason, { list });
      continue;
    }

    if (dec.add) {
      if (addsQueued >= cfg.maxAdds) { note(c, 'deferred', 'add_cap', { list }); continue; }
      if (mode === 'shadow') {
        note(c, 'would_add', dec.reason, { list });
        addsQueued += 1;
        console.log(`[BookedRouting] shadow: would add …${c.phone.slice(-4)} (LP lead ${c.ldsId || c.in1}, visit ${c.apptDate}) → "${list}"`);
        continue;
      }
      const key = dec.retry ? retryKey(c.phone, c.apptDate, list) : addKey(c.phone, c.apptDate, list);
      let won = false;
      try {
        won = await claim(d.supabase, key, { contactId: c.contactId, ldsId: c.ldsId, apptDate: c.apptDate });
        if (!won) { note(c, 'skipped', 'add_already_claimed', { list }); continue; }
        const record = buildBackstopRecord(c.row, c.lead);
        const ins = await d.supabase.from('agent_actions').insert(buildAddAction(c, record, list, { reason: dec.reason, nowMs })).select('id').single();
        if (ins.error) throw new Error(ins.error.message);
        addsQueued += 1;
        note(c, dec.retry ? 'add_retried' : 'added', dec.reason, { list, agent_action_id: ins.data?.id ?? null });
        console.log(`[BookedRouting] queued add …${c.phone.slice(-4)} → "${list}" as agent_action ${ins.data?.id}`);
      } catch (err) {
        if (won) await release(d.supabase, key);
        errors.push(`add ${c.phone}: ${err.message}`);
        note(c, 'failed', 'add_queue_failed', { list });
      }
      continue;
    }

    if (dec.remove || moveDue) {
      // One card per phone: the setter lists, "Conf - 2nd Day", or both.
      const lists = [...(dec.remove ? cfg.removeLists : []), ...(moveDue ? [cfg.conf.secondDay] : [])];
      const reason = dec.remove ? dec.reason : 'moved_to_next_day';
      if (removalsQueued >= cfg.maxRemovals) { note(c, 'deferred', 'removal_cap'); continue; }
      if (mode === 'shadow') {
        note(c, 'would_remove', reason, { list: lists.join(', ') });
        removalsQueued += 1;
        console.log(`[BookedRouting] shadow: would queue removal of …${c.phone.slice(-4)} from ${lists.join(', ')} (${reason})`);
        continue;
      }
      const keys = [...(dec.remove ? [removeKey(c.phone, c.apptDate, today)] : []), ...(moveDue ? [moveKey(c.phone, c.apptDate)] : [])];
      const won = [];
      try {
        for (const key of keys) {
          if (!(await claim(d.supabase, key, { contactId: c.contactId, ldsId: c.ldsId, apptDate: c.apptDate }))) break;
          won.push(key);
        }
        if (won.length !== keys.length) {
          for (const k of won) await release(d.supabase, k);
          won.length = 0;
          note(c, 'skipped', 'removal_already_claimed');
          continue;
        }
        const row = buildRemovalAction(c, { reason, readded: Boolean(dec.readded), confList: list, lists, cfg, nowMs });
        const ins = await d.supabase.from('agent_actions').insert(row).select('id').single();
        if (ins.error) throw new Error(ins.error.message);
        removalsQueued += 1;
        note(c, 'remove_queued', reason, { list: lists.join(', '), agent_action_id: ins.data?.id ?? null });
        console.log(`[BookedRouting] queued removal of …${c.phone.slice(-4)} from ${lists.join(', ')} as agent_action ${ins.data?.id} (${row.requires_approval ? 'awaiting approval' : 'auto — standing exception'})`);
      } catch (err) {
        for (const k of won) await release(d.supabase, k);
        errors.push(`removal ${c.phone}: ${err.message}`);
        note(c, 'failed', 'removal_queue_failed');
      }
      continue;
    }

    note(c, dec.reason === 'dnc' ? 'skipped' : 'waiting', dec.reason, list ? { list } : {});
  }

  // 4. Adds that failed twice: ONE #contact-center card, each visit once (live).
  if (addFailed.length && mode === 'live') {
    const channel = String(env.SLACK_CHANNEL_SERVICE || '').trim();
    const { fresh } = await d.filterNew({ audit: ADD_FAILED_AUDIT, items: addFailed, ttlDays: 14, nowMs, deps: { supabase: d.supabase } });
    if (fresh.length) {
      const res = channel
        ? await Promise.resolve(d.postToSlack(formatAddFailedCard(fresh), channel)).catch((err) => ({ ok: false, error: err.message }))
        : { ok: false, error: 'SLACK_CHANNEL_SERVICE unset' };
      if (res?.ok) await d.recordPosted({ audit: ADD_FAILED_AUDIT, items: fresh, nowMs, deps: { supabase: d.supabase } });
      else errors.push(`#contact-center add-failed card: ${res?.error || 'post failed'}`);
    }
  }

  await alarm();
  return finish({ add_failed: addFailed.length, inbound_source: inboundSource, candidates: candidates.length, five9_lookups: lookups, approvals_expired: expired.expired });
}

/** One pass as its own job_runs row; called after each inbound-watch pass. */
export async function runBookedRoutingTick() {
  const { value: res } = await runJob(JOB_ID, () => runBookedDialRouting());
  if (res && res.ok === false) console.warn(`[BookedRouting] pass finished with errors: ${res.errors.join('; ')}`);
  else if (res && !res.skipped && (res.adds_queued || res.removals_queued)) {
    console.log(`[BookedRouting] ${res.mode}: ${res.adds_queued} add(s), ${res.removals_queued} removal(s), ${res.lp_readded} LP re-add(s)`);
  }
  return res;
}
