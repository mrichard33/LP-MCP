/**
 * LP Callback Re-queue — src/services/lp-callback-requeue.js
 *
 * 2026-08-18 (John Czeropski, KE2VqAhWZ91iCdmwAmmx / prospect 452653): two
 * ai.analysis_completed events recommended callback_request with
 * requested_fulfillment=phone_call, the outbound SMS promised "someone will
 * ring you within the next few minutes" — and no call ever happened, because
 * no LP push happened. Under the architecture Mark decided (LP is the ONLY
 * writer into Five9's LP_ASAP list), the LP push IS the dial trigger:
 * LeadAdd → LP pushes to LP_ASAP → DIAL ASAP dials (~4s, measured on lead
 * 567746). This module is the machinery that makes that push correct:
 *
 *   - queue precondition: a lead already sitting in a Data dial queue with
 *     attempts remaining is already dialable — a second LeadAdd would be
 *     pure duplication. GetLeadsByCQDID across the Data queues decides.
 *   - dedup window: no second re-queue LeadAdd for the same contact within
 *     LP_REQUEUE_DEDUP_MINUTES (default 60).
 *   - address repair FIRST: never dispatch a rep to a lead with no address.
 *     A blank prospect address is repaired via UpdateProspectInfo (the only
 *     primitive that can — a re-push never repairs the prospect, proven
 *     live), read back to confirm, THEN LeadAdd.
 *   - attribution guardrail: srs_id is UNCHANGED on the re-queue row (Mark's
 *     decision — revenue/close-rate/CPS stay on the channel that paid for
 *     the lead). The re-queue is marked in zero-reporting-weight fields:
 *     sender "GHL-Agentic-Callback-Requeue" and user2
 *     "requeue:callback:<ISO8601>" (user1 carries the GHL contact id).
 *
 * F6 discipline: LP allows 60 API calls/min domain-wide, shared with the
 * sync engine. The queue sweep pages at 1000 rows with an inter-call delay
 * and the snapshot is cached for LP_REQUEUE_QUEUE_CACHE_TTL_MIN so a burst
 * of callbacks does not re-pull per event.
 */

import supabase from '../supabase.js';
import { getLeadsByCQDID, updateProspectInfo, getCustomersByProspectID, buildProspectUpdateFields } from '../lp-client.js';

export const REQUEUE_SENDER = 'GHL-Agentic-Callback-Requeue';

// The Data dial queues a still-dialable lead can sit in (handoff C3):
// 8 Data - Hot Leads <7 · 30 Data - Warm Leads <30 · 9 Data - Leads >30 ·
// 31 Data - Catch All · 26 Data - Old >180
export const DATA_QUEUE_IDS = [8, 30, 9, 31, 26];

export const REQUEUE_DEDUP_MINUTES = () =>
  Math.max(1, Number(process.env.LP_REQUEUE_DEDUP_MINUTES) || 60);
const QUEUE_CACHE_TTL_MS = () =>
  Math.max(1, Number(process.env.LP_REQUEUE_QUEUE_CACHE_TTL_MIN) || 10) * 60 * 1000;
// Per-queue page cap: 12 pages = 12,000 rows, above the largest queue
// measured 2026-08-18 (cqd 9 at 8,963). A queue deeper than the cap logs the
// truncation rather than silently under-scanning.
const MAX_PAGES_PER_QUEUE = 12;
const PAGE_SIZE = 1000;
const INTER_CALL_DELAY_MS = 1200; // ~50/min worst case, well under the 60/min shared budget

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** requeue marker written to LeadAdd user2 — queryable, carries no reporting weight */
export function buildRequeueUser2(now = new Date()) {
  return `requeue:callback:${now.toISOString()}`;
}

// ─── Queue snapshot (cached) ───────────────────────────────────────

let _queueCache = { at: 0, byLdsId: null, truncated: [] };

/** Test hook. */
export function _resetQueueCache() {
  _queueCache = { at: 0, byLdsId: null, truncated: [] };
}

/**
 * Pull the Data queues into a Map keyed by Lds_ID. Cached for the TTL.
 * deps.fetchQueuePage is injectable for tests.
 */
async function loadQueueSnapshot(deps = {}) {
  const now = Date.now();
  if (_queueCache.byLdsId && now - _queueCache.at < QUEUE_CACHE_TTL_MS()) {
    return _queueCache;
  }
  const fetchPage = deps.fetchQueuePage
    || ((cqdId, startrow, endrow) => getLeadsByCQDID(cqdId, startrow, endrow, { slow: true }));

  const byLdsId = new Map();
  const truncated = [];
  for (const cqdId of DATA_QUEUE_IDS) {
    for (let page = 0; page < MAX_PAGES_PER_QUEUE; page++) {
      const startrow = page * PAGE_SIZE + 1;
      const rows = await fetchPage(cqdId, startrow, startrow + PAGE_SIZE - 1);
      const list = Array.isArray(rows) ? rows : (rows?.rows || []);
      for (const row of list) {
        const lds = String(row.Lds_ID ?? row.lds_id ?? '');
        if (lds) byLdsId.set(lds, row);
      }
      if (list.length < PAGE_SIZE) break;
      if (page === MAX_PAGES_PER_QUEUE - 1) {
        truncated.push(cqdId);
        console.warn(`[LP-REQUEUE] queue ${cqdId} deeper than ${MAX_PAGES_PER_QUEUE * PAGE_SIZE} rows — scan truncated (lead may be present but unseen)`);
      }
      if (!deps.fetchQueuePage) await sleep(INTER_CALL_DELAY_MS);
    }
    if (!deps.fetchQueuePage) await sleep(INTER_CALL_DELAY_MS);
  }
  _queueCache = { at: now, byLdsId, truncated };
  return _queueCache;
}

/**
 * PRECONDITION (handoff C3): is any of the contact's existing LP leads
 * already sitting in a Data dial queue? Presence in a GetLeadsByCQDID feed
 * means LP still considers the lead available to be dialed — a second
 * LeadAdd would be pure duplication.
 *
 * @param {Array<string|number>} ldsIds — the prospect's existing lead ids
 * @returns {{ present: boolean, row: (Object|null), lds_id: (string|null),
 *             truncated_queues: Array<number>, cache_age_ms: number }}
 */
export async function findLeadInDataQueues(ldsIds, deps = {}) {
  const ids = (ldsIds || []).map((x) => String(x)).filter(Boolean);
  if (ids.length === 0) {
    return { present: false, row: null, lds_id: null, truncated_queues: [], cache_age_ms: 0 };
  }
  const snapshot = await loadQueueSnapshot(deps);
  for (const id of ids) {
    const row = snapshot.byLdsId.get(id);
    if (row) {
      return {
        present: true,
        row,
        lds_id: id,
        truncated_queues: snapshot.truncated,
        cache_age_ms: Date.now() - snapshot.at,
      };
    }
  }
  return {
    present: false,
    row: null,
    lds_id: null,
    truncated_queues: snapshot.truncated,
    cache_age_ms: Date.now() - snapshot.at,
  };
}

// ─── Dedup window ──────────────────────────────────────────────────

/**
 * True when a re-queue LeadAdd already went out for this contact inside the
 * dedup window. Reads agent_actions (the durable local record of every
 * re-queue — execution_result.requeued is stamped by the handler).
 */
export async function recentRequeueExists(contactId, deps = {}) {
  const db = deps.supabase || supabase;
  const windowMin = REQUEUE_DEDUP_MINUTES();
  const since = new Date(Date.now() - windowMin * 60 * 1000).toISOString();
  const { data, error } = await db
    .from('agent_actions')
    .select('id, created_at, execution_result')
    .eq('action_type', 'lp_callback_requeue')
    .eq('target_id', contactId)
    .eq('status', 'completed')
    .gte('created_at', since)
    .order('created_at', { ascending: false })
    .limit(5);
  if (error) {
    // Fail CLOSED for a dedup check: a missed dedup means a duplicate LP
    // row; a false positive means a skipped re-queue that the verification
    // sweep would surface. Duplication is the worse failure.
    console.warn(`[LP-REQUEUE] dedup lookup failed for ${contactId}: ${error.message} — treating as duplicate (fail-closed)`);
    return { duplicate: true, reason: 'dedup_lookup_error', window_minutes: windowMin };
  }
  const prior = (data || []).find((r) => r?.execution_result?.requeued === true);
  return {
    duplicate: !!prior,
    prior_action_id: prior?.id || null,
    prior_at: prior?.created_at || null,
    window_minutes: windowMin,
  };
}

// ─── Prospect address repair (F4) ──────────────────────────────────

/**
 * Repair a blank/stale prospect address from the GHL contact, then read
 * back to confirm the write took. Never sends a blank over a populated LP
 * field (buildProspectUpdateFields strips blanks). Fails LOUD — a silent
 * no-op here means a rep dispatched to a lead with no address.
 *
 * @returns {{ repaired: boolean, before: Object|null, after: Object|null }}
 */
export async function repairProspectAddress({ prospectId, ghlContact }, deps = {}) {
  const update = buildProspectUpdateFields({
    firstname: ghlContact.firstName,
    lastname:  ghlContact.lastName,
    address1:  ghlContact.address1,
    city:      ghlContact.city,
    state:     ghlContact.state,
    zip:       ghlContact.postalCode,
    phone:     ghlContact.phone ? String(ghlContact.phone).replace(/\D/g, '').slice(-10) : null,
    email:     ghlContact.email,
  });
  if (!update.address1) {
    throw new Error(`repairProspectAddress: GHL contact has no address1 — nothing to repair prospect ${prospectId} with`);
  }

  const doUpdate = deps.updateProspectInfo || updateProspectInfo;
  const doReadback = deps.getCustomersByProspectID || getCustomersByProspectID;

  let before = null;
  try {
    const beforeRes = await doReadback(prospectId);
    before = Array.isArray(beforeRes) ? (beforeRes[0] || null) : (beforeRes || null);
  } catch (err) {
    console.warn(`[LP-REQUEUE] prospect ${prospectId} pre-repair read failed (continuing): ${err.message}`);
  }

  await doUpdate({ custnumber: prospectId, updates: update });

  const afterRes = await doReadback(prospectId);
  const after = Array.isArray(afterRes) ? (afterRes[0] || null) : (afterRes || null);
  const afterAddress = String(
    after?.Address1 ?? after?.address1 ?? after?.Address ?? after?.address ?? ''
  ).trim();

  console.log(`[LP-REQUEUE] prospect ${prospectId} address repair: before="${JSON.stringify(before)?.slice(0, 200)}" after="${JSON.stringify(after)?.slice(0, 200)}"`);

  if (!afterAddress) {
    throw new Error(`repairProspectAddress: UpdateProspectInfo for ${prospectId} returned OK but read-back still shows a blank address — repair did NOT take`);
  }
  return { repaired: true, before, after };
}

export default {
  REQUEUE_SENDER,
  DATA_QUEUE_IDS,
  buildRequeueUser2,
  findLeadInDataQueues,
  recentRequeueExists,
  repairProspectAddress,
  _resetQueueCache,
};
