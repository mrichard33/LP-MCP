#!/usr/bin/env node
/**
 * Release idempotency keys burned by the missing-client TypeError
 * scripts/repair-ci-stuck-syncs.js
 *
 * WHY THIS EXISTS. syncToLp/syncToGhl had no production default for their CRM
 * client (fixed in src/ci/sync.js). On the first live tick the write site threw
 *
 *   Cannot read properties of undefined (reading 'addNote')
 *
 * on every call that reached it. The throw happens on the line that CALLS the
 * client, so it precedes the request: no HTTP was made, nothing reached Lead
 * Perfection. But the ci_syncs row is inserted BEFORE the call — that is what
 * makes idempotency structural — so each of those calls now holds a
 * UNIQUE(idempotency_key) row that will refuse the retry forever. Fixing the
 * client without releasing these keys delivers nothing: every affected call
 * comes straight back as skipped:duplicate.
 *
 * ── THIS IS THE NARROW EXCEPTION TO "NEVER DELETE A FAILED SYNC ROW" ────────
 * markSyncFailed() keeps failed rows deliberately: deleting one releases the
 * key, and a retry after a request that ACTUALLY LANDED would put a second note
 * on a customer's record. That reasoning is sound and unchanged. It simply does
 * not apply to this one error, because this error proves the request was never
 * made. The safety of this script is therefore entirely in the narrowness of
 * its filter, and every widening of that filter is a chance to double-post.
 *
 * A row is released ONLY when ALL of these hold:
 *   - status is 'pending' or 'failed'   (never 'synced', never 'shadow')
 *   - external_ref IS NULL              (nothing came back from a CRM)
 *   - response IS NULL                  (no CRM response was ever recorded)
 *   - error is EXACTLY the missing-client TypeError for addNote/addGHLNote
 *   - the error names the client belonging to this row's own target
 *     (target 'lp' ↔ addNote, target 'ghl' ↔ addGHLNote) — a mismatch means
 *     the message did not come from this row's write site, so the "no HTTP
 *     call" proof does not hold for it
 *
 * Everything else is REFUSED and printed with the reason. A timeout, a 500, a
 * rejected note body — all of those may have landed, and none of them are this.
 *
 * ── THE ROW IS DELETED; THE FACT IS NOT ────────────────────────────────────
 * Deleting the row is what releases the key, but the failure is still a fact
 * about the call. Each release writes a ci_events row (stage 'sync', event
 * 'key_released') carrying the deleted row's target, status, attempts and
 * error, so the audit trail survives the delete.
 *
 * ── THE PARENT CALL ────────────────────────────────────────────────────────
 * A sync that failed terminally parks its call in 'review' with
 * review_reason='sync_failed'. Releasing the key without moving that call back
 * to the sync stage would leave it parked with nothing to park it. Only calls
 * whose key this run actually released are touched, only from
 * 'review'/'completed', and only when review_reason='sync_failed'.
 *
 * The reset also clears the lease and the retry timer and zeroes attempts —
 * the same field set POST /ci/review/:call_id/resolve applies on a retry. It
 * deliberately does NOT go through applyResolve(): that derives the resume
 * stage from the artifacts and would send a call with a current summary back to
 * 'analyzed', re-running matching. The match is not what failed here; only the
 * delivery was, so the call resumes at 'syncing' — the status stageSync claims.
 *
 * ⚠ 'syncing', NOT 'matched'. Matching moved ahead of transcription, so
 * 'matched' now means "ready to TRANSCRIBE" and would send these calls back
 * through analysis, paying model tokens to reproduce a summary they already
 * hold. 'syncing' is the rung stageSync claims.
 *
 * Usage:
 *   node scripts/repair-ci-stuck-syncs.js                # dry-run (default)
 *   node scripts/repair-ci-stuck-syncs.js --execute      # write
 *   node scripts/repair-ci-stuck-syncs.js --limit=50     # cap the scan
 *
 * Pre-conditions:
 *   - the sync.js client-default fix is DEPLOYED (otherwise the next tick just
 *     burns the keys again)
 *   - SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY set (for --execute)
 *   - Mark has read the dry-run output before --execute
 */

const ARGV = process.argv.slice(2);

/** Statuses that can hold a burned key. 'synced'/'shadow' are never touched. */
export const RELEASABLE_STATUSES = ['pending', 'failed'];

/**
 * The one error this script recognises, per target.
 *
 * Anchored on V8's exact wording. `null` is admitted alongside `undefined`
 * because a client injected as null fails identically and equally provably
 * before the request; nothing else is.
 */
export const RELEASABLE_ERROR = {
  lp: /^Cannot read properties of (?:undefined|null) \(reading 'addNote'\)$/,
  ghl: /^Cannot read properties of (?:undefined|null) \(reading 'addGHLNote'\)$/,
};

/** Parse the flags. Pure — argv is an argument, so the rules are testable. */
export function parseArgs(argv) {
  let execute = false;
  let limit = null;
  for (const a of argv || []) {
    if (a === '--execute') execute = true;
    else if (a.startsWith('--limit=')) {
      const n = parseInt(a.slice('--limit='.length), 10);
      if (Number.isFinite(n) && n > 0) limit = n;
    }
  }
  return { execute, limit };
}

/**
 * Decide whether ONE ci_syncs row may have its key released. Pure.
 *
 * Refusing is a RESULT carrying its reason, not an exception, so every refusal
 * is printed rather than aborting the run — and so the rules are testable
 * without a database.
 *
 * @returns {{releasable: boolean, reason: string}}
 */
export function classifyRow(row) {
  const target = row?.target;
  if (!RELEASABLE_STATUSES.includes(row?.status)) {
    return { releasable: false, reason: `status '${row?.status}' is not pending/failed` };
  }
  if (row?.external_ref != null) {
    return { releasable: false, reason: 'external_ref is set — a CRM accepted this write' };
  }
  if (row?.response != null) {
    return { releasable: false, reason: 'a CRM response is recorded — the request was made' };
  }
  const pattern = RELEASABLE_ERROR[target];
  if (!pattern) {
    return { releasable: false, reason: `unknown target '${target}'` };
  }
  const error = String(row?.error ?? '');
  if (!pattern.test(error.trim())) {
    // Including the wrong-client case: an 'lp' row carrying the addGHLNote
    // message did not come from the LP write site, so nothing here proves it
    // made no request.
    return { releasable: false, reason: 'error is not the missing-client TypeError for this target' };
  }
  return { releasable: true, reason: 'missing-client TypeError — threw before the request' };
}

/** Split a page of rows into what may be released and what is refused. Pure. */
export function planRepair(rows) {
  const release = [];
  const refuse = [];
  for (const row of rows || []) {
    const verdict = classifyRow(row);
    (verdict.releasable ? release : refuse).push({ row, reason: verdict.reason });
  }
  return { release, refuse };
}

/**
 * Which parent calls this run should move back to the sync stage. Pure.
 *
 * `callIds` is the set whose keys were released — a call whose key we did NOT
 * touch is none of this script's business, however it looks.
 */
export function planParentReset(calls, callIds) {
  const ids = new Set(callIds || []);
  return (calls || []).filter((c) => (
    ids.has(c?.id)
    && ['review', 'completed'].includes(c?.status)
    && c?.review_reason === 'sync_failed'
  ));
}

/** The patch that puts a parked call back in the queue at the sync stage. */
export const PARENT_RESET_PATCH = {
  // 'syncing', not 'matched' — see the header. stageSync claims 'syncing';
  // 'matched' is the transcribe rung since the early match gate shipped.
  status: 'syncing',
  review_reason: null,
  status_detail: null,
  attempts: 0,
  next_retry_at: null,
  locked_until: null,
  locked_by: null,
};

/** Refuse to touch anything but the LP MCP instance. */
async function assertLpInstance(supabase) {
  const host = process.env.SUPABASE_URL ? new URL(process.env.SUPABASE_URL).host : '(unset)';
  const { error } = await supabase.from('lp_leads').select('id').limit(1);
  if (error) {
    console.error(`Refusing to write: SUPABASE_URL points at ${host}, which does not look like the LP MCP instance.`);
    console.error(`  probe: SELECT id FROM lp_leads LIMIT 1 -> ${error.message}`);
    process.exit(1);
  }
  console.log(`  target instance OK (${host}, lp_leads reachable)`);
}

const short = (v, n) => (v == null ? '—' : String(v).length > n ? `${String(v).slice(0, n - 1)}…` : String(v));

/**
 * Delete one sync row, re-asserting the safety conditions IN THE DELETE.
 *
 * The read that classified the row and this delete are separate statements. If
 * a concurrent worker delivered the note in between, external_ref is now set
 * and this delete matches nothing — which is the outcome we want, rather than
 * dropping the record of a note that landed.
 */
async function releaseOne(supabase, row) {
  const { data, error } = await supabase
    .from('ci_syncs')
    .delete()
    .eq('id', row.id)
    .in('status', RELEASABLE_STATUSES)
    .is('external_ref', null)
    .select('id');
  if (error) throw new Error(error.message);
  if (!data?.length) {
    throw new Error('row changed underneath the dry-run (external_ref or status moved) — left in place');
  }

  // The row is gone; the fact is not.
  const { error: evErr } = await supabase.from('ci_events').insert({
    call_id: row.call_id,
    stage: 'sync',
    event: 'key_released',
    detail: {
      script: 'repair-ci-stuck-syncs',
      target: row.target,
      sync_id: row.id,
      was_status: row.status,
      attempts: row.attempts,
      error: row.error,
      note: 'idempotency key released — the write threw before any HTTP request',
    },
  });
  if (evErr) console.warn(`  (audit event insert failed for ${row.id}: ${evErr.message})`);
}

async function main() {
  const args = parseArgs(ARGV);

  const { default: supabase } = await import('../src/supabase.js');
  if (!supabase) {
    console.error('Supabase not configured (SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY missing).');
    process.exit(1);
  }

  console.log(`repair-ci-stuck-syncs ${args.execute ? '--execute' : '(DRY-RUN — no writes; pass --execute after review)'}`);
  console.log('  releases ONLY rows whose error is the missing-client TypeError, with no external_ref');
  console.log('  and no CRM response — those provably made no HTTP request. Everything else is refused.\n');

  let q = supabase
    .from('ci_syncs')
    .select('id, call_id, target, status, external_ref, response, error, attempts, created_at')
    .in('status', RELEASABLE_STATUSES)
    .order('created_at', { ascending: true });
  if (args.limit) q = q.limit(args.limit);

  const { data: rows, error } = await q;
  if (error) throw new Error(`ci_syncs read failed: ${error.message}`);

  if (!rows?.length) {
    console.log('No pending or failed ci_syncs rows at all. Nothing to do.');
    return;
  }

  const { release, refuse } = planRepair(rows);

  // Every row examined is printed before anything is written — including the
  // refusals, which are the evidence that the filter stayed narrow.
  console.log(`Examined ${rows.length} pending/failed row(s).\n`);
  console.log(`  ${'sync_id'.padEnd(38)} ${'target'.padEnd(7)} ${'status'.padEnd(8)} ${'att'.padEnd(4)} error`);
  for (const { row } of [...release, ...refuse]) {
    console.log(
      `  ${String(row.id).padEnd(38)} ${String(row.target).padEnd(7)} ${String(row.status).padEnd(8)}`
      + ` ${String(row.attempts ?? 0).padEnd(4)} ${short(row.error, 70)}`,
    );
  }

  if (refuse.length) {
    console.log(`\n  REFUSED (${refuse.length}) — left exactly as they are:`);
    for (const { row, reason } of refuse) console.log(`    ${row.id} (${row.target}): ${reason}`);
  }

  if (!release.length) {
    console.log('\nNothing to release. No row carries the missing-client TypeError.');
    return;
  }

  const callIds = [...new Set(release.map(({ row }) => row.call_id))];
  console.log(`\n  RELEASE (${release.length}) across ${callIds.length} call(s):`);
  for (const { row } of release) console.log(`    ${row.id} (${row.target}) call=${row.call_id}`);

  // The parent calls, read now so the dry run shows exactly which ones move.
  const { data: calls, error: cErr } = await supabase
    .from('ci_calls')
    .select('id, five9_call_id, status, review_reason, attempts')
    .in('id', callIds);
  if (cErr) throw new Error(`ci_calls read failed: ${cErr.message}`);

  const toReset = planParentReset(calls || [], callIds);
  console.log(`\n  parent calls: ${(calls || []).length} read, ${toReset.length} to reset to 'syncing'`);
  for (const c of calls || []) {
    const mark = toReset.includes(c) ? '-> matched' : '(left alone)';
    console.log(`    ${String(c.five9_call_id ?? c.id).padEnd(20)} ${String(c.status).padEnd(10)}`
      + ` ${String(c.review_reason ?? '—').padEnd(16)} ${mark}`);
  }

  if (!args.execute) {
    console.log('\nDRY-RUN complete. No writes performed.');
    return;
  }

  console.log('');
  await assertLpInstance(supabase);

  let released = 0;
  const failures = [];
  for (const { row } of release) {
    try {
      await releaseOne(supabase, row);
      released += 1;
      console.log(`  released ${row.target} key for call ${row.call_id}`);
    } catch (err) {
      // One stubborn row must not abandon the rest half-done.
      failures.push({ id: row.id, error: err.message });
      console.error(`  ${row.id} NOT released: ${err.message}`);
    }
  }

  let reset = 0;
  for (const c of toReset) {
    const { error: upErr } = await supabase.from('ci_calls').update(PARENT_RESET_PATCH).eq('id', c.id);
    if (upErr) {
      failures.push({ id: c.id, error: `parent reset failed: ${upErr.message}` });
      console.error(`  call ${c.five9_call_id ?? c.id} NOT reset: ${upErr.message}`);
      continue;
    }
    reset += 1;
    console.log(`  call ${c.five9_call_id ?? c.id} -> matched`);
  }

  console.log(`\nReleased ${released}/${release.length} key(s); reset ${reset}/${toReset.length} parent call(s).`);
  console.log('The next worker tick re-claims these calls and retries the write against the real client.');
  if (failures.length) {
    console.log(`\n${failures.length} item(s) FAILED:`);
    for (const f of failures) console.log(`  ${f.id}: ${f.error}`);
    process.exitCode = 1;
  }
}

// Only run as a script — the pure planners are imported by tests.
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error('repair-ci-stuck-syncs failed:', err.message);
    process.exit(1);
  });
}
