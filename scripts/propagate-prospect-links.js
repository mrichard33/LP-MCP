#!/usr/bin/env node
/**
 * Copy an established GHL link across a prospect's own leads.
 * scripts/propagate-prospect-links.js
 *
 * ─── The invariant ──────────────────────────────────────────────────────────
 * One LP prospect is one person, so every lead under it belongs to the same
 * GHL contact or to none. Measured 2026-09-19: 1,182 leads sat NULL beside a
 * sibling that already knew the contact. No matching, no inference and no
 * network call is needed to close that — the answer is already on the row
 * next to it.
 *
 * This is deliberately NOT scripts/backfill-ghl-link-propagate.js, which
 * pushes a lead's link DOWN to its own children (lp_jobs, lp_job_milestones,
 * lp_notes, lp_call_logs). This one moves ACROSS, lead to sibling lead.
 *
 * ─── Ambiguity is refused, never tie-broken ─────────────────────────────────
 * A prospect whose linked leads disagree about the contact id is exactly the
 * conflict case (63 prospects at time of writing) and is skipped and reported,
 * not resolved by majority or recency. Electing between two ids is a triage
 * decision with evidence behind it; a propagation pass has no evidence to
 * offer, and guessing here would manufacture precisely the wrong-person link
 * this system spends its effort avoiding.
 *
 * ─── Usage ──────────────────────────────────────────────────────────────────
 *   node scripts/propagate-prospect-links.js           # dry run (default)
 *   node scripts/propagate-prospect-links.js --apply
 *   node scripts/propagate-prospect-links.js --limit=50 --apply
 *
 * DRY RUN BY DEFAULT. A .jsonl rollback log records every row written; the
 * previous value is always NULL by construction, which is what an undo needs.
 */

import fs from 'fs';
import path from 'path';
import { runSQL } from '../src/admin/supabase-admin.js';
import { LINK_SOURCE } from '../src/services/link-corroboration.js';
import { buildLeadLinkUpdate, buildLeadLinkReadback } from '../src/lp-link-write-sql.js';

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
  const file = path.join(opt.logDir, `prospect-propagate-${stamp}.jsonl`);
  const fd = fs.openSync(file, 'a');
  return { file, write: (e) => fs.writeSync(fd, `${JSON.stringify(e)}\n`), close: () => fs.closeSync(fd) };
}

async function main() {
  console.log(`[ProspectPropagate] ${opt.apply ? 'LIVE RUN' : 'DRY RUN'}`);

  // One row per prospect that has both a linked and an unlinked lead, carrying
  // the distinct ids its linked leads hold. Grouping in SQL keeps the whole
  // decision in one read; agreement is then a length check.
  const prospects = await runSQL(`
    SELECT lp_prospect_id,
           array_agg(DISTINCT ghl_contact_id) FILTER (WHERE ghl_contact_id IS NOT NULL) AS ids,
           count(*) FILTER (WHERE ghl_contact_id IS NULL) AS unlinked
      FROM lp_leads
     WHERE lp_prospect_id IS NOT NULL
     GROUP BY lp_prospect_id
    HAVING count(*) FILTER (WHERE ghl_contact_id IS NOT NULL) > 0
       AND count(*) FILTER (WHERE ghl_contact_id IS NULL) > 0
     ORDER BY lp_prospect_id`);

  const agreed = prospects.filter((p) => (p.ids || []).length === 1);
  const conflicted = prospects.filter((p) => (p.ids || []).length > 1);
  const recoverable = agreed.reduce((n, p) => n + Number(p.unlinked), 0);

  console.log(`  prospects with a link to spread : ${prospects.length}`);
  console.log(`    linked leads agree            : ${agreed.length}  (${recoverable} lead(s) recoverable)`);
  console.log(`    linked leads DISAGREE         : ${conflicted.length}  (skipped — ambiguity is refused)`);

  if (conflicted.length) {
    console.log('\n  conflicted prospects (triage separately):');
    for (const p of conflicted.slice(0, 10)) {
      console.log(`    ${p.lp_prospect_id}: ${p.ids.join(' vs ')}`);
    }
    if (conflicted.length > 10) console.log(`    …and ${conflicted.length - 10} more`);
  }

  const targets = agreed.slice(0, opt.limit === Infinity ? agreed.length : opt.limit);
  if (!targets.length) { console.log('\nNothing to do.'); return; }

  const log = openLog();
  const stats = { written: 0, raced: 0, failed: 0, leads_seen: 0 };

  try {
    for (const p of targets) {
      const contactId = p.ids[0];
      const leads = await runSQL(`
        SELECT lp_lead_id FROM lp_leads
         WHERE lp_prospect_id = '${String(p.lp_prospect_id).replace(/'/g, "''")}'
           AND ghl_contact_id IS NULL
         ORDER BY lp_lead_id`);

      for (const l of leads) {
        stats.leads_seen++;
        const entry = {
          lp_lead_id: l.lp_lead_id,
          lp_prospect_id: p.lp_prospect_id,
          ghl_contact_id: contactId,
          source: LINK_SOURCE.PROSPECT_PROPAGATED,
          previous: { ghl_contact_id: null },
        };

        if (!opt.apply) { log.write({ ...entry, result: 'dry_run' }); continue; }

        try {
          await runSQL(buildLeadLinkUpdate(l.lp_lead_id, contactId, LINK_SOURCE.PROSPECT_PROPAGATED));
          const [after] = await runSQL(buildLeadLinkReadback(l.lp_lead_id));

          if (after?.ghl_contact_id === contactId) {
            stats.written++;
            log.write({ ...entry, result: 'written' });
          } else {
            // buildLeadLinkUpdate guards on ghl_contact_id IS NULL, so the live
            // 15-minute sync linking this lead first wins — and its link stands.
            stats.raced++;
            log.write({ ...entry, result: 'raced', after });
          }
        } catch (err) {
          stats.failed++;
          log.write({ ...entry, result: 'error', error: err.message });
          console.warn(`  lead ${l.lp_lead_id}: ${err.message}`);
        }
      }
    }
  } finally {
    log.close();
  }

  console.log('\nResult');
  console.log(`  unlinked leads examined : ${stats.leads_seen}`);
  console.log(`  links written           : ${stats.written}`);
  console.log(`  raced (sync won)        : ${stats.raced}`);
  console.log(`  failed                  : ${stats.failed}`);
  console.log(`\nrollback log → ${log.file}`);
  if (!opt.apply) console.log('\nDry run — nothing was written. Re-run with --apply.');
}

main().catch((err) => { console.error(err); process.exit(1); });
