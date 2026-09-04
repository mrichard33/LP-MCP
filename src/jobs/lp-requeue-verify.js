/**
 * LP Re-queue Verification Sweep — src/jobs/lp-requeue-verify.js
 *
 * Handoff C4 (2026-08-18): the outbound SMS says someone will ring within
 * minutes, so verify rather than assume. After a callback re-queue, confirm
 * the call actually reached a dialer.
 *
 * TWO MODES since 2026-09-04, because the re-queue has two destinations
 * (LP_REQUEUE_MODE). A five9-mode row is verified by verifyFive9Push: it
 * creates no LP lead, so there is no lds_id to wait for and the LP checks
 * below would escalate every single callback once its window expired. The
 * question asked is the same — did this reach a dialer — of whichever system
 * received it.
 *
 * LP mode (LP_REQUEUE_MODE=lp_leadadd), unchanged:
 *
 *   1. LP's ~60s inbound callback writes the newly issued lds_id back to
 *      the GHL contact (field GmAVmW6V9sekD7pVONKr). A value different from
 *      the pre-requeue lead ids proves LP processed the inbound row and the
 *      lead exists — the LP_ASAP push happens at creation (measured 4s on
 *      lead 567746), so an issued lds IS the dial trigger having fired.
 *   2. Until then, GetInboundLeadInfo by lognumber (= GHL contact id)
 *      confirms the row landed in LP's inbound queue (in flight).
 *   3. If the bounded window (LP_REQUEUE_VERIFY_WINDOW_MIN, default 12min)
 *      expires without an issued lds, fire a PRIORITY GroupMe with the
 *      contact's details so a human places the call. A promised call is
 *      never silently dropped.
 *
 * Registration: startLpRequeueVerifyScheduler() + registerLpRequeueVerifyRoutes()
 * are wired in src/index.js — PR #702's lesson: a job that is never imported
 * is dead code on main.
 */

import supabase from '../supabase.js';
import { getInboundLeadInfo } from '../lp-client.js';
import { sendGroupMeMessage } from '../groupme.js';
import { ghlFetch } from '../actions/helpers.js';

const FIELD_LP_LEAD_ID = 'GmAVmW6V9sekD7pVONKr'; // lds_id custom field

const SWEEP_INTERVAL_MS = Number(process.env.LP_REQUEUE_VERIFY_INTERVAL_MS || 2 * 60 * 1000);
const SWEEP_LOOKBACK_H = 24;
// Give LP's ~60s callback room before the first check burns API budget.
const MIN_AGE_MS = 90 * 1000;

function readCF(contact, fieldId) {
  const arr = contact?.customFields || [];
  const f = arr.find((x) => x.id === fieldId);
  return (f?.value !== undefined && f?.value !== null) ? String(f.value) : '';
}

// db is a TEST SEAM. It defaults to the module client, so every production
// call site is unchanged; without it this whole file is untestable, which is
// why it had no tests until 2026-09-04 and why the five9 branch could have
// shipped escalating every callback.
async function stampResult(actionId, executionResult, patch, db = supabase) {
  const merged = { ...(executionResult || {}), ...patch };
  const { error } = await db
    .from('agent_actions')
    .update({ execution_result: merged, updated_at: new Date().toISOString() })
    .eq('id', actionId);
  if (error) console.warn(`[RequeueVerify] stamp failed for action ${actionId}: ${error.message}`);
  return merged;
}

/**
 * Verify one completed re-queue action. Returns the verify_status written
 * ('lds_issued' | 'escalated' | null when still pending inside the window).
 */
async function verifyOne(row, deps = {}) {
  const res = row.execution_result || {};
  const contactId = row.target_id;
  const preLds = new Set((res.pre_lds_ids || []).map(String));
  const inboundId = String(res.lp_inbound_lead_id || '');
  const deadline = res.verify_deadline ? Date.parse(res.verify_deadline) : (Date.parse(row.created_at) + 12 * 60 * 1000);

  // A five9-mode re-queue creates no LP lead, so there is no lds_id to wait
  // for and steps 1-3 below would escalate EVERY push once its window expired
  // — a priority GroupMe per callback. The promise still has to be verified
  // though; skipping would drop the one guarantee this sweep exists to make.
  // So the same question is asked of the system that actually received it.
  if (res.mode === 'five9') return verifyFive9Push(row, res, deps);

  // 1. Has LP issued a NEW lds_id? (the ~60s callback writes it to GHL)
  let newLds = null;
  try {
    const fetcher = deps.ghlFetch || ghlFetch;
    const ghlRes = await fetcher('GET', `/contacts/${contactId}`);
    const current = readCF(ghlRes?.contact, FIELD_LP_LEAD_ID);
    if (current && !preLds.has(current)) newLds = current;
  } catch (err) {
    console.warn(`[RequeueVerify] GHL read failed for ${contactId}: ${err.message}`);
  }

  if (newLds) {
    const elapsedS = Math.round((Date.now() - Date.parse(row.created_at)) / 1000);
    console.log(`[RequeueVerify] ✅ ${contactId}: new lds ${newLds} issued ${elapsedS}s after re-queue (in1=${inboundId || 'n/a'})`);
    await stampResult(row.id, res, {
      verify_status: 'lds_issued',
      verified_at: new Date().toISOString(),
      new_lds_id: newLds,
      lead_to_lds_seconds: elapsedS,
    }, deps.supabase || supabase);
    return 'lds_issued';
  }

  // 2. Inside the window: confirm the inbound row landed, then keep waiting.
  if (Date.now() < deadline) {
    if (inboundId && !res.inbound_row_seen) {
      try {
        const infoFn = deps.getInboundLeadInfo || getInboundLeadInfo;
        const info = await infoFn({ lognumber: contactId });
        const rows = Array.isArray(info) ? info : (info?.data || info?.leads || info?.results || info?.items || []);
        const seen = JSON.stringify(rows || []).includes(inboundId);
        if (seen) await stampResult(row.id, res, { inbound_row_seen: true }, deps.supabase || supabase);
        else console.log(`[RequeueVerify] ${contactId}: in1 ${inboundId} not visible in inbound queue yet`);
      } catch (err) {
        console.warn(`[RequeueVerify] inbound check failed for ${contactId}: ${err.message}`);
      }
    }
    return null; // still pending
  }

  // 3. Window expired with no issued lds → a human places the call. NOW.
  console.error(`[RequeueVerify] ⛔ ${contactId}: re-queue in1=${inboundId || 'unknown'} did NOT become dialable inside the window — escalating`);
  let name = contactId, phone = 'unknown';
  try {
    const fetcher = deps.ghlFetch || ghlFetch;
    const ghlRes = await fetcher('GET', `/contacts/${contactId}`);
    const c = ghlRes?.contact || {};
    name = `${c.firstName || ''} ${c.lastName || ''}`.trim() || contactId;
    phone = c.phone || 'unknown';
  } catch {}
  const notify = deps.sendGroupMeMessage || sendGroupMeMessage;
  await notify(
    `🚨 PROMISED CALLBACK DID NOT REACH THE DIALER\n` +
    `Contact: ${name} (${contactId})\n` +
    `Phone: ${phone}\n` +
    `LP inbound id: ${inboundId || 'unknown'} | prospect: ${res.lp_prospect_id || 'unknown'}\n` +
    `The customer was told someone will ring within minutes. The LP re-queue was pushed ` +
    `${Math.round((Date.now() - Date.parse(row.created_at)) / 60000)}min ago and LP has not issued a lead.\n` +
    `→ CALL THEM MANUALLY NOW, then check why LP did not process the inbound row.`
  ).catch((err) => console.warn(`[RequeueVerify] escalation GroupMe failed: ${err.message}`));
  await stampResult(row.id, res, {
    verify_status: 'escalated',
    verified_at: new Date().toISOString(),
  }, deps.supabase || supabase);
  return 'escalated';
}

/**
 * Verify a five9-mode re-queue: did the Five9 push actually execute?
 *
 * The LP path waits on LP issuing an lds_id. Here the equivalent proof is the
 * five9_add_records_to_list row this re-queue queued reaching status
 * 'completed' — that row only completes after withFive9WriteGate has run the
 * SOAP call and assertNoRecordFailures has passed, so a completed row means
 * Five9 accepted the record.
 *
 * Same escalation as the LP path when the window expires, because the customer
 * heard the same promise either way.
 */
async function verifyFive9Push(row, res, deps = {}) {
  const db = deps.supabase || supabase;
  const contactId = row.target_id;
  const five9ActionId = res.five9_action_id;
  const deadline = res.verify_deadline ? Date.parse(res.verify_deadline) : (Date.parse(row.created_at) + 12 * 60 * 1000);

  // No id recorded means the queue insert itself is unaccounted for. Treat it
  // as unverifiable rather than assume success — the whole point is that a
  // promised call is never silently dropped.
  let status = null;
  let errorMessage = null;
  if (five9ActionId) {
    try {
      const { data } = await db
        .from('agent_actions')
        .select('status, error_message')
        .eq('id', five9ActionId)
        .limit(1);
      status = data?.[0]?.status ?? null;
      errorMessage = data?.[0]?.error_message ?? null;
    } catch (err) {
      console.warn(`[RequeueVerify] five9 action read failed for ${contactId}: ${err.message}`);
      return null; // unreadable is not a verdict; try again next sweep
    }
  }

  if (status === 'completed') {
    const elapsedS = Math.round((Date.now() - Date.parse(row.created_at)) / 1000);
    console.log(`[RequeueVerify] ✅ ${contactId}: five9 push (action ${five9ActionId}) completed ${elapsedS}s after re-queue`);
    await stampResult(row.id, res, {
      verify_status: 'five9_pushed',
      verified_at: new Date().toISOString(),
      five9_action_status: status,
      push_to_five9_seconds: elapsedS,
    }, db);
    return 'lds_issued'; // counted as a success by the sweep's tally
  }

  // Still inside the window and not yet failed → keep waiting.
  if (Date.now() < deadline && status !== 'failed') return null;

  console.error(`[RequeueVerify] ⛔ ${contactId}: five9 push (action ${five9ActionId || 'unknown'}) did not complete inside the window (status=${status || 'unknown'}) — escalating`);
  let name = contactId, phone = 'unknown';
  try {
    const fetcher = deps.ghlFetch || ghlFetch;
    const ghlRes = await fetcher('GET', `/contacts/${contactId}`);
    const c = ghlRes?.contact || {};
    name = `${c.firstName || ''} ${c.lastName || ''}`.trim() || contactId;
    phone = c.phone || 'unknown';
  } catch {}
  const notify = deps.sendGroupMeMessage || sendGroupMeMessage;
  await notify(
    `🚨 PROMISED CALLBACK DID NOT REACH THE DIALER\n` +
    `Contact: ${name} (${contactId})\n` +
    `Phone: ${phone}\n` +
    `Five9 list: ${res.list || 'Callback Request'} | CustID: ${res.cust_id || 'unknown'}\n` +
    `five9_add_records_to_list action ${five9ActionId || 'unknown'} is "${status || 'unknown'}"` +
    `${errorMessage ? ` — ${String(errorMessage).slice(0, 160)}` : ''}\n` +
    `The customer was told someone will ring within minutes and the push was queued ` +
    `${Math.round((Date.now() - Date.parse(row.created_at)) / 60000)}min ago.\n` +
    `→ CALL THEM MANUALLY NOW, then check the Five9 write gate and the action executor.`
  ).catch((err) => console.warn(`[RequeueVerify] escalation GroupMe failed: ${err.message}`));
  await stampResult(row.id, res, {
    verify_status: 'escalated',
    verified_at: new Date().toISOString(),
    five9_action_status: status,
  }, db);
  return 'escalated';
}

export async function runRequeueVerifySweep(deps = {}) {
  const db = deps.supabase || supabase;
  const since = new Date(Date.now() - SWEEP_LOOKBACK_H * 60 * 60 * 1000).toISOString();
  const { data, error } = await db
    .from('agent_actions')
    .select('id, target_id, created_at, execution_result')
    .eq('action_type', 'lp_callback_requeue')
    .eq('status', 'completed')
    .gte('created_at', since)
    .order('created_at', { ascending: true })
    .limit(50);
  if (error) {
    console.warn(`[RequeueVerify] sweep query failed: ${error.message}`);
    return { checked: 0, error: error.message };
  }

  const pending = (data || []).filter((r) => {
    const res = r.execution_result || {};
    if (res.requeued !== true) return false;
    if (res.verify_status) return false;
    return (Date.now() - Date.parse(r.created_at)) >= MIN_AGE_MS;
  });

  let issued = 0, escalated = 0, stillPending = 0;
  for (const row of pending) {
    try {
      const status = await verifyOne(row, deps);
      if (status === 'lds_issued') issued++;
      else if (status === 'escalated') escalated++;
      else stillPending++;
    } catch (err) {
      console.warn(`[RequeueVerify] verifyOne threw for action ${row.id}: ${err.message}`);
      stillPending++;
    }
  }
  if (pending.length) {
    console.log(`[RequeueVerify] sweep: ${pending.length} pending → ${issued} issued, ${escalated} escalated, ${stillPending} still waiting`);
  }
  return { checked: pending.length, issued, escalated, still_pending: stillPending };
}

let _handle = null;
export function startLpRequeueVerifyScheduler() {
  if (String(process.env.LP_REQUEUE_VERIFY_ENABLED || 'true').toLowerCase() === 'false') {
    console.log('[RequeueVerify] scheduler disabled via LP_REQUEUE_VERIFY_ENABLED=false');
    return;
  }
  if (_handle) return;
  _handle = setInterval(() => {
    runRequeueVerifySweep().catch((err) => console.error(`[RequeueVerify] sweep error: ${err.message}`));
  }, SWEEP_INTERVAL_MS);
  if (_handle.unref) _handle.unref();
  console.log(`[RequeueVerify] Scheduler armed: every ${Math.round(SWEEP_INTERVAL_MS / 1000)}s, ${SWEEP_LOOKBACK_H}h lookback`);
}

export function registerLpRequeueVerifyRoutes(app) {
  app.post('/n8n/lp-requeue/verify-sweep', async (req, res) => {
    try {
      res.json(await runRequeueVerifySweep());
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });
}

export const _internal = { verifyOne, stampResult };
export default { runRequeueVerifySweep, startLpRequeueVerifyScheduler, registerLpRequeueVerifyRoutes };
