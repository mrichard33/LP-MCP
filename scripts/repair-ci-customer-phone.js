#!/usr/bin/env node
/**
 * Repair customer_phone on already-discovered calls — scripts/repair-ci-customer-phone.js
 *
 * WHY THIS EXISTS AND WHY RE-DISCOVERY IS NOT ENOUGH.
 * buildCallRow() used to set customer_phone from the ANI unconditionally. On an
 * INBOUND call the ANI is the customer, which is why every recording fetch that
 * ever succeeded was inbound. On Outbound / Manual / Preview the ANI is a Reece
 * local-presence caller ID and the DNIS is the customer — so 13,944 of 15,114
 * live rows (92%, measured 2026-08-24) name a Reece number as the customer.
 *
 * discovery.js now derives both columns from customerNumberFor(). That fixes
 * every call discovered from here on. It does NOT fix the rows already stored:
 * discoverCalls() upserts with `ignoreDuplicates: true`, deliberately, so that
 * a re-discovery cannot reset a call that is part-way through the pipeline.
 * Re-running discovery over the same window is therefore a no-op on exactly the
 * rows that need repairing. Hence a script, not a backfill of discovery.
 *
 * Usage:
 *   node scripts/repair-ci-customer-phone.js                # dry-run
 *   node scripts/repair-ci-customer-phone.js --execute      # write
 *   node scripts/repair-ci-customer-phone.js --limit=100    # cap the scan
 *
 * Flags:
 *   --execute   actually write; omitted, nothing is written
 *   --limit=N   examine at most N calls (ordered by id, so it is a sample)
 *
 * ── IT USES THE SAME HELPER DISCOVERY USES ─────────────────────────────────
 * customerNumberFor() / customerE164For() are imported from src/ci/discovery.js
 * rather than reimplemented here. A repair script with its own copy of "which
 * number is the customer" is a second implementation that can drift from the
 * first, and the drift would be invisible: rows repaired by this script and
 * rows written by discovery would simply disagree, with nothing to flag it.
 *
 * ── IT TOUCHES TWO COLUMNS, AND ONLY TWO ───────────────────────────────────
 * customer_phone and customer_phone_e164. NOT status, NOT attempts, NOT
 * locked_until / locked_by / next_retry_at, NOT review_reason. A call in flight
 * stays exactly where it is; this corrects a derived value underneath it and
 * changes nothing about the pipeline's state machine. Requeueing the calls that
 * can now find their audio is a separate, deliberate step
 * (scripts/requeue-ci-review.js --reason=recording_missing).
 *
 * ani and dnis are never written. They are the audit trail this script reads.
 *
 * ── IDEMPOTENT BY CONSTRUCTION ─────────────────────────────────────────────
 * A row is only written when the recomputed value actually DIFFERS from what is
 * stored, so a second run reports 0 changes rather than rewriting 14k rows.
 *
 * Pre-conditions:
 *   - SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY set (for --execute)
 *   - Mark has reviewed the dry-run output before --execute
 */

import { customerNumberFor, customerE164For } from '../src/ci/discovery.js';

const ARGV = process.argv.slice(2);

/** PostgREST caps a read; page through rather than silently taking the first N. */
export const PAGE_SIZE = 1000;
/** Concurrent single-row updates. Bounded so a 14k repair cannot flood the pool. */
export const WRITE_CONCURRENCY = 20;

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
 * Decide what one stored row should become. Pure.
 *
 * Returns `changed: false` when the stored values already agree with the
 * recomputed ones — which is what makes a second run a no-op, and what keeps
 * the 1,170 already-correct inbound rows from being pointlessly rewritten.
 *
 * @returns {{changed: boolean, id, five9_call_id, direction, fromPhone, toPhone, fromE164, toE164}}
 */
export function planRow(row) {
  const toPhone = customerNumberFor(row);
  const toE164 = customerE164For(row);
  return {
    changed: row?.customer_phone !== toPhone || row?.customer_phone_e164 !== toE164,
    id: row?.id,
    five9_call_id: row?.five9_call_id ?? null,
    direction: row?.direction ?? null,
    fromPhone: row?.customer_phone ?? null,
    toPhone,
    fromE164: row?.customer_phone_e164 ?? null,
    toE164,
  };
}

/** Plan a whole page. Pure — the array in, the changes out. */
export function planRepair(rows) {
  return (rows || []).map(planRow).filter((p) => p.changed);
}

/** Count planned changes by direction, for the report the handoff asks for. */
export function countByDirection(planned) {
  const out = {};
  for (const p of planned || []) {
    const k = p.direction || '(null)';
    out[k] = (out[k] || 0) + 1;
  }
  return out;
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

/**
 * Read every ci_calls row, a page at a time.
 *
 * Ordered by id so paging is stable, and only the six columns this needs are
 * selected — raw_metadata carries the full report legs and pulling it for 15k
 * rows would move a great deal of JSON for nothing.
 */
async function* readCalls(supabase, limit) {
  let from = 0;
  let seen = 0;
  for (;;) {
    const size = limit ? Math.min(PAGE_SIZE, limit - seen) : PAGE_SIZE;
    if (size <= 0) return;
    const { data, error } = await supabase
      .from('ci_calls')
      .select('id, five9_call_id, direction, ani, dnis, customer_phone, customer_phone_e164')
      .order('id', { ascending: true })
      .range(from, from + size - 1);
    if (error) throw new Error(`ci_calls read failed: ${error.message}`);
    if (!data?.length) return;
    seen += data.length;
    yield data;
    if (data.length < size) return;
    from += data.length;
  }
}

/** Write one row's two columns. Nothing else is in the payload. */
async function writeOne(supabase, p) {
  const { error } = await supabase
    .from('ci_calls')
    .update({ customer_phone: p.toPhone, customer_phone_e164: p.toE164 })
    .eq('id', p.id);
  if (error) throw new Error(error.message);
}

async function main() {
  const args = parseArgs(ARGV);

  const { default: supabase } = await import('../src/supabase.js');
  if (!supabase) {
    console.error('Supabase not configured (SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY missing).');
    process.exit(1);
  }

  console.log(`repair-ci-customer-phone ${args.execute ? '--execute' : '(DRY-RUN — no writes; pass --execute after review)'}`);
  console.log('  rule: inbound -> ANI; everything else -> DNIS, falling back to ANI when DNIS is blank');
  console.log(`  writes customer_phone and customer_phone_e164 ONLY${args.limit ? `, scanning at most ${args.limit} call(s)` : ''}\n`);

  const planned = [];
  let examined = 0;
  for await (const page of readCalls(supabase, args.limit)) {
    examined += page.length;
    planned.push(...planRepair(page));
  }

  if (!planned.length) {
    console.log(`Examined ${examined} call(s). Nothing to repair — every row already agrees with customerNumberFor().`);
    return;
  }

  const byDirection = countByDirection(planned);
  console.log(`Examined ${examined} call(s); ${planned.length} need repair.\n`);
  console.log('  by direction:');
  for (const [k, v] of Object.entries(byDirection).sort((a, b) => b[1] - a[1])) {
    console.log(`    ${String(k).padEnd(24)} ${v}`);
  }

  // A sample rather than 14k lines — enough to eyeball that the rule is doing
  // what it says before anything is written.
  console.log('\n  sample (first 10):');
  console.log(`    ${'five9_call_id'.padEnd(20)} ${'direction'.padEnd(12)} ${'from'.padEnd(14)} -> to`);
  for (const p of planned.slice(0, 10)) {
    console.log(
      `    ${String(p.five9_call_id ?? p.id).padEnd(20)} ${String(p.direction ?? '—').padEnd(12)}`
      + ` ${String(p.fromPhone ?? '—').padEnd(14)} -> ${p.toPhone ?? '—'}`,
    );
  }

  if (!args.execute) {
    console.log('\nDRY-RUN complete. No writes performed.');
    return;
  }

  console.log('');
  await assertLpInstance(supabase);

  let done = 0;
  const failures = [];
  for (let i = 0; i < planned.length; i += WRITE_CONCURRENCY) {
    const chunk = planned.slice(i, i + WRITE_CONCURRENCY);
    const results = await Promise.allSettled(chunk.map((p) => writeOne(supabase, p)));
    results.forEach((r, j) => {
      // One bad row must not abandon the rest of the batch half-done.
      if (r.status === 'fulfilled') done += 1;
      else failures.push({ call: chunk[j].five9_call_id ?? chunk[j].id, error: r.reason?.message ?? String(r.reason) });
    });
    if ((i + chunk.length) % 2000 < WRITE_CONCURRENCY) {
      console.log(`  ${i + chunk.length}/${planned.length} …`);
    }
  }

  console.log(`\nRepaired ${done}/${planned.length} call(s).`);
  console.log('  by direction:');
  for (const [k, v] of Object.entries(byDirection).sort((a, b) => b[1] - a[1])) {
    console.log(`    ${String(k).padEnd(24)} ${v}`);
  }
  if (failures.length) {
    console.log(`\n${failures.length} row(s) FAILED and still hold the old value:`);
    for (const f of failures.slice(0, 20)) console.log(`  ${f.call}: ${f.error}`);
    process.exitCode = 1;
  }
}

// Only run as a script — the pure planners are imported by tests.
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error('repair-ci-customer-phone failed:', err.message);
    process.exit(1);
  });
}
