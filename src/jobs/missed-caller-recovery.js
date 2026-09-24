// ─── Missed paid caller recovery — src/jobs/missed-caller-recovery.js ───────
//
// WHAT
//   Every 15 minutes, reads v_unmatched_inbound_callers_30d (sql/125): Five9
//   callers whose number matches NO LP lead. For paid campaigns only, calls
//   from the last 72 hours whose last disposition means "nobody talked to
//   them" (Hung Up, Sent To Voicemail, Abandon, ...) are queued to the Five9
//   "Callback Request" list so an agent rings them back. Every decision is
//   written to missed_caller_recovery_log (sql/126).
//
// WHY (2026-09-24)
//   The 2026-09-23 audit found 257 Google PPC Windows callers in 30 days with
//   no LP record, mostly hang-ups and voicemails. They were paid leads, and
//   nothing ever followed up: no LP record means no LP queue, so no dial.
//
// MODES — MISSED_CALLER_RECOVERY_MODE, default `shadow`
//   off     do nothing.
//   shadow  decide everything and log `would_push`; never write to Five9.
//   live    queue the push and log `pushed`. Going live is Mark's decision.
//   Anything unrecognised is treated as `shadow`, never `live`: a typo must not
//   start dialling people, and must not silently switch the job off either.
//
// WHAT THIS NEVER DOES
//   - Never calls LP addlead and never creates an LP lead. Standing rule
//     (Mark): sending leads to LP to trigger calls mints duplicates — lead
//     573111 on 2026-09-04 is the incident. scripts/test-missed-caller-
//     recovery.js fails if this file ever references LP's lead writers.
//   - Never sends customer-facing text. It only queues a dial.
//   - Never writes to LP_ASAP. The only list is callbackListName().
//   - Never dials an "Appointment Set" caller. A call dispositioned as an
//     appointment with no LP record is a broken booking, not a lost lead:
//     it is logged `alert_appt_no_lp` and emitted as
//     identity.appt_without_lp_record for a human to fix.
//
// THE PUSH PATH
//   Not src/five9/list-dispatch.js. That module is break-glass only and its
//   banner forbids extending it. The Callback Request list's real path is the
//   one lp_callback_requeue uses: queue an unarmed five9_add_records_to_list
//   agent_action (the single carve-out, Mark 2026-09-04 — see
//   AUTO_APPROVED_FIVE9_OP in src/tools/agent-tools.js), which the executor
//   runs and five9.admin_write audits. Same list name, same callNowMode.
//
//   The record carries number1 ONLY. There is no CustID because there is no
//   LP record, so the LeadPerfection screen pop has nothing to open — the
//   agent sees a bare number. callback-push.js refuses to push without a
//   CustID for LP-backed callbacks; here it cannot exist by definition. This
//   is the open question to settle before `live`.
//
// SAFETY ORDER, PER CALLER
//   1. Five9 DNC — the existing checkDncForNumbers (five9_check_dnc). FAILS
//      CLOSED: if the check cannot be read, eligible rows are left UNLOGGED so
//      the next pass retries them. Unknown DNC status is never a dial.
//   2. Cross-list check (findContactInOtherLists, the lp_callback_requeue
//      guard) — someone another campaign is already working is not pushed
//      again. Fails open, exactly as it does there.
//   3. Per-caller cooldown — one queued dial per number per 72 hours, however
//      many times they ring back or under how many campaigns.
//   4. Claim, then act — the log row is inserted ON CONFLICT DO NOTHING
//      BEFORE the push, and the push happens only when the claim won. If the
//      push then fails, the claim is removed so the next pass retries.
//
// Shadow runs steps 1–3 too (they are reads), so `would_push` means "live
// would have pushed this", not "this passed a looser test".

import { runSQL as defaultRunSQL } from '../admin/supabase-admin.js';
import defaultSupabase from '../supabase.js';
import { checkDncForNumbers as defaultCheckDnc } from '../five9-admin.js';
import {
  findContactInOtherLists as defaultFindOtherLists,
  callbackListName,
  callbackCallNowMode,
} from '../five9/callback-push.js';
import { emitEvent as defaultEmitEvent } from '../event-emitter.js';
import { runJob } from '../job-runner.js';

export const JOB_ID = 'missed-caller-recovery';
export const LOG_TABLE = 'missed_caller_recovery_log';
export const RULE_KEY = 'MISSED_CALLER_RECOVERY';
export const LOOKBACK_HOURS = 72;
export const INTERVAL_MS = 15 * 60 * 1000;
export const MODES = Object.freeze(['off', 'shadow', 'live']);
const DNC_BATCH = 200; // five9_check_dnc's own cap
const MAX_ROWS_PER_PASS = 500;

export const APPT_SET_DISPOSITION = 'Appointment Set';

// "Nobody spoke to them." Anything else — Not Interested, Service Call, Cant
// Do Project — was a conversation, and redialling it is not recovery.
export const ELIGIBLE_DISPOSITIONS = Object.freeze([
  'Hung Up',
  'Caller Disconnected',
  'Sent To Voicemail',
  'NA',
  'Abandon',
  'No Disposition',
]);

// Paid, lead-generating inbound campaigns. "Main Number" is excluded: it mixes
// service calls and existing customers (decided, 2026-09-23).
export const DEFAULT_CAMPAIGNS = Object.freeze([
  'Google PPC Windows',
  'St Pete Sticky',
  'Ft Myers Sticky',
  'FTL Sticky',
  'JAX Sticky',
  'Magazine - Best Pick Reports',
  'Magazine - 5 Star Reviews',
  'TheHomeMag',
  'Billboard-Trailer Job Signs',
]);

/* --- config, read per pass ---------------------------------------------- */

export function recoveryMode(env = process.env) {
  const raw = String(env.MISSED_CALLER_RECOVERY_MODE ?? '').trim().toLowerCase();
  if (!raw) return 'shadow';
  return MODES.includes(raw) ? raw : 'shadow';
}

export function recoveryCampaigns(env = process.env) {
  const raw = String(env.MISSED_CALLER_RECOVERY_CAMPAIGNS ?? '').trim();
  if (!raw) return [...DEFAULT_CAMPAIGNS];
  const list = raw.split(',').map((s) => s.trim()).filter(Boolean);
  return list.length ? list : [...DEFAULT_CAMPAIGNS];
}

/* --- pure decisions ----------------------------------------------------- */

/** 'appt_no_lp' | 'eligible' | 'ineligible' */
export function classifyDisposition(disposition) {
  const d = String(disposition ?? '').trim();
  if (d === APPT_SET_DISPOSITION) return 'appt_no_lp';
  return ELIGIBLE_DISPOSITIONS.includes(d) ? 'eligible' : 'ineligible';
}

/**
 * Inclusive: a call exactly LOOKBACK_HOURS old is still in. An unparseable
 * timestamp is out — we cannot say it is recent.
 */
export function isWithinLookback(lastCallAt, nowMs = Date.now(), hours = LOOKBACK_HOURS) {
  const t = Date.parse(lastCallAt);
  if (!Number.isFinite(t)) return false;
  return t >= nowMs - hours * 3600 * 1000;
}

export function last10(phone) {
  const d = String(phone ?? '').replace(/\D/g, '');
  return d.length >= 10 ? d.slice(-10) : '';
}

const sqlStr = (v) => `'${String(v).replace(/'/g, "''")}'`;

/**
 * Candidate rows: allow-listed campaign, last call inside the lookback, and no
 * log row yet for this exact (caller, campaign, last_call_at).
 * recently_queued feeds the per-caller cooldown.
 */
export function buildCandidatesSql(campaigns, hours = LOOKBACK_HOURS) {
  const h = Number(hours);
  if (!Array.isArray(campaigns) || !campaigns.length) throw new Error('no campaigns to read');
  if (!Number.isFinite(h) || h <= 0) throw new Error(`bad lookback: ${hours}`);
  return `
    SELECT v.caller, v.campaign, v.last_call_at, v.last_disposition, v.calls,
           EXISTS (
             SELECT 1 FROM ${LOG_TABLE} r
              WHERE r.caller_phone = v.caller
                AND r.action IN ('pushed', 'would_push')
                AND r.created_at >= now() - interval '${h} hours'
           ) AS recently_queued
      FROM v_unmatched_inbound_callers_30d v
     WHERE v.campaign IN (${campaigns.map(sqlStr).join(', ')})
       AND v.last_call_at >= now() - interval '${h} hours'
       AND NOT EXISTS (
             SELECT 1 FROM ${LOG_TABLE} r
              WHERE r.caller_phone = v.caller
                AND r.campaign = v.campaign
                AND r.last_call_at = v.last_call_at
           )
     ORDER BY v.last_call_at DESC
     LIMIT ${MAX_ROWS_PER_PASS}`;
}

/** The Five9 record: number1 only — see "THE PUSH PATH" above. */
export function buildMissedCallerRecord(caller) {
  const number1 = last10(caller);
  if (!number1) throw new Error(`missed caller has no usable 10-digit number (got "${caller}")`);
  return { fieldNames: ['number1'], values: [number1], number1 };
}

/* --- effects (all behind deps) ------------------------------------------ */

/** Claim the key. Returns the new row id, or null when it was already logged. */
async function claim(db, row, mode, action, detail) {
  const { data, error } = await db
    .from(LOG_TABLE)
    .upsert({
      caller_phone: row.caller,
      campaign: row.campaign,
      last_call_at: row.last_call_at,
      last_disposition: row.last_disposition ?? null,
      mode,
      action,
      detail: detail ? String(detail).slice(0, 500) : null,
    }, { onConflict: 'caller_phone,campaign,last_call_at', ignoreDuplicates: true })
    .select('id');
  if (error) throw new Error(`${LOG_TABLE} write failed: ${error.message}`);
  return Array.isArray(data) && data[0] ? data[0].id : null;
}

/** Queue the unarmed Callback Request push — the lp_callback_requeue path. */
export async function queueCallbackPush(row, { supabase: db }) {
  const record = buildMissedCallerRecord(row.caller);
  const listName = callbackListName();
  const callNowMode = callbackCallNowMode();
  const { data, error } = await db.from('agent_actions').insert({
    event_id: null,
    action_type: 'five9_add_records_to_list',
    target_system: 'five9',
    target_entity: 'list',
    target_id: listName,
    action_payload: {
      list_name: listName,
      field_names: record.fieldNames,
      records: [record.values],
      call_now_mode: callNowMode,
    },
    rollback_payload: {
      action_type: 'five9_delete_record_from_list',
      list_name: listName,
      field_names: ['number1'],
      records: [[record.number1]],
    },
    reasoning:
      `Missed paid caller recovery: ${record.number1} called "${row.campaign}" at ${row.last_call_at} ` +
      `(last disposition "${row.last_disposition}") and has no LP record. Dialing copy only — no LP lead ` +
      `is created (no-duplicate-LP-leads rule). Queued unarmed under the five9_add_records_to_list carve-out.`,
    rule_applied: RULE_KEY,
    confidence: 1.0,
    status: 'pending',
    requires_approval: false,
    priority: 70,
  }).select('id').single();
  if (error) throw new Error(`could not queue the Five9 push: ${error.message}`);
  return { actionId: data?.id ?? null, listName, callNowMode };
}

/** DNC status per number, in five9_check_dnc-sized batches. Throws if any batch fails. */
async function readDnc(numbers, checkDnc) {
  const onDnc = new Set();
  for (let i = 0; i < numbers.length; i += DNC_BATCH) {
    const res = await checkDnc(numbers.slice(i, i + DNC_BATCH));
    for (const n of (res?.on_dnc || [])) {
      const k = last10(n);
      if (k) onDnc.add(k);
    }
  }
  return onDnc;
}

/* --- the pass ----------------------------------------------------------- */

export async function runMissedCallerRecovery({ env = process.env, nowMs = Date.now(), deps = {} } = {}) {
  const mode = recoveryMode(env);
  if (mode === 'off') return { skipped: true, reason: 'MISSED_CALLER_RECOVERY_MODE=off', mode };

  const runSQL = deps.runSQL || defaultRunSQL;
  const db = deps.supabase || defaultSupabase;
  const checkDnc = deps.checkDnc || defaultCheckDnc;
  const findOtherLists = deps.findOtherLists || defaultFindOtherLists;
  const emitEvent = deps.emitEvent || defaultEmitEvent;
  const queuePush = deps.queuePush || queueCallbackPush;

  const campaigns = recoveryCampaigns(env);
  const counts = { candidates: 0, would_push: 0, pushed: 0, skipped_dnc: 0, skipped_ineligible: 0, alert_appt_no_lp: 0, already_logged: 0, dnc_unknown: 0 };
  const errors = [];
  const result = () => ({ ok: errors.length === 0, mode, campaigns: campaigns.length, ...counts, errors });

  let rows;
  try {
    rows = await runSQL(buildCandidatesSql(campaigns));
    if (!Array.isArray(rows)) throw new Error('candidate read returned no row set');
  } catch (err) {
    errors.push(`read: ${err.message}`);
    return result();
  }

  // The SQL already filters these; re-checking in JS keeps the rules in one
  // testable place and guards against a view that drifts.
  const allowed = new Set(campaigns);
  const candidates = rows
    .map((r) => ({ ...r, caller: last10(r.caller) }))
    .filter((r) => r.caller && allowed.has(r.campaign) && isWithinLookback(r.last_call_at, nowMs));
  counts.candidates = candidates.length;

  // DNC once, for every eligible number. Fail closed.
  const eligibleNumbers = [...new Set(candidates
    .filter((r) => classifyDisposition(r.last_disposition) === 'eligible')
    .map((r) => r.caller))];
  let onDnc = null;
  if (eligibleNumbers.length) {
    try {
      onDnc = await readDnc(eligibleNumbers, checkDnc);
    } catch (err) {
      errors.push(`dnc: ${err.message}`);
    }
  }

  const queuedThisPass = new Set();
  const log = async (row, action, detail) => {
    const id = await claim(db, row, mode, action, detail);
    if (id) counts[action] += 1; else counts.already_logged += 1;
    return id;
  };

  for (const row of candidates) {
    try {
      const kind = classifyDisposition(row.last_disposition);

      if (kind === 'appt_no_lp') {
        const id = await log(row, 'alert_appt_no_lp', 'Appointment Set on a call with no LP record — not dialled');
        if (id) {
          // bypass_filter is LOAD-BEARING (2026-09-24). No agent_rule consumes
          // this event — it is observability for a human — so it is not on the
          // intake allowlist, and without the bypass emitEvent drops it into
          // system_events_filtered and returns { filtered: true } without
          // throwing. That is exactly how the first live alert (9549727102,
          // Google PPC, 2026-09-24 03:07Z) vanished while the pass read ok.
          const emitted = await emitEvent({
            event_type: 'identity.appt_without_lp_record',
            source: 'lp_mcp',
            entity_type: 'phone',
            entity_id: row.caller,
            priority: 'high',
            payload: {
              caller: row.caller,
              campaign: row.campaign,
              last_call_at: row.last_call_at,
              last_disposition: row.last_disposition,
              calls: row.calls ?? null,
              log_id: id,
            },
            idempotency_key: `appt_without_lp_${row.caller}_${row.campaign}_${row.last_call_at}`,
            bypass_filter: true,
          }).catch((err) => { errors.push(`emit ${row.caller}: ${err.message}`); return undefined; });
          // emitEvent never throws: it returns null on a write error and
          // { filtered } when the intake filter drops the event. Either way the
          // alert did not land, and the pass must not read ok.
          if (emitted === null || emitted?.filtered) {
            errors.push(`emit ${row.caller}: identity.appt_without_lp_record did not land (${emitted?.reason || 'emitEvent returned null'})`);
          }
        }
        continue;
      }

      if (kind === 'ineligible') {
        await log(row, 'skipped_ineligible', `disposition "${row.last_disposition ?? ''}" is not a missed call`);
        continue;
      }

      if (!onDnc) { counts.dnc_unknown += 1; continue; } // unlogged → retried next pass
      if (onDnc.has(row.caller)) {
        await log(row, 'skipped_dnc', 'on the Five9 DNC list');
        continue;
      }

      if (row.recently_queued === true || queuedThisPass.has(row.caller)) {
        await log(row, 'skipped_ineligible', `already queued within ${LOOKBACK_HOURS}h`);
        continue;
      }

      const other = await findOtherLists(row.caller, { listName: callbackListName() });
      if (other?.suppress) {
        await log(row, 'skipped_ineligible', `already live in Five9 list(s): ${other.lists.join(', ')}`);
        continue;
      }
      const failOpenNote = other?.failed_open ? ' (cross-list check unreadable — failed open)' : '';

      if (mode === 'shadow') {
        const id = await log(row, 'would_push', `would queue to "${callbackListName()}"${failOpenNote}`);
        if (id) queuedThisPass.add(row.caller);
        continue;
      }

      // live: claim first, then push; release the claim if the push fails.
      const id = await log(row, 'pushed', `queued to "${callbackListName()}"${failOpenNote}`);
      if (!id) continue;
      try {
        const q = await queuePush(row, { supabase: db });
        queuedThisPass.add(row.caller);
        await db.from(LOG_TABLE)
          .update({ detail: `queued to "${q.listName}" as agent_action ${q.actionId} (callNowMode ${q.callNowMode})${failOpenNote}` })
          .eq('id', id);
      } catch (err) {
        counts.pushed -= 1;
        await db.from(LOG_TABLE).delete().eq('id', id);
        throw err;
      }
    } catch (err) {
      errors.push(`${row.caller}/${row.campaign}: ${err.message}`);
    }
  }

  return result();
}

/* --- scheduler ---------------------------------------------------------- */

let timer = null;
let running = false;

export function startMissedCallerRecoveryScheduler(env = process.env) {
  if (timer) return timer;
  if (recoveryMode(env) === 'off') {
    console.log('[MissedCallerRecovery] scheduler not started (MISSED_CALLER_RECOVERY_MODE=off)');
    return null;
  }
  const tick = async () => {
    if (running) return; // a slow pass must not overlap itself
    running = true;
    try {
      const { value: res } = await runJob(JOB_ID, () => runMissedCallerRecovery());
      if (res && res.ok === false) console.warn(`[MissedCallerRecovery] pass finished with errors: ${res.errors.join('; ')}`);
      else if (res && !res.skipped) {
        console.log(`[MissedCallerRecovery] ${res.mode}: candidates=${res.candidates} would_push=${res.would_push} pushed=${res.pushed} dnc=${res.skipped_dnc} ineligible=${res.skipped_ineligible} appt_no_lp=${res.alert_appt_no_lp}`);
      }
    } catch (err) {
      console.error(`[MissedCallerRecovery] pass threw: ${err.message}`);
    } finally {
      running = false;
    }
  };
  timer = setInterval(tick, INTERVAL_MS);
  if (typeof timer.unref === 'function') timer.unref();
  console.log(`[MissedCallerRecovery] scheduler started — mode ${recoveryMode(env)}, every 15m`);
  return timer;
}

export function stopMissedCallerRecoveryScheduler() {
  if (timer) { clearInterval(timer); timer = null; }
}
