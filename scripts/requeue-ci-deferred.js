#!/usr/bin/env node
/**
 * Requeue the DNC / cancellation backlog so it gets BOTH — scripts/requeue-ci-deferred.js
 *
 * Usage:
 *   node scripts/requeue-ci-deferred.js                       # dry-run
 *   node scripts/requeue-ci-deferred.js --execute
 *   node scripts/requeue-ci-deferred.js --reason=dnc_request --limit=5
 *
 * ── WHY THIS EXISTS AND WHY IT IS NOT `requeue-ci-review.js --reason=…` ────
 * sql/073 made a DNC or cancellation request deliver its note and THEN queue
 * for a human. That behaviour is driven by ci_calls.pending_review_reason,
 * which stageAnalyze sets — and a requeued backlog call never re-runs
 * stageAnalyze.
 *
 * resumeStatusFor() resolves these calls to 'analyzed' (they all have a
 * current summary), which dispatches MATCH, not analyze. So the plain requeue
 * delivers 85 notes and then COMPLETES every call, while applyResolve clears
 * review_reason — the backlog quietly empties out of the review queue and
 * nobody is left prompted to action a customer's "take me off your list".
 *
 * That is the opposite of the decision sql/073 implements. This script carries
 * the reason across the gap: it copies review_reason into
 * pending_review_reason FIRST, then requeues, so stageSync finds it and parks
 * the call again after the note lands.
 *
 * ── THE ORDER IS THE WHOLE SAFETY PROPERTY ────────────────────────────────
 * Column first, requeue second, per call. Interrupted between them, the call
 * is still parked in review with a pending reason set — harmless, and a re-run
 * of this script is idempotent. Interrupted the other way round, the call is
 * in flight with NO reason, completes, and the customer's request is lost from
 * the queue with nothing to indicate it ever existed. So a failed column write
 * SKIPS that call's requeue rather than proceeding without it.
 *
 * ── THE REQUEUE ITSELF GOES THROUGH applyResolve ──────────────────────────
 * Same reason requeue-ci-review.js does (see its docblock): a bulk requeue
 * written as its own UPDATE is how `attempts = 0` gets forgotten or a call is
 * sent back to the wrong stage, and neither failure announces itself.
 * pending_review_reason is a separate additive write because applyResolve does
 * not own that column — deliberately, since nothing else should set it.
 *
 * ── IT REFUSES ANY REASON OUTSIDE THE DEFERRED SET ────────────────────────
 * Only the reasons in DEFER_REVIEW_UNTIL_SYNCED are eligible. Copying any
 * other review_reason into pending_review_reason would make stageSync park a
 * call on a reason the pipeline never intended to defer — for instance
 * re-parking a low-confidence transcript AFTER writing the note it was parked
 * to prevent.
 *
 * NOTHING IS AUTO-ACTIONED. This makes the requests visible on the customer
 * record and keeps them queued. No tag, no DNC write, no cancellation.
 *
 * Pre-conditions:
 *   - SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY set (for --execute)
 *   - sql/073 applied (the column must exist)
 *   - Mark has reviewed the dry-run output before --execute
 */

import { applyResolve, resumeStatusFor } from '../src/ci/routes.js';
import { DEFER_REVIEW_UNTIL_SYNCED } from '../src/ci/analysis-schema.js';

const ARGV = process.argv.slice(2);

/** The reasons this script may touch. One source, shared with the pipeline. */
export const ELIGIBLE_REASONS = [...DEFER_REVIEW_UNTIL_SYNCED];

/** Parse the flags. Pure — argv is an argument, so the rules are testable. */
export function parseArgs(argv) {
  const reasons = [];
  let execute = false;
  let limit = null;

  for (const a of argv || []) {
    if (a === '--execute') execute = true;
    else if (a.startsWith('--reason=')) {
      const v = a.slice('--reason='.length).trim();
      if (v) reasons.push(v);
    } else if (a.startsWith('--limit=')) {
      const n = parseInt(a.slice('--limit='.length), 10);
      if (Number.isFinite(n) && n > 0) limit = n;
    }
  }
  return { reasons, execute, limit };
}

/**
 * Turn the flags into a decision, or into the reason it is refused. Pure.
 *
 * No flags selects the WHOLE deferred set — that is the intended use, and it
 * is safe precisely because the set is closed. There is no `--all` here for
 * the same reason: there is nothing broader this script may legitimately do.
 */
export function planSelection({ reasons = [], limit = null } = {}) {
  const chosen = reasons.length ? reasons : ELIGIBLE_REASONS;
  const bad = chosen.filter((r) => !DEFER_REVIEW_UNTIL_SYNCED.has(r));
  if (bad.length) {
    return {
      ok: false,
      error: `refusing [${bad.join(', ')}] — only ${ELIGIBLE_REASONS.join(', ')} may be carried into `
        + 'pending_review_reason; anything else would park a call on a reason the pipeline never deferred',
      reasons: chosen,
      limit,
    };
  }
  return { ok: true, reasons: chosen, limit };
}

/**
 * Carry one call's review_reason into pending_review_reason, then requeue it.
 *
 * Returns what happened, never throws for a per-call failure: one bad call
 * must not abandon the rest of the batch half-done.
 *
 * `resolve` is injected so a test can prove the ORDER — specifically that a
 * failed column write leaves the call parked and does NOT requeue it.
 */
export async function requeueOne(db, call, { resolve = applyResolve } = {}) {
  const { error } = await db.from('ci_calls')
    .update({ pending_review_reason: call.review_reason })
    .eq('id', call.id);
  if (error) {
    // Do NOT requeue. In flight with no reason is the one outcome worse than
    // leaving the call exactly where it is.
    return { ok: false, requeued: false, error: `pending_review_reason write failed: ${error.message}` };
  }

  try {
    const { status } = await resolve(db, call, 'retry');
    return { ok: true, requeued: true, status, carried: call.review_reason };
  } catch (err) {
    // The column is set and the call is still parked. Re-running is safe.
    return { ok: false, requeued: false, error: `requeue failed: ${err.message}` };
  }
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

/** sql/073 must be applied, or every carry write rejects on an unknown column. */
async function assertColumnExists(supabase) {
  const { error } = await supabase.from('ci_calls').select('pending_review_reason').limit(1);
  if (error) {
    console.error('Refusing to run: ci_calls.pending_review_reason is not readable.');
    console.error(`  probe -> ${error.message}`);
    console.error('  Apply sql/073_ci_pending_review_reason.sql first.');
    process.exit(1);
  }
}

async function main() {
  const args = parseArgs(ARGV);
  const plan = planSelection(args);
  if (!plan.ok) {
    console.error(`requeue-ci-deferred: ${plan.error}`);
    process.exit(1);
  }

  const { default: supabase } = await import('../src/supabase.js');
  if (!supabase) {
    console.error('Supabase not configured (SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY missing).');
    process.exit(1);
  }

  console.log(`requeue-ci-deferred ${args.execute ? '--execute' : '(DRY-RUN — no writes; pass --execute after review)'}`);
  console.log(`  selecting: review_reason in [${plan.reasons.join(', ')}]${plan.limit ? `, limit ${plan.limit}` : ''}`);
  console.log('  each call: pending_review_reason <- review_reason, THEN requeue\n');

  await assertColumnExists(supabase);

  let q = supabase
    .from('ci_calls')
    .select('id, five9_call_id, review_reason, pending_review_reason, attempts, status')
    .eq('status', 'review')
    .in('review_reason', plan.reasons)
    .order('call_start', { ascending: true });
  if (plan.limit) q = q.limit(plan.limit);

  const { data: calls, error } = await q;
  if (error) throw new Error(`ci_calls read failed: ${error.message}`);

  if (!calls?.length) {
    console.log('Nothing selected — no reviewed call carries a deferred reason.');
    return;
  }

  // The dry run shows where each call lands AND what reason it will carry,
  // before anything is written. A requeue whose destination is a surprise is
  // not reviewable.
  console.log(`${calls.length} call(s) selected:\n`);
  console.log(`  ${'five9_call_id'.padEnd(20)} ${'reason to carry'.padEnd(22)} attempts  resumes at`);
  const planned = [];
  for (const c of calls) {
    const resume = await resumeStatusFor(supabase, c.id);
    planned.push({ ...c, resume });
    console.log(
      `  ${String(c.five9_call_id ?? c.id).padEnd(20)} ${String(c.review_reason ?? '—').padEnd(22)}`
      + ` ${String(c.attempts ?? 0).padEnd(8)} ${resume}`,
    );
  }

  const byReason = planned.reduce((a, p) => ({ ...a, [p.review_reason]: (a[p.review_reason] || 0) + 1 }), {});
  console.log(`\n  carrying: ${Object.entries(byReason).map(([k, v]) => `${k}=${v}`).join('  ')}`);
  console.log('  after the note lands, stageSync parks each call again on that reason');
  console.log('  (attempts reset to 0 on every requeue, exactly as the endpoint does)');

  const notAnalyzed = planned.filter((p) => p.resume !== 'analyzed');
  if (notAnalyzed.length) {
    // These re-run stageAnalyze, which sets pending_review_reason itself. The
    // carry is harmless there (analyze overwrites it), but worth naming so the
    // dry run does not look like it is doing something it is not.
    console.log(`\n  note: ${notAnalyzed.length} call(s) resume BEFORE analyze and will set the reason themselves`);
  }

  if (!args.execute) {
    console.log('\nDRY-RUN complete. No writes performed.');
    return;
  }

  await assertLpInstance(supabase);

  let done = 0;
  const failures = [];
  for (const c of planned) {
    const r = await requeueOne(supabase, c);
    if (r.ok) {
      done += 1;
      console.log(`  ${c.five9_call_id ?? c.id} -> ${r.status} (carrying ${r.carried})`);
    } else {
      failures.push({ call: c.five9_call_id ?? c.id, error: r.error });
      console.error(`  ${c.five9_call_id ?? c.id} FAILED: ${r.error}`);
    }
  }

  console.log(`\nRequeued ${done}/${planned.length} call(s), each carrying its reason to sync.`);
  if (failures.length) {
    console.log(`${failures.length} failed and are STILL in review:`);
    for (const f of failures) console.log(`  ${f.call}: ${f.error}`);
    process.exitCode = 1;
  }
}

// Only run as a script — the pure helpers are imported by tests.
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error('requeue-ci-deferred failed:', err.message);
    process.exit(1);
  });
}
