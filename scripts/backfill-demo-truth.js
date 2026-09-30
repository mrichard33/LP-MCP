#!/usr/bin/env node
// scripts/backfill-demo-truth.js — bring the lp-demo-completed tag in line with
// demo truth (src/demo-truth.js). DRY RUN BY DEFAULT.
//
// 2026-09-30 (fix/demo-truth). The routing tag lp-demo-completed was on 1,733
// contacts against ~5,013 who truly demoed: seven cancel/no-show rules stripped
// it, LP_DAY15_STAMP added it for NIS/NOC/BO/1Leg (not demos), and Sale and
// NoRehash never added it. Demoed leads who cancelled were therefore routed as
// pre-demo into S5.2 cancelled-estimate messaging. Field sync now ADDS the tag
// going forward (DEMO_TAG_SYNC_MODE); this one-time, reviewed pass fixes the
// population, including the only removals anything in this repo makes.
//
//   ADD    — demo truth = true, contact lacks lp-demo-completed
//   REMOVE — demo truth = false, contact has lp-demo-completed, and has none of
//            PROTECTED_TAGS (a customer keeps the tag whatever LP's lead rows
//            say — a sale is a demo that happened), and has at least one LP
//            lead linked (a tagged contact with no link is left alone)
//
// Usage:
//   node scripts/backfill-demo-truth.js                          # dry run
//   node scripts/backfill-demo-truth.js --execute \
//        --confirm-add=<N> --confirm-remove=<M> [--limit=200]
//
// --execute refuses unless both confirm counts equal THIS run's computed
// counts exactly — re-run the dry run and copy its numbers. Each execute run
// writes at most --limit contacts (default 200), one every 500 ms, removals
// first. Every write is re-verified against the LIVE GHL contact immediately
// before it is made, and touches ONLY the lp-demo-completed tag.
//
// Adding the tag enrolls the contact once in "U. RebookLink Resolver"
// (tag-added trigger). Expected and harmless — it is why this is throttled.
//
// Needs SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY (LP), HL_SUPABASE_URL /
// HL_SUPABASE_SERVICE_ROLE_KEY (the HL contacts cache), and GHL_API_KEY for
// --execute.

import { writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { contactHadDemo, demoEvidence } from '../src/demo-truth.js';

export const DEMO_TAG = 'lp-demo-completed';
// customer / lp-sale / p2:active are the handoff's list. Measured 2026-09-30, NO
// live GHL contact carries any of the three, so on their own they protect
// nobody. deal-won (2,351 contacts) and stage:customer-onboarding (2,343) are
// the customer markers GHL actually uses, so they are protected too.
export const PROTECTED_TAGS = Object.freeze([
  'customer', 'lp-sale', 'p2:active', 'deal-won', 'stage:customer-onboarding',
]);
export const PAGE_SIZE = 1000;
export const HL_CHUNK = 500;
export const PACE_MS = 500;
export const DEFAULT_LIMIT = 200;
export const SAMPLE_SIZE = 20;
export const ADD_CSV = '/tmp/demo-truth-add.csv';
export const REMOVE_CSV = '/tmp/demo-truth-remove.csv';

const norm = (t) => (typeof t === 'string' ? t.trim().toLowerCase() : '');
const hasTag = (tags, tag) => (tags || []).some((t) => norm(t) === tag);
const hasProtected = (tags) => PROTECTED_TAGS.some((p) => hasTag(tags, p));

export function parseArgs(argv) {
  const str = (name) => {
    const hit = argv.find((a) => a.startsWith(`--${name}=`));
    return hit ? hit.slice(name.length + 3) : null;
  };
  const int = (name) => {
    const raw = str(name);
    if (raw === null) return { raw, value: null };
    const n = Number(raw);
    return { raw, value: Number.isInteger(n) && n >= 0 ? n : NaN };
  };
  const execute = argv.includes('--execute');
  const add = int('confirm-add');
  const remove = int('confirm-remove');
  const limit = int('limit');
  const errors = [];
  if (execute && (add.value === null || remove.value === null)) {
    errors.push('--execute requires --confirm-add=<N> and --confirm-remove=<M> (the dry-run counts)');
  }
  if (Number.isNaN(add.value)) errors.push('--confirm-add must be a non-negative integer');
  if (Number.isNaN(remove.value)) errors.push('--confirm-remove must be a non-negative integer');
  if (Number.isNaN(limit.value) || limit.value === 0) errors.push('--limit must be a positive integer');
  return {
    execute,
    confirmAdd: add.value,
    confirmRemove: remove.value,
    limit: limit.value || DEFAULT_LIMIT,
    errors,
  };
}

// Short "why" for a sample line: the evidence that made it a demo, or the
// dispositions on record that did not.
function explain(leads) {
  const ev = demoEvidence(leads);
  if (ev) return ev;
  const seen = new Set();
  for (const l of leads) {
    if (l?.disposition_code) seen.add(`lead:${String(l.disposition_code).trim()}`);
    for (const a of (Array.isArray(l?.appts) ? l.appts : [])) {
      if (a?.disposition) seen.add(`appt:${String(a.disposition).trim()}`);
    }
  }
  return seen.size ? `no demo (${[...seen].join(' ')})` : 'no demo (no dispositions)';
}

/**
 * Pure. Decide the ADD and REMOVE lists.
 *   leadsByContact — Map<ghl_contact_id, lp_leads rows>
 *   hlTags         — Map<ghl_contact_id, string[]> for every contact the HL
 *                    cache has (not deleted). A contact missing here is
 *                    skipped: it is gone from GHL or not mirrored yet. A
 *                    tagged contact with no LP lead linked is skipped too.
 */
export function planDemoTruthBackfill(leadsByContact, hlTags) {
  const add = [];
  const remove = [];
  let skippedNotInHl = 0;
  let skippedNoLpLeads = 0;
  const ids = new Set([...leadsByContact.keys(), ...hlTags.keys()]);
  for (const id of ids) {
    const tags = hlTags.get(id);
    if (!tags) { skippedNotInHl += 1; continue; }
    const leads = leadsByContact.get(id) || [];
    // Tagged in GHL but no lp_leads row links to it: we cannot tell whether
    // this person demoed (a link gap is far likelier than a fake tag), so it
    // is left alone — "not applicable" is not "no demo".
    if (leads.length === 0) { skippedNoLpLeads += 1; continue; }
    const truth = contactHadDemo(leads);
    const tagged = hasTag(tags, DEMO_TAG);
    if (truth && !tagged) add.push({ contact_id: id, why: explain(leads) });
    else if (!truth && tagged && !hasProtected(tags)) {
      remove.push({ contact_id: id, why: explain(leads) });
    }
  }
  const byId = (a, b) => a.contact_id.localeCompare(b.contact_id);
  return { add: add.sort(byId), remove: remove.sort(byId), skippedNotInHl, skippedNoLpLeads };
}

async function defaultDeps() {
  const [{ default: supabase }, { hlRunSQL, esc }, { ghlFetch }, tags] = await Promise.all([
    import('../src/supabase.js'),
    import('../src/admin/hl-client.js'),
    import('../src/actions/helpers.js'),
    import('../src/actions/handlers/tags.js'),
  ]);
  return {
    supabase,
    hlRunSQL,
    esc,
    ghlFetch,
    executeAddTag: tags.executeAddTag,
    executeRemoveTag: tags.executeRemoveTag,
    writeFile: writeFileSync,
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    log: console.log,
  };
}

async function loadLeads(deps) {
  if (!deps.supabase) throw new Error('LP Supabase not configured (SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY)');
  const byContact = new Map();
  for (let from = 0; ; from += PAGE_SIZE) {
    const { data, error } = await deps.supabase
      .from('lp_leads')
      .select('ghl_contact_id, disposition_code, closed_won, appts:raw_lp_data->appointments')
      .not('ghl_contact_id', 'is', null)
      .order('id', { ascending: true })
      .range(from, from + PAGE_SIZE - 1);
    if (error) throw new Error(`lp_leads read failed at ${from}: ${error.message}`);
    for (const row of data || []) {
      if (!byContact.has(row.ghl_contact_id)) byContact.set(row.ghl_contact_id, []);
      byContact.get(row.ghl_contact_id).push(row);
    }
    if (!data || data.length < PAGE_SIZE) break;
  }
  return byContact;
}

// HL contacts cache: every contact that carries the tag, plus every contact
// LP links to (in chunks). Tags come back whole so the planner can see the
// protected ones.
async function loadHlTags(deps, contactIds) {
  const tags = new Map();
  const put = (rows) => { for (const r of rows || []) if (r?.ghl_contact_id) tags.set(r.ghl_contact_id, r.tags || []); };
  put(await deps.hlRunSQL(
    `SELECT ghl_contact_id, tags FROM contacts
      WHERE deleted_at IS NULL AND ghl_contact_id IS NOT NULL
        AND EXISTS (SELECT 1 FROM unnest(tags) t WHERE lower(t) = '${DEMO_TAG}')`,
  ));
  const ids = [...contactIds];
  for (let i = 0; i < ids.length; i += HL_CHUNK) {
    const list = ids.slice(i, i + HL_CHUNK).map((id) => `'${deps.esc(id)}'`).join(',');
    put(await deps.hlRunSQL(
      `SELECT ghl_contact_id, tags FROM contacts
        WHERE deleted_at IS NULL AND ghl_contact_id IN (${list})`,
    ));
  }
  return tags;
}

function toCsv(rows) {
  const q = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  return ['contact_id,why', ...rows.map((r) => `${q(r.contact_id)},${q(r.why)}`)].join('\n') + '\n';
}

async function liveTags(deps, contactId) {
  try {
    const res = await deps.ghlFetch('GET', `/contacts/${contactId}`);
    const contact = res?.contact || null;
    return contact ? (contact.tags || []) : null;
  } catch { return null; }
}

export async function run(argv, deps) {
  const args = parseArgs(argv);
  if (args.errors.length) {
    args.errors.forEach((e) => deps.log(`ERROR: ${e}`));
    return { ok: false, errors: args.errors };
  }

  const leadsByContact = await loadLeads(deps);
  const hlTags = await loadHlTags(deps, leadsByContact.keys());
  const plan = planDemoTruthBackfill(leadsByContact, hlTags);

  deps.log(`[demo-truth] ${leadsByContact.size} LP-linked contacts, ${hlTags.size} found in the HL cache, ${plan.skippedNotInHl} not in HL (skipped), ${plan.skippedNoLpLeads} tagged but with no LP lead linked (left alone)`);
  deps.log(`[demo-truth] ADD ${plan.add.length}  REMOVE ${plan.remove.length}`);
  deps.log('\nADD samples (contact_id  evidence):');
  plan.add.slice(0, SAMPLE_SIZE).forEach((r) => deps.log(`  ${r.contact_id}  ${r.why}`));
  deps.log('\nREMOVE samples (contact_id  dispositions on record):');
  plan.remove.slice(0, SAMPLE_SIZE).forEach((r) => deps.log(`  ${r.contact_id}  ${r.why}`));
  deps.writeFile(ADD_CSV, toCsv(plan.add));
  deps.writeFile(REMOVE_CSV, toCsv(plan.remove));
  deps.log(`\n[demo-truth] wrote ${ADD_CSV} and ${REMOVE_CSV}`);

  const result = { ok: true, add: plan.add.length, remove: plan.remove.length, written: { added: 0, removed: 0, skipped: 0 } };
  if (!args.execute) {
    deps.log(`\nDRY RUN — nothing written. To apply:\n  node scripts/backfill-demo-truth.js --execute --confirm-add=${plan.add.length} --confirm-remove=${plan.remove.length} --limit=${args.limit}`);
    return result;
  }

  if (args.confirmAdd !== plan.add.length || args.confirmRemove !== plan.remove.length) {
    const msg = `confirm counts do not match this run (add ${args.confirmAdd} vs ${plan.add.length}, remove ${args.confirmRemove} vs ${plan.remove.length}) — re-run the dry run and copy its numbers`;
    deps.log(`REFUSED: ${msg}`);
    return { ...result, ok: false, errors: [msg] };
  }

  // Removals first: they are the small, reviewed set and the riskier write.
  const queue = [
    ...plan.remove.map((r) => ({ ...r, op: 'remove' })),
    ...plan.add.map((r) => ({ ...r, op: 'add' })),
  ].slice(0, args.limit);

  for (let i = 0; i < queue.length; i += 1) {
    const item = queue[i];
    if (i > 0) await deps.sleep(PACE_MS);
    const tags = await liveTags(deps, item.contact_id);
    if (tags === null) { result.written.skipped += 1; deps.log(`  skip ${item.contact_id}: live contact unreadable`); continue; }
    try {
      if (item.op === 'remove') {
        if (!hasTag(tags, DEMO_TAG)) { result.written.skipped += 1; deps.log(`  skip ${item.contact_id}: tag already gone`); continue; }
        if (hasProtected(tags)) { result.written.skipped += 1; deps.log(`  skip ${item.contact_id}: now carries a protected tag`); continue; }
        await deps.executeRemoveTag({ target_id: item.contact_id, action_payload: { tag: DEMO_TAG } });
        result.written.removed += 1;
        deps.log(`  removed ${DEMO_TAG} from ${item.contact_id} (${item.why})`);
      } else {
        if (hasTag(tags, DEMO_TAG)) { result.written.skipped += 1; deps.log(`  skip ${item.contact_id}: already tagged`); continue; }
        await deps.executeAddTag({ target_id: item.contact_id, action_payload: { tag: DEMO_TAG } });
        result.written.added += 1;
        deps.log(`  added ${DEMO_TAG} to ${item.contact_id} (${item.why})`);
      }
    } catch (err) {
      result.written.skipped += 1;
      deps.log(`  FAILED ${item.op} ${item.contact_id}: ${err.message}`);
    }
  }
  deps.log(`\n[demo-truth] EXECUTE: added ${result.written.added}, removed ${result.written.removed}, skipped ${result.written.skipped} (of ${queue.length} this run; ${plan.add.length + plan.remove.length - queue.length} left for later runs)`);
  return result;
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  run(process.argv.slice(2), await defaultDeps())
    .then((r) => process.exit(r.ok ? 0 : 1))
    .catch((err) => { console.error(`[demo-truth] FAILED: ${err.message}`); process.exit(1); });
}
