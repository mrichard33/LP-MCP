#!/usr/bin/env node
/**
 * TIER B — do stranded LP leads have an existing GHL contact at all?
 * scripts/probe-ghl-link-candidates.js
 *
 * Answers one question across the whole stranded population, rather than a
 * sample: for each lp_leads row with no ghl_contact_id, is there a GHL contact
 * whose phone or email corroborates it?
 *
 * Usage:
 *   node scripts/probe-ghl-link-candidates.js                    # report only
 *   node scripts/probe-ghl-link-candidates.js --cohort=jobs      # job-bearing
 *   node scripts/probe-ghl-link-candidates.js --cohort=recent90
 *   node scripts/probe-ghl-link-candidates.js --write            # WRITES verdicts
 *
 * Like scripts/audit-orphan-ghl-links.js and unlike scripts/backfill-*.js, this
 * defaults to READ-ONLY and writing is opt-in. It is an audit tool, and the
 * decision it informs is whether Tier B is worth doing at all.
 *
 * ─── Why this exists ────────────────────────────────────────────────────────
 * Tier B assumed stranded leads have GHL contacts we simply failed to link.
 * Sampling on 2026-08-29 said otherwise:
 *
 *   control (leads that ARE linked)      230 / 240 found  95.8%
 *   stranded, job-bearing (any age)        8 / 273 found   2.9%
 *   stranded, created in last 90 days      3 / 260 found   1.2%
 *
 * The control proves the method and the mirror are sound, so the stranded
 * cohorts genuinely have no GHL counterpart. Structurally: GHL holds ~18.2k
 * contacts, LP holds ~236k leads, and the ~12.2k distinct linked contacts are
 * nearly all of GHL. LP is the full historical lead universe; GHL is the
 * actively-marketed subset. They were never the same population.
 *
 * This script exists to confirm that against every row before Tier B is closed
 * out, and to capture the genuine handful for review.
 *
 * ─── What it never does ─────────────────────────────────────────────────────
 * It never writes lp_leads. A verdict here is a CANDIDATE for review, not a
 * link. Promotion is a separate, explicitly approved step — and note that
 * promoting a link is NOT firing-neutral the way Tier A was: it makes the
 * sweeper's lead fallback (src/milestones.js:147) resolve where it previously
 * returned nothing, arming historical milestone fires. See
 * docs/ghl-link-backfill-tiers.md before promoting anything.
 *
 * ─── Matching ───────────────────────────────────────────────────────────────
 * Reuses corroborateIdentity / phonesMatch / normalizeEmail from
 * src/services/link-corroboration.js — they already handle the LP bare-10-digit
 * vs GHL E.164 mismatch and the "NA" email sentinel. No second matcher.
 *
 * Lookups are batched .in() queries against the HL contacts mirror on the
 * indexed columns (17,354 of 18,229 contacts store +1XXXXXXXXXX), NOT the
 * hl_query/run_sql path — the HL instance still carries the old
 * `EXECUTE ... INTO result` run_sql body, which returns only the first column
 * of the first row and would silently discard the result set.
 *
 * MANY LP LEADS TO ONE GHL CONTACT IS NORMAL, NOT A CONFLICT — repeat inquiries
 * from one household. 3,872 contacts already map to more than one lead. Only the
 * reverse (one lead, several candidate contacts) is ambiguity, and only that is
 * recorded to lp_link_conflicts.
 */

import { pathToFileURL } from 'node:url';
import supabase from '../src/supabase.js';
import { getHlSupabase } from '../src/admin/hl-client.js';
import { _internal as corroboration } from '../src/services/link-corroboration.js';

const { corroborateIdentity, normalizeEmail } = corroboration;

const args = process.argv.slice(2);
const has = (n) => args.includes(`--${n}`);
const strArg = (n, d) => (args.find((a) => a.startsWith(`--${n}=`)) || '').split('=')[1] || d;
const numArg = (n, d) => {
  const v = parseInt(strArg(n, ''), 10);
  return Number.isFinite(v) && v > 0 ? v : d;
};

const WRITE = has('write');
const COHORT = strArg('cohort', 'both');
const PAGE = numArg('page', 500);
const LIMIT = numArg('limit', 0);

if (!['both', 'jobs', 'recent90'].includes(COHORT)) {
  console.error(`--cohort must be one of: both, jobs, recent90 (got "${COHORT}")`);
  process.exit(1);
}

const digits = (s) => String(s || '').replace(/\D/g, '');
const last10 = (s) => {
  const d = digits(s);
  return d.length >= 10 ? d.slice(-10) : null;
};

// GHL stores +1XXXXXXXXXX; a handful of rows deviate. Query both plausible
// forms so the lookup stays an indexed .in() instead of a scan.
const phoneVariants = (p10) => [`+1${p10}`, p10, `1${p10}`, `+${p10}`];

async function fetchStrandedLeads() {
  // The cohort predicate lives in SQL because "has a job" is an EXISTS over
  // lp_jobs and would otherwise mean pulling all 217k stranded leads into Node.
  const cohortSql = {
    jobs: `EXISTS (SELECT 1 FROM lp_jobs j WHERE j.lp_lead_id = l.lp_lead_id)`,
    recent90: `l.created_at_lp > now() - interval '90 days'`,
    both: `(EXISTS (SELECT 1 FROM lp_jobs j WHERE j.lp_lead_id = l.lp_lead_id)
            OR l.created_at_lp > now() - interval '90 days')`,
  }[COHORT];

  const { data, error } = await supabase.rpc('run_sql', {
    query_text: `
      SELECT l.lp_lead_id, l.lp_prospect_id, l.phone, l.phone_alt, l.email,
             l.created_at_lp
        FROM lp_leads l
       WHERE l.ghl_contact_id IS NULL
         AND ${cohortSql}
       ORDER BY l.lp_lead_id
       ${LIMIT ? `LIMIT ${LIMIT}` : ''}
    `,
  });
  if (error) throw new Error(`lead fetch failed: ${error.message}`);
  return Array.isArray(data) ? data : [];
}

// One batched read of the HL mirror for a slice of leads. Returns contacts
// keyed by both last-10 phone and normalized email so a lead can be resolved
// without a second round trip.
async function fetchCandidates(hl, leads) {
  const phones = new Set();
  const emails = new Set();
  for (const l of leads) {
    for (const p of [last10(l.phone), last10(l.phone_alt)]) {
      if (p) phoneVariants(p).forEach((v) => phones.add(v));
    }
    const e = normalizeEmail(l.email);
    if (e) emails.add(e);
  }

  const byPhone = new Map();
  const byEmail = new Map();
  const add = (map, key, row) => {
    if (!key) return;
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(row);
  };

  const cols = 'ghl_contact_id, phone, email, synced_at, deleted_at';
  for (const [col, values] of [['phone', [...phones]], ['email', [...emails]]]) {
    for (let i = 0; i < values.length; i += 200) {
      const chunk = values.slice(i, i + 200);
      if (chunk.length === 0) continue;
      const { data, error } = await hl.from('contacts').select(cols).in(col, chunk);
      if (error) throw new Error(`HL ${col} lookup failed: ${error.message}`);
      for (const row of data || []) {
        if (row.deleted_at) continue;
        add(byPhone, last10(row.phone), row);
        add(byEmail, normalizeEmail(row.email), row);
      }
    }
  }
  return { byPhone, byEmail };
}

function classify(lead, byPhone, byEmail) {
  const lpIdentity = {
    phone: lead.phone || null,
    phoneAlt: lead.phone_alt || null,
    email: normalizeEmail(lead.email),
  };

  const seen = new Map();
  for (const p of [last10(lead.phone), last10(lead.phone_alt)]) {
    for (const c of (p && byPhone.get(p)) || []) seen.set(c.ghl_contact_id, c);
  }
  for (const c of (lpIdentity.email && byEmail.get(lpIdentity.email)) || []) {
    seen.set(c.ghl_contact_id, c);
  }

  // Re-run the shared corroboration predicate rather than trusting the join:
  // it is the same check the resolver applies before any real bind.
  const corroborated = [...seen.values()]
    .filter((c) => corroborateIdentity(lpIdentity, c) === 'pass');

  if (corroborated.length === 0) return { verdict: 'no_candidate', lpIdentity, contacts: [] };
  if (corroborated.length === 1) return { verdict: 'match', lpIdentity, contacts: corroborated };
  return { verdict: 'ambiguous', lpIdentity, contacts: corroborated };
}

async function main() {
  const hl = getHlSupabase();
  if (!hl) {
    console.error('HL Supabase not configured (HL_SUPABASE_URL / service key) — cannot probe.');
    process.exit(1);
  }

  console.log('─'.repeat(72));
  console.log(`TIER B probe  cohort=${COHORT}  ${WRITE ? 'WRITE verdicts' : 'REPORT ONLY'}`);
  console.log('─'.repeat(72));

  const leads = await fetchStrandedLeads();
  console.log(`\nStranded leads in cohort: ${leads.length}`);

  const stats = { match: 0, ambiguous: 0, no_candidate: 0, no_identity: 0 };
  const samples = [];

  for (let i = 0; i < leads.length; i += PAGE) {
    const slice = leads.slice(i, i + PAGE);
    const { byPhone, byEmail } = await fetchCandidates(hl, slice);

    for (const lead of slice) {
      const hasIdentity = last10(lead.phone) || last10(lead.phone_alt) || normalizeEmail(lead.email);
      if (!hasIdentity) { stats.no_identity++; continue; }

      const { verdict, lpIdentity, contacts } = classify(lead, byPhone, byEmail);
      stats[verdict]++;

      if (verdict === 'match' && samples.length < 25) {
        samples.push({ lp_lead_id: lead.lp_lead_id, ghl_contact_id: contacts[0].ghl_contact_id });
      }

      if (!WRITE) continue;

      if (verdict === 'match') {
        await supabase.from('lp_link_verifications').upsert({
          lp_lead_id: String(lead.lp_lead_id),
          ghl_contact_id: contacts[0].ghl_contact_id,
          verdict: 'pass',
          verify_source: 'hl_cache',
          detail: {
            probe: 'tier_b_reconciliation',
            ghl_phone: contacts[0].phone || null,
            ghl_email: contacts[0].email || null,
            cache_synced_at: contacts[0].synced_at || null,
          },
          verified_at: new Date().toISOString(),
        }, { onConflict: 'lp_lead_id,ghl_contact_id' });
      } else if (verdict === 'ambiguous') {
        // One lead, several corroborating contacts. Never guessed at.
        await supabase.from('lp_link_conflicts').insert({
          lp_lead_id: String(lead.lp_lead_id),
          lp_prospect_id: lead.lp_prospect_id ? String(lead.lp_prospect_id) : null,
          resolution: 'rejected_conflict',
          reason: 'tier_b_probe_multiple_candidate_contacts',
          lp_phone: lpIdentity.phone,
          lp_email: lpIdentity.email,
          detail: { candidates: contacts.map((c) => c.ghl_contact_id) },
        });
      }
    }
    console.log(`  ...${Math.min(i + PAGE, leads.length)} / ${leads.length}`);
  }

  const evaluated = stats.match + stats.ambiguous + stats.no_candidate;
  const pct = (n) => (evaluated ? ((n / evaluated) * 100).toFixed(1) : '0.0');

  console.log('\nResult:');
  console.log(`  match (exactly one corroborating contact) : ${stats.match}  (${pct(stats.match)}%)`);
  console.log(`  ambiguous (several candidates)            : ${stats.ambiguous}  (${pct(stats.ambiguous)}%)`);
  console.log(`  no GHL contact at all                     : ${stats.no_candidate}  (${pct(stats.no_candidate)}%)`);
  console.log(`  skipped, no LP phone or email             : ${stats.no_identity}`);

  if (samples.length) {
    console.log('\nSample matches (verify a few by hand in BOTH systems):');
    for (const s of samples) console.log(`  lp_lead_id=${s.lp_lead_id} -> ${s.ghl_contact_id}`);
  }

  console.log(
    WRITE
      ? '\nVerdicts written to lp_link_verifications. lp_leads NOT touched — promotion is a separate approved step.'
      : '\nReport only — nothing written. Re-run with --write to record verdicts for review.',
  );
}

// Test seam. main() runs only when this file is the entry point, so the test
// can import the matching logic without opening a Supabase connection.
export const _internal = { last10, phoneVariants, classify };

const isEntryPoint = process.argv[1]
  && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isEntryPoint) {
  main().catch((err) => { console.error('Fatal:', err.message); process.exit(1); });
}
