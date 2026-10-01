#!/usr/bin/env node
// scripts/reassert-lp-disposition.js — make GHL "LP Disposition" match the
// contact's CURRENT LP lead again. DRY RUN BY DEFAULT.
//
// 2026-09-30 (fix/f0-oppfdn-integrity). GHL's "I.LP-IN LP Inbound Disposition
// Webhook" wrote LP Disposition (URWTGtobi9a9Y7gwGxC8) from ONE lead's
// lead_status, while LP-MCP field sync wrote it from another lead. Field sync
// never noticed the overwrite: its change detection compares LP's payload with
// LP's own stored hash (ghl_fields_hash), never with GHL's actual value. Once
// GHL stops writing the field (Post-merge step 4), this script finds the
// contacts where GHL still shows a value the webhook wrote and makes field sync
// push them again.
//
//   node scripts/reassert-lp-disposition.js                      # dry run
//   node scripts/reassert-lp-disposition.js --execute --confirm=<N>
//
// --execute sets ghl_fields_hash = 'reassert' on EVERY lp_leads row of each
// mismatched contact. Field sync then sees a hash mismatch and pushes, draining
// under its 500-per-cycle cap.
//
// WHY THE 'reassert' SENTINEL AND NOT NULL: syncLeadFieldsToGHL treats a NULL
// stored hash as "first sync" and emits lp.disposition_changed for the pushed
// code — which would fire every disposition-keyed routing rule (S5.2, F.0, …)
// for contacts whose disposition did not change. Any non-null value that can
// never equal a real hash forces the push and emits nothing, because the prior
// disposition is then the merged lead's own code. See the regression test in
// scripts/test-current-lead.js.
//
// Needs SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY (LP) and HL_SUPABASE_URL /
// HL_SUPABASE_SERVICE_ROLE_KEY (HL contacts cache).

import { writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { pickCurrentLead } from '../src/current-lead.js';

export const DISPOSITION_FIELD_ID = 'URWTGtobi9a9Y7gwGxC8';
export const REASSERT_HASH = 'reassert';
export const MISMATCH_CSV = '/tmp/lp-disposition-mismatch.csv';
const PAGE = 1000;
const HL_CHUNK = 500;
const WRITE_CHUNK = 200;

export function parseArgs(argv) {
  const hit = argv.find((a) => a.startsWith('--confirm='));
  const confirm = hit ? Number(hit.slice('--confirm='.length)) : null;
  const execute = argv.includes('--execute');
  const errors = [];
  if (execute && confirm === null) errors.push('--execute requires --confirm=<N> (the dry-run count)');
  if (confirm !== null && !(Number.isInteger(confirm) && confirm >= 0)) errors.push('--confirm must be a non-negative integer');
  return { execute, confirm, errors };
}

/** Pure. leadsByContact: Map<id, rows>; ghlValues: Map<id, string|null> (contacts in HL only). */
export function findMismatches(leadsByContact, ghlValues) {
  const out = [];
  for (const [id, leads] of leadsByContact) {
    if (!ghlValues.has(id)) continue; // not in the HL cache — nothing to compare
    const current = pickCurrentLead(leads.filter((l) => !l.lp_deleted_at));
    if (!current) continue;
    const lp = String(current.disposition_code ?? '').trim();
    const ghl = String(ghlValues.get(id) ?? '').trim();
    if (lp !== ghl) out.push({ contact_id: id, ghl: ghl || '(empty)', lp: lp || '(empty)', lp_lead_id: current.lp_lead_id });
  }
  return out.sort((a, b) => a.contact_id.localeCompare(b.contact_id));
}

async function defaultDeps() {
  const [{ default: supabase }, { hlRunSQL, esc }] = await Promise.all([
    import('../src/supabase.js'),
    import('../src/admin/hl-client.js'),
  ]);
  return { supabase, hlRunSQL, esc, writeFile: writeFileSync, log: console.log };
}

async function loadLeads(deps) {
  if (!deps.supabase) throw new Error('LP Supabase not configured');
  const byContact = new Map();
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await deps.supabase.from('lp_leads')
      .select('ghl_contact_id, lp_lead_id, disposition_code, appointment_date, created_at_lp, updated_at_lp, lp_deleted_at')
      .not('ghl_contact_id', 'is', null)
      .order('id', { ascending: true })
      .range(from, from + PAGE - 1);
    if (error) throw new Error(`lp_leads read failed at ${from}: ${error.message}`);
    for (const r of data || []) {
      if (!byContact.has(r.ghl_contact_id)) byContact.set(r.ghl_contact_id, []);
      byContact.get(r.ghl_contact_id).push(r);
    }
    if (!data || data.length < PAGE) break;
  }
  return byContact;
}

async function loadGhlValues(deps, ids) {
  const values = new Map();
  const list = [...ids];
  for (let i = 0; i < list.length; i += HL_CHUNK) {
    const inList = list.slice(i, i + HL_CHUNK).map((id) => `'${deps.esc(id)}'`).join(',');
    const rows = await deps.hlRunSQL(
      `SELECT ghl_contact_id,
              (SELECT f->>'value' FROM jsonb_array_elements(CASE WHEN jsonb_typeof(custom_fields)='array' THEN custom_fields ELSE '[]'::jsonb END) f
                WHERE f->>'id' = '${DISPOSITION_FIELD_ID}' LIMIT 1) AS disp
         FROM contacts WHERE deleted_at IS NULL AND ghl_contact_id IN (${inList})`,
    );
    for (const r of rows || []) values.set(r.ghl_contact_id, r.disp ?? null);
  }
  return values;
}

export async function run(argv, deps) {
  const args = parseArgs(argv);
  if (args.errors.length) { args.errors.forEach((e) => deps.log(`ERROR: ${e}`)); return { ok: false }; }

  const leads = await loadLeads(deps);
  const ghl = await loadGhlValues(deps, leads.keys());
  const mism = findMismatches(leads, ghl);

  const breakdown = new Map();
  for (const m of mism) breakdown.set(`${m.ghl} → ${m.lp}`, (breakdown.get(`${m.ghl} → ${m.lp}`) || 0) + 1);
  deps.log(`[reassert] ${leads.size} LP-linked contacts, ${ghl.size} in the HL cache, ${mism.length} mismatched`);
  deps.log('\n(ghl → LP) breakdown:');
  [...breakdown.entries()].sort((a, b) => b[1] - a[1]).forEach(([k, n]) => deps.log(`  ${String(n).padStart(5)}  ${k}`));
  deps.log('\nSamples:');
  mism.slice(0, 20).forEach((m) => deps.log(`  ${m.contact_id}  ghl=${m.ghl}  lp=${m.lp}  (lead ${m.lp_lead_id})`));
  deps.writeFile(MISMATCH_CSV, ['contact_id,ghl,lp,lp_lead_id', ...mism.map((m) => `${m.contact_id},${m.ghl},${m.lp},${m.lp_lead_id}`)].join('\n') + '\n');
  deps.log(`\n[reassert] wrote ${MISMATCH_CSV}`);

  if (!args.execute) {
    deps.log(`\nDRY RUN — nothing written. To apply:\n  node scripts/reassert-lp-disposition.js --execute --confirm=${mism.length}`);
    return { ok: true, mismatched: mism.length };
  }
  if (args.confirm !== mism.length) {
    deps.log(`REFUSED: --confirm=${args.confirm} does not match this run's ${mism.length} — re-run the dry run and copy its number`);
    return { ok: false, mismatched: mism.length };
  }

  let rows = 0;
  const ids = mism.map((m) => m.contact_id);
  for (let i = 0; i < ids.length; i += WRITE_CHUNK) {
    const { data, error } = await deps.supabase.from('lp_leads')
      .update({ ghl_fields_hash: REASSERT_HASH })
      .in('ghl_contact_id', ids.slice(i, i + WRITE_CHUNK))
      .select('lp_lead_id');
    if (error) throw new Error(`hash update failed at ${i}: ${error.message}`);
    rows += (data || []).length;
  }
  deps.log(`[reassert] EXECUTE: marked ${rows} lp_leads rows across ${ids.length} contacts. Field sync pushes them over the next cycles (500/cycle).`);
  return { ok: true, mismatched: mism.length, rows };
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  run(process.argv.slice(2), await defaultDeps())
    .then((r) => process.exit(r.ok ? 0 : 1))
    .catch((err) => { console.error(`[reassert] FAILED: ${err.message}`); process.exit(1); });
}
