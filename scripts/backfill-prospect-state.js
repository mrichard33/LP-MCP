#!/usr/bin/env node
/**
 * backfill-prospect-state.js — repair LP prospects whose state was truncated
 * to a wrong-but-plausible two-character value.
 *
 * WHY LP AND NOT SUPABASE: lp_prospects is a MIRROR. upsert-prospect.js copies
 * `state` verbatim from LP on every sync, so a Supabase UPDATE is reverted the
 * next time that prospect syncs. The only durable repair is
 * updateProspectInfo() against LP itself, which is the system of record.
 *
 * WHAT WENT WRONG: LP's state column truncates to two characters, silently.
 * "Florida" became "Fl"; the literal string "null" became "nu". Neither ever
 * raised an error, and both still look like a state code.
 *
 * TIERS — only unambiguous repairs are attempted:
 *
 *   tier1  state in ('Fl','fl')  →  'FL'
 *          NO INFERENCE. The stored value already says Florida; we are only
 *          undoing the truncation and case. Safe regardless of zip.
 *
 *   tier2  state = 'nu' AND trim(zip) is a known Reece FL service-area zip
 *          →  'FL'
 *          Inference, but a tight one: every zip in service_area_zips is a
 *          Florida market we actually serve.
 *
 *   skip   everything else — chiefly 'nu' rows with no usable zip, or a zip
 *          outside the service area (93505 is California). Guessing a state
 *          from nothing is worse than leaving a visibly broken value that
 *          someone can still fix by hand.
 *
 * Blank states ('  ') are OUT OF SCOPE. Absent is not the same defect as
 * wrong, the population is an order of magnitude larger, and it deserves its
 * own decision.
 *
 * SAFETY:
 *   - Dry run by DEFAULT. --apply is required to write anything.
 *   - --limit N bounds a run; the script is resumable because it re-reads
 *     current state each time and skips rows already correct.
 *   - Only `state` is sent. buildProspectUpdateFields strips blanks, so no
 *     other field can be overwritten — but VERIFY THIS ON ONE ROW FIRST with
 *     --verify, which reads the prospect back after the write and diffs every
 *     field. Do not batch until that comes back clean.
 *   - Paced with a delay between writes; LP monitors for excessive use.
 *   - Every outcome is printed and tallied. Failures never abort the run.
 *
 * USAGE:
 *   node scripts/backfill-prospect-state.js                      # dry run, all
 *   node scripts/backfill-prospect-state.js --limit 1 --apply --verify
 *   node scripts/backfill-prospect-state.js --tier tier1 --apply
 *   node scripts/backfill-prospect-state.js --apply
 */

import 'dotenv/config';
import supabase from '../src/supabase.js';
import { updateProspectInfo, getCustomersByProspectID } from '../src/lp-client.js';

const args = process.argv.slice(2);
const has = (f) => args.includes(f);
const val = (f, d) => {
  const i = args.indexOf(f);
  return i >= 0 && args[i + 1] ? args[i + 1] : d;
};

const APPLY = has('--apply');
const VERIFY = has('--verify');
const LIMIT = parseInt(val('--limit', '0'), 10) || 0;
const TIER = val('--tier', 'all');
const DELAY_MS = parseInt(val('--delay', '400'), 10);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

if (!supabase) {
  console.error('No Supabase client — set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY.');
  process.exit(1);
}

/** Every zip we serve is a Florida market zip. */
async function loadServiceZips() {
  const zips = new Set();
  let from = 0;
  const page = 1000;
  for (;;) {
    const { data, error } = await supabase
      .from('service_area_zips')
      .select('zip')
      .range(from, from + page - 1);
    if (error) throw new Error(`service_area_zips read failed: ${error.message}`);
    if (!data?.length) break;
    for (const r of data) if (r.zip) zips.add(String(r.zip).trim());
    if (data.length < page) break;
    from += page;
  }
  return zips;
}

async function loadCandidates() {
  const rows = [];
  let from = 0;
  const page = 1000;
  for (;;) {
    const { data, error } = await supabase
      .from('lp_prospects')
      .select('lp_prospect_id, first_name, last_name, address, city, state, zip, ghl_contact_id')
      .in('state', ['nu', 'Fl', 'fl'])
      .range(from, from + page - 1);
    if (error) throw new Error(`lp_prospects read failed: ${error.message}`);
    if (!data?.length) break;
    rows.push(...data);
    if (data.length < page) break;
    from += page;
  }
  return rows;
}

function classify(row, serviceZips) {
  const st = String(row.state || '').trim();
  if (st === 'Fl' || st === 'fl') {
    return { tier: 'tier1', target: 'FL', why: `stored "${st}" is "Florida" truncated` };
  }
  if (st === 'nu') {
    const zip = String(row.zip || '').trim();
    if (zip && serviceZips.has(zip)) {
      return { tier: 'tier2', target: 'FL', why: `zip ${zip} is a Reece FL service area` };
    }
    return { tier: 'skip', target: null, why: zip ? `zip ${zip} not in service area` : 'no usable zip' };
  }
  return { tier: 'skip', target: null, why: `unexpected state "${st}"` };
}

/** Read the prospect back and report which fields differ from the pre-write snapshot. */
async function verifyWrite(prospectId, before) {
  const res = await getCustomersByProspectID(prospectId).catch((e) => {
    console.log(`      verify: read-back failed (${e.message})`);
    return null;
  });
  const rec = Array.isArray(res) ? res[0] : res;
  if (!rec) return console.log('      verify: no record returned');
  const pick = (o, ...k) => k.map((x) => o?.[x]).find((v) => v !== undefined);
  const after = {
    state: pick(rec, 'state', 'State'),
    address1: pick(rec, 'address1', 'Address1'),
    city: pick(rec, 'city', 'City'),
    zip: pick(rec, 'zip', 'Zip'),
    phone1: pick(rec, 'phone1', 'Phone1'),
    email: pick(rec, 'email', 'Email'),
    firstname: pick(rec, 'firstname', 'FirstName'),
    lastname: pick(rec, 'lastname', 'LastName'),
  };
  console.log(`      verify: state now "${String(after.state ?? '').trim()}"`);
  for (const [k, v] of Object.entries(before)) {
    if (k === 'state') continue;
    const now = String(after[k] ?? '').trim();
    const was = String(v ?? '').trim();
    if (now !== was) console.log(`      ⚠️  verify: ${k} CHANGED "${was}" → "${now}" — STOP, this is not a partial update`);
  }
}

const serviceZips = await loadServiceZips();
const candidates = await loadCandidates();

const plan = candidates
  .map((row) => ({ row, ...classify(row, serviceZips) }))
  .filter((p) => (TIER === 'all' ? true : p.tier === TIER));

const actionable = plan.filter((p) => p.tier !== 'skip');
const skipped = plan.filter((p) => p.tier === 'skip');
const work = LIMIT ? actionable.slice(0, LIMIT) : actionable;

console.log('─'.repeat(70));
console.log(`mode        : ${APPLY ? 'APPLY (writes to LP)' : 'DRY RUN (no writes)'}`);
console.log(`service zips: ${serviceZips.size}`);
console.log(`candidates  : ${candidates.length} prospects with state in (nu, Fl, fl)`);
console.log(`  tier1     : ${plan.filter((p) => p.tier === 'tier1').length}  ("Fl"/"fl" → FL, no inference)`);
console.log(`  tier2     : ${plan.filter((p) => p.tier === 'tier2').length}  ("nu" + FL service-area zip → FL)`);
console.log(`  skip      : ${skipped.length}  (left alone)`);
console.log(`this run    : ${work.length}${LIMIT ? ` (--limit ${LIMIT})` : ''}`);
console.log('─'.repeat(70));

if (!APPLY) {
  for (const p of work.slice(0, 25)) {
    const r = p.row;
    console.log(`  ${p.tier}  ${r.lp_prospect_id}  "${r.state}" → ${p.target}  [${p.why}]  ${r.first_name || ''} ${r.last_name || ''} ${r.zip || ''}`.trimEnd());
  }
  if (work.length > 25) console.log(`  … and ${work.length - 25} more`);
  const skipReasons = {};
  for (const s of skipped) skipReasons[s.why.replace(/zip \S+/, 'zip <n>')] = (skipReasons[s.why.replace(/zip \S+/, 'zip <n>')] || 0) + 1;
  console.log('\nskip reasons:');
  for (const [why, n] of Object.entries(skipReasons).sort((a, b) => b[1] - a[1])) console.log(`  ${n}\t${why}`);
  console.log('\nDry run only. Re-run with --apply to write. Start with --limit 1 --apply --verify.');
  process.exit(0);
}

let ok = 0; let failed = 0;
for (const [i, p] of work.entries()) {
  const r = p.row;
  const before = {
    state: r.state, address1: r.address, city: r.city, zip: r.zip,
    phone1: null, email: null, firstname: r.first_name, lastname: r.last_name,
  };
  try {
    await updateProspectInfo({ custnumber: r.lp_prospect_id, updates: { state: p.target } });
    ok++;
    console.log(`  [${i + 1}/${work.length}] ✅ ${r.lp_prospect_id} "${r.state}" → ${p.target}  (${p.tier})`);
    if (VERIFY) await verifyWrite(r.lp_prospect_id, before);
  } catch (err) {
    failed++;
    console.log(`  [${i + 1}/${work.length}] ❌ ${r.lp_prospect_id}: ${err.message}`);
  }
  if (i < work.length - 1) await sleep(DELAY_MS);
}

console.log('─'.repeat(70));
console.log(`written: ${ok}   failed: ${failed}   skipped (not attempted): ${skipped.length}`);
console.log('The Supabase mirror catches up on the next prospect sync; it is not written here.');
