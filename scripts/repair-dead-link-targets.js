#!/usr/bin/env node
/**
 * Clear LP links that point at a GHL contact which no longer exists.
 * scripts/repair-dead-link-targets.js
 *
 * ─── Two conditions that look alike and are not ─────────────────────────────
 * Every distinct ghl_contact_id referenced by lp_leads is checked against the
 * HL contacts mirror. Measured 2026-09-19 across 18,642 referenced contacts:
 *
 *   GONE (17 contacts, 40 leads) — soft-deleted in GHL. The link does not
 *     point at a person any anymore. Cleared, with ghl_link_source set to
 *     target_unresolvable: the previous source (usually phone_email_match)
 *     asserted evidence about a contact that has since been deleted, and
 *     leaving it beside a NULL id would go on claiming it.
 *
 *   UNCORROBORATABLE (4 contacts, 4 leads) — live, but carrying no phone and
 *     no email, so nothing can ever be compared against LP's identity.
 *     REPORTED AND LEFT ALONE. This is "could not tell", not "wrong", and the
 *     three-way rule this codebase runs on everywhere else (see
 *     reportAlertCondition in src/alert-state.js) says a read that concluded
 *     nothing must change nothing. Destroying a link on that evidence would be
 *     the same error as clearing an alarm because the check failed.
 *
 * Note on ordering: scripts/propagate-prospect-links.js spreads a sibling's
 * link across a prospect without checking the target, by design — it makes no
 * network calls. So it can hand a few more rows to this script. Run this one
 * after it, which is also the order they appear in the plan.
 *
 * ─── Usage ──────────────────────────────────────────────────────────────────
 *   node scripts/repair-dead-link-targets.js           # dry run (default)
 *   node scripts/repair-dead-link-targets.js --apply
 *
 * DRY RUN BY DEFAULT. A .jsonl rollback log records the previous id and source
 * for every row touched.
 */

import fs from 'fs';
import path from 'path';
import { runSQL } from '../src/admin/supabase-admin.js';
import { getHlSupabase } from '../src/admin/hl-client.js';
import { buildDeadTargetClear, buildRejectedLinkReadback } from '../src/lp-link-write-sql.js';

const args = process.argv.slice(2);
const has = (n) => args.includes(`--${n}`);
const strArg = (n, d) => (args.find((a) => a.startsWith(`--${n}=`)) || '').split('=')[1] || d;

const opt = {
  apply: has('apply') && !has('dry-run'),
  logDir: strArg('log-dir', './lp-link-repair'),
  chunk: 300,
};

const q = (v) => `'${String(v).replace(/'/g, "''")}'`;

function openLog() {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  fs.mkdirSync(opt.logDir, { recursive: true });
  const file = path.join(opt.logDir, `dead-link-targets-${stamp}.jsonl`);
  const fd = fs.openSync(file, 'a');
  return { file, write: (e) => fs.writeSync(fd, `${JSON.stringify(e)}\n`), close: () => fs.closeSync(fd) };
}

async function main() {
  console.log(`[DeadTargets] ${opt.apply ? 'LIVE RUN' : 'DRY RUN'}`);

  const hl = getHlSupabase();
  const hlSQL = async (sql) => {
    const { data, error } = await hl.rpc('run_sql', { query_text: sql });
    if (error) throw new Error(error.message);
    return Array.isArray(data) ? data : [];
  };

  const referenced = await runSQL(
    'SELECT DISTINCT ghl_contact_id FROM lp_leads WHERE ghl_contact_id IS NOT NULL');
  const ids = referenced.map((r) => r.ghl_contact_id);
  console.log(`  distinct contacts referenced by lp_leads: ${ids.length}`);

  // Two instances, so fetch from one and filter against the other rather than
  // joining (CLAUDE.md).
  const seen = new Map();
  for (let i = 0; i < ids.length; i += opt.chunk) {
    const batch = ids.slice(i, i + opt.chunk).map(q).join(',');
    for (const r of await hlSQL(
      `SELECT ghl_contact_id, deleted_at,
              nullif(regexp_replace(coalesce(phone,''), '[^0-9]', '', 'g'), '') AS ph,
              nullif(trim(coalesce(email,'')), '') AS em
         FROM contacts WHERE ghl_contact_id IN (${batch})`)) seen.set(r.ghl_contact_id, r);
  }

  const gone = [];
  const uncorroboratable = [];
  const dangling = [];
  for (const id of ids) {
    const r = seen.get(id);
    if (!r) { dangling.push(id); continue; }
    if (r.deleted_at) { gone.push(id); continue; }
    if (!r.ph && !r.em) uncorroboratable.push(id);
  }

  console.log(`    soft-deleted in GHL                     : ${gone.length}`);
  console.log(`    live but no phone and no email          : ${uncorroboratable.length}  (left alone)`);
  console.log(`    absent from the mirror entirely         : ${dangling.length}`);

  if (dangling.length) {
    // Not cleared: absence from the mirror is as likely to mean the mirror is
    // behind as it is to mean the contact is gone. Say so and stop.
    console.warn('\n  ⚠️  ids absent from the HL mirror — verify the mirror is current before treating these as dead:');
    for (const id of dangling.slice(0, 10)) console.warn(`      ${id}`);
  }

  if (uncorroboratable.length) {
    const rows = await runSQL(
      `SELECT lp_lead_id, ghl_contact_id FROM lp_leads
        WHERE ghl_contact_id IN (${uncorroboratable.map(q).join(',')}) ORDER BY lp_lead_id`);
    console.log('\n  uncorroboratable links (reported, NOT cleared):');
    for (const r of rows) console.log(`      lead ${r.lp_lead_id} → ${r.ghl_contact_id}`);
  }

  if (!gone.length) { console.log('\nNo dead targets to clear.'); return; }

  const targets = await runSQL(
    `SELECT lp_lead_id, ghl_contact_id, ghl_link_source FROM lp_leads
      WHERE ghl_contact_id IN (${gone.map(q).join(',')}) ORDER BY lp_lead_id`);
  console.log(`\n  lp_leads rows pointing at a deleted contact: ${targets.length}`);

  const log = openLog();
  const stats = { cleared: 0, raced: 0, failed: 0 };

  try {
    for (const t of targets) {
      const entry = {
        lp_lead_id: t.lp_lead_id,
        previous: { ghl_contact_id: t.ghl_contact_id, ghl_link_source: t.ghl_link_source },
        deleted_at: seen.get(t.ghl_contact_id)?.deleted_at || null,
      };
      if (!opt.apply) { log.write({ ...entry, result: 'dry_run' }); continue; }

      try {
        await runSQL(buildDeadTargetClear(t.lp_lead_id, t.ghl_contact_id));
        const [after] = await runSQL(buildRejectedLinkReadback(t.lp_lead_id));
        if (after?.ghl_contact_id == null) {
          stats.cleared++;
          log.write({ ...entry, result: 'written', after });
        } else {
          stats.raced++;
          log.write({ ...entry, result: 'raced', after });
        }
      } catch (err) {
        stats.failed++;
        log.write({ ...entry, result: 'error', error: err.message });
        console.warn(`  lead ${t.lp_lead_id}: ${err.message}`);
      }
    }
  } finally {
    log.close();
  }

  console.log('\nResult');
  console.log(`  links cleared      : ${stats.cleared}`);
  console.log(`  raced (left alone) : ${stats.raced}`);
  console.log(`  failed             : ${stats.failed}`);
  console.log(`\nrollback log → ${log.file}`);
  if (!opt.apply) console.log('\nDry run — nothing was written. Re-run with --apply.');
}

main().catch((err) => { console.error(err); process.exit(1); });
