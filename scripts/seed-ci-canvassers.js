#!/usr/bin/env node
/**
 * Seed the canvasser roster — scripts/seed-ci-canvassers.js
 *
 * Loads ci_canvassers (sql/067) from a CSV export of the canvasser roster.
 * This is the table the global canvasser-ANI guard checks: on canvass work the
 * ANI is the canvasser at the door, not the customer, and a phone-tier match
 * on such a call attaches an AI note to an EMPLOYEE or to a stranger who
 * happens to own that number.
 *
 * Unlike seed-ci-maps.js this one has NO live source to read — the roster
 * lives outside Five9, so the CSV path is a required argument and the file is
 * the source of truth. It is deliberately NOT committed to the repo: it is 847
 * employees' names and personal mobile numbers.
 *
 * Usage:
 *   node scripts/seed-ci-canvassers.js ./ci_canvassers_seed.csv             # dry-run
 *   node scripts/seed-ci-canvassers.js ./ci_canvassers_seed.csv --execute   # write
 *
 * Expected columns (header row required, order-independent, case-insensitive):
 *   pro_id, name, market, phone_last10, phone_source
 *
 * Pre-conditions:
 *   - sql/067_ci_canvassers.sql applied (the table exists)
 *   - SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY set (for --execute)
 *   - Mark has reviewed the dry-run output before --execute (§14.2)
 *
 * Idempotency: upserts on the composite key (pro_id, phone_last10). Re-running
 * refreshes name/market/phone_source/active and never duplicates.
 *
 * WHY THE KEY IS COMPOSITE, and why this script must not "de-duplicate" by
 * phone: 11 numbers in the roster are carried by MORE THAN ONE Pro ID (shared
 * household and company lines). Keying on phone alone would silently drop one
 * side of each pair — a canvasser who then gets matched as a customer, which
 * is the exact failure this table exists to prevent.
 */

import fs from 'node:fs';
import path from 'node:path';

const EXECUTE = process.argv.includes('--execute');

/** The CSV path: the first argument that is not a flag. */
export function csvPathFromArgv(argv) {
  return argv.slice(2).find((a) => !a.startsWith('--')) || null;
}

/**
 * Split one CSV line, honouring double-quoted fields.
 *
 * The roster genuinely contains a quoted comma — `"Edward Kuriger, Jr"` — so a
 * bare split(',') shifts every later column on that row: the market becomes
 * the name, the phone becomes the market, and the row is dropped as
 * phone-less. Rather than a regex, this walks the line so a doubled quote
 * ("") inside a quoted field is handled too.
 */
export function splitCsvLine(line) {
  const out = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quoted) {
      if (c === '"') {
        if (line[i + 1] === '"') { field += '"'; i++; } else { quoted = false; }
      } else field += c;
    } else if (c === '"') {
      quoted = true;
    } else if (c === ',') {
      out.push(field); field = '';
    } else field += c;
  }
  out.push(field);
  return out.map((f) => f.trim());
}

/**
 * Every phone normalises to its last 10 digits.
 *
 * '321-305-0187', '13213050187', '+1 (321) 305-0187' and '3213050187' are all
 * the same number and must all produce the same key — otherwise the guard
 * misses the very rows it was seeded with. Anything that does not yield
 * exactly 10 digits returns null and the row is SKIPPED, never stored short:
 * a 7-digit fragment in this table would match nothing, or worse, be extended
 * by some later reader into a number belonging to somebody else.
 */
export function normalizePhone(value) {
  const digits = String(value ?? '').replace(/\D/g, '');
  if (digits.length < 10) return null;
  return digits.slice(-10);
}

/**
 * Parse the roster CSV into upsertable rows.
 *
 * Returns the rows AND everything that was rejected, because a silently
 * shorter roster is a silently weaker guard. Nothing is guessed: a row missing
 * a usable pro_id or phone is reported, not repaired.
 *
 * @returns {{rows: object[], skipped: object[], duplicates: object[], sharedPhones: Array}}
 */
export function parseRoster(text) {
  const lines = String(text ?? '').split(/\r?\n/).filter((l) => l.trim());
  if (!lines.length) return { rows: [], skipped: [], duplicates: [], sharedPhones: [] };

  const header = splitCsvLine(lines[0]).map((h) => h.toLowerCase().replace(/^﻿/, ''));
  const at = (name) => header.indexOf(name);
  const idx = {
    proId: at('pro_id'),
    name: at('name'),
    market: at('market'),
    phone: at('phone_last10'),
    source: at('phone_source'),
  };
  if (idx.proId < 0 || idx.phone < 0) {
    throw new Error(
      `CSV is missing required column(s): ${[idx.proId < 0 && 'pro_id', idx.phone < 0 && 'phone_last10'].filter(Boolean).join(', ')}`
      + ` — header was [${header.join(', ')}]`,
    );
  }

  const rows = [];
  const skipped = [];
  const duplicates = [];
  const seen = new Map();          // 'proId|phone' -> row
  const byPhone = new Map();       // phone -> Set(proId)

  for (let i = 1; i < lines.length; i++) {
    const cells = splitCsvLine(lines[i]);
    const rawPro = cells[idx.proId];
    const proId = Number.parseInt(String(rawPro ?? '').trim(), 10);
    const phone = normalizePhone(cells[idx.phone]);

    if (!Number.isInteger(proId)) {
      skipped.push({ line: i + 1, reason: 'no usable pro_id', raw: lines[i] });
      continue;
    }
    if (!phone) {
      skipped.push({ line: i + 1, reason: 'no usable phone', pro_id: proId, raw: cells[idx.phone] ?? '' });
      continue;
    }

    const key = `${proId}|${phone}`;
    if (seen.has(key)) {
      // Same person, same number, twice in the export. Harmless, but the
      // upsert would carry a duplicate key in ONE payload, which Postgres
      // rejects outright rather than merging.
      duplicates.push({ line: i + 1, pro_id: proId, phone_last10: phone });
      continue;
    }

    const row = {
      pro_id: proId,
      name: (cells[idx.name] ?? '').trim() || null,
      market: idx.market >= 0 ? ((cells[idx.market] ?? '').trim() || null) : null,
      phone_last10: phone,
      phone_source: idx.source >= 0 ? ((cells[idx.source] ?? '').trim() || null) : null,
      active: true,
    };
    seen.set(key, row);
    rows.push(row);
    if (!byPhone.has(phone)) byPhone.set(phone, new Set());
    byPhone.get(phone).add(proId);
  }

  const sharedPhones = [...byPhone.entries()]
    .filter(([, pros]) => pros.size > 1)
    .map(([phone, pros]) => ({ phone_last10: phone, pro_ids: [...pros].sort((a, b) => a - b) }));

  return { rows, skipped, duplicates, sharedPhones };
}

/** Guard: refuse to write anywhere that is not the LP instance. */
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
  const csvPath = csvPathFromArgv(process.argv);
  if (!csvPath) {
    console.error('Usage: node scripts/seed-ci-canvassers.js <path-to-csv> [--execute]');
    process.exit(1);
  }
  const resolved = path.resolve(csvPath);
  if (!fs.existsSync(resolved)) {
    console.error(`CSV not found: ${resolved}`);
    process.exit(1);
  }

  console.log(`seed-ci-canvassers ${EXECUTE ? '--execute' : '(DRY-RUN — no writes; pass --execute after review)'}`);
  console.log(`  source: ${resolved}\n`);

  const { rows, skipped, duplicates, sharedPhones } = parseRoster(fs.readFileSync(resolved, 'utf8'));

  const distinctPhones = new Set(rows.map((r) => r.phone_last10)).size;
  const distinctPros = new Set(rows.map((r) => r.pro_id)).size;

  console.log(`ci_canvassers — ${rows.length} proposed row(s)`);
  console.log(`  distinct phone numbers: ${distinctPhones}`);
  console.log(`  distinct Pro IDs:       ${distinctPros}`);

  console.log('\n  SAMPLE — first 5 rows as they will be written:');
  for (const r of rows.slice(0, 5)) {
    console.log(
      `    pro_id=${String(r.pro_id).padEnd(6)} ${String(r.name ?? '(no name)').padEnd(30)}`
      + ` market=${String(r.market ?? '-').padEnd(6)} phone=${r.phone_last10}  src=${r.phone_source ?? '-'}`,
    );
  }

  // The composite key exists FOR this case; print it so review can confirm the
  // shared lines are real rather than an export defect.
  console.log(`\n  SHARED NUMBERS — ${sharedPhones.length} number(s) carried by more than one Pro ID.`);
  console.log('  These are why the primary key is (pro_id, phone_last10): keying on phone alone');
  console.log('  would silently drop one side of each pair and leave that canvasser unguarded.');
  for (const s of sharedPhones) console.log(`    ${s.phone_last10} -> Pro IDs ${s.pro_ids.join(', ')}`);

  if (duplicates.length) {
    console.log(`\n  EXACT DUPLICATES — ${duplicates.length} repeated (pro_id, phone) pair(s), collapsed to one row each:`);
    for (const d of duplicates.slice(0, 20)) console.log(`    line ${d.line}: ${d.pro_id} / ${d.phone_last10}`);
    if (duplicates.length > 20) console.log(`    …and ${duplicates.length - 20} more`);
  }

  if (skipped.length) {
    console.log(`\n  SKIPPED — ${skipped.length} row(s) with nothing usable to key on. NOT seeded,`);
    console.log('  which means any call from those numbers stays UNGUARDED. Resolve before volume:');
    for (const s of skipped.slice(0, 20)) {
      console.log(`    line ${s.line}: ${s.reason}${s.pro_id ? ` (pro_id ${s.pro_id}, raw '${s.raw}')` : ''}`);
    }
    if (skipped.length > 20) console.log(`    …and ${skipped.length - 20} more`);
  }

  if (!rows.length) {
    console.error('\nNo usable rows parsed — refusing to continue. Check the CSV header and contents.');
    process.exit(1);
  }

  if (!EXECUTE) {
    console.log('\nDRY-RUN complete. No writes performed.');
    return;
  }

  // ─── writes (only past --execute) ──────────────────────────────────────────
  const { default: supabase } = await import('../src/supabase.js');
  if (!supabase) {
    console.error('Supabase not configured (SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY missing).');
    process.exit(1);
  }
  await assertLpInstance(supabase);

  // Chunked: one 847-row payload is fine today, but the roster only grows and
  // a single oversized request fails as a whole rather than partially.
  const CHUNK = 500;
  let written = 0;
  for (let i = 0; i < rows.length; i += CHUNK) {
    const slice = rows.slice(i, i + CHUNK).map((r) => ({ ...r, updated_at: new Date().toISOString() }));
    const { error } = await supabase
      .from('ci_canvassers')
      .upsert(slice, { onConflict: 'pro_id,phone_last10' });
    if (error) throw new Error(`ci_canvassers upsert failed: ${error.message}`);
    written += slice.length;
    console.log(`  upserted ${written}/${rows.length}`);
  }
  console.log('Seed complete.');
}

// Only run as a script — the parsers above are imported by the tests.
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error('seed-ci-canvassers failed:', err.message);
    process.exit(1);
  });
}
