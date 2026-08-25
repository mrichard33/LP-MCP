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
import { addNote as lpAddNote } from '../lp-client.js';
import { addGHLNote } from '../ghl.js';
import { getConfig, liveWrites, allowProbableLp, ghlCreateEnabled, nextRetryAt } from './config.js';
import { composeNote, idempotencyKey } from './notes.js';
import { WRITABLE_TIERS } from './match.js';

const LOG = '[CISync]';

/** Postgres unique-violation. A duplicate write attempt, not an outage. */
const UNIQUE_VIOLATION = '23505';

/**
 * ── THE PRODUCTION CLIENTS ─────────────────────────────────────────────────
 * 2026-08-24 — the first live tick threw `Cannot read properties of undefined
 * (reading 'addNote')` on six calls and reached no HTTP. syncToLp/syncToGhl
 * took `lpClient`/`ghlClient` with NO default, and nothing upstream supplied
 * one: worker.runTick() defaults adapter, transcriber and loadAudio but passes
 * these two straight through. Every test injected a client, so the production
 * path had never once executed.
 *
 * The default lives HERE, in the destructure at the write site, and nowhere
 * else. Two reasons:
 *   - The gate stays at the single write site. A default constructed in
 *     runTick() would put a second source of the client above liveWrites(),
 *     which is exactly the "second path to the API" the header warns about.
 *   - The write site is not only reached from the worker. The review resolve
 *     path and scripts/requeue-ci-review.js put a call back to 'matched' and a
 *     later tick syncs it; anything that calls syncToLp/syncToGhl directly
 *     would still have had `undefined` if the default sat in the worker.
 *
 * Exported so a test can assert these ARE the real client functions — an
 * injected stub proves nothing about what production does.
 */
export const defaultLpClient = { addNote: lpAddNote };
export const defaultGhlClient = { addGHLNote };

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

/**
 * Mark a claimed sync row as SENT but not yet proven — the honest state of an
 * LP note between the write and the read-back.
 *
 * Only LP uses this. GHL's addGHLNote returns something that varies with what
 * happened (see classifyGhlNoteResult), so a GHL write can be classified on the
 * spot and goes straight to 'synced'. LP's constant acknowledgment cannot be,
 * which is the whole reason this state exists.
 *
 * `synced_at` IS stamped here: it records when the write went out, and
 * src/ci/verify.js uses it to decide which rows have had time to settle.
 * `verified_at` — set only by the read-back — is the one that means proven.
 */
export async function markSentUnconfirmed(db, id, { response = null } = {}) {
  const { error } = await db.from('ci_syncs').update({
    status: 'sent_unconfirmed',
    response: response ?? null,
    error: null,
    synced_at: new Date().toISOString(),
  }).eq('id', id);
  if (error) throw new Error(`ci_syncs update failed: ${error.message}`);
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
export async function markSyncFailed(db, row, err, cfg = getConfig(), { permanent = false } = {}) {
  const attempts = (row.attempts || 0) + 1;
  // `permanent` is for a failure that retrying cannot fix — a CRM telling us
  // the contact does not exist. Burning five attempts and a backoff curve on
  // that only delays the review a human has to do anyway.
  const terminal = permanent || attempts >= cfg.maxAttempts;
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
 * @param {object} [opts.lpClient]  { addNote }; defaults to the REAL LP client
 */
export async function syncToLp(call, summary, match, { db = supabase, cfg = getConfig(), lpClient = defaultLpClient, link = null, agentLabel = null } = {}) {
  const target = 'lp';
  const rectype = match?.evidence?.note_target?.rectype ?? null;
  const recid = match?.evidence?.note_target?.recid ?? null;

  if (!rectype || !recid) {
    return { target, skipped: true, reason: 'no_note_target' };
  }
  if (!tierWritable(match.tier, target, cfg)) {
    return { target, skipped: true, reason: `tier_${match.tier}_not_writable` };
  }

  const noteBody = composeNote(call, summary, link, agentLabel);
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

    // SENT — NOT YET PROVEN. This is not hedging; it is the whole lesson of
    // 2026-08-24.
    //
    // /api/SalesApi/AddNotes answers with the bare string "UPDATED
    // SUCCESSFULLY!" and nothing else — no id, no digits, one distinct response
    // template across every live note (recorded by shapeOf, pinned by
    // scripts/test-ci-lp-note-id.js). It is a CONSTANT: byte-identical whether
    // the note landed on the record or vanished. So "addNote did not throw"
    // proves LP returned 2xx, and that is all it proves.
    //
    // This line used to call markSynced on exactly that. 286 rows recorded
    // `synced` over four hours and nothing in the database could say which of
    // them a rep could actually read.
    //
    // So the row now says what is true — LP accepted the write, we have not
    // looked — and src/ci/verify.js promotes it to 'synced' once it has SEEN
    // the note in LP, filling external_ref with the real lp_note_id on the way
    // past. That id exists; AddNotes just will not hand it over.
    //
    // The idempotency key is already held, so nothing re-sends this in the
    // meantime, which is the correct posture for a write that probably landed.
    await markSentUnconfirmed(db, claim.row.id, { response: shapeOf(resp) });
    console.log(`${LOG} call=${call.id} target=lp sent, awaiting read-back (${rectype}/${recid})`);
    return { target, sent: true, confirmed: false };
  } catch (err) {
    const f = await markSyncFailed(db, claim.row, err, cfg);
    console.error(`${LOG} call=${call.id} target=lp FAILED (attempt ${f.attempts}): ${err.message}`);
    return { target, failed: true, terminal: f.terminal, error: err.message };
  }
}

/**
 * What did addGHLNote actually do?
 *
 * ── WHY THIS EXISTS ────────────────────────────────────────────────────────
 * addGHLNote does NOT signal failure by throwing. It returns four different
 * things (src/ghl.js), and the write site used to treat all four as success:
 *
 *   data object          the note was written
 *   {skipped:true,...}   an identical note is already on the contact
 *   'not_found'          the contact is unreachable — PERMANENT, never retry
 *   null                 GHL disabled, empty body, or a transient failure
 *
 * `markSynced` was called unconditionally, so a contact that no longer exists
 * and a GHL outage both recorded status='synced' with a null external_ref —
 * indistinguishable from a delivered note. Nothing retried, nothing alerted,
 * and the review queue stayed empty while notes silently went nowhere. This is
 * the same class of defect as the missing client default: a non-exception
 * result that means "no write happened" being read as "write happened".
 *
 * 'not_found' is a TRUTHY STRING, so it must be tested before any truthiness
 * check — the ordering ghl.js's own header warns about.
 *
 * A duplicate IS delivery. The note is on the contact; the dedupe guard only
 * stopped us adding a second copy. Recording that as a failure would retry
 * forever against a guard designed to keep winning.
 *
 * @returns {{delivered: boolean, permanent?: boolean, reason?: string,
 *            message?: string, externalRef?: string|null}}
 */
export function classifyGhlNoteResult(resp) {
  // Sentinel FIRST — truthy string.
  if (resp === 'not_found') {
    return {
      delivered: false,
      permanent: true,
      reason: 'contact_not_found',
      message: 'GHL contact not found — the note has nowhere to go (permanent)',
    };
  }
  if (resp == null) {
    return {
      delivered: false,
      permanent: false,
      reason: 'ghl_unavailable',
      message: 'GHL returned no result — disabled, rate-limited, or a transient failure',
    };
  }
  if (resp.skipped === true) {
    // Already on the record. Delivered, and worth naming so the row does not
    // read as though this pipeline wrote it.
    return { delivered: true, reason: 'duplicate_note', externalRef: resp.matched_note_id ?? null };
  }
  return { delivered: true, externalRef: resp.id ?? resp.note?.id ?? null };
}

/**
 * Push the note to GoHighLevel.
 *
 * Contact creation is a THIRD gate on top of live+ghlWrites, because creating
 * a contact from a call that matched nothing is the duplicate-contact risk
 * §14.4 calls the top danger. Without it, a missed match quietly becomes a new
 * contact record rather than a review item.
 *
 * @param {object} [opts.ghlClient]  { addGHLNote }; defaults to the REAL client
 */
export async function syncToGhl(call, summary, match, { db = supabase, cfg = getConfig(), ghlClient = defaultGhlClient, link = null, agentLabel = null } = {}) {
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

  const noteBody = composeNote(call, summary, link, agentLabel);
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
    const verdict = classifyGhlNoteResult(resp);

    if (verdict.delivered) {
      await markSynced(db, claim.row.id, { externalRef: verdict.externalRef, response: shapeOf(resp) });
      console.log(`${LOG} call=${call.id} target=ghl synced${verdict.reason ? ` (${verdict.reason})` : ''}`);
      return { target, synced: true, ...(verdict.reason ? { reason: verdict.reason } : {}) };
    }

    // NOT delivered, and addGHLNote did not throw to say so — see
    // classifyGhlNoteResult. Route it through the same failure bookkeeping a
    // thrown error gets, so the row carries the reason and the retry policy.
    const f = await markSyncFailed(db, claim.row, new Error(verdict.message), cfg, {
      permanent: verdict.permanent,
    });
    console.error(`${LOG} call=${call.id} target=ghl NOT DELIVERED (${verdict.reason}`
      + `${verdict.permanent ? ', permanent' : `, attempt ${f.attempts}`}): ${verdict.message}`);
    return { target, failed: true, terminal: f.terminal, reason: verdict.reason, error: verdict.message };
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

/**
 * Longest string response templated into `response`. A composed note runs
 * ~1,000–1,600 bytes (measured on the first five live notes), so a cap this
 * far below that cannot capture a note body even if LP ever echoed one back.
 */
export const ACK_TEMPLATE_MAX = 80;

/**
 * Shape-only description of a CRM response. §10 keeps note bodies and customer
 * data out of stored logs — the key names are enough to tell a changed API
 * from a failed extraction, which is what this is for.
 *
 * A STRING response gets one thing more: a digit-masked template, e.g.
 * `Notes added: #####`. Without it, `{shape: 'string'}` is all we ever learn,
 * and "LP hands back no id" stays indistinguishable from "our extractor is
 * wrong" — the exact ambiguity that left lp_note_id null on 131 rows for a
 * month. Every digit is masked, so an id cannot leak through it, and only a
 * short string is templated at all.
 */
export function shapeOf(resp) {
  if (resp == null) return { shape: 'null' };
  if (typeof resp === 'string') {
    const out = { shape: 'string', length: resp.length };
    if (resp.length <= ACK_TEMPLATE_MAX) out.template = resp.replace(/\d/g, '#');
    return out;
  }
  if (typeof resp !== 'object') return { shape: typeof resp };
  return { shape: 'object', keys: Object.keys(resp).slice(0, 10) };
}

export default {
  syncCall, syncToLp, syncToGhl, tierWritable, claimSync, markSynced, markSyncFailed,
  defaultLpClient, defaultGhlClient, classifyGhlNoteResult,
};
