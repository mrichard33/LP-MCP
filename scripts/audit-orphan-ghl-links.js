#!/usr/bin/env node
/**
 * Orphan GHL link audit — scripts/audit-orphan-ghl-links.js
 *
 * Finds ghl_contact_id values stored in LP that no longer resolve to a contact
 * we can reach, and (only when explicitly told to) clears them.
 *
 * Usage:
 *   node scripts/audit-orphan-ghl-links.js                  # dry run — reports only
 *   node scripts/audit-orphan-ghl-links.js --limit=200      # cap ids probed
 *   node scripts/audit-orphan-ghl-links.js --batch=25       # write batch size
 *   node scripts/audit-orphan-ghl-links.js --execute        # WRITES: NULLs orphan links
 *
 * NOTE: this inverts the convention used by scripts/backfill-*.js, which
 * default to writing with --dry-run as the opt-out. Deliberate — this script
 * nulls production columns, so writing is opt-IN and requires approval.
 *
 * ─── Background (2026-07-28) ────────────────────────────────────────────────
 * LP lead 562172 carried ghl_contact_id=Y21mrJPUGYGKIWFptVpu, an id present in
 * no Reece location. GHL answers such an id with HTTP 403 "The token does not
 * have access to this location.", which the old classifier did not recognise,
 * so the notes push retried it every 90s forever and each attempt walked the
 * shared ghlFailCount toward the process-wide GHL kill switch. The classifier
 * and the terminal-state columns fix the retry loop; this script finds the
 * other ids already sitting in the same state.
 *
 * ─── Design constraints ─────────────────────────────────────────────────────
 * 1. Three-way probe. `unknown` is NOT `orphan`. getGHLContact() collapses
 *    not-found, transient failure and "GHL disabled" into a single null, so it
 *    cannot be used here — a network blip would look like an orphan and
 *    --execute would clear a perfectly good link. Only an affirmative
 *    not-found classification is ever eligible for a write.
 * 2. Probes go through ghlFetch, not src/ghl.js. That still respects the token
 *    bucket (ghlFetch awaits acquireToken) but bypasses the ghlDisabled kill
 *    switch — an audit tool must not read every id as unknown because an
 *    unrelated incident tripped the switch earlier in the process.
 * 3. NO cross-instance joins. LP and HL are separate Supabase projects; ids are
 *    fetched from each and joined in application logic.
 * 4. An HL contacts-cache MISS is not proof of absence (see the note on
 *    fetchContactCache in src/services/link-corroboration.js). Every miss is
 *    confirmed with a live read; only cache HITS short-circuit.
 * 5. system_events is NEVER touched. Those rows are audit records — they are
 *    supposed to preserve what the id was at the time.
 */

import supabase from '../src/supabase.js';
import { getHlSupabase } from '../src/admin/hl-client.js';
import { probeGHLContact } from '../src/services/ghl-contact-probe.js';

const args = process.argv.slice(2);
const numArg = (name, fallback) => {
  const raw = (args.find(a => a.startsWith(`--${name}=`)) || '').split('=')[1];
  const n = parseInt(raw || '', 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
};

const opt = {
  execute: args.includes('--execute'),
  noCache: args.includes('--no-cache'),
  limit: numArg('limit', 0),          // 0 = no cap
  batch: numArg('batch', 25),         // write batch size
  cacheChunk: numArg('cache-chunk', 200),
};

// ghl_contact_id lives on these three LP tables. system_events also carries it
// and is deliberately absent — see constraint 5 above.
const TABLES = ['lp_leads', 'lp_notes', 'lp_call_logs'];

const PAGE = 1000;

// ─── Collect distinct ids per table ──────────────────────────────────────────

async function collectIds() {
  /** @type {Map<string, Set<string>>} id → set of table names */
  const byId = new Map();
  const perTable = {};

  for (const table of TABLES) {
    let offset = 0;
    let seen = 0;
    while (true) {
      const { data, error } = await supabase
        .from(table)
        .select('ghl_contact_id')
        .not('ghl_contact_id', 'is', null)
        .range(offset, offset + PAGE - 1);
      if (error) throw new Error(`${table}: ${error.message}`);
      if (!data || data.length === 0) break;

      for (const row of data) {
        const id = row.ghl_contact_id;
        if (!id) continue;
        seen++;
        if (!byId.has(id)) byId.set(id, new Set());
        byId.get(id).add(table);
      }
      if (data.length < PAGE) break;
      offset += PAGE;
    }
    perTable[table] = seen;
    console.log(`[OrphanAudit] ${table}: ${seen} rows with a link`);
  }

  return { byId, perTable };
}

// ─── HL contacts cache (cheap pre-filter, separate Supabase instance) ────────

async function cacheHits(ids) {
  const hits = new Set();
  let hl;
  try {
    hl = getHlSupabase();
  } catch (err) {
    console.warn(`[OrphanAudit] HL cache unavailable (${err.message}) — every id will be live-probed`);
    return hits;
  }

  for (let i = 0; i < ids.length; i += opt.cacheChunk) {
    const chunk = ids.slice(i, i + opt.cacheChunk);
    const { data, error } = await hl
      .from('contacts')
      .select('ghl_contact_id, deleted_at')
      .in('ghl_contact_id', chunk);
    if (error) {
      // A cache read failure is not evidence of anything — fall through to the
      // live probe for this chunk rather than marking it absent.
      console.warn(`[OrphanAudit] HL cache read failed for chunk ${i}: ${error.message}`);
      continue;
    }
    for (const row of data || []) {
      if (row.ghl_contact_id && !row.deleted_at) hits.add(row.ghl_contact_id);
    }
  }
  return hits;
}

// ─── Live probe — three-way, never two-way ───────────────────────────────────
//
// Shared with the webhook link backfill (src/rest-api.js) via
// src/services/ghl-contact-probe.js. ONLY an affirmative not-found (404,
// 400+"not found", 403 wrong-location) yields 'orphan'; timeouts, 429s, 5xx and
// bare 403s are 'unknown' and are never written.
const probeContact = probeGHLContact;

// ─── Clear (only under --execute, only for confirmed orphans) ────────────────

async function clearOrphans(orphanIds, byId) {
  const cleared = {};
  for (const table of TABLES) cleared[table] = 0;

  for (let i = 0; i < orphanIds.length; i += opt.batch) {
    const chunk = orphanIds.slice(i, i + opt.batch);
    for (const table of TABLES) {
      const relevant = chunk.filter(id => byId.get(id)?.has(table));
      if (relevant.length === 0) continue;
      const { error, count } = await supabase
        .from(table)
        .update({ ghl_contact_id: null }, { count: 'exact' })
        .in('ghl_contact_id', relevant);
      if (error) {
        console.error(`[OrphanAudit] clear failed on ${table} batch ${i}: ${error.message}`);
        continue;
      }
      cleared[table] += count || 0;
    }
    console.log(`[OrphanAudit] checkpoint: cleared through ${Math.min(i + opt.batch, orphanIds.length)}/${orphanIds.length} orphan ids`);
  }
  return cleared;
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  console.log(`[OrphanAudit] mode=${opt.execute ? 'EXECUTE (WILL WRITE)' : 'dry run'} limit=${opt.limit || 'none'} batch=${opt.batch}`);

  const { byId } = await collectIds();
  let ids = [...byId.keys()];
  console.log(`[OrphanAudit] ${ids.length} distinct ghl_contact_id values across ${TABLES.join(', ')}`);

  if (opt.limit && ids.length > opt.limit) {
    ids = ids.slice(0, opt.limit);
    console.log(`[OrphanAudit] capped to ${ids.length} ids by --limit`);
  }

  // --no-cache forces a live probe of every id. The cache short-circuit is a
  // cost optimisation that under-reports (see the NOTE in the results block).
  const hits = opt.noCache ? new Set() : await cacheHits(ids);
  const toProbe = ids.filter(id => !hits.has(id));
  console.log(`[OrphanAudit] HL cache: ${hits.size} accepted as present (not probed), ${toProbe.length} to live-probe${opt.noCache ? ' (--no-cache)' : ''}`);

  const orphans = [];
  const unknowns = [];
  let probed = 0;
  for (const id of toProbe) {
    const verdict = await probeContact(id);
    probed++;
    if (verdict === 'orphan') orphans.push(id);
    else if (verdict === 'unknown') unknowns.push(id);
    if (probed % 50 === 0) {
      console.log(`[OrphanAudit] probed ${probed}/${toProbe.length} — ${orphans.length} orphan, ${unknowns.length} unknown`);
    }
  }

  // ─── Report, grouped by table ───────────────────────────────────────────
  const orphanRows = {};
  for (const table of TABLES) {
    orphanRows[table] = orphans.filter(id => byId.get(id)?.has(table)).length;
  }

  console.log('\n[OrphanAudit] ── Results ──────────────────────────────────');
  console.log(`  distinct ids examined : ${ids.length}`);
  console.log(`  present (cache hit)   : ${hits.size}`);
  console.log(`  present (live probe)  : ${toProbe.length - orphans.length - unknowns.length}`);
  console.log(`  ORPHAN                : ${orphans.length}`);
  console.log(`  unknown (NOT written) : ${unknowns.length}`);
  console.log('  orphan ids per table:');
  for (const table of TABLES) console.log(`    ${table.padEnd(14)} ${orphanRows[table]}`);
  if (orphans.length) {
    console.log(`  sample orphan ids: ${orphans.slice(0, 10).join(', ')}`);
  }
  if (unknowns.length) {
    console.log(`  ⚠️  ${unknowns.length} id(s) could not be resolved either way (timeout / 429 / 5xx / bare 403).`);
    console.log(`     These are NEVER cleared. Re-run to re-probe: ${unknowns.slice(0, 10).join(', ')}`);
  }
  console.log('  system_events: not examined, never modified (audit records).');
  console.log(`  NOTE: ${hits.size} id(s) were accepted on an HL cache hit and NOT live-probed.`);
  console.log('        The cache lags live GHL, so a recently-deleted contact still reads as');
  console.log('        present. The orphan count above is therefore a LOWER BOUND, not exhaustive.');
  console.log('        The error direction is safe (it never nulls a good link). Re-run with');
  console.log('        --no-cache to live-probe every id when you need a complete count.');

  if (!opt.execute) {
    console.log('\n[OrphanAudit] DRY RUN — nothing written. Re-run with --execute to clear the orphan links above.');
    return;
  }
  if (orphans.length === 0) {
    console.log('\n[OrphanAudit] --execute given but no orphans found — nothing to do.');
    return;
  }

  console.log(`\n[OrphanAudit] EXECUTE — clearing ${orphans.length} orphan ids in batches of ${opt.batch}...`);
  const cleared = await clearOrphans(orphans, byId);
  console.log('[OrphanAudit] rows cleared:');
  for (const table of TABLES) console.log(`    ${table.padEnd(14)} ${cleared[table]}`);
  console.log('[OrphanAudit] complete.');
}

main().catch((err) => {
  console.error(`[OrphanAudit] fatal: ${err.message}`);
  process.exit(1);
});
