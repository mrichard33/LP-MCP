#!/usr/bin/env node
/**
 * Release keys for CI notes LP does not actually have — proven one row at a time
 * scripts/repair-ci-phantom-syncs.js
 *
 * ── WHAT HAPPENED ──────────────────────────────────────────────────────────
 * Between 2026-08-24 22:29Z and 2026-08-25 03:00Z the CI pipeline recorded 286
 * ci_syncs rows as `synced` for target 'lp'. `synced` rested on nothing more
 * than "addNote did not throw", because /api/SalesApi/AddNotes answers every
 * write with the constant "UPDATED SUCCESSFULLY!". 195 of those went out as
 * rectype 'ils' — attached to the inquiry rather than the prospect, which is
 * not where a rep reads — and Mark could not find them.
 *
 * Each of those rows holds a UNIQUE(idempotency_key), so a note that never
 * landed can never be re-sent while its row stands. This releases the keys.
 *
 * ── ABSENCE IS PROVEN BY READING LP, NEVER BY THE MIRROR ───────────────────
 * The lp_notes mirror says nothing useful here, and believing it is what made
 * this incident look ten times worse than it is. Measured across all 286:
 *
 *     lead present in the mirror ................. 286
 *     mirror re-read the record AFTER the write ..   1
 *     of those, note found in LP .................   1
 *
 * The mirror only re-syncs leads in its own scope. 285 records were never
 * looked at again, so their absence from lp_notes is a coverage artefact. The
 * one that WAS re-read has its note.
 *
 * So this script asks Lead Perfection itself, per row, at repair time, through
 * the same read the verify sweep uses (src/ci/verify.js → auditLpNotes).
 *
 * ── THE THREE OUTCOMES, AND WHY ONLY ONE IS ACTIONABLE ─────────────────────
 *   FOUND on the prospect  the note is delivered and visible. REFUSED.
 *   FOUND on the lead      delivered but invisible to a rep. REFUSED — see
 *                          below; this is a human decision, not a repair.
 *   read FAILED            we could not ask. UNKNOWN, never "absent". REFUSED.
 *   read OK, not present   the only case this script touches.
 *
 * Releasing a key on anything else means a retry after a landed write, which
 * puts a SECOND note on a customer's record — the exact failure the
 * idempotency key exists to prevent.
 *
 * ── A LEAD-ATTACHED NOTE IS NOT A MISS ─────────────────────────────────────
 * If the audit finds the ils notes present on the inquiry, they were delivered.
 * Re-sending them as 'cst' would leave two copies in LP — one visible, one not
 * — and that trade (a rep finally sees the note vs. a duplicated record) is
 * Mark's call to make, not this script's. They are listed separately and
 * refused. There is deliberately no flag to override that.
 *
 * ── THE ROW IS DELETED; THE FACT IS NOT ────────────────────────────────────
 * Deleting the row releases the key, but the failure remains a fact about the
 * call, so each release writes a ci_events row (stage 'sync', event
 * 'key_released') carrying what was deleted and the evidence that justified it.
 *
 * Usage:
 *   node scripts/repair-ci-phantom-syncs.js                 # dry-run (default)
 *   node scripts/repair-ci-phantom-syncs.js --execute
 *   node scripts/repair-ci-phantom-syncs.js --limit=50      # cap prospects read
 *   node scripts/repair-ci-phantom-syncs.js --status=sent_unconfirmed
 *
 * Pre-conditions:
 *   - the note-target fix (src/ci/match.js) is DEPLOYED, or the retry files the
 *     note right back onto the lead
 *   - SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY and LP API credentials
 *   - Mark has read the dry-run output before --execute
 */

import { auditLpNotes } from '../src/ci/verify.js';

const ARGV = process.argv.slice(2);

/** The window the incident occupied. Rows outside it are not this repair's. */
export const INCIDENT_FROM = '2026-08-24T22:00:00.000Z';
export const INCIDENT_TO = '2026-08-25T04:00:00.000Z';

/** Parse the flags. Pure — argv is an argument, so the rules are testable. */
export function parseArgs(argv) {
  let execute = false;
  let limit = null;
  let status = 'synced';
  let from = INCIDENT_FROM;
  let to = INCIDENT_TO;
  for (const a of argv || []) {
    if (a === '--execute') execute = true;
    else if (a.startsWith('--limit=')) {
      const n = parseInt(a.slice('--limit='.length), 10);
      if (Number.isFinite(n) && n > 0) limit = n;
    } else if (a.startsWith('--status=')) status = a.slice('--status='.length).trim() || 'synced';
    else if (a.startsWith('--from=')) from = a.slice('--from='.length).trim();
    else if (a.startsWith('--to=')) to = a.slice('--to='.length).trim();
  }
  return { execute, limit, status, from, to };
}

/**
 * Decide whether ONE audited row may have its key released. Pure.
 *
 * Refusing is a RESULT carrying its reason, not an exception, so every refusal
 * is printed rather than aborting the run — and so the rules are testable
 * without a database or an LP call.
 *
 * @param {object} r    one row from auditLpNotes().results
 * @param {{from:string,to:string}} window
 * @returns {{releasable: boolean, reason: string, category: string}}
 */
export function classifyAudited(r, { from = INCIDENT_FROM, to = INCIDENT_TO } = {}) {
  if (r?.external_ref != null) {
    return { releasable: false, category: 'has_ref', reason: 'external_ref is set — a verified note id is recorded' };
  }
  const at = r?.synced_at ? Date.parse(r.synced_at) : NaN;
  if (!Number.isFinite(at) || at < Date.parse(from) || at > Date.parse(to)) {
    return { releasable: false, category: 'out_of_window', reason: `synced_at ${r?.synced_at ?? '—'} is outside ${from}..${to}` };
  }
  if (!r?.read_ok) {
    // The rule the whole script rests on. We could not ask LP, so we know
    // nothing, and "probably fine to retry" is precisely how a delivered note
    // gets double-posted.
    return { releasable: false, category: 'unread', reason: `LP could not be read (${r?.read_error ?? 'unknown'}) — UNKNOWN is not ABSENT` };
  }
  if (r.found && r.side === 'prospect') {
    return { releasable: false, category: 'delivered', reason: `delivered and visible (lp_note_id ${r.lp_note_id ?? '—'})` };
  }
  if (r.found) {
    return {
      releasable: false,
      category: 'delivered_invisible',
      reason: `delivered but attached to lead ${r.lds_id ?? '—'} (lp_note_id ${r.lp_note_id ?? '—'}) — re-sending leaves a second copy; Mark decides`,
    };
  }
  return { releasable: true, category: 'absent', reason: 'read succeeded and the note is not on the record' };
}

/** Split an audit into what may be released and what is refused. Pure. */
export function planRepair(results, window) {
  const release = [];
  const refuse = [];
  for (const r of results || []) {
    const verdict = classifyAudited(r, window);
    (verdict.releasable ? release : refuse).push({ row: r, ...verdict });
  }
  return { release, refuse };
}

/** Which parent calls this run should move back to the sync stage. Pure. */
export function planParentReset(calls, callIds) {
  const ids = new Set(callIds || []);
  return (calls || []).filter((c) => (
    ids.has(c?.id)
    && ['review', 'completed'].includes(c?.status)
  ));
}

/** The patch that puts a call back in the queue at the sync stage. */
export const PARENT_RESET_PATCH = {
  // 'syncing', not 'matched': stageSync claims 'syncing'. Since matching moved
  // ahead of transcription, 'matched' means "ready to transcribe" and would
  // re-run analysis on a call that only needs its note re-sent.
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
 * Delete one sync row, RE-ASSERTING the safety conditions in the delete itself.
 *
 * The LP read that proved this note absent and this delete are separate
 * statements. If the verify sweep confirmed the note in between, external_ref
 * is now set and this delete matches nothing — which is the outcome we want,
 * rather than dropping the record of a note that turned out to be there.
 */
async function releaseOne(supabase, row, evidence) {
  const { data, error } = await supabase
    .from('ci_syncs')
    .delete()
    .eq('id', row.sync_id)
    .eq('status', row.status ?? 'synced')
    .is('external_ref', null)
    .select('id');
  if (error) throw new Error(error.message);
  if (!data?.length) {
    throw new Error('row changed underneath the audit (external_ref or status moved) — left in place');
  }

  const { error: evErr } = await supabase.from('ci_events').insert({
    call_id: row.call_id,
    stage: 'sync',
    event: 'key_released',
    detail: {
      script: 'repair-ci-phantom-syncs',
      target: 'lp',
      sync_id: row.sync_id,
      synced_at: row.synced_at,
      sent_as: `${row.rectype}/${row.recid}`,
      lp_cst_id: row.lp_cst_id,
      evidence,
      note: 'idempotency key released — a successful LP read did not contain this note',
    },
  });
  if (evErr) console.warn(`  (audit event insert failed for ${row.sync_id}: ${evErr.message})`);
}

async function main() {
  const args = parseArgs(ARGV);

  const { default: supabase } = await import('../src/supabase.js');
  if (!supabase) {
    console.error('Supabase not configured (SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY missing).');
    process.exit(1);
  }

  console.log(`repair-ci-phantom-syncs ${args.execute ? '--execute' : '(DRY-RUN — no writes; pass --execute after review)'}`);
  console.log('  Releases ONLY rows where a SUCCESSFUL Lead Perfection read did not contain the note.');
  console.log('  A note that was found, or a read that failed, is refused and printed.\n');

  console.log(`Reading LP for status='${args.status}' rows in ${args.from} .. ${args.to}`);
  const audit = await auditLpNotes({ db: supabase, status: args.status, limit: args.limit });
  console.log(`  ${audit.writes} write(s) across ${audit.prospects} prospect(s); read ${audit.prospects_read}.`);
  if (audit.prospects_skipped > 0) {
    console.log(`  ${audit.prospects_skipped} prospect(s) NOT read (--limit) — their rows are refused as unread, never released.`);
  }
  console.log(`\n  AUDIT VERDICT: ${audit.verdict}\n`);

  const { release, refuse } = planRepair(audit.results, args);

  // Every row examined is printed before anything is written — the refusals
  // included, because they are the evidence that the filter stayed narrow.
  const byCategory = new Map();
  for (const item of refuse) {
    if (!byCategory.has(item.category)) byCategory.set(item.category, []);
    byCategory.get(item.category).push(item);
  }
  for (const [cat, items] of byCategory) {
    console.log(`  REFUSED — ${cat} (${items.length}):`);
    for (const { row, reason } of items.slice(0, 40)) {
      console.log(`    ${short(row.marker, 18).padEnd(18)} ${String(row.rectype).padEnd(5)} ${short(reason, 82)}`);
    }
    if (items.length > 40) console.log(`    … and ${items.length - 40} more`);
    console.log('');
  }

  if (!release.length) {
    console.log('Nothing to release. No row was proven absent from LP.');
    return;
  }

  const callIds = [...new Set(release.map(({ row }) => row.call_id))];
  console.log(`  RELEASE (${release.length}) across ${callIds.length} call(s) — proven absent by a successful read:`);
  for (const { row } of release) {
    console.log(`    ${short(row.marker, 18).padEnd(18)} ${String(row.rectype).padEnd(5)} sent ${row.synced_at} to ${row.recid}`);
  }

  const { data: calls, error: cErr } = await supabase
    .from('ci_calls')
    .select('id, five9_call_id, status, review_reason, attempts')
    .in('id', callIds);
  if (cErr) throw new Error(`ci_calls read failed: ${cErr.message}`);

  const toReset = planParentReset(calls || [], callIds);
  console.log(`\n  parent calls: ${(calls || []).length} read, ${toReset.length} to reset to 'syncing'`);

  if (!args.execute) {
    console.log('\nDRY-RUN complete. No writes performed.');
    return;
  }

  console.log('');
  await assertLpInstance(supabase);

  let released = 0;
  const failures = [];
  for (const { row, reason } of release) {
    try {
      await releaseOne(supabase, row, reason);
      released += 1;
      console.log(`  released lp key for call ${row.call_id}`);
    } catch (err) {
      // One stubborn row must not abandon the rest half-done.
      failures.push({ id: row.sync_id, error: err.message });
      console.error(`  ${row.sync_id} NOT released: ${err.message}`);
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
  console.log('The next worker tick re-claims these calls and writes the note onto the PROSPECT.');
  if (failures.length) {
    console.log(`\n${failures.length} item(s) FAILED:`);
    for (const f of failures) console.log(`  ${f.id}: ${f.error}`);
    process.exitCode = 1;
  }
}

// Only run as a script — the pure planners are imported by tests.
const isMain = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  main().catch((err) => { console.error(`\nFAILED: ${err.message}`); process.exit(1); });
}
