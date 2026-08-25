/**
 * Delivery is proven by reading LP back, never by "addNote did not throw"
 * src/ci/verify.js
 *
 * ── THE DEFECT THIS CLOSES ─────────────────────────────────────────────────
 * /api/SalesApi/AddNotes answers every successful write with the constant
 * string "UPDATED SUCCESSFULLY!" — no id, no echo, nothing that varies with
 * what was written. So the write site's only signal is that lpPost did not
 * raise, which proves LP returned 2xx and nothing more.
 *
 * On 2026-08-24 that let 286 ci_syncs rows record `synced` on a non-throw, and
 * when the notes could not be found there was no way to tell a phantom write
 * from a note filed where nobody looks. Four hours of writes accumulated
 * unverified because the row could not express "sent, not yet confirmed".
 *
 * Now it can. syncToLp records `sent_unconfirmed`; this module goes and looks;
 * only a note we have SEEN in LP becomes `synced`.
 *
 * ── WHY A SWEEP, NOT A READ-BACK ON THE WRITE PATH ─────────────────────────
 * GetLead returns every note on a person in one response, so verification
 * costs one LP read per PROSPECT rather than one per note — a call burst about
 * one customer verifies in a single request. It also keeps the write path at
 * exactly one HTTP call, so a slow or flapping read can never turn a delivered
 * note into a failed one.
 *
 * The cost is a window (CI_VERIFY_DELAY_MS) in which a delivered note is not
 * yet marked delivered. That is the right trade: `sent_unconfirmed` is an
 * honest state and a rep never sees it, whereas a premature `synced` is a lie
 * that took four hours to notice.
 *
 * ── UNKNOWN IS NOT ABSENT ──────────────────────────────────────────────────
 * The load-bearing rule of this file. If the LP read FAILS we change nothing —
 * not the status, not the attempt count. Treating "we could not ask" as "it is
 * not there" is how a delivered note gets retried, and a retry after a landed
 * write puts a second note on a customer's record. The only thing that may
 * ever mark a note missing is a SUCCESSFUL read that did not contain it.
 *
 * ── AND THE ID WE COULD NEVER GET ──────────────────────────────────────────
 * A pleasant side effect: the read-back carries the real lp_note_id, which
 * AddNotes refuses to return. Verified rows finally populate external_ref with
 * something true, so an audit can join a ci_syncs row to the note a rep read.
 */

import supabaseDefault from '../supabase.js';
import { getConfig } from './config.js';
import { findCiNote, readProspect, markerFor } from './lp-readback.js';
import { getLead } from '../lp-client.js';
import { sendAlert } from './alerts.js';

const LOG = '[CI]';

/** The status a delivered-but-unproven LP note sits in. */
export const UNCONFIRMED = 'sent_unconfirmed';

/**
 * The production read. Defaulted at the destructure of every consumer, never
 * supplied by a caller — the same lesson as defaultLpClient in sync.js, where a
 * pure pass-through left every direct-call path with an undefined client and
 * threw on the first live tick.
 */
export const defaultLpReader = getLead;

/**
 * Read the verification knobs off the environment. Pure — env is an argument,
 * so the floors below are testable without mutating process.env.
 *
 * CI_VERIFY_ENABLED defaults ON. This is the safety net that would have caught
 * the 08-24 incident in minutes; it should take a deliberate act to remove it,
 * not an unset variable.
 */
export function readVerifyEnv(env = process.env) {
  const num = (v, dflt, min) => {
    const n = parseInt(v, 10);
    return Number.isFinite(n) && n >= min ? n : dflt;
  };
  return {
    enabled: String(env.CI_VERIFY_ENABLED ?? 'true').toLowerCase() !== 'false',
    // Long enough that LP has certainly committed the write, short enough that
    // a silent no-op surfaces while the operator is still watching.
    delayMs: num(env.CI_VERIFY_DELAY_MS, 120000, 1000),
    maxAttempts: num(env.CI_VERIFY_MAX_ATTEMPTS, 3, 1),
    batch: num(env.CI_VERIFY_BATCH, 50, 1),
    // The LEGACY PASS. 286 rows recorded `synced` on 2026-08-24 before
    // sent_unconfirmed existed, on nothing but a non-throw, and 195 of them
    // were filed on the lead where no rep reads. They cannot verify themselves
    // through the normal path — they are already 'synced' — so the sweep also
    // takes a small slice of them each tick and settles them the same way.
    //
    // Deliberately SMALL and default-on: it is a backfill riding on a
    // five-minute worker tick, so at 10 per tick the whole backlog resolves in
    // about two hours without ever competing with live verification.
    legacyEnabled: String(env.CI_VERIFY_LEGACY_ENABLED ?? 'true').toLowerCase() !== 'false',
    legacyBatch: num(env.CI_VERIFY_LEGACY_BATCH, 10, 1),
  };
}

/**
 * One unit of work per PROSPECT. Pure.
 *
 * Grouping is what makes this cheap: GetLead returns every note on a person, so
 * nine notes about one customer cost one read. It is also what makes the
 * ils/cst comparison fair — both are settled by the same payload.
 *
 * A row whose prospect is unknown cannot be read at all. It comes back
 * separately rather than being quietly dropped, because "never checked" and
 * "not in LP" must never merge.
 */
export function groupByProspect(rows) {
  const byProspect = new Map();
  const unresolved = [];
  for (const r of rows || []) {
    const cst = r?.lp_cst_id ?? (r?.rectype === 'cst' ? r?.recid : null);
    if (cst == null || cst === '') { unresolved.push(r); continue; }
    const key = String(cst);
    if (!byProspect.has(key)) byProspect.set(key, []);
    byProspect.get(key).push(r);
  }
  return { byProspect, unresolved };
}

/**
 * Tally outcomes into the table that decides the repair. Pure.
 *
 * `found_on_lead` is broken out from `found` deliberately: a note that exists
 * but hangs off the inquiry is DELIVERED and INVISIBLE. Re-sending it would put
 * a second copy on the customer's record, so it must never be counted with the
 * misses that genuinely need re-sending.
 */
export function summarise(results) {
  const empty = () => ({ checked: 0, found: 0, found_on_prospect: 0, found_on_lead: 0, missing: 0, unread: 0 });
  const acc = { cst: empty(), ils: empty(), unknown: empty() };
  for (const r of results || []) {
    const bucket = acc[r.rectype] || acc.unknown;
    bucket.checked += 1;
    if (!r.read_ok) { bucket.unread += 1; continue; }
    if (!r.found) { bucket.missing += 1; continue; }
    bucket.found += 1;
    if (r.side === 'prospect') bucket.found_on_prospect += 1;
    else bucket.found_on_lead += 1;
  }
  return acc;
}

/**
 * The one sentence the operator needs, pinned by a test rather than left to
 * whoever is reading the table at 2am. Pure.
 */
export function verdictOf(acc) {
  const { ils, cst } = acc;
  const ilsRead = ils.found + ils.missing;
  const cstRead = cst.found + cst.missing;

  if (ilsRead === 0 && cstRead === 0) {
    return 'INCONCLUSIVE — nothing could be read from LP. Fix credentials or connectivity and re-run; no repair may act on this.';
  }
  if (cstRead > 0 && cst.found === 0 && ilsRead > 0 && ils.found === 0) {
    return 'NEITHER rectype is present. This is NOT a rectype problem — stop, and compare the AddNotes payload byte-for-byte against a working src/ghl-note-pipeline/lp-write.js call.';
  }
  if (ils.found > 0 && ils.found_on_lead === ils.found) {
    return 'DELIVERED BUT INVISIBLE — the ils notes are in LP, attached to the inquiry rather than the prospect. A VISIBILITY defect, not a delivery one. Re-sending them as cst leaves a second copy on the record; that is a human decision, not the repair script\'s.';
  }
  if (ilsRead > 0 && ils.found === 0 && cst.found > 0) {
    return 'NOT DELIVERED — AddNotes silently no-ops for rectype=\'ils\'. Those writes never landed and are safe to re-send as cst.';
  }
  return 'MIXED — read the per-row table before deciding; the two rectypes do not tell a single story.';
}

/**
 * Load ci_syncs rows with everything needed to check them: the note target we
 * aimed at (ci_matches) and the prospect to read (ci_calls).
 *
 * ci_matches hangs off ci_calls rather than ci_syncs, so it is fetched
 * separately and joined here — one predictable query beats a nested embed whose
 * shape depends on how PostgREST resolves UNIQUE(call_id).
 */
export async function loadSyncRows({ db = supabaseDefault, status = 'synced', olderThan = null, unverifiedOnly = false } = {}) {
  let q = db
    .from('ci_syncs')
    // ci_calls carries five9_call_id and NOT lp_cst_id — the prospect id lives
    // on ci_matches (worker.js writes it there at match time). Asking ci_calls
    // for it made PostgREST reject the whole select, which made loadSyncRows
    // throw on EVERY call and silently disabled the entire verify sweep from
    // the day it shipped. See the schema assertion in the tests.
    .select('id, call_id, status, synced_at, created_at, external_ref, verified_at, verify_attempts, ci_calls(five9_call_id)')
    .eq('target', 'lp')
    .eq('status', status)
    .order('synced_at', { ascending: true });
  if (olderThan) q = q.lt('synced_at', olderThan);
  // The legacy slice: 'synced' rows that no read-back ever confirmed. A row
  // carrying external_ref or verified_at has already been settled and must not
  // be re-read — re-reading it would burn LP calls forever on a closed case.
  if (unverifiedOnly) q = q.is('external_ref', null).is('verified_at', null);

  const { data: syncs, error } = await q;
  if (error) throw new Error(`ci_syncs read failed: ${error.message}`);

  // ci_matches carries BOTH the note target we aimed at and the prospect id we
  // have to read back, so one query serves both.
  const callIds = [...new Set((syncs || []).map((s) => s.call_id))];
  const matchByCall = new Map();
  for (let i = 0; i < callIds.length; i += 200) {
    const { data: matches, error: mErr } = await db
      .from('ci_matches').select('call_id, lp_cst_id, evidence').in('call_id', callIds.slice(i, i + 200));
    if (mErr) throw new Error(`ci_matches read failed: ${mErr.message}`);
    for (const m of matches || []) matchByCall.set(m.call_id, m);
  }

  return (syncs || []).map((s) => {
    const m = matchByCall.get(s.call_id) ?? {};
    const t = m.evidence?.note_target ?? {};
    return {
      sync_id: s.id,
      call_id: s.call_id,
      status: s.status,
      synced_at: s.synced_at,
      external_ref: s.external_ref,
      verified_at: s.verified_at ?? null,
      verify_attempts: s.verify_attempts ?? 0,
      five9_call_id: s.ci_calls?.five9_call_id ?? null,
      lp_cst_id: m.lp_cst_id ?? null,
      rectype: t.rectype ?? 'unknown',
      recid: t.recid ?? null,
      marker: markerFor(s.call_id),
    };
  });
}

/**
 * Check a set of rows against LP. READ ONLY — this never writes.
 *
 * Shared by the CLI, the /ci/verify-notes route and the repair script, so all
 * three read the same evidence the same way and cannot drift apart.
 */
export async function auditLpNotes({ db = supabaseDefault, lpReader = defaultLpReader, status = 'synced', limit = 25, marker = null } = {}) {
  let rows = await loadSyncRows({ db, status });
  if (marker) rows = rows.filter((r) => r.marker === `[AI-CI:${marker}`);

  const { byProspect, unresolved } = groupByProspect(rows);
  const prospects = [...byProspect.keys()];
  const scan = limit ? prospects.slice(0, limit) : prospects;

  const results = [];
  for (const cst of scan) {
    const { ok, prospect, error } = await readProspect(cst, { lpReader });
    for (const r of byProspect.get(cst)) {
      if (!ok) { results.push({ ...r, read_ok: false, found: false, side: null, lp_note_id: null, read_error: error }); continue; }
      if (!prospect) { results.push({ ...r, read_ok: true, found: false, side: null, lp_note_id: null, read_error: 'prospect not found in LP' }); continue; }
      const hit = findCiNote(prospect, r.call_id);
      results.push({
        ...r, read_ok: true, found: hit.found, side: hit.side,
        lds_id: hit.ldsId, lp_note_id: hit.lpNoteId, copies: hit.copies, read_error: null,
      });
    }
  }
  for (const r of unresolved) {
    results.push({ ...r, read_ok: false, found: false, side: null, lp_note_id: null, read_error: 'no prospect id on ci_calls' });
  }

  const summary = summarise(results);
  return {
    writes: rows.length,
    prospects: prospects.length,
    prospects_read: scan.length,
    prospects_skipped: prospects.length - scan.length,
    results,
    summary,
    verdict: verdictOf(summary),
  };
}

/**
 * THE SETTLE RULE. One prospect read at a time, and for each of its rows:
 *
 *   found        → 'synced', verified_at set, external_ref = the real note id
 *   read OK,
 *   not found    → verify_attempts+1; at maxAttempts, 'failed' + an alert
 *   read FAILED  → NOTHING CHANGES. Unknown is not absent.
 *
 * Extracted so the live pass and the legacy backfill share it EXACTLY. Two
 * copies of this would drift, and the branch that would drift first is the last
 * one — the one that must never turn "we could not ask LP" into "LP does not
 * have it", because that releases the idempotency key on a delivered note and
 * the retry double-posts onto a customer's record.
 *
 * `fromStatus` is the status the row is expected to still be in, and it is
 * re-asserted in every UPDATE. It differs between the passes
 * ('sent_unconfirmed' live, 'synced' legacy), so hardcoding it would make one
 * pass silently match nothing.
 *
 * @returns {{checked:number, verified:number, missing:number, failed:number, unread:number}}
 */
async function settleRows({ db, rows, fromStatus, opts, lpReader, now, alert, label }) {
  const stats = { checked: 0, verified: 0, missing: 0, failed: 0, unread: 0, skipped: false };
  if (!rows.length) return stats;

  const { byProspect, unresolved } = groupByProspect(rows);

  for (const [cst, group] of byProspect) {
    const { ok, prospect, error } = await readProspect(cst, { lpReader });

    if (!ok) {
      // The rule this module exists for. We could not ask, so we know nothing —
      // and an unread row keeps its attempt count, or a run of LP outages would
      // burn through maxAttempts and fail notes that were delivered.
      stats.unread += group.length;
      stats.checked += group.length;
      console.warn(`${LOG} verify: LP read failed for prospect ${cst} (${error}) — ${group.length} note(s) left unconfirmed, attempts untouched`);
      continue;
    }

    for (const r of group) {
      stats.checked += 1;
      const hit = prospect ? findCiNote(prospect, r.call_id) : { found: false };

      if (hit.found) {
        const { error: uErr } = await db.from('ci_syncs').update({
          status: 'synced',
          // The id AddNotes will not give us, recovered on the way back.
          external_ref: hit.lpNoteId,
          verified_at: now().toISOString(),
          error: null,
        }).eq('id', r.sync_id).eq('status', fromStatus);
        if (uErr) { console.warn(`${LOG} verify: could not mark ${r.sync_id} synced: ${uErr.message}`); continue; }
        stats.verified += 1;
        if (hit.side === 'lead') {
          // Present, but on the inquiry — delivered and invisible to a rep.
          // Worth saying out loud every time: this is the exact shape of the
          // 08-24 incident, and a silent promotion would hide its return.
          console.warn(`${LOG} verify: call=${r.call_id} note found on LEAD ${hit.ldsId}, not the prospect — delivered but not where a rep reads`);
        }
        continue;
      }

      // A successful read that did not contain it. This — and only this — is
      // grounds for calling a note missing.
      const attempts = (r.verify_attempts || 0) + 1;
      const terminal = attempts >= opts.maxAttempts;
      const { error: uErr } = await db.from('ci_syncs').update({
        status: terminal ? 'failed' : fromStatus,
        verify_attempts: attempts,
        error: terminal ? 'not_present_in_lp — LP accepted the write but the note is not on the record' : null,
      }).eq('id', r.sync_id).eq('status', fromStatus);
      if (uErr) { console.warn(`${LOG} verify: could not record miss for ${r.sync_id}: ${uErr.message}`); continue; }

      stats.missing += 1;
      if (terminal) {
        stats.failed += 1;
        console.error(`${LOG} verify: call=${r.call_id} note NOT in LP after ${attempts} read(s) (${r.rectype}/${r.recid}) — marked failed`);
        try {
          await alert(
            'ci_note_not_in_lp',
            `CI note NOT in Lead Perfection after ${attempts} read-back(s).`
            + ` LP accepted the write (2xx) but the note is absent from the record.`
            + ` call=${r.call_id} five9=${r.five9_call_id ?? '—'} sent=${r.rectype}/${r.recid} prospect=${r.lp_cst_id ?? '—'}`,
          );
        } catch (e) { console.warn(`${LOG} verify: alert failed: ${e.message}`); }
      }
    }
  }

  for (const _ of unresolved) { stats.checked += 1; stats.unread += 1; }
  if (unresolved.length) {
    console.warn(`${LOG} verify${label}: ${unresolved.length} note(s) have no prospect id and cannot be read back`);
  }

  if (stats.checked) {
    console.log(`${LOG} verify${label}: checked=${stats.checked} verified=${stats.verified} missing=${stats.missing} failed=${stats.failed} unread=${stats.unread}`);
  }
  return stats;
}

/**
 * Promote the notes we can now see; leave alone the ones we cannot.
 *
 * TWO PASSES, one settle rule.
 *
 *   live    'sent_unconfirmed' rows past the settle delay — the normal path
 *           every LP note now takes.
 *   legacy  'synced' rows that no read-back ever confirmed (external_ref and
 *           verified_at both NULL). These are the 286 written on 2026-08-24
 *           before this state existed, whose `synced` rests on a non-throw and
 *           nothing else. They cannot verify themselves through the live path
 *           because they are already 'synced', so a small slice is taken each
 *           tick until the backlog is settled.
 *
 * Both go through settleRows, so the rule that matters — a failed read changes
 * NOTHING — cannot drift between them.
 */
export async function verifyPendingLpNotes({
  db = supabaseDefault,
  cfg = getConfig(),
  env = process.env,
  lpReader = defaultLpReader,
  now = () => new Date(),
  alert = sendAlert,
} = {}) {
  const opts = readVerifyEnv(env);
  const empty = { checked: 0, verified: 0, missing: 0, failed: 0, unread: 0, skipped: false };

  if (!opts.enabled) return { ...empty, skipped: 'disabled' };
  if (typeof lpReader !== 'function') return { ...empty, skipped: 'no_lp_reader' };

  const cutoff = new Date(now().getTime() - opts.delayMs).toISOString();
  const live = (await loadSyncRows({ db, status: UNCONFIRMED, olderThan: cutoff })).slice(0, opts.batch);
  const stats = await settleRows({
    db, rows: live, fromStatus: UNCONFIRMED, opts, lpReader, now, alert, label: '',
  });

  if (!opts.legacyEnabled) return stats;

  // The legacy backfill rides the same tick. Oldest first, so the incident's
  // earliest writes — the ones a rep is most likely to have gone looking for —
  // are settled first.
  const legacyRows = (await loadSyncRows({ db, status: 'synced', unverifiedOnly: true })).slice(0, opts.legacyBatch);
  if (!legacyRows.length) return stats;

  const legacy = await settleRows({
    db, rows: legacyRows, fromStatus: 'synced', opts, lpReader, now, alert, label: '(legacy)',
  });

  return {
    checked: stats.checked + legacy.checked,
    verified: stats.verified + legacy.verified,
    missing: stats.missing + legacy.missing,
    failed: stats.failed + legacy.failed,
    unread: stats.unread + legacy.unread,
    skipped: false,
    legacy,
  };
}

export default {
  UNCONFIRMED, defaultLpReader, readVerifyEnv, groupByProspect, summarise, verdictOf,
  loadSyncRows, auditLpNotes, verifyPendingLpNotes,
};
