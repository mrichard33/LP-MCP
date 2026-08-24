#!/usr/bin/env node
/**
 * Requeue calls out of the review queue — scripts/requeue-ci-review.js
 *
 * 30 calls are parked in review. Resolving them one HTTP call at a time is not
 * repeatable, and Mark needs this again after every discovery backfill.
 *
 * Usage:
 *   node scripts/requeue-ci-review.js --reason=unknown_team                    # dry-run
 *   node scripts/requeue-ci-review.js --reason=unknown_team --execute
 *   node scripts/requeue-ci-review.js --reason=a --reason=b --limit=5
 *   node scripts/requeue-ci-review.js --all --confirm --execute
 *
 * Flags:
 *   --reason=<review_reason>  repeatable; requeue only these reasons
 *   --all                     every reviewed call, whatever the reason
 *   --confirm                 REQUIRED alongside --all
 *   --limit=N                 cap the batch
 *   --execute                 actually write; omitted, nothing is written
 *
 * ── IT DOES NOT WRITE ITS OWN UPDATE ───────────────────────────────────────
 * Every write goes through applyResolve() from src/ci/routes.js — the exact
 * function POST /ci/review/:call_id/resolve calls. This is not tidiness. A
 * bulk requeue written as its own UPDATE is how `attempts = 0` gets forgotten,
 * or how a call gets sent back to the wrong stage — and neither failure
 * announces itself. The calls simply re-fail, or re-buy a transcript that
 * already exists, and the queue looks like the requeue did nothing.
 *
 * resumeStatusFor() derives the resume stage from the ARTIFACTS on disk:
 *   a current summary  -> analyzed     (re-match, transcript NOT re-bought)
 *   a transcript       -> transcribed  (re-analyze)
 *   a recording        -> fetched      (re-transcribe)
 *   nothing            -> discovered
 *
 * ── --all NEEDS --confirm TOO ──────────────────────────────────────────────
 * A fat-fingered `--all --execute` would requeue the entire queue, including
 * the calls that are parked precisely because retrying them just re-fails
 * (recording_missing has no recording to find). Two flags, deliberately.
 *
 * Pre-conditions:
 *   - SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY set (for --execute)
 *   - Mark has reviewed the dry-run output before --execute
 */

import { applyResolve, resumeStatusFor } from '../src/ci/routes.js';

const ARGV = process.argv.slice(2);

/** Parse the flags. Pure — argv is an argument, so the rules are testable. */
export function parseArgs(argv) {
  const reasons = [];
  let all = false;
  let confirm = false;
  let execute = false;
  let limit = null;

  for (const a of argv || []) {
    if (a === '--all') all = true;
    else if (a === '--confirm') confirm = true;
    else if (a === '--execute') execute = true;
    else if (a.startsWith('--reason=')) {
      const v = a.slice('--reason='.length).trim();
      if (v) reasons.push(v);
    } else if (a.startsWith('--limit=')) {
      const n = parseInt(a.slice('--limit='.length), 10);
      if (Number.isFinite(n) && n > 0) limit = n;
    }
  }
  return { reasons, all, confirm, execute, limit };
}

/**
 * Turn the flags into a decision, or into the reason it is refused.
 *
 * Refusing is a RESULT, not an exception, so the refusals are testable and so
 * main() can print one clean message rather than a stack trace.
 *
 * @returns {{ok: boolean, error?: string, reasons: string[], all: boolean, limit: number|null}}
 */
export function planSelection({ reasons, all, confirm, limit }) {
  if (all && reasons.length) {
    return { ok: false, error: '--all and --reason are mutually exclusive — pick one', reasons, all, limit };
  }
  if (!all && !reasons.length) {
    return {
      ok: false,
      error: 'nothing selected — pass --reason=<review_reason> (repeatable), or --all --confirm',
      reasons, all, limit,
    };
  }
  if (all && !confirm) {
    return {
      ok: false,
      error: '--all requeues EVERY reviewed call, including ones that will just re-fail. Add --confirm if you mean it.',
      reasons, all, limit,
    };
  }
  return { ok: true, reasons, all, limit };
}

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

async function main() {
  const args = parseArgs(ARGV);
  const plan = planSelection(args);
  if (!plan.ok) {
    console.error(`requeue-ci-review: ${plan.error}`);
    process.exit(1);
  }

  const { default: supabase } = await import('../src/supabase.js');
  if (!supabase) {
    console.error('Supabase not configured (SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY missing).');
    process.exit(1);
  }

  console.log(`requeue-ci-review ${args.execute ? '--execute' : '(DRY-RUN — no writes; pass --execute after review)'}`);
  console.log(`  selecting: ${plan.all ? 'ALL reviewed calls' : `review_reason in [${plan.reasons.join(', ')}]`}`
    + `${plan.limit ? `, limit ${plan.limit}` : ''}\n`);

  let q = supabase
    .from('ci_calls')
    .select('id, five9_call_id, review_reason, attempts, status')
    .eq('status', 'review')
    .order('call_start', { ascending: true });
  if (!plan.all) q = q.in('review_reason', plan.reasons);
  if (plan.limit) q = q.limit(plan.limit);

  const { data: calls, error } = await q;
  if (error) throw new Error(`ci_calls read failed: ${error.message}`);

  if (!calls?.length) {
    console.log('Nothing selected — no reviewed call matches.');
    return;
  }

  // The resume stage is derived per call from its artifacts, so the dry run
  // shows exactly where each one will land BEFORE anything is written. A
  // requeue whose destination is a surprise is not reviewable.
  console.log(`${calls.length} call(s) selected:\n`);
  console.log(`  ${'five9_call_id'.padEnd(20)} ${'current reason'.padEnd(26)} attempts  resumes at`);
  const planned = [];
  for (const c of calls) {
    const resume = await resumeStatusFor(supabase, c.id);
    planned.push({ ...c, resume });
    console.log(
      `  ${String(c.five9_call_id ?? c.id).padEnd(20)} ${String(c.review_reason ?? '—').padEnd(26)}`
      + ` ${String(c.attempts ?? 0).padEnd(8)} ${resume}`,
    );
  }

  const byResume = planned.reduce((a, p) => ({ ...a, [p.resume]: (a[p.resume] || 0) + 1 }), {});
  console.log(`\n  resume totals: ${Object.entries(byResume).map(([k, v]) => `${k}=${v}`).join('  ')}`);
  console.log('  (attempts reset to 0 on every requeue, exactly as the endpoint does)');

  if (!args.execute) {
    console.log('\nDRY-RUN complete. No writes performed.');
    return;
  }

  await assertLpInstance(supabase);

  let done = 0;
  const failures = [];
  for (const c of planned) {
    try {
      // The SAME function the HTTP endpoint calls. Not a copy of it.
      const { status } = await applyResolve(supabase, c, 'retry');
      done += 1;
      console.log(`  ${c.five9_call_id ?? c.id} -> ${status}`);
    } catch (err) {
      // One bad call must not abandon the rest of the batch half-done.
      failures.push({ call: c.five9_call_id ?? c.id, error: err.message });
      console.error(`  ${c.five9_call_id ?? c.id} FAILED: ${err.message}`);
    }
  }

  console.log(`\nRequeued ${done}/${planned.length} call(s).`);
  if (failures.length) {
    console.log(`${failures.length} failed and are STILL in review:`);
    for (const f of failures) console.log(`  ${f.call}: ${f.error}`);
    process.exitCode = 1;
  }
}

// Only run as a script — parseArgs/planSelection are imported by tests.
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error('requeue-ci-review failed:', err.message);
    process.exit(1);
  });
}
