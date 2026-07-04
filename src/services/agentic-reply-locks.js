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
 * Table: agentic_reply_locks (sql/migrations/2026-07-03_agentic_reply_locks.sql
 * + 2026-07-03_agentic_send_hotfix.sql)
 * One row per contact_id:
 *   status 'in_flight'  — a reply job holds the slot (generating / sending)
 *   status 'sent'       — last job sent; cooldown_until gates the next send;
 *                         last_message_id/last_conversation_id record WHAT
 *                         was sent (the "sent marker", written at GHL 2xx)
 *
 * 2026-07-03 evening hotfix (dropped-replies incident, contact
 * 0kk3xz6XatILy8jajymX):
 *   - Acquisition is now ATOMIC + RE-ENTRANT via the acquire_agentic_reply_lock
 *     Postgres function (row-locked; a job is never blocked or superseded by
 *     its own lock). The previous read-then-conditional-write loop remains as
 *     the deploy-before-DDL fallback, mirroring the claim_agent_actions
 *     pattern in src/actions/index.js.
 *   - 'already_sent': a retry of a job whose prior (zombie) attempt already
 *     delivered finds the sent marker and completes as a dedup — the
 *     delivered-but-watchdog-timed-out send can no longer double-send.
 *   - Newest-job-wins: an OLDER numeric job meeting a newer live in_flight
 *     holder yields (terminal superseded_by_newer_job) instead of displacing
 *     the newer reply.
 *   - superseded_by now records the DISPLACED job's id (was: the new job's
 *     own id — the incident's self-referential 165923/165923 row).
 *   - Per-acquisition holder token (holder#nonce): releaseAgenticSlot is
 *     conditional on it, so a zombie attempt's late release cannot delete a
 *     newer attempt's row.
 *
 * Semantics otherwise unchanged:
 *   - Acquire while another (older) job is in_flight → the NEWER job
 *     supersedes; the displaced job aborts at checkNotSuperseded() before its
 *     GHL POST. Supersede only ever cancels UNSENT work.
 *   - Acquire inside cooldown_until → blocked with retry_at; the caller
 *     defers (DB-persisted retry_at) and the re-run repeats the full gate.
 *   - in_flight rows older than LOCK_TTL_SEC are reclaimed at acquire time
 *     (and swept by the heartbeat stale-lock reaper).
 *
 * Fail-open on infra errors (missing table/RPC, DB hiccup) so transient
 * issues never block legitimate replies — mirrors outbound-locks.js.
 */

import crypto from 'crypto';
import supabase from '../supabase.js';

export const LOCK_TTL_SEC = parseInt(process.env.LOCK_TTL_SEC || '120', 10);
export const MIN_AGENTIC_SEND_GAP_SEC = parseInt(process.env.MIN_AGENTIC_SEND_GAP_SEC || '90', 10);

// Matches the claim_agent_actions fallback detection in src/actions/index.js.
const RPC_MISSING_RE = /does not exist|could not find|undefined function|42883|schema cache/i;
const COLUMN_MISSING_RE = /column|42703|schema cache/i;

function makeHolderToken(holder) {
  return `${holder || 'agent_executor'}#${crypto.randomBytes(4).toString('hex')}`;
}

/** Numeric-or-null view of a job id ("165923" → 165923, "job-abc" → null). */
function numericJobId(id) {
  return /^[0-9]+$/.test(String(id ?? '')) ? Number(id) : null;
}

/**
 * Pure decision core — what should an acquire attempt do given the current
 * row? No I/O; unit-tested in scripts/test-agentic-reply-locks.js. Mirrors
 * the acquire_agentic_reply_lock RPC's branch order exactly:
 *
 *   'insert'            — no row; INSERT a fresh in_flight row
 *   'already_held'      — this job already holds the slot (re-entrant)
 *   'already_sent'      — this job's prior attempt committed a send (dedup)
 *   'blocked_cooldown'  — cooldown_until is in the future; defer
 *   'yield_to_newer'    — a NEWER numeric job holds the slot live; this
 *                         older job is stale and must terminal-skip
 *   'supersede'         — older live in_flight holder; displace it (unsent)
 *   'reclaim_expired'   — in_flight holder older than TTL (crashed); take over
 *   'reclaim_after_send'— last job sent and cooldown has passed; take the slot
 */
export function decideSlotAcquisition(row, { jobId, nowMs, ttlSec = LOCK_TTL_SEC }) {
  if (!row) return { action: 'insert' };

  if (row.status === 'in_flight' && String(row.job_id) === String(jobId)) {
    return { action: 'already_held' };
  }
  if (row.status === 'sent' && String(row.job_id) === String(jobId)) {
    return {
      action: 'already_sent',
      messageId: row.last_message_id ?? null,
      conversationId: row.last_conversation_id ?? null,
    };
  }

  const cooldownUntil = row.cooldown_until ? Date.parse(row.cooldown_until) : null;
  if (Number.isFinite(cooldownUntil) && cooldownUntil > nowMs) {
    return {
      action: 'blocked_cooldown',
      retryAt: new Date(cooldownUntil).toISOString(),
      retryInMs: cooldownUntil - nowMs,
    };
  }

  if (row.status === 'in_flight') {
    const lockedAtMs = Date.parse(row.locked_at);
    const expired = !Number.isFinite(lockedAtMs) || (nowMs - lockedAtMs) > ttlSec * 1000;
    if (expired) return { action: 'reclaim_expired' };
    const mine = numericJobId(jobId);
    const theirs = numericJobId(row.job_id);
    if (mine !== null && theirs !== null && mine < theirs) {
      return { action: 'yield_to_newer', newerJobId: row.job_id };
    }
    return { action: 'supersede', supersededJobId: row.job_id };
  }

  // status === 'sent' with cooldown passed (or never set)
  return { action: 'reclaim_after_send' };
}

async function readSlot(contact_id) {
  const extended = 'contact_id, job_id, status, holder, trigger_id, superseded_by, locked_at, cooldown_until, last_message_id, last_conversation_id';
  const legacy = 'contact_id, job_id, status, holder, trigger_id, superseded_by, locked_at, cooldown_until';
  let { data, error } = await supabase
    .from('agentic_reply_locks')
    .select(extended)
    .eq('contact_id', contact_id)
    .maybeSingle();
  if (error && COLUMN_MISSING_RE.test(error.message || '')) {
    // DDL-grace: marker columns not applied yet
    ({ data, error } = await supabase
      .from('agentic_reply_locks')
      .select(legacy)
      .eq('contact_id', contact_id)
      .maybeSingle());
  }
  if (error) throw new Error(error.message);
  return data || null;
}

/**
 * Acquire the per-contact agentic reply slot.
 *
 * Returns one of:
 *   { acquired: true,  holder_token, superseded_job_id?, reason? }
 *   { acquired: false, reason: 'cooldown', retry_at, retry_in_ms }
 *   { acquired: false, reason: 'already_sent', message_id, conversation_id }
 *   { acquired: false, reason: 'yield_to_newer', newer_job_id }
 *
 * Primary path: the atomic acquire_agentic_reply_lock RPC (row-locked,
 * re-entrant). Fallback (RPC not yet applied — deploy-before-DDL grace):
 * the historical read-then-conditional-write loop, with the same decision
 * semantics via decideSlotAcquisition.
 */
export async function acquireAgenticSlot({ contact_id, job_id, trigger_id, holder }) {
  if (!supabase) return { acquired: true, reason: 'no_supabase' };
  if (!contact_id || !job_id) return { acquired: true, reason: 'missing_params_open' };

  const holderToken = makeHolderToken(holder);

  const { data, error } = await supabase.rpc('acquire_agentic_reply_lock', {
    p_contact_id: String(contact_id),
    p_job_id: String(job_id),
    p_trigger_id: trigger_id ? String(trigger_id) : null,
    p_holder: holderToken,
    p_ttl_sec: LOCK_TTL_SEC,
  });

  if (!error) {
    return mapRpcOutcome(data, { contact_id, job_id, holderToken });
  }
  if (!RPC_MISSING_RE.test(error.message || '')) {
    console.error(`[agentic-reply-locks] acquire RPC error for ${contact_id}: ${error.message} — failing open`);
    return { acquired: true, reason: 'rpc_error_open', holder_token: holderToken };
  }
  console.warn('[agentic-reply-locks] acquire_agentic_reply_lock RPC missing — using legacy read-then-write fallback. Apply sql/migrations/2026-07-03_agentic_send_hotfix.sql.');
  return acquireAgenticSlotLegacy({ contact_id, job_id, trigger_id, holderToken });
}

function mapRpcOutcome(data, { contact_id, job_id, holderToken }) {
  const out = (data && typeof data === 'object') ? data : {};
  switch (out.outcome) {
    case 'acquired':
    case 'reclaim_expired':
    case 'reclaim_after_send':
      return { acquired: true, reason: out.outcome === 'acquired' ? undefined : out.outcome, holder_token: holderToken };
    case 'already_held':
      return { acquired: true, reason: 'already_held', holder_token: holderToken };
    case 'superseded':
      console.log(`[agentic-reply-locks] job ${job_id} superseded unsent job ${out.superseded_job_id} for contact ${contact_id}`);
      return { acquired: true, superseded_job_id: out.superseded_job_id, holder_token: holderToken };
    case 'already_sent':
      return {
        acquired: false,
        reason: 'already_sent',
        message_id: out.message_id ?? null,
        conversation_id: out.conversation_id ?? null,
      };
    case 'cooldown': {
      const retryAtMs = Date.parse(out.retry_at);
      return {
        acquired: false,
        reason: 'cooldown',
        retry_at: out.retry_at,
        retry_in_ms: Number.isFinite(retryAtMs) ? Math.max(0, retryAtMs - Date.now()) : null,
      };
    }
    case 'yield_to_newer':
      return { acquired: false, reason: 'yield_to_newer', newer_job_id: out.newer_job_id };
    default:
      console.error(`[agentic-reply-locks] unexpected acquire outcome ${JSON.stringify(out)} for ${contact_id} — failing open`);
      return { acquired: true, reason: 'unknown_outcome_open', holder_token: holderToken };
  }
}

/**
 * Legacy acquisition loop (pre-RPC). Take-over is a conditional UPDATE keyed
 * on the previously read job_id so two racing acquirers cannot both win; the
 * loser re-reads and re-decides (bounded retries), then fails open.
 */
async function acquireAgenticSlotLegacy({ contact_id, job_id, trigger_id, holderToken }) {
  const nowIso = () => new Date().toISOString();

  for (let attempt = 0; attempt < 3; attempt++) {
    let row;
    try {
      row = await readSlot(contact_id);
    } catch (err) {
      console.error(`[agentic-reply-locks] read error for ${contact_id}: ${err.message}`);
      return { acquired: true, reason: 'read_error_open', holder_token: holderToken };
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
    if (decision.action === 'already_sent') {
      return {
        acquired: false,
        reason: 'already_sent',
        message_id: decision.messageId,
        conversation_id: decision.conversationId,
      };
    }
    if (decision.action === 'yield_to_newer') {
      return { acquired: false, reason: 'yield_to_newer', newer_job_id: decision.newerJobId };
    }

    if (decision.action === 'insert') {
      const { error } = await supabase.from('agentic_reply_locks').insert({
        contact_id: String(contact_id),
        job_id: String(job_id),
        status: 'in_flight',
        holder: holderToken,
        trigger_id: trigger_id ? String(trigger_id) : null,
        superseded_by: null,
        locked_at: nowIso(),
        cooldown_until: null,
        updated_at: nowIso(),
      });
      if (!error) return { acquired: true, holder_token: holderToken };
      if (error.code === '23505') continue; // lost the insert race — re-read and re-decide
      console.error(`[agentic-reply-locks] insert error for ${contact_id}: ${error.message}`);
      return { acquired: true, reason: 'insert_error_open', holder_token: holderToken };
    }

    // already_held / supersede / reclaim_expired / reclaim_after_send — take
    // over (or refresh) the row, conditional on the job_id we just read so a
    // concurrent taker loses. already_held refreshes holder to THIS attempt's
    // token so a zombie's late conditional release no-ops.
    const superseding = decision.action === 'supersede';
    const patch = {
      job_id: String(job_id),
      status: 'in_flight',
      holder: holderToken,
      trigger_id: trigger_id ? String(trigger_id) : null,
      // Record the DISPLACED job's id (2026-07-03 hotfix — was the new job's
      // own id, producing self-referential forensics rows).
      superseded_by: superseding ? String(row.job_id) : null,
      locked_at: nowIso(),
      cooldown_until: null,
      updated_at: nowIso(),
    };
    let { data: updated, error } = await supabase
      .from('agentic_reply_locks')
      .update({ ...patch, last_message_id: null, last_conversation_id: null })
      .eq('contact_id', contact_id)
      .eq('job_id', row.job_id)
      .select('contact_id');
    if (error && COLUMN_MISSING_RE.test(error.message || '')) {
      ({ data: updated, error } = await supabase
        .from('agentic_reply_locks')
        .update(patch)
        .eq('contact_id', contact_id)
        .eq('job_id', row.job_id)
        .select('contact_id'));
    }

    if (error) {
      console.error(`[agentic-reply-locks] takeover error for ${contact_id}: ${error.message}`);
      return { acquired: true, reason: 'takeover_error_open', holder_token: holderToken };
    }
    if (updated && updated.length > 0) {
      if (superseding) {
        console.log(`[agentic-reply-locks] job ${job_id} superseded unsent job ${decision.supersededJobId} for contact ${contact_id}`);
        return { acquired: true, superseded_job_id: decision.supersededJobId, holder_token: holderToken };
      }
      return { acquired: true, reason: decision.action === 'already_held' ? 'already_held' : decision.action, holder_token: holderToken };
    }
    // 0 rows updated → someone else took the slot between read and write; retry
  }

  console.warn(`[agentic-reply-locks] acquire contention exhausted for ${contact_id} — failing open`);
  return { acquired: true, reason: 'contention_open', holder_token: holderToken };
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
 * Mark a successful send: status 'sent' + arm the cooldown + persist the sent
 * marker (message/conversation ids). Called from executeSendMessage
 * IMMEDIATELY after the GHL 2xx — before any post-send work — so a
 * watchdog-orphaned (zombie) attempt's delivery is durably visible to its
 * retry, which then completes as a dedup instead of re-sending.
 *
 * Conditional on job_id — if a newer job displaced us after our POST (rare
 * race), leave its in_flight row alone and log loudly for forensics.
 * Deliberately NOT conditional on the holder token: a zombie's commit landing
 * is desirable (it IS the sent marker).
 */
export async function commitAgenticSend(contact_id, job_id, opts = {}) {
  if (!supabase || !contact_id || !job_id) return;
  const gapSec = Number.isFinite(opts.gapSec) ? opts.gapSec
    : (Number.isFinite(opts) ? opts : MIN_AGENTIC_SEND_GAP_SEC); // tolerate legacy numeric 3rd arg
  const base = {
    status: 'sent',
    cooldown_until: new Date(Date.now() + gapSec * 1000).toISOString(),
    updated_at: new Date().toISOString(),
  };
  const marker = {
    last_message_id: opts.message_id ? String(opts.message_id) : null,
    last_conversation_id: opts.conversation_id ? String(opts.conversation_id) : null,
  };
  let { data, error } = await supabase
    .from('agentic_reply_locks')
    .update({ ...base, ...marker })
    .eq('contact_id', contact_id)
    .eq('job_id', String(job_id))
    .select('contact_id');
  if (error && COLUMN_MISSING_RE.test(error.message || '')) {
    ({ data, error } = await supabase
      .from('agentic_reply_locks')
      .update(base)
      .eq('contact_id', contact_id)
      .eq('job_id', String(job_id))
      .select('contact_id'));
  }
  if (error) {
    console.error(`[agentic-reply-locks] commit error for ${contact_id}: ${error.message}`);
  } else if (!data || data.length === 0) {
    console.warn(`[agentic-reply-locks] commit found no in_flight row for contact ${contact_id} job ${job_id} — a newer job superseded after our POST`);
  }
}

/**
 * Release a failed (never sent) job's slot so a retry or a newer job can
 * acquire immediately. No cooldown is armed — nothing was sent. Conditional
 * on job_id + in_flight (+ holder token when provided) so we never delete a
 * superseding job's row, a committed 'sent' row, or — with the token — a
 * newer attempt of our own job (zombie-release guard, 2026-07-03 hotfix).
 */
export async function releaseAgenticSlot(contact_id, job_id, opts = {}) {
  if (!supabase || !contact_id || !job_id) return;
  let query = supabase
    .from('agentic_reply_locks')
    .delete()
    .eq('contact_id', contact_id)
    .eq('job_id', String(job_id))
    .eq('status', 'in_flight');
  if (opts.holderToken) query = query.eq('holder', opts.holderToken);
  const { error } = await query;
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
      last_message_id: row.last_message_id ?? null,
    };
  } catch (err) {
    console.error(`[agentic-reply-locks] peek error for ${contact_id}: ${err.message}`);
    return { held: false, reason: 'peek_error_open' };
  }
}
