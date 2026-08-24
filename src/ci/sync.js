/**
 * Call Intelligence — CRM sync — src/ci/sync.js
 *
 * §5/§9. The ONLY code in this subsystem that can write to a customer record.
 * Everything upstream produces data; this posts it to Lead Perfection and
 * GoHighLevel.
 *
 * ── THE SHAPE OF THE SAFETY ────────────────────────────────────────────────
 * There is exactly ONE place per target where an HTTP call can happen, and it
 * sits behind liveWrites(target) from config.js. That function is the single
 * authority: shadow mode, or the target's flag being off, returns false and
 * nothing is sent. No write site reads CALL_INTEL_* env directly — if a second
 * path to the API ever appears, the gate stops being a gate.
 *
 * In shadow mode this module still does ALL of its work: composes the note,
 * inserts the ci_syncs row, stores note_body, and marks the row 'shadow'. What
 * it does not do is make the request. That means QA reads exactly the text
 * that would have gone live, and flipping the flag changes one thing only —
 * whether the POST happens.
 *
 * ── IDEMPOTENCY IS A DATABASE CONSTRAINT, NOT A CHECK ──────────────────────
 * The ci_syncs row is inserted BEFORE the API call, carrying a UNIQUE
 * idempotency_key. A duplicate attempt therefore fails on the constraint at
 * insert time and never reaches the API. Checking "have we sent this already?"
 * in application code would leave a window between the check and the send;
 * the constraint has no window.
 *
 * ── THE TWO TARGETS ARE INDEPENDENT ────────────────────────────────────────
 * An LP failure must not prevent or roll back the GHL note, and vice versa.
 * They are separate rows, separate keys, separate retries. A shared failure
 * path would mean one CRM being down silently costs us the note in the other.
 */

import supabase from '../supabase.js';
import { getConfig, liveWrites, allowProbableLp, ghlCreateEnabled, nextRetryAt } from './config.js';
import { composeNote, idempotencyKey } from './notes.js';
import { WRITABLE_TIERS } from './match.js';

const LOG = '[CISync]';

/** Postgres unique-violation. A duplicate write attempt, not an outage. */
const UNIQUE_VIOLATION = '23505';

/**
 * May this match tier be written to this target?
 *
 * `exact` and `high` always qualify. `probable` is additionally gated behind
 * CALL_INTEL_ALLOW_PROBABLE, and for LP only — §8 never permits a probable
 * write to GHL, because a wrong GHL contact can also trigger automation.
 */
export function tierWritable(tier, target, cfg = getConfig()) {
  if (!WRITABLE_TIERS.has(tier)) return false;
  if (tier !== 'probable') return true;
  return target === 'lp' && allowProbableLp(cfg);
}

/**
 * Record the intent to write, and return whether to proceed.
 *
 * Inserting first is what makes the unique key load-bearing: the row exists
 * before any request, so a concurrent or repeated attempt collides here rather
 * than at the CRM.
 *
 * @returns {Promise<{ok: boolean, row?: object, reason?: string}>}
 */
export async function claimSync(db, { callId, target, noteBody, request, status }) {
  const key = idempotencyKey(callId, target);
  const { data, error } = await db
    .from('ci_syncs')
    .insert({
      call_id: callId,
      target,
      status,
      idempotency_key: key,
      note_body: noteBody,
      request: request ?? null,
    })
    .select()
    .maybeSingle();

  if (error) {
    if (error.code === UNIQUE_VIOLATION) {
      // Already claimed. This is the constraint doing its job — a second note
      // on a customer's record is exactly what it exists to prevent.
      console.log(`${LOG} call=${callId} target=${target} already synced (idempotency_key held)`);
      return { ok: false, reason: 'duplicate' };
    }
    throw new Error(`ci_syncs insert failed: ${error.message}`);
  }
  return { ok: true, row: data };
}

/** Mark a claimed sync row as delivered. */
export async function markSynced(db, id, { externalRef = null, response = null } = {}) {
  const { error } = await db.from('ci_syncs').update({
    status: 'synced',
    external_ref: externalRef,
    response: response ?? null,
    error: null,
    synced_at: new Date().toISOString(),
  }).eq('id', id);
  if (error) throw new Error(`ci_syncs update failed: ${error.message}`);
}

/**
 * Record a delivery failure with backoff.
 *
 * The row stays — a failed sync is a fact about a call and belongs in the
 * audit trail. It is NOT deleted so the write can be retried: deleting it
 * would release the idempotency key, and a retry after a request that actually
 * landed would double-post.
 */
export async function markSyncFailed(db, row, err, cfg = getConfig()) {
  const attempts = (row.attempts || 0) + 1;
  const terminal = attempts >= cfg.maxAttempts;
  const { error } = await db.from('ci_syncs').update({
    status: terminal ? 'failed' : 'pending',
    error: String(err?.message || err).slice(0, 500),
    attempts,
  }).eq('id', row.id);
  if (error) console.warn(`${LOG} could not record sync failure: ${error.message}`);
  return { terminal, attempts, retryAt: terminal ? null : nextRetryAt(attempts) };
}

/**
 * Push the note to Lead Perfection.
 *
 * @param {object} opts.lpClient  injected { addNote } — real client in prod
 */
export async function syncToLp(call, summary, match, { db = supabase, cfg = getConfig(), lpClient, link = null } = {}) {
  const target = 'lp';
  const rectype = match?.evidence?.note_target?.rectype ?? null;
  const recid = match?.evidence?.note_target?.recid ?? null;

  if (!rectype || !recid) {
    return { target, skipped: true, reason: 'no_note_target' };
  }
  if (!tierWritable(match.tier, target, cfg)) {
    return { target, skipped: true, reason: `tier_${match.tier}_not_writable` };
  }

  const noteBody = composeNote(call, summary, link);
  const live = liveWrites(target, cfg);
  const request = { rectype, recid, nct_id: cfg.lpNoteCategoryId };

  const claim = await claimSync(db, {
    callId: call.id,
    target,
    noteBody,
    request,
    status: live ? 'pending' : 'shadow',
  });
  if (!claim.ok) return { target, skipped: true, reason: claim.reason };

  if (!live) {
    // Shadow: the row and the exact body are stored, and no HTTP happens.
    console.log(`${LOG} call=${call.id} target=lp SHADOW (${rectype}/${recid}) — note stored, not sent`);
    return { target, shadow: true, note_bytes: noteBody.length };
  }

  try {
    const resp = await lpClient.addNote({ rectype, recid, notes: noteBody, categoryId: cfg.lpNoteCategoryId });
    await markSynced(db, claim.row.id, { externalRef: extractLpNoteId(resp), response: shapeOf(resp) });
    console.log(`${LOG} call=${call.id} target=lp synced (${rectype}/${recid})`);
    return { target, synced: true };
  } catch (err) {
    const f = await markSyncFailed(db, claim.row, err, cfg);
    console.error(`${LOG} call=${call.id} target=lp FAILED (attempt ${f.attempts}): ${err.message}`);
    return { target, failed: true, terminal: f.terminal, error: err.message };
  }
}

/**
 * Push the note to GoHighLevel.
 *
 * Contact creation is a THIRD gate on top of live+ghlWrites, because creating
 * a contact from a call that matched nothing is the duplicate-contact risk
 * §14.4 calls the top danger. Without it, a missed match quietly becomes a new
 * contact record rather than a review item.
 */
export async function syncToGhl(call, summary, match, { db = supabase, cfg = getConfig(), ghlClient, link = null } = {}) {
  const target = 'ghl';
  const contactId = match?.ghl_contact_id ?? null;

  if (!contactId) {
    // No contact and creation is not enabled → record the skip with its
    // reason rather than silently doing nothing.
    const reason = ghlCreateEnabled(cfg) ? 'no_contact_creation_not_implemented' : 'no_ghl_contact';
    return { target, skipped: true, reason };
  }
  if (!tierWritable(match.tier, target, cfg)) {
    return { target, skipped: true, reason: `tier_${match.tier}_not_writable` };
  }

  const noteBody = composeNote(call, summary, link);
  const live = liveWrites(target, cfg);

  const claim = await claimSync(db, {
    callId: call.id,
    target,
    noteBody,
    request: { contact_id: contactId },
    status: live ? 'pending' : 'shadow',
  });
  if (!claim.ok) return { target, skipped: true, reason: claim.reason };

  if (!live) {
    console.log(`${LOG} call=${call.id} target=ghl SHADOW — note stored, not sent`);
    return { target, shadow: true, note_bytes: noteBody.length };
  }

  try {
    const resp = await ghlClient.addGHLNote(contactId, noteBody);
    await markSynced(db, claim.row.id, { externalRef: resp?.id ?? resp?.note?.id ?? null, response: shapeOf(resp) });
    console.log(`${LOG} call=${call.id} target=ghl synced`);
    return { target, synced: true };
  } catch (err) {
    const f = await markSyncFailed(db, claim.row, err, cfg);
    console.error(`${LOG} call=${call.id} target=ghl FAILED (attempt ${f.attempts}): ${err.message}`);
    return { target, failed: true, terminal: f.terminal, error: err.message };
  }
}

/**
 * Sync one call to both CRMs.
 *
 * The two run INDEPENDENTLY and neither can abort the other: LP being down
 * must not cost us the GHL note. Settled results are collected so one
 * rejection cannot escape and skip the other target.
 */
export async function syncCall(call, summary, match, opts = {}) {
  const [lp, ghl] = await Promise.allSettled([
    syncToLp(call, summary, match, opts),
    syncToGhl(call, summary, match, opts),
  ]);
  const unwrap = (r, target) => (r.status === 'fulfilled'
    ? r.value
    : { target, failed: true, error: String(r.reason?.message || r.reason) });
  return { lp: unwrap(lp, 'lp'), ghl: unwrap(ghl, 'ghl') };
}

/** Response id extraction, mirroring src/ghl-note-pipeline/lp-write.js. */
export function extractLpNoteId(resp) {
  if (!resp) return null;
  if (resp.note_id) return String(resp.note_id);
  if (resp.noteId) return String(resp.noteId);
  if (resp.id) return String(resp.id);
  const m = String(resp.message || '').match(/(\d+)\s*$/);
  return m ? m[1] : null;
}

/**
 * Shape-only description of a CRM response. §10 keeps note bodies and customer
 * data out of stored logs — the key names are enough to tell a changed API
 * from a failed extraction, which is what this is for.
 */
export function shapeOf(resp) {
  if (resp == null) return { shape: 'null' };
  if (typeof resp !== 'object') return { shape: typeof resp };
  return { shape: 'object', keys: Object.keys(resp).slice(0, 10) };
}

export default { syncCall, syncToLp, syncToGhl, tierWritable, claimSync, markSynced, markSyncFailed };
