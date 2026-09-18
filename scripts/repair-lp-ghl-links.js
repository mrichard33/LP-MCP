#!/usr/bin/env node
/**
 * Repair LP↔GHL Links — scripts/repair-lp-ghl-links.js
 *
 * ONE job: give the open P2 opportunities that scripts/reconcile-p2-stages.js
 * could not touch an `lp_jobs` row it can find, by writing the LP↔GHL link that
 * was never written in the first place.
 *
 * WHY A REPAIR PASS EXISTS
 * ────────────────────────
 * The 2026-09-18 reconciler pass moved 89 stages, won 1,186 and lost 501 with
 * zero failures — and left a cohort untouched because `fetchJobsWithMilestones`
 * keys `lp_jobs` on `ghl_contact_id` and no row could be found. The handoff
 * counted 332 that morning; this script measured 344 on the same day, and the
 * number moves as opportunities open and close, which is why nothing here is
 * written against a hardcoded expectation.
 *
 * Those are NOT missing records. Sampled contacts carry `lp-linked` /
 * `lp-inbound` tags in GHL, their LP records exist and are findable by phone,
 * and `lp_leads.ghl_contact_id` / `lp_jobs.ghl_contact_id` are simply NULL.
 * Worked example: Liz & Cesar Alcãzar, GHL contact fyPgZaoTsBqVxUgDqP9Q,
 * $19,000, tagged `lp-linked`, LP lead 536772 / prospect 429315, disposition
 * Sale — a real closed deal, invisible to every contact-id-keyed query.
 *
 * THIS WRITES TO LP SUPABASE ONLY. It never calls a GHL write endpoint. Its
 * only GHL traffic is a read (`GET /contacts/{id}`) for a postal code, and only
 * when the HL contacts mirror cannot supply one.
 *
 * ─── WHY NOT EXTEND backfill-ghl-link-propagate.js ─────────────────────────
 * That script (Tier A) propagates an EXISTING lp_leads link down to its child
 * rows. It performs no identity inference at all, which is exactly what makes
 * it safe to run unattended — and exactly why it cannot do this job: here the
 * parent lead is itself unlinked, so there is nothing to propagate. The two are
 * complements and both are needed. Tier A was extended in the same change to
 * cover lp_notes and lp_call_logs; run it AFTER this one so the links this
 * script writes onto lp_leads reach the children.
 *
 * ─── THE SELECTION RULE IS NOT IN THIS FILE ────────────────────────────────
 * src/lp-link-selection.js owns it, pure and unit-tested, because it is the
 * decision that can be silently wrong. Mark's ruling in full lives in that
 * file's header. In short: pick the lead that HAS A JOB — not the most recent,
 * not the most recent non-cancelled. `latestJob()` in src/lp-job-value.js
 * answers a different question and is untouched.
 *
 * ─── TIERS ─────────────────────────────────────────────────────────────────
 *   1  phone, last 10 digits, both sides normalized   → auto-write
 *   2  phone + zip agreement                          → auto-write, confidence high
 *   3  last name + zip                                → REPORT ONLY, never writes
 *
 * TIER 1 NORMALIZATION IS WHERE THIS SILENTLY FAILS. GHL stores `+13524453161`;
 * LP stores `3524453161`. Measured over the live cohort on 2026-09-18: matching
 * GHL's stored phone against LP's stored phone as full strings finds 0 of 344.
 * Matching on `right(regexp_replace(phone,'[^0-9]','','g'), 10)` on BOTH sides
 * finds 110. The delta is the entire yield.
 *
 * TIER 2 IS A CONFIDENCE FLAG, NOT A SEPARATE YIELD PASS. Phone+zip is strictly
 * narrower than phone alone, so it cannot recover a row tier 1 missed — it
 * raises confidence on a row tier 1 already found. A tier-1 match whose zip also
 * agrees is `high`; phone-only is `medium`. Both are written; the confidence is
 * recorded in the rollback log so a later review can rank what to spot-check.
 *
 * TIER 3 NEVER WRITES. Common surnames in one zip are exactly how you attach a
 * stranger's job to a customer. It emits a CSV a human rules on.
 *
 * AMBIGUITY IS A REFUSAL, NOT A COIN FLIP. More than one candidate surviving the
 * selection rule is reported `ambiguous` and nothing is written.
 *
 * ─── SAFETY ────────────────────────────────────────────────────────────────
 * DRY RUN BY DEFAULT — needs --apply to write anything.
 * Every write is guarded `AND ghl_contact_id IS NULL`, so a link established by
 * the live 15-minute sync between the read and the write is never overwritten;
 * the guard turns that race into a no-op that the summary reports as `raced`.
 * A `.jsonl` rollback log per run records the previous value (always NULL) for
 * every row touched.
 *
 * ─── USAGE ─────────────────────────────────────────────────────────────────
 *   node scripts/repair-lp-ghl-links.js                       # dry run, all tiers
 *   node scripts/repair-lp-ghl-links.js --tier=1              # tier 1 only
 *   node scripts/repair-lp-ghl-links.js --tier=1 --limit=25 --apply
 *   node scripts/repair-lp-ghl-links.js --tier=1 --apply
 *   node scripts/repair-lp-ghl-links.js --tier=3              # produce the CSV
 *
 *   --apply         Actually write. Without it nothing is written to LP.
 *   --dry-run       Force dry run even alongside --apply.
 *   --limit=N       Cap the contacts this run WRITES for. Classification is
 *                   never capped, so the summary stays complete.
 *   --tier=1,2,3    Which tiers to run (default all). Tier 2 implies tier 1 —
 *                   it is a flag on tier 1's matches, not a pass of its own.
 *   --no-live-zip   Never call GHL for a postal code; use the mirror or nothing.
 *   --log-dir=PATH  Rollback log destination (default ./lp-link-repair).
 *   --report-dir=P  Tier 3 CSV destination (default ./reports).
 *
 * Environment (already set on the LP-MCP Railway service — this script does not
 * load .env, so run it under `railway run --service LP-MCP --`):
 *   GHL_API_KEY, HL_SUPABASE_URL, HL_SUPABASE_SERVICE_ROLE_KEY,
 *   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
 */

import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { ghlFetch } from '../src/actions/helpers.js';
import { PIPELINE_IDS } from '../src/actions/constants.js';
import { hlRunSQL } from '../src/admin/hl-client.js';
import { shapeValidLognumber } from '../src/ghl-link-shape.js';
import { runSQL } from '../src/admin/supabase-admin.js';
import {
  phone10, zipKey, lastNameKey, classifyTierOne, buildTier3Rows,
} from '../src/lp-link-match.js';
import { LINK_SOURCE } from '../src/services/link-corroboration.js';
import { selectAllIn } from '../src/supabase-page.js';
import supabase from '../src/supabase.js';

// ═══════════════════════════════════════════════════════════════════
// I/O
// ═══════════════════════════════════════════════════════════════════

const args = process.argv.slice(2);
const has = (name) => args.includes(`--${name}`);
const strArg = (name, fallback) => {
  const raw = (args.find((a) => a.startsWith(`--${name}=`)) || '').split('=').slice(1).join('=');
  return raw || fallback;
};
const intArg = (name, fallback) => {
  const n = parseInt(strArg(name, ''), 10);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
};

const opt = {
  apply: has('apply') && !has('dry-run'),
  limit: intArg('limit', Infinity),
  tiers: new Set(strArg('tier', '1,2,3').split(',').map((s) => s.trim()).filter(Boolean)),
  liveZip: !has('no-live-zip'),
  logDir: strArg('log-dir', './lp-link-repair'),
  reportDir: strArg('report-dir', './reports'),
};

const badTiers = [...opt.tiers].filter((t) => !['1', '2', '3'].includes(t));
if (badTiers.length) {
  console.error(`--tier accepts 1, 2 and 3 (got: ${badTiers.join(', ')})`);
  process.exit(1);
}
// Tier 2 is a flag on tier 1's matches, never a pass of its own. Asking for
// tier 2 without tier 1 would silently do nothing, so say so instead.
const runTier1 = opt.tiers.has('1') || opt.tiers.has('2');
const runTier2 = opt.tiers.has('2');
const runTier3 = opt.tiers.has('3');

const PIPELINE_P2 = PIPELINE_IDS.P2;

/** Open P2 opportunities, from the HL mirror, with whatever contact detail it holds. */
async function fetchOpenP2(mirrorHasAddress) {
  const zipCol = mirrorHasAddress ? 'c.postal_code' : 'NULL::text';
  const rows = await hlRunSQL(`
    SELECT o.ghl_opportunity_id, o.ghl_contact_id, o.monetary_value,
           c.first_name, c.last_name, c.phone, ${zipCol} AS postal_code
      FROM opportunities o
      JOIN contacts c ON c.ghl_contact_id = o.ghl_contact_id
     WHERE o.ghl_pipeline_id = '${PIPELINE_P2}'
       AND o.ghl_contact_id IS NOT NULL
       AND o.deleted_at IS NULL
       AND o.status = 'open'
     ORDER BY o.ghl_contact_id
  `);

  // Same completeness discipline as reconcile-p2-stages.js: hlRunSQL is not
  // subject to the PostgREST row cap, but that is a property of the transport
  // rather than a guarantee, so it is checked rather than assumed.
  const [{ n } = {}] = await hlRunSQL(`
    SELECT count(*) AS n
      FROM opportunities o
      JOIN contacts c ON c.ghl_contact_id = o.ghl_contact_id
     WHERE o.ghl_pipeline_id = '${PIPELINE_P2}'
       AND o.ghl_contact_id IS NOT NULL
       AND o.deleted_at IS NULL
       AND o.status = 'open'
  `);
  const expected = Number(n);
  if (Number.isFinite(expected) && (rows || []).length !== expected) {
    throw new Error(
      `HL opportunities read incomplete: got ${(rows || []).length} of ${expected}. `
      + 'Refusing to repair from a partial candidate set.',
    );
  }
  return rows || [];
}

/** True when the contacts mirror carries postal_code (i.e. sql/017 has been applied). */
async function mirrorHasAddressColumns() {
  const rows = await hlRunSQL(`
    SELECT count(*) AS n FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'contacts' AND column_name = 'postal_code'
  `);
  return Number(rows?.[0]?.n || 0) > 0;
}

/**
 * Which of these contacts ALREADY have an lp_jobs row.
 *
 * This is the reconciler's own key, so the cohort this script repairs is
 * defined by the same predicate the reconciler skipped on — not by an
 * independent guess at what "unlinked" means.
 */
async function contactsWithJobs(contactIds) {
  const rows = await selectAllIn(supabase, 'lp_jobs', {
    columns: 'id, ghl_contact_id',
    orderBy: 'id',
    column: 'ghl_contact_id',
    values: contactIds,
  });
  return new Set(rows.map((r) => r.ghl_contact_id));
}

const sqlList = (values) => values.map((v) => `'${String(v).replace(/'/g, "''")}'`).join(',');

/**
 * Unlinked LP leads whose normalized phone is in `keys`.
 *
 * Goes through runSQL rather than the PostgREST client on purpose: the match is
 * on an EXPRESSION over the phone column, and `.in('phone', keys)` would be an
 * exact-string compare that happens to work only because LP currently stores
 * bare 10 digits. The day one vendor row arrives as `(352) 445-3161`, the
 * client form misses it silently and the expression form does not.
 * sql/122 adds the matching index so this is a lookup, not a 242k-row scan.
 */
async function fetchLeadsByPhone10(keys) {
  const out = [];
  const CHUNK = 200;
  for (let i = 0; i < keys.length; i += CHUNK) {
    const chunk = keys.slice(i, i + CHUNK);
    const rows = await runSQL(`
      SELECT l.lp_lead_id, l.lp_prospect_id, l.last_name, l.zip, l.phone,
             right(regexp_replace(coalesce(l.phone,''), '[^0-9]', '', 'g'), 10) AS phone10,
             EXISTS (SELECT 1 FROM lp_jobs j WHERE j.lp_lead_id = l.lp_lead_id) AS has_job
        FROM lp_leads l
       WHERE l.ghl_contact_id IS NULL
         AND right(regexp_replace(coalesce(l.phone,''), '[^0-9]', '', 'g'), 10) IN (${sqlList(chunk)})
    `);
    out.push(...(Array.isArray(rows) ? rows : []));
  }
  return out;
}

/** Unlinked LP leads matching any of these surname keys — tier 3 candidates only. */
async function fetchLeadsByLastName(keys) {
  const out = [];
  const CHUNK = 100;
  for (let i = 0; i < keys.length; i += CHUNK) {
    const chunk = keys.slice(i, i + CHUNK);
    const rows = await runSQL(`
      SELECT l.lp_lead_id, l.lp_prospect_id, l.last_name, l.zip, l.phone,
             lower(regexp_replace(coalesce(l.last_name,''), '[^A-Za-z]', '', 'g')) AS name_key,
             EXISTS (SELECT 1 FROM lp_jobs j WHERE j.lp_lead_id = l.lp_lead_id) AS has_job
        FROM lp_leads l
       WHERE l.ghl_contact_id IS NULL
         AND l.zip IS NOT NULL
         AND lower(regexp_replace(coalesce(l.last_name,''), '[^A-Za-z]', '', 'g')) IN (${sqlList(chunk)})
    `);
    out.push(...(Array.isArray(rows) ? rows : []));
  }
  return out;
}

/** The contact's postal code from GHL, live. Null on any failure — never throws. */
async function liveZip(contactId) {
  try {
    const res = await ghlFetch('GET', `/contacts/${contactId}`, null, { maxWaitMs: 10000 });
    const c = res?.contact || res;
    return c?.postalCode ?? c?.postal_code ?? null;
  } catch (err) {
    // A zip we cannot read only costs CONFIDENCE (tier 2) or a tier-3 report
    // row. It never blocks a tier-1 write, so this degrades rather than fails.
    console.warn(`[LinkRepair] live zip read failed for ${contactId}: ${err.message}`);
    return null;
  }
}

function openLog() {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  fs.mkdirSync(opt.logDir, { recursive: true });
  const file = path.join(opt.logDir, `lp-link-repair-${stamp}.jsonl`);
  const fd = fs.openSync(file, 'a');
  return {
    file,
    write: (entry) => fs.writeSync(fd, `${JSON.stringify(entry)}\n`),
    close: () => fs.closeSync(fd),
  };
}

/**
 * Write the link onto one lead and its jobs.
 *
 * Both statements carry `AND ghl_contact_id IS NULL`. The live 15-minute sync
 * runs while this does, so a lead legitimately linked between the read and the
 * write must be left alone — the guard turns that race into a reported no-op
 * instead of an overwrite, which is the one outcome nobody could undo from the
 * rollback log.
 *
 * ghl_link_source is stamped in the same statement. A populated ghl_contact_id
 * must never sit next to a NULL source — that is what made the
 * Y21mrJPUGYGKIWFptVpu link untraceable (see src/sync-children.js, 2026-07-29).
 */
async function writeLink(lpLeadId, contactId, source) {
  // Shape-check the id before it reaches a statement. Two jobs: it refuses a
  // malformed id that GHL's mirror should never have held, and it means the
  // interpolation below cannot carry anything but 20 alphanumerics. Shape
  // validity is NOT link validity (src/ghl-link-shape.js) — the phone match is
  // what makes this a link; this is the floor, not the evidence.
  if (!shapeValidLognumber(contactId)) {
    throw new Error(`refusing to write a malformed GHL contact id: ${JSON.stringify(contactId)}`);
  }
  const leadRows = await runSQL(`
    WITH u AS (
      UPDATE lp_leads
         SET ghl_contact_id = '${contactId}', ghl_link_source = '${String(source).replace(/'/g, "''")}'
       WHERE lp_lead_id = '${String(lpLeadId).replace(/'/g, "''")}'
         AND ghl_contact_id IS NULL
      RETURNING 1
    ) SELECT count(*) AS n FROM u
  `);
  const leadsUpdated = Number(leadRows?.[0]?.n || 0);
  if (leadsUpdated === 0) return { leadsUpdated: 0, jobsUpdated: 0 };

  const jobRows = await runSQL(`
    WITH u AS (
      UPDATE lp_jobs
         SET ghl_contact_id = '${contactId}'
       WHERE lp_lead_id = '${String(lpLeadId).replace(/'/g, "''")}'
         AND ghl_contact_id IS NULL
      RETURNING 1
    ) SELECT count(*) AS n FROM u
  `);
  return { leadsUpdated, jobsUpdated: Number(jobRows?.[0]?.n || 0) };
}

function writeTier3Csv(rows) {
  fs.mkdirSync(opt.reportDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const file = path.join(opt.reportDir, `lp-link-tier3-review-${stamp}.csv`);
  const esc = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const header = [
    'ghl_contact_id', 'ghl_opportunity_id', 'ghl_name', 'ghl_phone', 'ghl_zip',
    'lp_lead_id', 'lp_prospect_id', 'matched_on', 'disagreed',
  ].join(',');
  const lines = rows.map((r) => [
    r.ghl_contact_id, r.ghl_opportunity_id, r.ghl_name, r.ghl_phone, r.ghl_zip,
    r.lp_lead_id, r.lp_prospect_id, r.matched, r.disagreed,
  ].map(esc).join(','));
  fs.writeFileSync(file, `${header}\n${lines.join('\n')}\n`);
  return file;
}

async function main() {
  console.log('─'.repeat(74));
  console.log(
    `LP↔GHL LINK REPAIR  [${opt.apply ? 'APPLY' : 'DRY RUN'}]  `
    + `tiers=${[...opt.tiers].sort().join(',')}  limit=${opt.limit === Infinity ? 'none' : opt.limit}`,
  );
  console.log('Writes to LP Supabase only. No GHL writes, ever.');
  console.log('─'.repeat(74));

  const mirrorHasAddress = await mirrorHasAddressColumns();
  console.log(
    `\ncontacts mirror postal_code: ${mirrorHasAddress ? 'PRESENT' : 'ABSENT'}`
    + `${mirrorHasAddress ? '' : ' — sql/017 (HL-MCP) not applied yet; tier 2 falls back to live GHL reads'}`,
  );

  const opps = await fetchOpenP2(mirrorHasAddress);
  console.log(`open P2 opportunities: ${opps.length}`);

  const withJobs = await contactsWithJobs([...new Set(opps.map((o) => o.ghl_contact_id))]);
  const cohort = opps.filter((o) => !withJobs.has(o.ghl_contact_id));
  console.log(`of those, WITHOUT any lp_jobs row (the repair cohort): ${cohort.length}`);
  if (cohort.length === 0) {
    console.log('\nNothing to repair.');
    return;
  }

  // ─── Zip resolution, once, shared by tiers 2 and 3 ────────────────────────
  const zipSource = { mirror: 0, live: 0, none: 0 };
  for (const c of cohort) {
    if (zipKey(c.postal_code)) { c.ghlZip = c.postal_code; zipSource.mirror++; continue; }
    if (!opt.liveZip || (!runTier2 && !runTier3)) { c.ghlZip = null; zipSource.none++; continue; }
    const z = await liveZip(c.ghl_contact_id);
    if (zipKey(z)) { c.ghlZip = z; zipSource.live++; } else { c.ghlZip = null; zipSource.none++; }
  }
  console.log(
    `zip source — mirror: ${zipSource.mirror}, live GHL: ${zipSource.live}, none: ${zipSource.none}`,
  );

  // ─── Tier 1 (+2) ──────────────────────────────────────────────────────────
  const decisions = new Map();   // ghl_contact_id → decision
  if (runTier1) {
    const keys = [...new Set(cohort.map((c) => phone10(c.phone)).filter(Boolean))];
    console.log(`\ntier 1: ${keys.length} distinct normalized phones from ${cohort.length} contacts`);
    const leads = await fetchLeadsByPhone10(keys);
    const byPhone = new Map();
    for (const l of leads) {
      if (!byPhone.has(l.phone10)) byPhone.set(l.phone10, []);
      byPhone.get(l.phone10).push(l);
    }
    console.log(`tier 1: ${leads.length} unlinked lp_leads rows matched on ${byPhone.size} of those`);

    for (const c of cohort) {
      const key = phone10(c.phone);
      decisions.set(c.ghl_contact_id, classifyTierOne(c, key ? byPhone.get(key) || [] : []));
    }
  }

  // ─── Writes ───────────────────────────────────────────────────────────────
  const stats = {
    matched: 0, written: 0, ambiguous: 0, no_job_bearing_lead: 0,
    no_candidates: 0, unmatched: 0, raced: 0, over_limit: 0, failed: 0,
    confidence_high: 0, confidence_medium: 0,
  };
  const log = openLog();
  console.log(`\nrollback log → ${log.file}`);

  let acted = 0;
  for (const c of cohort) {
    const d = decisions.get(c.ghl_contact_id);
    if (!d) continue;

    if (d.verdict !== 'selected') {
      stats[d.verdict] = (stats[d.verdict] ?? 0) + 1;
      continue;
    }
    stats.matched++;
    if (d.confidence === 'high') stats.confidence_high++; else stats.confidence_medium++;

    if (acted >= opt.limit) { stats.over_limit++; continue; }

    const entry = {
      ts: new Date().toISOString(),
      ghl_contact_id: c.ghl_contact_id,
      ghl_opportunity_id: c.ghl_opportunity_id,
      tier: d.tier,
      confidence: d.confidence,
      zip_source: zipKey(c.postal_code) ? 'mirror' : (c.ghlZip ? 'live_ghl' : 'none'),
      lp_lead_id: d.lead.lp_lead_id,
      lp_prospect_id: d.lead.lp_prospect_id ?? null,
      // The previous value, which is what a rollback needs. It is always NULL by
      // construction (the read filters on it and the write guards on it), and it
      // is recorded literally rather than assumed so the log stands alone.
      previous_ghl_contact_id: null,
      applied: opt.apply,
    };

    if (!opt.apply) {
      log.write({ ...entry, result: 'dry_run' });
      acted++;
      continue;
    }

    try {
      const res = await writeLink(d.lead.lp_lead_id, c.ghl_contact_id, LINK_SOURCE.PHONE10_REPAIR);
      if (res.leadsUpdated === 0) {
        // The guard held: something linked this lead between our read and our
        // write. Not an error — the live sync got there first, and its link is
        // at least as good as ours.
        stats.raced++;
        log.write({ ...entry, result: 'raced_guard_held' });
      } else {
        stats.written++;
        acted++;
        log.write({ ...entry, result: 'written', jobs_updated: res.jobsUpdated });
      }
    } catch (err) {
      stats.failed++;
      log.write({ ...entry, result: 'failed', error: err.message });
      console.warn(`[LinkRepair] write failed for ${c.ghl_contact_id}: ${err.message}`);
    }
  }
  log.close();

  // ─── Tier 3 — report only ─────────────────────────────────────────────────
  let tier3File = null;
  let tier3Rows = [];
  if (runTier3) {
    const unresolved = cohort.filter((c) => {
      const d = decisions.get(c.ghl_contact_id);
      return !d || d.verdict !== 'selected';
    });
    const nameKeys = [...new Set(unresolved.map((c) => lastNameKey(c.last_name)).filter(Boolean))];
    console.log(
      `\ntier 3: ${unresolved.length} contacts ${runTier1 ? 'unresolved by tier 1' : '(tier 1 not run — whole cohort)'}, `
      + `${nameKeys.length} distinct surnames`,
    );
    const leads = nameKeys.length ? await fetchLeadsByLastName(nameKeys) : [];
    const byName = new Map();
    for (const l of leads) {
      if (!byName.has(l.name_key)) byName.set(l.name_key, []);
      byName.get(l.name_key).push(l);
    }
    for (const c of unresolved) {
      const key = lastNameKey(c.last_name);
      const rows = buildTier3Rows(
        { lastName: c.last_name, ghlZip: c.ghlZip, phone: c.phone },
        key ? byName.get(key) || [] : [],
      );
      for (const r of rows) {
        tier3Rows.push({
          ghl_contact_id: c.ghl_contact_id,
          ghl_opportunity_id: c.ghl_opportunity_id,
          ghl_name: `${c.first_name || ''} ${c.last_name || ''}`.trim(),
          ghl_phone: phone10(c.phone) || '',
          ghl_zip: zipKey(c.ghlZip) || '',
          ...r,
        });
      }
    }
    tier3File = writeTier3Csv(tier3Rows);
  }

  // ─── Summary ──────────────────────────────────────────────────────────────
  console.log(`\n${'─'.repeat(74)}`);
  console.log('SUMMARY');
  console.log('─'.repeat(74));
  console.log(`cohort (open P2, no lp_jobs row)   : ${cohort.length}`);
  if (runTier1) {
    console.log('\ntier 1/2 — phone, last 10 digits:');
    console.log(`  matched (a lead was selected)    : ${stats.matched}`);
    console.log(`    confidence high (zip agrees)   : ${stats.confidence_high}`);
    console.log(`    confidence medium (phone only) : ${stats.confidence_medium}`);
    console.log(`  written                          : ${stats.written}${opt.apply ? '' : '  (dry run — nothing written)'}`);
    console.log(`  raced (link appeared mid-run)    : ${stats.raced}`);
    console.log(`  ambiguous (refused)              : ${stats.ambiguous}`);
    console.log(`  no_job_bearing_lead (refused)    : ${stats.no_job_bearing_lead}`);
    console.log(`  unmatched (no LP lead by phone)  : ${stats.unmatched}`);
    console.log(`  over --limit (classified only)   : ${stats.over_limit}`);
    console.log(`  failed                           : ${stats.failed}`);
  }
  if (runTier3) {
    console.log('\ntier 3 — last name + zip (REPORT ONLY, never written):');
    console.log(`  candidate pairs for human review : ${tier3Rows.length}`);
    console.log(`  csv                              : ${tier3File}`);
    // Without a zip on the GHL side tier 3 cannot compare anything and returns
    // nothing. Say so, or "0 candidates" reads as "nothing to review" when it
    // really means "not measured".
    if (tier3Rows.length === 0 && zipSource.mirror + zipSource.live === 0) {
      console.log('  ^ 0 because NO zip was available for any contact — not because none matched.');
      console.log('    Apply HL-MCP sql/017, or re-run with GHL_API_KEY set and without --no-live-zip.');
    }
  }
  console.log(`\nzip source used — mirror: ${zipSource.mirror}, live GHL: ${zipSource.live}, none: ${zipSource.none}`);
  if (runTier1) {
    console.log(
      `\nof the ${cohort.length} unreconcilable opportunities, `
      + `${opt.apply ? stats.written : stats.matched} ${opt.apply ? 'now carry' : 'would carry'} a link `
      + `(${cohort.length - (opt.apply ? stats.written : stats.matched)} still unresolved).`,
    );
  } else {
    // Tier 3 alone resolves nothing by design, so it must not be reported
    // against the cohort as though it had tried and failed.
    console.log(`\nTier 1 was not run, so none of the ${cohort.length} is resolved by this pass — tier 3 only reports.`);
  }
  if (!opt.apply) console.log('\nDry run — no LP rows were changed. Re-run with --apply to write.');
}

// Importable for tests without executing. Same guard as reconcile-p2-stages.js.
if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  main().catch((err) => {
    console.error('Fatal:', err.message);
    process.exit(1);
  });
}
