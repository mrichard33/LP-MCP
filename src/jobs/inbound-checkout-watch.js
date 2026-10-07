// ─── Inbound checkout watch — src/jobs/inbound-checkout-watch.js ──────────────
//
// Every 5 minutes, around the clock: read LP's inbound queue (48h), mirror it
// into lp_inbound_queue, tell #contact-center which inquiries are waiting to be
// checked out, and finish the GHL side of inquiries LP has issued. The WHY and
// every rule live in src/inbound-checkout-watch.js; this file reads, claims and
// writes. Structure mirrors src/jobs/new-lead-dial-backstop.js.
//
// MODES — INBOUND_CHECKOUT_WATCH_MODE, default `shadow`
//   off     do nothing.
//   shadow  read, mirror and decide; log "would post" / "would write". No Slack,
//           no marks, no GHL or LP write. (The mirror upsert runs: it is our own
//           table and changes nothing anyone acts on.)
//   live    cards, write-backs, marks. Going live is Mark's decision.
//   Anything unrecognised is `shadow`.
//
// FAIL CLOSED ON READS
//   A failed LP read ends the pass: no posts, no writes, the error in
//   job_runs and (live) one edge-triggered #ops alarm. "Could not read" never
//   reads as "nothing waiting". A missing sql/149 table is NOT a failure: the
//   mirror logs once and the watch still alerts.
//
// CLAIM, THEN ACT
//   The overnight card and each appointment write claim a key in
//   lp_appointment_sync_marks (unique dedup_key, ignoreDuplicates) first; a
//   lost claim does nothing. Card lines dedupe through audit_posted_items
//   (src/alert-posted.js), the one "already posted" store.

import { runJob } from '../job-runner.js';
import { upsertInboundQueue } from '../lp-inbound-queue.js';
import { readInboundRows } from './new-lead-dial-backstop.js';
import { etDateKey } from '../new-lead-dial-backstop.js';
import { runBookedRoutingTick } from './booked-dial-routing.js';
import { routingMode } from '../booked-dial-routing.js';
import {
  watchMode, watchConfig, watchRow, classifyRow, assessWaiting, inOfficeHours, formatWaitCard, formatEscalateCard,
  writebackCandidates, writebackDecision, summarize, overnightKey, apptKey, checkedKey, GHL_FIELD_LP_LEAD_ID,
  INBOUND_WAIT_AUDIT, HELD_IMPORT_AUDIT,
} from '../inbound-checkout-watch.js';

export const JOB_ID = 'inbound-checkout-watch';
export const INTERVAL_MS = 5 * 60 * 1000;
const MARKS_TABLE = 'lp_appointment_sync_marks';
const ALERT_KEY = 'inbound-checkout-watch';
export const WAIT_AUDIT = INBOUND_WAIT_AUDIT;
export const ESCALATE_AUDIT = 'inbound_checkout_escalate';
export const ISSUED_TAG = 'lp-issued-via-watch';

async function defaultDeps() {
  const [supabaseMod, lp, slack, alertState, alertPosted, ghl, lpAppt] = await Promise.all([
    import('../supabase.js'),
    import('../lp-client.js'),
    import('../slack.js'),
    import('../alert-state.js'),
    import('../alert-posted.js'),
    import('../ghl.js'),
    import('../actions/handlers/lp-appointment.js'),
  ]);
  return {
    supabase: supabaseMod.default,
    listInboundLeads: lp.listInboundLeads,
    postToSlack: slack.postToSlack,
    reportAlertCondition: alertState.reportAlertCondition,
    sendAlertMessage: alertState.sendAlertMessage,
    filterNew: alertPosted.filterNew,
    recordPosted: alertPosted.recordPosted,
    getGHLContact: ghl.getGHLContact,
    updateGHLContactFields: ghl.updateGHLContactFields,
    applyGHLTag: ghl.applyGHLTag,
    executeSetLPAppointment: lpAppt.executeSetLPAppointment,
  };
}

async function readMarks(db, keys) {
  const seen = new Set();
  for (let i = 0; i < keys.length; i += 300) {
    const { data, error } = await db.from(MARKS_TABLE).select('dedup_key').in('dedup_key', keys.slice(i, i + 300));
    if (error) throw new Error(`marks read: ${error.message}`);
    for (const r of data || []) seen.add(r.dedup_key);
  }
  return seen;
}

/** Claim a key. True only for the caller that inserted it. */
async function claim(db, key, { contactId = null, ldsId = null, apptDate = null } = {}) {
  const { data, error } = await db.from(MARKS_TABLE).upsert({
    dedup_key: key, contact_id: contactId, lds_id: ldsId, appt_date: apptDate, created_at: new Date().toISOString(),
  }, { onConflict: 'dedup_key', ignoreDuplicates: true }).select('dedup_key');
  if (error) throw new Error(`claim ${key}: ${error.message}`);
  return Array.isArray(data) && data.length > 0;
}
const release = (db, key) => Promise.resolve(db.from(MARKS_TABLE).delete().in('dedup_key', [key])).catch(() => {});

export async function runInboundCheckoutWatch({ env = process.env, nowMs = Date.now(), deps: depsIn = {} } = {}) {
  const mode = watchMode(env);
  if (mode === 'off') return { skipped: true, reason: 'INBOUND_CHECKOUT_WATCH_MODE=off', mode };

  const d = { ...(depsIn.supabase && depsIn.listInboundLeads ? {} : await defaultDeps()), ...depsIn };
  const cfg = watchConfig(env);
  const office = inOfficeHours(nowMs, cfg);
  const errors = [];
  const posted = { wait: 0, overnight: 0, escalate: 0 };
  const would = { wait: [], overnight: [], escalate: [] };
  const writes = [];
  const finish = (extra = {}) => ({ ok: errors.length === 0, mode, office_hours: office, posted, errors, ...extra });
  const alarm = async () => {
    if (mode !== 'live') return;
    await Promise.resolve(d.reportAlertCondition({
      key: ALERT_KEY,
      active: errors.length > 0,
      label: 'LP inbound checkout watch',
      text: `⚠️ LP inbound checkout watch is failing — inquiries waiting in LP may not be flagged.\n${errors.slice(0, 5).join('\n')}`,
      recoveredText: '✅ LP inbound checkout watch is running cleanly again.',
      channel: 'ops',
    })).catch((err) => console.warn(`[InboundWatch] alert state: ${err.message}`));
  };

  // 1. The read that must succeed.
  let raw;
  try {
    raw = await readInboundRows(d.listInboundLeads, nowMs, cfg.lookbackHours);
  } catch (err) {
    errors.push(`read: ${err.message}`);
    await alarm();
    return finish({ insufficient_evidence: true });
  }
  const mirror = await upsertInboundQueue(d.supabase, raw, { nowMs });

  // One row per inquiry.
  const seen = new Set();
  const rows = [];
  for (const r of raw.map(watchRow)) {
    if (!r.in1 || seen.has(r.in1)) continue;
    seen.add(r.in1);
    rows.push(r);
  }
  const assessed = assessWaiting(rows, nowMs, cfg);
  const due = assessed.filter((a) => a.due);
  const escalate = assessed.filter((a) => a.escalate);
  const today = etDateKey(nowMs);

  let marks = new Set();
  const candidates = writebackCandidates(rows, nowMs, cfg);
  try {
    marks = await readMarks(d.supabase, [
      overnightKey(today),
      ...candidates.flatMap((r) => [checkedKey(r.in1), apptKey(r.ldsId)]),
    ]);
  } catch (err) {
    // Marks guard the write-backs and the overnight card. Unreadable = do
    // neither this pass (fail closed); the waiting card still goes out.
    errors.push(err.message);
    marks = null;
  }

  // 2. Cards — office hours only.
  const channel = String(env.SLACK_CHANNEL_SERVICE || '').trim();
  const post = async (text) => (channel
    ? Promise.resolve(d.postToSlack(text, channel)).catch((err) => ({ ok: false, error: err.message }))
    : { ok: false, error: 'SLACK_CHANNEL_SERVICE unset' });
  const asItems = (list, reason) => list.map((a) => ({ ...a, key: a.row.in1, reason }));
  // An in1 the held-row "import this lead" card already named is not carded
  // again here (2026-10-07). A failed read keeps them all (filterNew is fail-open).
  const notHeldCarded = async (items) => {
    if (mode !== 'live' || !items.length) return items;
    const { fresh } = await d.filterNew({
      audit: HELD_IMPORT_AUDIT, items: items.map((a) => ({ key: a.key, reason: 'card' })), ttlDays: 30, nowMs, deps: { supabase: d.supabase },
    });
    const open = new Set(fresh.map((f) => f.key));
    return items.filter((a) => open.has(a.key));
  };

  if (office) {
    // 2a. The overnight card, once, in the first in-hours pass — only the
    // inquiries past their threshold (2026-10-07: it listed every waiting row,
    // 13-minute-old ones included). Nothing due: no card, the key is still
    // claimed so a row that turns due later goes on the regular card.
    if (marks && !marks.has(overnightKey(today))) {
      const all = await notHeldCarded(asItems(due, 'waiting'));
      if (mode === 'shadow') {
        would.overnight = all.map((a) => a.row.in1);
        if (all.length) console.log(`[InboundWatch] shadow: would post the overnight card (${all.length} waiting)`);
      } else {
        try {
          if (await claim(d.supabase, overnightKey(today)) && all.length) {
            const res = await post(formatWaitCard(all, { overnight: true }));
            if (res?.ok) {
              posted.overnight = all.length;
              await d.recordPosted({ audit: WAIT_AUDIT, items: all, nowMs, deps: { supabase: d.supabase } });
              for (const a of all) a.row._announced = true;
            } else {
              await release(d.supabase, overnightKey(today));
              errors.push(`#contact-center overnight card: ${res?.error || 'post failed'}`);
            }
          }
        } catch (err) {
          errors.push(`overnight card: ${err.message}`);
        }
      }
    }

    // 2b. The regular card: new inquiries past their threshold.
    const dueItems = await notHeldCarded(asItems(due.filter((a) => !a.row._announced), 'waiting'));
    if (dueItems.length) {
      const { fresh } = mode === 'live'
        ? await d.filterNew({ audit: WAIT_AUDIT, items: dueItems, ttlDays: 3, nowMs, deps: { supabase: d.supabase } })
        : { fresh: dueItems };
      if (mode === 'shadow') {
        would.wait = fresh.map((a) => a.row.in1);
        console.log(`[InboundWatch] shadow: would post ${fresh.length} waiting inquiry line(s): ${would.wait.join(', ')}`);
      } else if (fresh.length) {
        const res = await post(formatWaitCard(fresh));
        if (res?.ok) {
          posted.wait = fresh.length;
          await d.recordPosted({ audit: WAIT_AUDIT, items: fresh, nowMs, deps: { supabase: d.supabase } });
        } else {
          errors.push(`#contact-center card: ${res?.error || 'post failed'}`);
        }
      }
    }

    // 2c. Past the escalation line: one #ops card for the new ones.
    const escItems = asItems(escalate, 'escalate');
    if (escItems.length) {
      const { fresh } = mode === 'live'
        ? await d.filterNew({ audit: ESCALATE_AUDIT, items: escItems, ttlDays: 3, nowMs, deps: { supabase: d.supabase } })
        : { fresh: escItems };
      if (mode === 'shadow') {
        would.escalate = fresh.map((a) => a.row.in1);
      } else if (fresh.length) {
        const sent = await Promise.resolve(d.sendAlertMessage(formatEscalateCard(fresh, cfg), { channel: 'ops' }))
          .catch((err) => ({ sent: false, reason: err.message }));
        if (sent?.sent) {
          posted.escalate = fresh.length;
          await d.recordPosted({ audit: ESCALATE_AUDIT, items: fresh, nowMs, deps: { supabase: d.supabase } });
        } else {
          errors.push(`#ops escalation card: ${sent?.reason || 'post failed'}`);
        }
      }
    }
  }

  // 3. Write-back for issued inquiries (any hour — no person is paged).
  let lookups = 0;
  let writesDone = 0;
  if (marks) {
    for (const row of candidates) {
      if (marks.has(checkedKey(row.in1))) continue;
      if (lookups >= cfg.maxLookups || writesDone >= cfg.maxWrites) break;
      lookups += 1;
      let contact = null;
      try { contact = await d.getGHLContact(row.lognumber); } catch { contact = null; }
      const dec = writebackDecision(row, contact, nowMs);
      const w = { in1: row.in1, lds: row.ldsId, contact: row.lognumber, decision: dec.reason };
      if (dec.reason === 'contact_unreadable') { writes.push(w); continue; }
      if (mode === 'shadow') {
        if (dec.reason !== 'nothing_to_do') {
          w.result = 'would';
          console.log(`[InboundWatch] shadow: would ${dec.reason} for inquiry ${row.in1} → lds ${row.ldsId} (contact ${row.lognumber})`);
        }
        writes.push(w);
        continue;
      }
      try {
        if (dec.writeLeadId) {
          await d.updateGHLContactFields(row.lognumber, [{ id: GHL_FIELD_LP_LEAD_ID, field_value: row.ldsId }]);
          await Promise.resolve(d.applyGHLTag(row.lognumber, ISSUED_TAG)).catch(() => {});
          w.lds_written = true;
          writesDone += 1;
        }
        if (dec.setAppt && !marks.has(apptKey(row.ldsId))) {
          if (await claim(d.supabase, apptKey(row.ldsId), { contactId: row.lognumber, ldsId: row.ldsId, apptDate: dec.setAppt.dateKey })) {
            writesDone += 1;
            let res;
            try {
              res = await d.executeSetLPAppointment({
                id: null,
                event_id: null,
                action_type: 'set_lp_appointment',
                target_id: row.ldsId,
                rule_applied: 'INBOUND_CHECKOUT_WATCH',
                action_payload: { appt_date: dec.setAppt.apptDate, appt_time: dec.setAppt.apptTime, ghl_contact_id: row.lognumber },
              });
            } catch (err) {
              // A throw is transient (LP down, circuit open): release so the
              // next pass retries. A returned skip is LP's answer: keep the claim.
              await release(d.supabase, apptKey(row.ldsId));
              throw err;
            }
            w.appt_result = res?.action || 'unknown';
          }
        }
        await claim(d.supabase, checkedKey(row.in1), { contactId: row.lognumber, ldsId: row.ldsId });
        w.result = 'done';
      } catch (err) {
        w.result = 'failed';
        errors.push(`write-back ${row.in1}: ${err.message}`);
      }
      writes.push(w);
    }
  }

  await alarm();
  return finish({
    rows: rows.length,
    mirror: mirror.missing ? 'table_missing' : (mirror.ok ? `upserted ${mirror.upserted}` : `failed: ${mirror.error}`),
    due: due.length,
    escalate: escalate.length,
    would: mode === 'shadow' ? would : undefined,
    writes: writes.slice(0, 50),
    writeback_lookups: lookups,
    ...summarize(rows, assessed, nowMs),
  });
}

/* --- scheduler -------------------------------------------------------------- */

let timer = null;
let running = false;

/**
 * One watch pass, then the booked-lead routing pass right after it (it reads
 * the mirror this pass just refreshed). Each is its own job_runs row, and a
 * routing failure never touches the watch.
 */
export async function runInboundTick() {
  const { value: res } = await runJob(JOB_ID, () => runInboundCheckoutWatch());
  if (res && res.ok === false) console.warn(`[InboundWatch] pass finished with errors: ${res.errors.join('; ')}`);
  else if (res && !res.skipped && (res.due || res.posted?.wait)) console.log(`[InboundWatch] ${res.mode}: ${res.due} waiting past threshold, oldest ${res.oldest_wait_min} min`);
  try {
    await runBookedRoutingTick();
  } catch (err) {
    console.error(`[BookedRouting] pass threw: ${err.message}`);
  }
}

export function startInboundCheckoutWatchScheduler(env = process.env) {
  if (timer) return timer;
  if (watchMode(env) === 'off' && routingMode(env) === 'off') {
    console.log('[InboundWatch] scheduler not started (INBOUND_CHECKOUT_WATCH_MODE=off and BOOKED_DIAL_ROUTING_MODE=off)');
    return null;
  }
  const tick = async () => {
    if (running) return; // wrap the work, not the tick
    running = true;
    try {
      await runInboundTick();
    } catch (err) {
      console.error(`[InboundWatch] pass threw: ${err.message}`);
    } finally {
      running = false;
    }
  };
  timer = setInterval(tick, INTERVAL_MS);
  if (typeof timer.unref === 'function') timer.unref();
  console.log(`[InboundWatch] scheduler started — watch ${watchMode(env)}, booked routing ${routingMode(env)}, every 5m, 24/7`);
  return timer;
}

export function stopInboundCheckoutWatchScheduler() {
  if (timer) { clearInterval(timer); timer = null; }
}
