/**
 * Agentic Reply Locks — src/services/agentic-reply-locks.js
 *
 * Enforcing per-CONTACT single-flight + cooldown + supersede for agentic
 * replies. Third protection layer alongside (not replacing):
 *
 *   outbound_locks (outbound-locks.js) — one send per (contact, trigger_id).
 *     Blind to two sends with DIFFERENT trigger_ids, which is exactly what
 *     the solo-analysis + buffer-flush double produced in the Steve Nkzhm
 *     incident (2026-07-03, 12 SMS in 8 min).
 *   agentic_consumed_messages (consumed-messages.js) — analysis-level dedup.
 *
 * Table: agentic_reply_locks (sql/migrations/2026-07-03_agentic_reply_locks.sql)
 * One row per contact_id:
 *   status 'in_flight'  — a reply job holds the slot (generating / sending)
 *   status 'sent'       — last job sent; cooldown_until gates the next send
 *
 * Semantics:
 *   - Acquire while another job is in_flight → the NEWER job supersedes: it
 *     takes over the row (job_id = new job). The displaced job discovers this
 *     via checkNotSuperseded() immediately before its GHL POST and aborts.
 *     Supersede therefore only ever cancels UNSENT work — a delivered SMS is
 *     never recalled (preempt-and-resend was tried and reverted, see
 *     outbound-locks.js header).
 *   - Acquire inside cooldown_until → blocked with retry_at; the caller
 *     reschedules and re-runs the full gate (supersession re-checked) at
 *     retry time.
 *   - in_flight rows older than LOCK_TTL_SEC are treated as crashed holders
 *     and reclaimed at acquire time.
 *
 * Fail-open on infra errors (missing table, DB hiccup) so transient issues
 * never block legitimate replies — mirrors outbound-locks.js. The enforcing
 * guarantee is for the steady-state path.
 */

import supabase from '../supabase.js';

export const LOCK_TTL_SEC = parseInt(process.env.LOCK_TTL_SEC || '120', 10);
export const MIN_AGENTIC_SEND_GAP_SEC = parseInt(process.env.MIN_AGENTIC_SEND_GAP_SEC || '90', 10);

/**
 * Pure decision core — what should an acquire attempt do given the current
 * row? No I/O; unit-tested in scripts/test-agentic-reply-locks.js.
 *
 * Returns { action, retryAt?, retryInMs?, supersededJobId? } where action is:
 *   'insert'            — no row; INSERT a fresh in_flight row
 *   'blocked_cooldown'  — cooldown_until is in the future; do not send
 *   'already_held'      — this job already holds the slot (idempotent re-acquire)
 *   'reclaim_expired'   — in_flight holder is older than TTL (crashed); take over
 *   'supersede'         — live in_flight holder; displace it (it is unsent)
 *   'reclaim_after_send'— last job sent and cooldown has passed; take the slot
 */
export function decideSlotAcquisition(row, { jobId, nowMs, ttlSec = LOCK_TTL_SEC }) {
  if (!row) return { action: 'insert' };

  const cooldownUntil = row.cooldown_until ? Date.parse(row.cooldown_until) : null;
  if (Number.isFinite(cooldownUntil) && cooldownUntil > nowMs) {
    return {
      action: 'blocked_cooldown',
      retryAt: new Date(cooldownUntil).toISOString(),
      retryInMs: cooldownUntil - nowMs,
    };
  }

  if (row.status === 'in_flight') {
    if (row.job_id === jobId) return { action: 'already_held' };
    const lockedAtMs = Date.parse(row.locked_at);
    const expired = !Number.isFinite(lockedAtMs) || (nowMs - lockedAtMs) > ttlSec * 1000;
    if (expired) return { action: 'reclaim_expired' };
    return { action: 'supersede', supersededJobId: row.job_id };
  }

  // status === 'sent' with cooldown passed (or never set)
  return { action: 'reclaim_after_send' };
}

async function readSlot(contact_id) {
  const { data, error } = await supabase
    .from('agentic_reply_locks')
    .select('contact_id, job_id, status, holder, trigger_id, superseded_by, locked_at, cooldown_until')
    .eq('contact_id', contact_id)
    .maybeSingle();
  if (error) throw new Error(error.message);
  return data || null;
}

/**
 * Acquire the per-contact agentic reply slot.
 *
 * Returns:
 *   { acquired: true,  superseded_job_id? , reason? }
 *   { acquired: false, reason: 'cooldown', retry_at, retry_in_ms }
 *
 * Take-over of an existing row is a conditional UPDATE keyed on the previous
 * job_id, so two racing acquirers cannot both win; the loser re-reads and
 * re-decides (bounded retries), then fails open.
 */
export async function acquireAgenticSlot({ contact_id, job_id, trigger_id, holder }) {
  if (!supabase) return { acquired: true, reason: 'no_supabase' };
  if (!contact_id || !job_id) return { acquired: true, reason: 'missing_params_open' };

  const nowIso = () => new Date().toISOString();

  for (let attempt = 0; attempt < 3; attempt++) {
    let row;
    try {
      row = await readSlot(contact_id);
    } catch (err) {
      console.error(`[agentic-reply-locks] read error for ${contact_id}: ${err.message}`);
      return { acquired: true, reason: 'read_error_open' };
    }

    const decision = decideSlotAcquisition(row, { jobId: job_id, nowMs: Date.now() });

    if (decision.action === 'blocked_cooldown') {
      return {
        acquired: false,
        reason: 'cooldown',
        retry_at: decision.retryAt,
        retry_in_ms: decision.retryInMs,
      };
    }

    if (decision.action === 'already_held') {
      return { acquired: true, reason: 'already_held' };
    }

    if (decision.action === 'insert') {
      const { error } = await supabase.from('agentic_reply_locks').insert({
        contact_id: String(contact_id),
        job_id: String(job_id),
        status: 'in_flight',
        holder: holder || 'agent_executor',
        trigger_id: trigger_id ? String(trigger_id) : null,
        superseded_by: null,
        locked_at: nowIso(),
        cooldown_until: null,
        updated_at: nowIso(),
      });
      if (!error) return { acquired: true };
      if (error.code === '23505') continue; // lost the insert race — re-read and re-decide
      console.error(`[agentic-reply-locks] insert error for ${contact_id}: ${error.message}`);
      return { acquired: true, reason: 'insert_error_open' };
    }

    // supersede / reclaim_expired / reclaim_after_send — take over the row,
    // conditional on the job_id we just read so a concurrent taker loses.
    const superseding = decision.action === 'supersede';
    const { data: updated, error } = await supabase
      .from('agentic_reply_locks')
      .update({
        job_id: String(job_id),
        status: 'in_flight',
        holder: holder || 'agent_executor',
        trigger_id: trigger_id ? String(trigger_id) : null,
        superseded_by: superseding ? String(job_id) : null,
        locked_at: nowIso(),
        cooldown_until: null,
        updated_at: nowIso(),
      })
      .eq('contact_id', contact_id)
      .eq('job_id', row.job_id)
      .select('contact_id');

    if (error) {
      console.error(`[agentic-reply-locks] takeover error for ${contact_id}: ${error.message}`);
      return { acquired: true, reason: 'takeover_error_open' };
    }
    if (updated && updated.length > 0) {
      if (superseding) {
        console.log(`[agentic-reply-locks] job ${job_id} superseded unsent job ${decision.supersededJobId} for contact ${contact_id}`);
        return { acquired: true, superseded_job_id: decision.supersededJobId };
      }
      return { acquired: true, reason: decision.action };
    }
    // 0 rows updated → someone else took the slot between read and write; retry
  }

  console.warn(`[agentic-reply-locks] acquire contention exhausted for ${contact_id} — failing open`);
  return { acquired: true, reason: 'contention_open' };
}

/**
 * True when this job still owns the slot. Called immediately before the GHL
 * POST — if a newer job took the slot while we were generating, our reply is
 * stale and UNSENT, so it is safe (and required) to abort.
 * Fail-open: infra errors report not-superseded so a DB hiccup can't block.
 */
export async function checkNotSuperseded(contact_id, job_id) {
  if (!supabase || !contact_id || !job_id) return { superseded: false, reason: 'open' };
  try {
    const row = await readSlot(contact_id);
    if (!row) return { superseded: false, reason: 'no_row' };
    if (String(row.job_id) !== String(job_id)) {
      return { superseded: true, by: row.job_id };
    }
    return { superseded: false };
  } catch (err) {
    console.error(`[agentic-reply-locks] supersession check error for ${contact_id}: ${err.message}`);
    return { superseded: false, reason: 'check_error_open' };
  }
}

/**
 * Mark a successful send: status 'sent' + arm the cooldown. Conditional on
 * job_id — if a newer job displaced us after our POST (rare race), leave its
 * in_flight row alone and log loudly for forensics.
 */
export async function commitAgenticSend(contact_id, job_id, gapSec = MIN_AGENTIC_SEND_GAP_SEC) {
  if (!supabase || !contact_id || !job_id) return;
  const { data, error } = await supabase
    .from('agentic_reply_locks')
    .update({
      status: 'sent',
      cooldown_until: new Date(Date.now() + gapSec * 1000).toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq('contact_id', contact_id)
    .eq('job_id', String(job_id))
    .select('contact_id');
  if (error) {
    console.error(`[agentic-reply-locks] commit error for ${contact_id}: ${error.message}`);
  } else if (!data || data.length === 0) {
    console.warn(`[agentic-reply-locks] commit found no in_flight row for contact ${contact_id} job ${job_id} — a newer job superseded after our POST`);
  }
}

/**
 * Release a failed (never sent) job's slot so a retry or a newer job can
 * acquire immediately. No cooldown is armed — nothing was sent. Conditional
 * on job_id + in_flight so we never delete a superseding job's row or a
 * committed 'sent' row.
 */
export async function releaseAgenticSlot(contact_id, job_id) {
  if (!supabase || !contact_id || !job_id) return;
  const { error } = await supabase
    .from('agentic_reply_locks')
    .delete()
    .eq('contact_id', contact_id)
    .eq('job_id', String(job_id))
    .eq('status', 'in_flight');
  if (error) console.error(`[agentic-reply-locks] release error for ${contact_id}: ${error.message}`);
}

/**
 * Read-only peek for /internal/check-outbound-lock (HL MCP / external callers).
 */
export async function checkAgenticSlot(contact_id) {
  if (!supabase || !contact_id) return { held: false };
  try {
    const row = await readSlot(contact_id);
    if (!row) return { held: false };
    const nowMs = Date.now();
    const lockedAtMs = Date.parse(row.locked_at);
    const inFlight = row.status === 'in_flight'
      && Number.isFinite(lockedAtMs)
      && (nowMs - lockedAtMs) <= LOCK_TTL_SEC * 1000;
    const cooldownUntil = row.cooldown_until ? Date.parse(row.cooldown_until) : null;
    const coolingDown = Number.isFinite(cooldownUntil) && cooldownUntil > nowMs;
    return {
      held: inFlight || coolingDown,
      status: row.status,
      job_id: row.job_id,
      holder: row.holder,
      in_flight: inFlight,
      cooling_down: coolingDown,
      cooldown_until: row.cooldown_until,
      locked_at: row.locked_at,
    };
  } catch (err) {
    console.error(`[agentic-reply-locks] peek error for ${contact_id}: ${err.message}`);
    return { held: false, reason: 'peek_error_open' };
  }
}
