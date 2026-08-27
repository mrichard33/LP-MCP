/**
 * Give back the write that shadow mode quietly consumed
 * src/ci/shadow-release.js
 *
 * ── THE DEFECT ─────────────────────────────────────────────────────────────
 * claimSync inserts the ci_syncs row — carrying its UNIQUE(idempotency_key) —
 * BEFORE it knows whether the write will actually go out. That ordering is what
 * makes idempotency structural rather than a check with a race in it, and it is
 * correct.
 *
 * But it means shadow mode holds the key too. A call processed while
 * CALL_INTEL_LP_WRITES is false composes its note, stores the exact body, marks
 * the row 'shadow' — and permanently spends that call's one opportunity to
 * write. Turning the flag on later delivers NOTHING for those calls: claimSync
 * hits the constraint and returns `duplicate`, forever.
 *
 * Measured 2026-08-25, before this existed: 82 rows at target='lp'
 * status='shadow', every one tier 'high', every one carrying a composed
 * note_body, every one on a call already marked 'completed'. 82 finished
 * summaries that could never reach a customer record. The count was climbing by
 * roughly 12 an hour for as long as the worker ran with writes off.
 *
 * ── WHY RELEASING THESE IS SAFE, AND HOW THAT DIFFERS FROM THE OTHER TWO ────
 * The repo has three key-release paths now, and they rest on different proofs:
 *
 *   repair-ci-stuck-syncs   the error string proves the throw preceded the
 *                           request  (a proof about a message)
 *   repair-ci-phantom-syncs a live LP read did not contain the note
 *                           (a proof about the world, and it can be wrong if
 *                           the read is wrong)
 *   THIS ONE                the row was written on the branch that RETURNS
 *                           BEFORE the HTTP call exists
 *
 * The third is structural. In syncToLp, `status: live ? 'pending' : 'shadow'`
 * decides the row, and the very next statement is `if (!live) return`. A
 * 'shadow' row is therefore a row whose code path never reached lpClient.addNote
 * — not "probably didn't", but "the function returned first". No request means
 * no note, which means releasing the key cannot double-post.
 *
 * That is the strongest of the three proofs, and it is the only reason this
 * script is allowed to touch rows without reading LP first.
 *
 * ── THE FILTER IS STILL NARROW, BECAUSE THE PROOF IS ABOUT THE ROW ──────────
 * The guarantee holds for a row that is *genuinely* a shadow row. So every
 * property that a shadow row must have is re-asserted, and anything else is
 * refused and printed:
 *
 *   status  = 'shadow'      the branch that returns early
 *   target  = 'lp'          see the GHL note below
 *   response IS NULL        no CRM ever answered
 *   external_ref IS NULL    no CRM ever identified a note
 *
 * A row that says 'shadow' but carries a response is not a shadow row; it is
 * something we do not understand, and this refuses it.
 *
 * ── GHL IS OUT OF SCOPE, ON PURPOSE ────────────────────────────────────────
 * 177 rows sit at target='ghl' status='shadow' with exactly the same burn. They
 * are NOT released here, because CALL_INTEL_GHL_WRITES is false: releasing them
 * would re-run the sync, hit shadow again, and burn a fresh key for no gain.
 * When GHL writes are turned on, that is the moment to release them — pass
 * { target: 'ghl' } then. Recorded here so it is a dated decision rather than
 * something rediscovered in six months.
 */

import supabaseDefault from '../supabase.js';

const LOG = '[CIShadow]';

/** Only these targets may ever be released, and only one at a time. */
export const RELEASABLE_TARGETS = ['lp', 'ghl'];

/**
 * Decide whether ONE ci_syncs row is a genuine shadow row. Pure.
 *
 * Refusing is a RESULT carrying its reason rather than an exception, so every
 * refusal is printed instead of aborting the run — and so the rules are
 * testable without a database.
 *
 * @returns {{releasable: boolean, reason: string}}
 */
export function classifyShadowRow(row, target = 'lp') {
  if (row?.target !== target) {
    return { releasable: false, reason: `target '${row?.target}' is not the requested '${target}'` };
  }
  if (row?.status !== 'shadow') {
    // Includes 'synced' and 'sent_unconfirmed': those rows DID reach the API,
    // so the early-return proof does not cover them and a retry could
    // double-post.
    return { releasable: false, reason: `status '${row?.status}' is not 'shadow' — the no-request proof does not apply` };
  }
  if (row?.response != null) {
    return { releasable: false, reason: 'a CRM response is recorded — this row is not what it says it is' };
  }
  if (row?.external_ref != null) {
    return { releasable: false, reason: 'external_ref is set — a CRM identified a note for this row' };
  }
  return { releasable: true, reason: 'shadow — syncToLp returned before the request existed' };
}

/** Split a page of rows into what may be released and what is refused. Pure. */
export function planShadowRelease(rows, target = 'lp') {
  const release = [];
  const refuse = [];
  for (const row of rows || []) {
    const verdict = classifyShadowRow(row, target);
    (verdict.releasable ? release : refuse).push({ row, reason: verdict.reason });
  }
  return { release, refuse };
}

/**
 * Which parent calls go back in the queue. Pure.
 *
 * A shadow sync ADVANCES its call to 'completed' — the call did everything
 * asked of it. Releasing the key without moving the call back would leave a
 * released row nothing would ever act on.
 *
 * 'review' is included because a call can be parked for one target while the
 * other shadowed; resuming it at 'syncing' re-runs the sync stage, which is
 * where the work actually is. Anything mid-pipeline is left alone — it is
 * already moving, and shoving it backwards would re-do finished stages.
 */
export function planParentResume(calls, callIds) {
  const ids = new Set(callIds || []);
  return (calls || []).filter((c) => ids.has(c?.id) && ['completed', 'review'].includes(c?.status));
}

/** Puts a call back at the sync stage with a clean lease and no retry timer. */
export const PARENT_RESUME_PATCH = {
  // 'syncing', not 'matched': stageSync claims 'syncing'. 'matched' has meant
  // "ready to transcribe" since matching moved ahead of transcription, and
  // would put this call through analysis again to re-send one note.
  status: 'syncing',
  review_reason: null,
  status_detail: null,
  attempts: 0,
  next_retry_at: null,
  locked_until: null,
  locked_by: null,
};

/**
 * Release shadow-mode idempotency keys so those calls can write for real.
 *
 * Dry-run by DEFAULT. `execute` must be passed explicitly — the same posture as
 * every other repair path in this repo, because the output is meant to be read
 * by a human before anything moves.
 *
 * @returns {Promise<{examined, releasable, released, resumed, refused, execute, rows}>}
 */
export async function releaseShadowSyncs({
  db = supabaseDefault,
  target = 'lp',
  execute = false,
  limit = 500,
} = {}) {
  if (!RELEASABLE_TARGETS.includes(target)) throw new Error(`unknown target '${target}'`);
  if (!db) throw new Error('Supabase not configured');

  const { data: rows, error } = await db
    .from('ci_syncs')
    .select('id, call_id, target, status, external_ref, response, note_body, created_at')
    .eq('target', target)
    .eq('status', 'shadow')
    .order('created_at', { ascending: true })
    .limit(Math.max(1, limit));
  if (error) throw new Error(`ci_syncs read failed: ${error.message}`);

  const { release, refuse } = planShadowRelease(rows || [], target);
  const result = {
    target,
    execute,
    examined: (rows || []).length,
    releasable: release.length,
    refused: refuse.map(({ row, reason }) => ({ sync_id: row.id, status: row.status, reason })),
    released: 0,
    resumed: 0,
    failures: [],
    rows: release.map(({ row }) => ({
      sync_id: row.id, call_id: row.call_id, note_bytes: row.note_body?.length ?? 0,
    })),
  };

  if (!execute || !release.length) return result;

  for (const { row } of release) {
    // The read that classified this row and this delete are separate
    // statements. Re-asserting the conditions IN the delete means that if a
    // concurrent worker turned this into a real send in between, the delete
    // matches nothing — which is the outcome we want, rather than dropping the
    // record of a note that went out.
    const { data, error: delErr } = await db
      .from('ci_syncs').delete()
      .eq('id', row.id).eq('status', 'shadow').is('external_ref', null).is('response', null)
      .select('id');
    if (delErr) { result.failures.push({ id: row.id, error: delErr.message }); continue; }
    if (!data?.length) {
      result.failures.push({ id: row.id, error: 'row changed underneath the plan — left in place' });
      continue;
    }
    result.released += 1;

    // The row is gone; the fact is not.
    const { error: evErr } = await db.from('ci_events').insert({
      call_id: row.call_id,
      stage: 'sync',
      event: 'key_released',
      detail: {
        script: 'shadow-release',
        target,
        sync_id: row.id,
        was_status: 'shadow',
        note_bytes: row.note_body?.length ?? 0,
        note: 'idempotency key released — the row was written on the branch that returns before the request',
      },
    });
    if (evErr) console.warn(`${LOG} audit event insert failed for ${row.id}: ${evErr.message}`);
  }

  const callIds = [...new Set(release.map(({ row }) => row.call_id))];
  const { data: calls, error: cErr } = await db
    .from('ci_calls').select('id, five9_call_id, status, review_reason').in('id', callIds);
  if (cErr) { result.failures.push({ id: 'ci_calls', error: cErr.message }); return result; }

  for (const c of planParentResume(calls || [], callIds)) {
    const { error: upErr } = await db.from('ci_calls').update(PARENT_RESUME_PATCH).eq('id', c.id);
    if (upErr) { result.failures.push({ id: c.id, error: `parent resume failed: ${upErr.message}` }); continue; }
    result.resumed += 1;
  }

  console.log(`${LOG} released ${result.released}/${result.releasable} ${target} key(s); resumed ${result.resumed} call(s)`);
  return result;
}

export default {
  RELEASABLE_TARGETS, classifyShadowRow, planShadowRelease, planParentResume,
  PARENT_RESUME_PATCH, releaseShadowSyncs,
};
