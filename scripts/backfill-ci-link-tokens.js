#!/usr/bin/env node
/**
 * Backfill recording link tokens — scripts/backfill-ci-link-tokens.js
 *
 * sql/068 added ci_recordings.link_token, and ensureLinkToken() mints one at
 * STORE TIME. Every recording ingested before that migration therefore has
 * link_token NULL and will never get one on its own — the fetch stage does not
 * revisit a recording it has already stored. Their notes would carry no
 * Recording: line, silently, forever.
 *
 * Measured 2026-08-24: all 10 existing ci_recordings rows are in that state.
 * New recordings are fine; this is a one-time catch-up for the ones that
 * predate the column.
 *
 * Usage:
 *   node scripts/backfill-ci-link-tokens.js             # dry-run: report only
 *   node scripts/backfill-ci-link-tokens.js --execute   # mint and write
 *
 * Pre-conditions:
 *   - sql/068 applied (link_token, link_expires_at, the UNIQUE index)
 *   - SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY set (for --execute)
 *   - Mark has reviewed the dry-run output before --execute
 *
 * ── WHY THIS REUSES recordings.js RATHER THAN MINTING ITS OWN ──────────────
 * mintLinkToken() and linkExpiresAt() are IMPORTED, never reimplemented. The
 * token is the entire access control on a public route; a second generator in
 * a script is exactly how one of the two ends up weaker than the other and
 * nobody notices, because both "work".
 *
 * ── WHAT IT REFUSES TO DO ──────────────────────────────────────────────────
 * It never overwrites a non-null link_token. A rotated token silently breaks
 * every link already pasted into a CRM note — no error, no log, just a dead
 * URL on a customer record. The filter is `link_token IS NULL` and the UPDATE
 * re-asserts it.
 *
 * ── EXPIRY IS DERIVED, NOT REFRESHED ───────────────────────────────────────
 * link_expires_at = fetched_at + CI_AUDIO_RETENTION_DAYS, the same rule the
 * live path uses. A recording whose fetched_at is already older than the
 * retention window gets a token anyway and simply reads as expired. It is NOT
 * skipped and its expiry is NOT extended to make it live: the audio is gone or
 * about to be, and handing out a working link to a purged object would be a
 * 404 dressed up as a feature.
 */

import {
  mintLinkToken,
  linkExpiresAt,
} from '../src/ci/recordings.js';
import { getConfig } from '../src/ci/config.js';

const EXECUTE = process.argv.includes('--execute');

/**
 * Decide what to mint. Pure — rows and config are arguments, so every boundary
 * is testable without a database.
 *
 * The filters repeat the ones in the query on purpose: the query narrows what
 * is fetched, this decides what is written. A backfill that trusts only its
 * own WHERE clause is one refactor away from rotating live tokens.
 *
 * @returns {{changes: Array, skipped: {has_token: number, purged: number, no_object: number}}}
 */
export function planLinkTokens(rows, { cfg = getConfig(), now = new Date() } = {}) {
  const changes = [];
  const skipped = { has_token: 0, purged: 0, no_object: 0 };

  for (const r of rows || []) {
    if (r?.link_token) { skipped.has_token += 1; continue; }
    if (r?.purged_at) { skipped.purged += 1; continue; }
    if (!r?.storage_path) { skipped.no_object += 1; continue; }

    const expires = linkExpiresAt(r.fetched_at, cfg);
    const expiresAt = expires ? expires.toISOString() : null;

    changes.push({
      id: r.id,
      call_id: r.call_id ?? null,
      source_filename: r.source_filename ?? null,
      fetched_at: r.fetched_at ?? null,
      token: mintLinkToken(),
      expiresAt,
      // Surfaced so the dry run can say plainly which links will be born dead
      // rather than leaving Mark to work it out from two timestamps.
      alreadyExpired: Boolean(expiresAt && new Date(expiresAt).getTime() <= now.getTime()),
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
    console.error('  The ci_* tables live on the LP instance only. Point SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY at it and re-run.');
    process.exit(1);
  }
  console.log(`  target instance OK (${host}, lp_leads reachable)`);
}

async function main() {
  const { default: supabase } = await import('../src/supabase.js');
  if (!supabase) {
    console.error('Supabase not configured (SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY missing).');
    process.exit(1);
  }
  const cfg = getConfig();

  console.log(`backfill-ci-link-tokens ${EXECUTE ? '--execute' : '(DRY-RUN — no writes; pass --execute after review)'}`);
  console.log(`  retention: ${cfg.audioRetentionDays} day(s) — link_expires_at = fetched_at + that\n`);

  const { data: rows, error } = await supabase
    .from('ci_recordings')
    .select('id, call_id, source_filename, storage_path, fetched_at, purged_at, link_token, link_expires_at')
    .is('link_token', null)
    .is('purged_at', null)
    .not('storage_path', 'is', null)
    .limit(5000);
  if (error) throw new Error(`ci_recordings read failed: ${error.message}`);

  const { changes, skipped } = planLinkTokens(rows || [], { cfg });

  console.log(`ci_recordings with no link_token, not purged, with an object: ${(rows || []).length}`);
  console.log(`  to be tokened: ${changes.length}`);
  if (skipped.has_token || skipped.purged || skipped.no_object) {
    console.log(`  skipped in planning — existing token ${skipped.has_token}, purged ${skipped.purged}, no object ${skipped.no_object}`);
  }

  if (changes.length) {
    console.log('\nPROPOSED — every row, not a sample (tokens shown by PREFIX only):');
    for (const c of changes) {
      console.log(
        `  ${String(c.source_filename ?? c.id).slice(0, 44).padEnd(46)}`
        + ` fetched ${String(c.fetched_at ?? '?').slice(0, 10)}`
        + ` -> expires ${String(c.expiresAt ?? '?').slice(0, 10)}`
        + ` token ${c.token.slice(0, 8)}…${c.alreadyExpired ? '   ⚠ ALREADY EXPIRED' : ''}`,
      );
    }
    const dead = changes.filter((c) => c.alreadyExpired).length;
    if (dead) {
      console.log(`\n  ${dead} of these are ALREADY PAST their expiry — their audio is at or past`);
      console.log('  the retention window. They are tokened anyway and will read as expired.');
      console.log('  Their expiry is deliberately NOT extended: a working link to a purged');
      console.log('  object is a 404 dressed up as a feature.');
    }
  } else {
    console.log('\nNothing to backfill — every stored, unpurged recording already has a token.');
  }

  if (!EXECUTE) {
    console.log('\nDRY-RUN complete. No writes performed.');
    return;
  }
  if (!changes.length) return;

  await assertLpInstance(supabase);

  let written = 0;
  for (const c of changes) {
    // One row at a time, each keyed on its own id AND re-asserting
    // link_token IS NULL. Tokens are unique per row, so there is no bulk form
    // of this write — and the re-assertion means a token minted by the live
    // path between the read and this write is left alone, not clobbered.
    const { data, error: updErr } = await supabase
      .from('ci_recordings')
      .update({ link_token: c.token, link_expires_at: c.expiresAt })
      .eq('id', c.id)
      .is('link_token', null)
      .select('id');
    if (updErr) throw new Error(`ci_recordings update failed for ${c.id}: ${updErr.message}`);
    if ((data || []).length) written += 1;
    else console.log(`  skipped ${c.id} — it gained a token while this ran`);
  }
  console.log(`\nBackfill complete: ${written} recording(s) tokened. Re-run to confirm it reports nothing to do.`);
}

// Only run as a script — planLinkTokens is imported by the tests.
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error('backfill-ci-link-tokens failed:', err.message);
    process.exit(1);
  });
}
