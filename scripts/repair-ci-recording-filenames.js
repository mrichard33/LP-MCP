#!/usr/bin/env node
/**
 * Re-parse recording filenames written during the format break
 * scripts/repair-ci-recording-filenames.js
 *
 * On 2026-08-22 the Five9 export began appending an identifier to every
 * recording filename — 32 hex characters plus 15 digits, abutting whatever
 * precedes it with no separator. On a plain agent call it glued onto the clock
 * and the name stopped parsing entirely (that is the outage this PR fixes). On
 * a TRANSFER LEG it landed inside the ivr_module token, so the file still
 * parsed and was ingested — with a corrupted module:
 *
 *   stored     Transfer to LightfireCB3E712B7E084D8A9BD23381B216E482300000002866719
 *   should be  Transfer to Lightfire
 *
 * That is not cosmetic. ci_transfer_target_map holds exactly one label,
 * 'Transfer to Lightfire', and classifyTeam matches it by EXACT equality — so
 * every one of these rows failed the lookup and fell through to the agent map
 * (empty on a transfer leg by design) and then the campaign map. Measured
 * 2026-08-25: before the boundary 101 rows carried 2 distinct module values;
 * after it, 20 rows carried 20 distinct values, one per file.
 *
 * The parser fix corrects everything ingested from now on. It cannot correct
 * rows already stored, which is what this is for.
 *
 * Usage:
 *   node scripts/repair-ci-recording-filenames.js             # dry-run
 *   node scripts/repair-ci-recording-filenames.js --execute   # apply
 *
 * ── WHY A SCRIPT AND NOT A MIGRATION ───────────────────────────────────────
 * Same reasoning as repair-ci-teams.js: a data UPDATE in runMigrations() would
 * re-run on every boot forever for a one-time correction, and would rewrite
 * rows on a deploy nobody connected to this repair. Migrations here are
 * additive DDL; correcting data is a deliberate act with a dry run in front.
 *
 * ── WHAT IT WILL NOT TOUCH ─────────────────────────────────────────────────
 * ONLY ivr_module and five9_recording_id, and only where re-parsing the stored
 * source_filename actually disagrees with what is stored. Not call_id, not the
 * match, not storage_path, not link_token — rotating a token would break every
 * recording link already pasted into an LP or GHL note. Not fetched_at either:
 * a repair must not look like pipeline activity in the audit trail.
 */

import { parseRecordingFilename } from '../src/ci/filenames.js';

const EXECUTE = process.argv.includes('--execute');

/**
 * Decide what to change. Pure — rows in, plan out — so every boundary is
 * testable without a database.
 *
 * A row is only rewritten when the re-parse DISAGREES with what is stored.
 * Re-writing a row to the value it already holds is noise in the audit trail
 * and makes a second run look like it found work to do.
 *
 * @returns {{changes: Array, skipped: {unparseable: number, already_correct: number}}}
 */
export function planFilenameRepairs(rows) {
  const changes = [];
  const skipped = { unparseable: 0, already_correct: 0 };

  for (const r of rows || []) {
    const parsed = parseRecordingFilename(r?.source_filename);

    // Still unreadable after the fix. That is a REPORT, not a silent skip:
    // it means the archive holds a third filename shape nobody has accounted
    // for, and the counting path added in PR 1 should already be alarming.
    if (!parsed) { skipped.unparseable += 1; continue; }

    const moduleChanged = (parsed.ivrModule ?? null) !== (r.ivr_module ?? null);
    const idChanged = (parsed.sessionId ?? null) !== (r.five9_recording_id ?? null);
    if (!moduleChanged && !idChanged) { skipped.already_correct += 1; continue; }

    changes.push({
      id: r.id,
      source_filename: r.source_filename,
      module_from: r.ivr_module ?? null,
      module_to: parsed.ivrModule ?? null,
      id_from: r.five9_recording_id ?? null,
      id_to: parsed.sessionId ?? null,
    });
  }

  return { changes, skipped };
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

/** Last 4 only in output — a filename starts with the customer's full number. */
function maskFilename(name) {
  return String(name ?? '').replace(/^(\d{3,15})/, (m) => `x${m.slice(-4)}`);
}

async function main() {
  const { default: supabase } = await import('../src/supabase.js');
  if (!supabase) {
    console.error('Supabase not configured (SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY missing).');
    process.exit(1);
  }

  console.log(`repair-ci-recording-filenames ${EXECUTE ? '--execute' : '(DRY-RUN — no writes; pass --execute after review)'}\n`);

  // Every row with a module, both eras. Deliberately NOT filtered to the
  // post-boundary window: the point is to let the re-parse decide, so a row
  // the boundary theory did not predict still shows up in the plan.
  const { data: rows, error } = await supabase
    .from('ci_recordings')
    .select('id, source_filename, ivr_module, five9_recording_id')
    .not('source_filename', 'is', null)
    .limit(5000);
  if (error) throw new Error(`ci_recordings read failed: ${error.message}`);

  const { changes, skipped } = planFilenameRepairs(rows || []);

  console.log(`ci_recordings rows examined: ${(rows || []).length}`);
  console.log(`  already correct: ${skipped.already_correct}`);
  console.log(`  STILL UNPARSEABLE after the fix: ${skipped.unparseable}`);
  console.log(`  to repair: ${changes.length}\n`);

  if (skipped.unparseable > 0) {
    console.warn(
      `  ⚠ ${skipped.unparseable} stored filename(s) do not parse even with the repaired parser.\n`
      + '    That means a filename shape nobody has accounted for. Investigate before\n'
      + '    treating this repair as complete.\n',
    );
  }

  if (changes.length) {
    console.log('PROPOSED CHANGES — every one, not a sample:');
    for (const c of changes) {
      console.log(`  ${maskFilename(c.source_filename)}`);
      if (c.module_from !== c.module_to) {
        console.log(`      ivr_module         ${JSON.stringify(c.module_from)} -> ${JSON.stringify(c.module_to)}`);
      }
      if (c.id_from !== c.id_to) {
        console.log(`      five9_recording_id ${JSON.stringify(c.id_from)} -> ${JSON.stringify(c.id_to)}`);
      }
    }
  } else {
    console.log('Nothing to repair.');
  }

  if (!EXECUTE) {
    console.log('\nDRY-RUN complete. No writes performed.');
    return;
  }
  if (!changes.length) return;

  await assertLpInstance(supabase);

  // One statement per row. The values differ per row, so there is no grouping
  // to exploit, and 20 rows does not justify a bulk upsert that could touch a
  // column this repair has no business writing.
  let written = 0;
  for (const c of changes) {
    const { error: updErr } = await supabase
      .from('ci_recordings')
      .update({ ivr_module: c.module_to, five9_recording_id: c.id_to })
      .eq('id', c.id);
    if (updErr) throw new Error(`ci_recordings update failed for ${c.id}: ${updErr.message}`);
    written += 1;
  }
  console.log(`\nRepair complete: ${written} row(s). Re-run to confirm it reports nothing to do.`);
  console.log('Then re-check team attribution — these rows can now match ci_transfer_target_map.');
}

// Only run as a script — planFilenameRepairs is imported by tests.
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error('repair-ci-recording-filenames failed:', err.message);
    process.exit(1);
  });
}
