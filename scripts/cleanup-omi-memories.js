#!/usr/bin/env node
/**
 * Cleanup — Omi memory rows, after the ruling to stop ingesting them
 * scripts/cleanup-omi-memories.js
 *
 * Mark's ruling 2026-09-16: LP-MCP stops pulling Omi's personal-fact
 * "memories" (OMI_PULL_MEMORIES, default false). This script deals with the 277
 * that were already filed — rows like "The user is using Claude as an AI
 * assistant" and "The user interacts with a person named Reece" (wrong; Reece is
 * the company), 30 of them generated from screenshots rather than speech, 232 of
 * them embedded and degrading memory_search.
 *
 * IT DELETES NOTHING. Mark's standing rule is mark-never-delete: every row is
 * closed with status 'dropped' and a closed_reason that says why, so the history
 * of what Omi heard survives even though it no longer shows up as open work.
 * Closed rows are already hidden from memory_search and from the embeddings
 * default, so the search pollution clears with no embedding rebuild — the
 * nightly re-syncs the embedding metadata on its own.
 *
 * DRY-RUN BY DEFAULT. Pass --execute to write. That is the repo's convention for
 * anything that writes a production column (see audit-orphan-ghl-links.js, which
 * documents the split), and it inverts the backfill-*.js default deliberately.
 *
 * WHY THE RAW SUPABASE CLIENT rather than guardedDb. The Omi scope guard in
 * src/memory/omi-db.js does permit claude_pending_items.update, but its own
 * comment scopes that verb to ONE column — omi_action_item_id, the write-back
 * loop guard — and says anything else updating a pending item from the Omi path
 * is a bug. This is an operator script, not the Omi request path, and closing
 * rows is exactly the "anything else" that comment rules out. Going through the
 * guard would read as sanctioned when it is not; going around it, and saying so
 * here, is the honest shape.
 *
 * Usage:
 *   node scripts/cleanup-omi-memories.js            # dry run — reports only
 *   node scripts/cleanup-omi-memories.js --execute  # WRITES: closes the rows
 *
 * Requires SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in the shell (nothing in
 * this import chain loads dotenv) — or run it via `railway run`.
 */
import { pathToFileURL } from 'node:url';
import supabaseDefault from '../src/supabase.js';

const CLOSED_BY = 'cleanup';
const CLOSED_REASON = 'omi memories no longer ingested — ruling 2026-09-16';
const OPEN_STATUSES = ['open', 'blocked'];
const PAGE_SIZE = 1000;
const BATCH_SIZE = 50;

/** Every open Omi memory row, paged. */
async function loadMemoryRows(supabase) {
  const rows = [];
  for (let from = 0; ; from += PAGE_SIZE) {
    const { data, error } = await supabase
      .from('claude_pending_items')
      .select('id, description, status, omi_action_item_id')
      .eq('origin', 'omi')
      .eq('raw->>source_type', 'memory')
      .in('status', OPEN_STATUSES)
      .order('id', { ascending: true })
      .range(from, from + PAGE_SIZE - 1);
    if (error) throw new Error(`claude_pending_items read failed: ${error.message}`);
    rows.push(...(data || []));
    if (!data || data.length < PAGE_SIZE) break;
  }
  return rows;
}

/** How many Omi memory rows sit in each status right now — the before/after line. */
async function counts(supabase) {
  const one = async (status) => {
    const q = supabase
      .from('claude_pending_items')
      .select('id', { count: 'exact', head: true })
      .eq('origin', 'omi')
      .eq('raw->>source_type', 'memory');
    const { count, error } = status === 'open' ? await q.in('status', OPEN_STATUSES) : await q.eq('status', status);
    if (error) throw new Error(`count (${status}) failed: ${error.message}`);
    return count ?? 0;
  };
  return { open: await one('open'), dropped: await one('dropped') };
}

export async function main(deps = {}) {
  const supabase = deps.supabase || supabaseDefault;
  const argv = deps.argv || process.argv.slice(2);
  const log = deps.log || console.log;
  const warn = deps.warn || console.warn;
  const execute = argv.includes('--execute');

  if (!supabase) {
    throw new Error('No Supabase client (SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY unset). Set them in the shell, or run via `railway run`.');
  }

  log(`\n═══ Omi memory cleanup — ${execute ? 'EXECUTE' : 'DRY-RUN'} ═══`);
  log(`Ruling 2026-09-16 · closes rows, deletes nothing\n`);

  const before = await counts(supabase);
  log(`Omi memory rows open (open|blocked) : ${before.open}`);
  log(`Omi memory rows already dropped     : ${before.dropped}\n`);

  const rows = await loadMemoryRows(supabase);
  log(`Selected for closing: ${rows.length}`);

  // The guard. A memory that was pushed to Omi as a task is a row on Mark's
  // Tasks page, and closing it here would strand that task with nothing on this
  // side pointing at it. Zero rows carry one today (verified 2026-09-16); this
  // exists so a FUTURE state where they do stops the run instead of quietly
  // half-doing it. Abort the WHOLE run rather than skipping the offenders —
  // a partial cleanup nobody was told about is worse than none.
  const pushed = rows.filter((r) => r.omi_action_item_id != null);
  if (pushed.length) {
    warn(`\nABORT — ${pushed.length} selected row(s) carry an omi_action_item_id, meaning they exist as tasks on Omi's Tasks page:`);
    for (const r of pushed) warn(`  id ${r.id}  omi_action_item_id ${r.omi_action_item_id}`);
    warn('\nNothing was written. Decide what should happen to those Omi tasks first.');
    return { ok: false, aborted: 'pushed_to_omi', pushed: pushed.map((r) => r.id), before, closed: 0 };
  }
  log('None carry an omi_action_item_id — nothing on Omi\'s Tasks page is affected.');

  if (!execute) {
    log(`\nDRY-RUN complete — nothing written. Re-run with --execute to close these ${rows.length} row(s).\n`);
    return { ok: true, dry_run: true, selected: rows.length, before, closed: 0 };
  }
  if (!rows.length) {
    log('\n--execute given but nothing is open — nothing to do.\n');
    return { ok: true, dry_run: false, selected: 0, before, closed: 0 };
  }

  const closedAt = new Date().toISOString();
  let closed = 0;
  const errors = [];
  for (let i = 0; i < rows.length; i += BATCH_SIZE) {
    const batch = rows.slice(i, i + BATCH_SIZE);
    const ids = batch.map((r) => r.id);
    const { error } = await supabase
      .from('claude_pending_items')
      .update({ status: 'dropped', closed_by: CLOSED_BY, closed_reason: CLOSED_REASON, closed_at: closedAt, updated_at: closedAt })
      .in('id', ids);
    if (error) {
      errors.push(`ids ${ids[0]}–${ids[ids.length - 1]}: ${error.message}`);
      warn(`  ✗ batch ${ids[0]}–${ids[ids.length - 1]} failed: ${error.message}`);
      continue;
    }
    closed += ids.length;
    log(`  ✓ closed ${ids.length} (${closed}/${rows.length})`);
  }

  const after = await counts(supabase);
  log(`\n── After ──`);
  log(`Omi memory rows open (open|blocked) : ${after.open}`);
  log(`Omi memory rows dropped             : ${after.dropped}`);
  log(`Rows deleted                        : 0`);
  if (errors.length) log(`Batches that failed                 : ${errors.length}`);
  log('');

  return { ok: errors.length === 0, dry_run: false, selected: rows.length, before, after, closed, errors };
}

// pathToFileURL, not `file://${process.argv[1]}` — the latter mis-encodes paths
// with spaces and is wrong on Windows.
if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main()
    .then((res) => { process.exit(res.ok ? 0 : 1); })
    .catch((err) => { console.error(`[cleanup-omi-memories] fatal: ${err.stack || err.message}`); process.exit(1); });
}

export default main;
