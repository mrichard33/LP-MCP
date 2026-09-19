#!/usr/bin/env node
/**
 * Clean up leads reading "refused to bind" beside a populated GHL contact id.
 * scripts/repair-rejected-links.js
 *
 * ─── What produced these rows ───────────────────────────────────────────────
 * ghl_link_source rejected_conflict / rejected_uncorroborated means the
 * corroborator declined a lognumber candidate. It is not supposed to coexist
 * with a populated ghl_contact_id. Measured 2026-09-19: 19 rows did, in two
 * distinct shapes, and the 2026-07-29 guard in sync-leads.js caught neither.
 *
 *   CLEAR (16 rows) — ghl_contact_id is identical to LP's lognumber. The
 *     stored id IS the rejected candidate, so the guard's `leadGhlId !==
 *     existingGhlId` test was false and it never ran. Verification compared
 *     that contact's phone/email against LP's and they disagreed, so the id is
 *     the wrong part. It goes; ghl_link_source stays as the record of why.
 *
 *   RESET (3 rows) — ghl_contact_id differs from the rejected lognumber. The
 *     guard correctly kept the stored link, then stamped the rejection over
 *     its classification anyway. The id came from a good phone match and must
 *     survive; only the label is wrong, and legacy_unverified is the honest
 *     floor — "linked, not corroborated" — which also puts the row back in
 *     scope for normal verification.
 *
 * The write path is fixed in the same change (src/sync-leads.js), so this is a
 * one-shot cleanup of rows already written, not a recurring sweep. Re-running
 * it is harmless: both guards are self-limiting.
 *
 * ─── Usage ──────────────────────────────────────────────────────────────────
 *   node scripts/repair-rejected-links.js            # dry run (default)
 *   node scripts/repair-rejected-links.js --apply
 *   node scripts/repair-rejected-links.js --limit=5 --apply
 *
 * DRY RUN BY DEFAULT — needs --apply to write anything, matching
 * scripts/repair-lp-ghl-links.js rather than the backfill-*.js convention,
 * because this one removes data.
 *
 * A .jsonl rollback log per run records the previous value of BOTH columns for
 * every row touched, which is all an undo needs.
 */

import fs from 'fs';
import path from 'path';
import { runSQL } from '../src/admin/supabase-admin.js';
import {
  buildRejectedLinkClear,
  buildRejectedSourceReset,
  buildRejectedLinkReadback,
} from '../src/lp-link-write-sql.js';

const args = process.argv.slice(2);
const has = (n) => args.includes(`--${n}`);
const strArg = (n, d) => (args.find((a) => a.startsWith(`--${n}=`)) || '').split('=')[1] || d;
const intArg = (n, d) => { const v = parseInt(strArg(n, ''), 10); return Number.isFinite(v) && v >= 0 ? v : d; };

const opt = {
  apply: has('apply') && !has('dry-run'),
  limit: intArg('limit', Infinity),
  logDir: strArg('log-dir', './lp-link-repair'),
};

function openLog() {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  fs.mkdirSync(opt.logDir, { recursive: true });
  const file = path.join(opt.logDir, `rejected-link-repair-${stamp}.jsonl`);
  const fd = fs.openSync(file, 'a');
  return { file, write: (e) => fs.writeSync(fd, `${JSON.stringify(e)}\n`), close: () => fs.closeSync(fd) };
}

async function main() {
  console.log(`[RejectedRepair] ${opt.apply ? 'LIVE RUN' : 'DRY RUN'}`);

  const rows = await runSQL(`
    SELECT lp_lead_id, ghl_contact_id, ghl_link_source,
           raw_lp_data->>'lognumber' AS lognumber
      FROM lp_leads
     WHERE ghl_link_source IN ('rejected_conflict', 'rejected_uncorroborated')
       AND ghl_contact_id IS NOT NULL
     ORDER BY lp_lead_id`);

  const planned = rows.slice(0, opt.limit === Infinity ? rows.length : opt.limit).map((r) => ({
    ...r,
    // The id being the rejected candidate is what decides the action. Compare
    // against LP's own lognumber rather than re-verifying: verification already
    // ran and produced the verdict this row carries.
    action: r.ghl_contact_id === r.lognumber ? 'clear' : 'reset',
  }));

  const counts = { clear: 0, reset: 0 };
  for (const r of planned) counts[r.action]++;
  console.log(`  found ${rows.length} affected row(s); planning ${planned.length}`);
  console.log(`    clear (stored id was the rejected candidate) : ${counts.clear}`);
  console.log(`    reset (good id, clobbered classification)    : ${counts.reset}`);

  if (!planned.length) { console.log('\nNothing to do.'); return; }

  const log = openLog();
  const stats = { cleared: 0, reset: 0, raced: 0, failed: 0 };

  try {
    for (const r of planned) {
      const entry = {
        lp_lead_id: r.lp_lead_id,
        action: r.action,
        // The previous values — what a rollback needs.
        previous: { ghl_contact_id: r.ghl_contact_id, ghl_link_source: r.ghl_link_source },
        lognumber: r.lognumber,
      };

      if (!opt.apply) { log.write({ ...entry, result: 'dry_run' }); continue; }

      const sql = r.action === 'clear'
        ? buildRejectedLinkClear(r.lp_lead_id, r.ghl_contact_id)
        : buildRejectedSourceReset(r.lp_lead_id, r.ghl_contact_id);

      try {
        await runSQL(sql);
        // Read the row back: the RPC returns a status object for a non-SELECT,
        // never a row count, so the stored value IS the outcome.
        const [after] = await runSQL(buildRejectedLinkReadback(r.lp_lead_id));
        const ok = r.action === 'clear'
          ? after?.ghl_contact_id == null
          : after?.ghl_link_source === 'legacy_unverified';

        if (ok) {
          stats[r.action === 'clear' ? 'cleared' : 'reset']++;
          log.write({ ...entry, result: 'written', after });
        } else {
          // Either guard can decline: the live 15-minute sync may have
          // relinked or reclassified the row between our read and our write.
          // That is the sync winning a race it should win, not a failure.
          stats.raced++;
          log.write({ ...entry, result: 'raced', after });
        }
      } catch (err) {
        stats.failed++;
        log.write({ ...entry, result: 'error', error: err.message });
        console.warn(`  lead ${r.lp_lead_id}: ${err.message}`);
      }
    }
  } finally {
    log.close();
  }

  console.log('\nResult');
  console.log(`  ids cleared            : ${stats.cleared}`);
  console.log(`  classifications reset  : ${stats.reset}`);
  console.log(`  raced (left alone)     : ${stats.raced}`);
  console.log(`  failed                 : ${stats.failed}`);
  console.log(`\nrollback log → ${log.file}`);
  if (!opt.apply) console.log('\nDry run — nothing was written. Re-run with --apply.');
}

main().catch((err) => { console.error(err); process.exit(1); });
