#!/usr/bin/env node
/**
 * Resolve prospects whose leads disagree about their GHL contact.
 * scripts/elect-prospect-links.js
 *
 * One LP prospect is one person, so its leads cannot belong to two different
 * GHL contacts. Measured 2026-09-19, 51 prospects violated that. The decision
 * itself lives in src/prospect-link-election.js — pure and exhaustively
 * tested, because it is the decision that can be silently wrong. This script
 * only gathers the evidence and applies the verdict.
 *
 * Every losing lead is re-pointed at the elected contact under
 * ghl_link_source = 'prospect_elected'. AMBIGUOUS PROSPECTS ARE LEFT EXACTLY
 * AS THEY ARE and reported: two live, corroborated, equally-held contacts is
 * not a tie to break, it is a question for a person.
 *
 * ─── Usage ──────────────────────────────────────────────────────────────────
 *   node scripts/elect-prospect-links.js            # dry run (default)
 *   node scripts/elect-prospect-links.js --apply
 *
 * DRY RUN BY DEFAULT. A .jsonl rollback log records the previous id and source
 * for every lead re-pointed, plus the full verdict for every prospect seen.
 */

import fs from 'fs';
import path from 'path';
import { runSQL } from '../src/admin/supabase-admin.js';
import { getHlSupabase } from '../src/admin/hl-client.js';
import { electProspectLink } from '../src/prospect-link-election.js';
import { buildElectedLinkUpdate, buildRejectedLinkReadback } from '../src/lp-link-write-sql.js';

const args = process.argv.slice(2);
const has = (n) => args.includes(`--${n}`);
const strArg = (n, d) => (args.find((a) => a.startsWith(`--${n}=`)) || '').split('=')[1] || d;

const opt = {
  apply: has('apply') && !has('dry-run'),
  logDir: strArg('log-dir', './lp-link-repair'),
};

const q = (v) => `'${String(v).replace(/'/g, "''")}'`;

function openLog() {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  fs.mkdirSync(opt.logDir, { recursive: true });
  const file = path.join(opt.logDir, `prospect-election-${stamp}.jsonl`);
  const fd = fs.openSync(file, 'a');
  return { file, write: (e) => fs.writeSync(fd, `${JSON.stringify(e)}\n`), close: () => fs.closeSync(fd) };
}

async function main() {
  console.log(`[ProspectElection] ${opt.apply ? 'LIVE RUN' : 'DRY RUN'}`);

  const conflicted = await runSQL(`
    SELECT lp_prospect_id FROM lp_leads
     WHERE ghl_contact_id IS NOT NULL AND lp_prospect_id IS NOT NULL
     GROUP BY lp_prospect_id
    HAVING count(DISTINCT ghl_contact_id) > 1
     ORDER BY lp_prospect_id`);
  console.log(`  prospects whose leads disagree: ${conflicted.length}`);
  if (!conflicted.length) { console.log('\nNothing to do.'); return; }

  const ids = conflicted.map((r) => r.lp_prospect_id);
  const leads = await runSQL(`
    SELECT lp_lead_id, lp_prospect_id, ghl_contact_id, ghl_link_source, phone
      FROM lp_leads
     WHERE lp_prospect_id IN (${ids.map(q).join(',')})
       AND ghl_contact_id IS NOT NULL
     ORDER BY lp_prospect_id, lp_lead_id`);

  // Two instances: fetch the candidate contacts from HL and filter in memory.
  const hl = getHlSupabase();
  const candidateIds = [...new Set(leads.map((l) => l.ghl_contact_id))];
  const contacts = new Map();
  for (let i = 0; i < candidateIds.length; i += 300) {
    const batch = candidateIds.slice(i, i + 300).map(q).join(',');
    const { data, error } = await hl.rpc('run_sql', {
      query_text: `SELECT ghl_contact_id, deleted_at, phone FROM contacts WHERE ghl_contact_id IN (${batch})`,
    });
    if (error) throw new Error(error.message);
    for (const r of (Array.isArray(data) ? data : [])) contacts.set(r.ghl_contact_id, r);
  }

  const byProspect = new Map();
  for (const l of leads) {
    if (!byProspect.has(l.lp_prospect_id)) byProspect.set(l.lp_prospect_id, []);
    byProspect.get(l.lp_prospect_id).push(l);
  }

  const log = openLog();
  const stats = { elected: 0, ambiguous: 0, repointed: 0, raced: 0, failed: 0 };
  const ambiguous = [];

  try {
    for (const [prospectId, prospectLeads] of byProspect) {
      const verdict = electProspectLink({ leads: prospectLeads, contacts });
      log.write({ lp_prospect_id: prospectId, verdict, leads: prospectLeads.length });

      if (verdict.verdict !== 'elected') {
        stats.ambiguous++;
        ambiguous.push({ prospectId, survivors: verdict.survivors });
        continue;
      }
      stats.elected++;

      const losers = prospectLeads.filter((l) => l.ghl_contact_id !== verdict.contactId);
      for (const l of losers) {
        const entry = {
          lp_lead_id: l.lp_lead_id,
          lp_prospect_id: prospectId,
          previous: { ghl_contact_id: l.ghl_contact_id, ghl_link_source: l.ghl_link_source },
          elected: verdict.contactId,
          reason: verdict.reason,
        };
        if (!opt.apply) { log.write({ ...entry, result: 'dry_run' }); continue; }

        try {
          await runSQL(buildElectedLinkUpdate(l.lp_lead_id, l.ghl_contact_id, verdict.contactId));
          const [after] = await runSQL(buildRejectedLinkReadback(l.lp_lead_id));
          if (after?.ghl_contact_id === verdict.contactId) {
            stats.repointed++;
            log.write({ ...entry, result: 'written' });
          } else {
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

  console.log(`  elected on evidence  : ${stats.elected}`);
  console.log(`  REFUSED (ambiguous)  : ${stats.ambiguous}`);
  if (ambiguous.length) {
    console.log('\n  left for a person to decide:');
    for (const a of ambiguous) console.log(`    prospect ${a.prospectId}: ${a.survivors.join(' vs ')}`);
  }

  console.log('\nResult');
  console.log(`  leads re-pointed   : ${stats.repointed}`);
  console.log(`  raced (left alone) : ${stats.raced}`);
  console.log(`  failed             : ${stats.failed}`);
  console.log(`\nrollback log → ${log.file}`);
  if (!opt.apply) console.log('\nDry run — nothing was written. Re-run with --apply.');
}

main().catch((err) => { console.error(err); process.exit(1); });
