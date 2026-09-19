/**
 * scripts/test-lp-link-repair.js
 *
 * Unit coverage for the LP↔GHL link repair decision surface:
 *   src/lp-link-selection.js — which lead a link is written onto
 *   src/lp-link-match.js     — phone/zip/name normalization and the tiers
 *   src/link-leak-alerts.js  — the prevention monitor's verdict
 *
 * All three are pure and dependency-free, which is why this suite needs no DB,
 * no env vars and no GHL. scripts/repair-lp-ghl-links.js is the I/O shell over
 * them and is deliberately NOT imported here — importing it would pull in the
 * Supabase driver and the GHL fetch wrapper at module load.
 *
 * WHAT THESE GUARD AGAINST. Every failure here is silent. A wrong selection
 * attaches a stranger's job to a customer and nothing downstream complains. A
 * phone normalization that drops back to full-string compare matches ZERO rows
 * and reads as "nothing to repair". A monitor that returns a boolean instead of
 * a three-way verdict announces a recovery nobody earned. None of them throws.
 *
 * Pure-function tests — no DB, no network, no GHL.
 * Run: node --test scripts/test-lp-link-repair.js
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { selectLinkLead } from '../src/lp-link-selection.js';
import {
  phone10, zipKey, lastNameKey, classifyTierOne, buildTier3Rows, disqualifyByFanout,
} from '../src/lp-link-match.js';
import { shouldAlertLinkLeak, formatLinkLeakAlert } from '../src/link-leak-alerts.js';
import {
  buildLeadLinkUpdate, buildLeadLinkReadback, buildJobsLinkUpdate, buildJobsLinkCount,
} from '../src/lp-link-write-sql.js';

const lead = (lp_lead_id, has_job, lp_prospect_id = '39362', extra = {}) =>
  ({ lp_lead_id: String(lp_lead_id), lp_prospect_id: String(lp_prospect_id), has_job, ...extra });

// ═══════════════════════════════════════════════════════════════════
// Task 1 — the selection rule (Mark's ruling, 2026-09-18)
// ═══════════════════════════════════════════════════════════════════

test('1. one job-bearing lead among four → picks it, not the most recent', () => {
  // The worked case from the ruling. Phone 7276571376, prospect 39362:
  //   131444 CXL · 131185 Sale (HAS A JOB) · 509149 OPPFDN · 46436 CCC
  // Picking by recency attaches to 509149 and misses the sale entirely — which
  // is exactly what latestJob() would do, and why it is not reused here.
  const candidates = [
    lead(131444, false),
    lead(131185, true),
    lead(509149, false),
    lead(46436, false),
  ];
  const res = selectLinkLead(candidates);
  assert.equal(res.verdict, 'selected');
  assert.equal(res.lead.lp_lead_id, '131185');
  assert.notEqual(res.lead.lp_lead_id, '509149'); // the recency answer
});

test('2. two job-bearing leads under one prospect → picks the higher lp_lead_id', () => {
  const res = selectLinkLead([lead(131185, true), lead(509149, true), lead(46436, false)]);
  assert.equal(res.verdict, 'selected');
  assert.equal(res.lead.lp_lead_id, '509149');
  assert.equal(res.jobBearingCount, 2);
});

test('3. no job-bearing lead → selects nothing, classified no_job_bearing_lead', () => {
  // A P2 opportunity means a contract was signed. A lead with no job is not the
  // record we want, and guessing buries the evidence. Measured on the live
  // cohort this is the LARGEST refusal bucket — 68 of 110 tier-1 matches.
  const res = selectLinkLead([lead(131444, false), lead(509149, false)]);
  assert.equal(res.verdict, 'no_job_bearing_lead');
  assert.equal(res.lead, null);
});

test('"no candidates at all" is reported apart from "candidates, none with a job"', () => {
  // "Not applicable" is not "unreadable" — the distinction that filed 432,474
  // non-events in the decision engine when it was collapsed (CLAUDE.md).
  assert.equal(selectLinkLead([]).verdict, 'no_candidates');
  assert.equal(selectLinkLead([lead(1, false)]).verdict, 'no_job_bearing_lead');
});

test('job-bearing leads under DIFFERENT prospects → ambiguous, never a tie-break', () => {
  const res = selectLinkLead([lead(131185, true, '39362'), lead(700001, true, '88888')]);
  assert.equal(res.verdict, 'ambiguous');
  assert.equal(res.lead, null);
  assert.deepEqual(res.prospectIds, ['39362', '88888']);
});

test('a second prospect with NO job does not make the pick ambiguous', () => {
  // The job-bearing filter runs FIRST. A shared phone whose other prospect has
  // no job is precisely what the ruling disambiguates — refusing here would
  // throw away a good repair.
  const res = selectLinkLead([lead(131185, true, '39362'), lead(700001, false, '88888')]);
  assert.equal(res.verdict, 'selected');
  assert.equal(res.lead.lp_lead_id, '131185');
});

test('a jobs ARRAY works the same as the has_job boolean', () => {
  const res = selectLinkLead([
    { lp_lead_id: '1', lp_prospect_id: '9', jobs: [] },
    { lp_lead_id: '2', lp_prospect_id: '9', jobs: [{ lp_job_id: '5' }] },
  ]);
  assert.equal(res.lead.lp_lead_id, '2');
});

// ═══════════════════════════════════════════════════════════════════
// Task 2 — the tiered matcher
// ═══════════════════════════════════════════════════════════════════

test('4. +13524453161 matches LP 3524453161', () => {
  // THE test. GHL stores E.164, LP stores bare digits. Measured over the live
  // 344-contact cohort: full-string equality matches 0, last-10 matches 110.
  assert.equal(phone10('+13524453161'), '3524453161');
  assert.equal(phone10('3524453161'), '3524453161');
  assert.equal(phone10('+13524453161'), phone10('3524453161'));
});

test('phone normalization survives the vendor formats too', () => {
  for (const v of ['(352) 445-3161', '352-445-3161', '352.445.3161', ' 1 352 445 3161 ']) {
    assert.equal(phone10(v), '3524453161', `failed on ${v}`);
  }
});

test('fewer than 10 digits is null, not a short key', () => {
  // '445-3161' as a key would match every number ending in those 7 digits.
  assert.equal(phone10('445-3161'), null);
  assert.equal(phone10(''), null);
  assert.equal(phone10(null), null);
});

test('5. phone matching two different prospects → ambiguous, no write', () => {
  const res = classifyTierOne(
    { ghl_contact_id: 'C1', ghlZip: '34239' },
    [lead(131185, true, '39362', { zip: '34239' }), lead(700001, true, '88888', { zip: '34239' })],
  );
  assert.equal(res.verdict, 'ambiguous');
  assert.equal(res.lead, null);
  assert.equal(res.tier, null);
});

test('6. tier 2 — zip agreement raises confidence to high; absence leaves it medium', () => {
  const candidates = [lead(131185, true, '39362', { zip: '34239' })];

  // Mirror or live fetch, the classifier does not care where ghlZip came from —
  // it is resolved once by the caller and both sources land in the same field.
  const agreeing = classifyTierOne({ ghl_contact_id: 'C1', ghlZip: '34239' }, candidates);
  assert.equal(agreeing.verdict, 'selected');
  assert.equal(agreeing.confidence, 'high');

  // No zip available at all (mirror absent AND the live read failed): the match
  // still stands, at medium. Tier 2 raises confidence; it never gates a write.
  const noZip = classifyTierOne({ ghl_contact_id: 'C1', ghlZip: null }, candidates);
  assert.equal(noZip.verdict, 'selected');
  assert.equal(noZip.lead.lp_lead_id, '131185');
  assert.equal(noZip.confidence, 'medium');

  // Disagreeing zips also stay medium — never a refusal. Phone is the match.
  const disagreeing = classifyTierOne({ ghl_contact_id: 'C1', ghlZip: '33101' }, candidates);
  assert.equal(disagreeing.verdict, 'selected');
  assert.equal(disagreeing.confidence, 'medium');
});

test('ZIP+4 on one side and ZIP-5 on the other still agree', () => {
  assert.equal(zipKey('34239-1234'), '34239');
  assert.equal(zipKey('34239'), '34239');
  assert.equal(zipKey('342'), null);   // too short to compare — not a prefix match
  assert.equal(zipKey(null), null);
});

test('7. tier 3 reports and never selects a lead to write', () => {
  const contact = { lastName: "O'Connor", ghlZip: '34239-1234', phone: '+13524453161' };
  const rows = buildTier3Rows(contact, [
    { lp_lead_id: '900', lp_prospect_id: '5', last_name: 'oconnor', zip: '34239', phone: '9998887777', has_job: true },
  ]);
  assert.equal(rows.length, 1);
  // The shape is a REPORT ROW. There is no lead, no confidence and no tier on
  // it — nothing a write path could consume even by accident.
  assert.equal(rows[0].lp_lead_id, '900');
  assert.equal('lead' in rows[0], false);
  assert.equal('confidence' in rows[0], false);
  assert.match(rows[0].matched, /last_name=oconnor/);
  assert.match(rows[0].disagreed, /phone 3524453161≠9998887777/);
});

test('tier 3 needs BOTH keys — a missing zip yields nothing, never a name-only match', () => {
  // A surname alone in a zip-less comparison is how you attach a stranger's job.
  const leads = [{ lp_lead_id: '900', last_name: 'smith', zip: '34239', has_job: true }];
  assert.deepEqual(buildTier3Rows({ lastName: 'Smith', ghlZip: null }, leads), []);
  assert.deepEqual(buildTier3Rows({ lastName: null, ghlZip: '34239' }, leads), []);
  assert.deepEqual(
    buildTier3Rows({ lastName: 'Smith', ghlZip: '33101' }, leads), [],  // zips disagree
  );
});

test('surname normalization collapses punctuation and spacing', () => {
  assert.equal(lastNameKey("O'Connor"), 'oconnor');
  assert.equal(lastNameKey('O Connor'), 'oconnor');
  assert.equal(lastNameKey('  OCONNOR '), 'oconnor');
  assert.equal(lastNameKey('X'), null);      // one letter is not a surname
  assert.equal(lastNameKey(''), null);
});

test('an unmatched contact is "unmatched", distinct from every refusal', () => {
  const res = classifyTierOne({ ghl_contact_id: 'C1', ghlZip: '34239' }, []);
  assert.equal(res.verdict, 'unmatched');
  assert.equal(res.lead, null);
});

// ═══════════════════════════════════════════════════════════════════
// Task 3 — the prevention monitor
// ═══════════════════════════════════════════════════════════════════

test('a new unlinked row where a GHL contact exists fires, and names the table', () => {
  const sample = {
    windowHours: 24,
    readOk: true,
    tables: { lp_jobs: 0, lp_job_milestones: 0, lp_notes: 3, lp_call_logs: 0 },
  };
  const d = shouldAlertLinkLeak(sample);
  assert.equal(d.verdict, 'alert');
  assert.equal(d.alert, true);
  assert.deepEqual(d.offenders, [{ table: 'lp_notes', count: 3 }]);
  // The table IS the diagnosis — notes fail through a different code path than
  // jobs, and a bare total sends the next reader to the wrong file.
  assert.match(formatLinkLeakAlert(sample, d.offenders), /lp_notes: 3/);
});

test('all zero is healthy — an explicit clear, not silence', () => {
  const d = shouldAlertLinkLeak({
    windowHours: 24, readOk: true, tables: { lp_jobs: 0, lp_notes: 0 },
  });
  assert.equal(d.verdict, 'healthy');
  assert.equal(d.alert, false);
});

test('a failed read is insufficient_evidence — it must neither page nor clear', () => {
  // The case people get wrong. Clearing on "I could not tell" announces a
  // recovery nobody earned; the caller maps this to active: null.
  const d = shouldAlertLinkLeak({
    windowHours: 24, readOk: false, tables: { lp_jobs: 0, lp_notes: null },
  });
  assert.equal(d.verdict, 'insufficient_evidence');
  assert.equal(d.alert, false);
  assert.deepEqual(d.unreadable, ['lp_notes']);
});

test('a CONFIRMED leak still fires even when another table could not be read', () => {
  // Incomplete evidence blocks the all-clear, never the alarm.
  const d = shouldAlertLinkLeak({
    windowHours: 24, readOk: false, tables: { lp_jobs: 5, lp_notes: null },
  });
  assert.equal(d.verdict, 'alert');
  assert.deepEqual(d.offenders, [{ table: 'lp_jobs', count: 5 }]);
  assert.deepEqual(d.unreadable, ['lp_notes']);
});

test('no tables measured at all is insufficient_evidence, not healthy', () => {
  assert.equal(
    shouldAlertLinkLeak({ windowHours: 24, readOk: true, tables: {} }).verdict,
    'insufficient_evidence',
  );
});

// ═══════════════════════════════════════════════════════════════════
// The write statements — shape only, but the shape is what broke
// ═══════════════════════════════════════════════════════════════════

test('the lead write is a BARE UPDATE, never a data-modifying CTE', () => {
  // 2026-09-18: all 42 live writes were refused with "WITH clause containing a
  // data-modifying statement must be at the top level". runSQL wraps any
  // statement beginning with SELECT or WITH (sql/run_sql.sql), which pushes the
  // CTE below the top level. CLAUDE.md's `WITH u AS (... RETURNING 1)` idiom is
  // correct for the MCP tool and wrong here — this pins the difference.
  const sql = buildLeadLinkUpdate('131185', 'ZbJFTZNhvzHJRQ3MHXmX', 'phone10_repair');
  assert.match(sql.trimStart(), /^UPDATE\b/);
  assert.doesNotMatch(sql, /\bWITH\b/i);
  assert.doesNotMatch(sql, /\bRETURNING\b/i);
});

test('the jobs write is a bare UPDATE too', () => {
  const sql = buildJobsLinkUpdate('131185', 'ZbJFTZNhvzHJRQ3MHXmX');
  assert.match(sql.trimStart(), /^UPDATE\b/);
  assert.doesNotMatch(sql, /\bWITH\b/i);
});

test('every write carries the IS NULL race guard', () => {
  // The live 15-minute sync runs while the repair does. A lead linked between
  // our read and our write must be left alone — the one outcome the rollback
  // log could not undo.
  for (const sql of [
    buildLeadLinkUpdate('1', 'ZbJFTZNhvzHJRQ3MHXmX', 'phone10_repair'),
    buildJobsLinkUpdate('1', 'ZbJFTZNhvzHJRQ3MHXmX'),
  ]) {
    assert.match(sql, /AND ghl_contact_id IS NULL/);
  }
});

test('the lead write always sets ghl_link_source alongside the id', () => {
  // A populated ghl_contact_id must never sit next to a NULL source.
  const sql = buildLeadLinkUpdate('1', 'ZbJFTZNhvzHJRQ3MHXmX', 'phone10_repair');
  assert.match(sql, /ghl_contact_id = 'ZbJFTZNhvzHJRQ3MHXmX'/);
  assert.match(sql, /ghl_link_source = 'phone10_repair'/);
});

test('readback and count are plain SELECTs the RPC can wrap', () => {
  assert.match(buildLeadLinkReadback('1').trimStart(), /^SELECT\b/);
  assert.match(buildJobsLinkCount('1', 'ZbJFTZNhvzHJRQ3MHXmX').trimStart(), /^SELECT\b/);
  // Aliased, because the RPC returns [{n: 3}] — an unaliased count(*) would
  // come back under a key the caller does not read.
  assert.match(buildJobsLinkCount('1', 'ZbJFTZNhvzHJRQ3MHXmX'), /count\(\*\) AS n/);
});

test("a lp_lead_id containing a quote cannot break out of the literal", () => {
  const sql = buildLeadLinkUpdate("O'Brien", 'ZbJFTZNhvzHJRQ3MHXmX', 'phone10_repair');
  assert.match(sql, /lp_lead_id = 'O''Brien'/);
});

// ═══════════════════════════════════════════════════════════════════
// Part 2 — the widened matcher
// ═══════════════════════════════════════════════════════════════════



test('the prospect widening finds the job on a SIBLING lead', () => {
  // The Espel case, prospect 2872: the phone match lands on a lead with no job,
  // while a sibling lead under the same prospect carries one. Before this, the
  // contact was refused no_job_bearing_lead and the job stayed invisible.
  const phoneMatched = lead(514983, false, '2872', { zip: '33624', matched_via: 'phone' });
  const sibling = lead(27320, true, '2872', { zip: '33624', matched_via: 'prospect' });

  assert.equal(selectLinkLead([phoneMatched]).verdict, 'no_job_bearing_lead');

  const res = classifyTierOne({ ghl_contact_id: 'C1', ghlZip: '33624' }, [phoneMatched, sibling]);
  assert.equal(res.verdict, 'selected');
  assert.equal(res.lead.lp_lead_id, '27320');
  assert.equal(res.via, 'prospect', 'the summary must be able to say HOW this was reached');
});

test('widening never crosses into a second prospect', () => {
  // Siblings are the same customer record. Two PROSPECTS with jobs are two
  // customer records sharing a key, and that is still a refusal.
  const res = classifyTierOne({ ghl_contact_id: 'C1', ghlZip: '33624' }, [
    lead(27320, true, '2872', { matched_via: 'prospect' }),
    lead(99001, true, '5555', { matched_via: 'prospect' }),
  ]);
  assert.equal(res.verdict, 'ambiguous');
  assert.equal(res.lead, null);
});

test('a direct match that already has a job is unaffected by widening', () => {
  // The widening only runs where the direct match produced no job-bearing lead.
  // This pins that a phone match still wins and still reports via=phone.
  const res = classifyTierOne({ ghl_contact_id: 'C1', ghlZip: '34239' }, [
    lead(131185, true, '39362', { zip: '34239', matched_via: 'phone' }),
  ]);
  assert.equal(res.verdict, 'selected');
  assert.equal(res.lead.lp_lead_id, '131185');
  assert.equal(res.via, 'phone');
});

test('via is reported for every write path, and null when nothing was selected', () => {
  for (const via of ['phone', 'phone_alt', 'email', 'prospect']) {
    const res = classifyTierOne({ ghl_contact_id: 'C1', ghlZip: null },
      [lead(1, true, '9', { matched_via: via })]);
    assert.equal(res.via, via);
  }
  assert.equal(classifyTierOne({ ghl_contact_id: 'C1' }, []).via, null);
  assert.equal(
    classifyTierOne({ ghl_contact_id: 'C1' }, [lead(1, false, '9', { matched_via: 'phone' })]).via,
    null,
    'a refusal has no via — nothing was reached',
  );
});

// ═══════════════════════════════════════════════════════════════════
// The key fan-out guard — the 2026-09-19 false link
// ═══════════════════════════════════════════════════════════════════

test('a key reaching several job-bearing prospects is refused, even with one unlinked lead', () => {
  // THE CASE. GHL contact fkAMlTXbJ6uLokm2bdqN was linked to LP lead 397568 —
  // June & Bryan Holmes, phone 2396711291 — on a shared email. The contact's
  // phone is 9414996465. Different people. The email was the CANVASSER'S own
  // (raiello54@gmail.com, promoter "Aiello, Robert - FTM"), on 148 leads across
  // 76 prospects, 5 of them job-bearing.
  //
  // The old guard saw ONE candidate, because only one of those 148 leads was
  // still unlinked — the `ghl_contact_id IS NULL` write-scope filter hid the
  // ambiguity. Fan-out is measured over the key instead.
  const candidates = [lead(397568, true, '303620', { match_key: 'raiello54@gmail.com' })];
  const fanout = new Map([['raiello54@gmail.com', 5]]);

  assert.equal(selectLinkLead(candidates).verdict, 'selected', 'the old guard saw no ambiguity');

  const res = classifyTierOne({ ghl_contact_id: 'C1', ghlZip: null }, candidates, fanout);
  assert.equal(res.verdict, 'ambiguous_key');
  assert.equal(res.lead, null);
  assert.equal(res.fanout, 5);
});

test('a key reaching ONE job-bearing prospect still writes, even if it spans two prospects', () => {
  // The counter-case that stops the guard being too blunt. Lead 522468 (Manuela
  // Hernandez) shares a phone with lead 310163 under a different prospect — LP
  // holds the same person twice — but only one of those prospects has a job, so
  // the job-bearing rule already resolves it and the link is correct.
  // Counting ALL prospects instead of job-bearing ones would discard it.
  const candidates = [lead(522468, true, '418115', { match_key: '2393246951', zip: '33990' })];
  const res = classifyTierOne({ ghl_contact_id: 'C1', ghlZip: '33990' },
    candidates, new Map([['2393246951', 1]]));
  assert.equal(res.verdict, 'selected');
  assert.equal(res.lead.lp_lead_id, '522468');
});

test('a key with no fan-out entry FAILS CLOSED', () => {
  // "Could not tell" must never write a link — the same doctrine as the
  // three-way alert verdicts elsewhere in this repo.
  const res = classifyTierOne({ ghl_contact_id: 'C1' },
    [lead(1, true, '9', { match_key: '5551234567' })], new Map());
  assert.equal(res.verdict, 'ambiguous_key');
  assert.equal(res.fanout, null);
});

test('candidates with no match_key bypass the guard — they are not key-derived', () => {
  // The prospect widening reaches siblings through a lead we already identified,
  // not through a key, so the key guard has nothing to say about them.
  const { kept, rejected } = disqualifyByFanout(
    [lead(1, true, '9'), lead(2, true, '9', { match_key: 'k' })],
    new Map([['k', 3]]),
  );
  assert.equal(kept.length, 1);
  assert.equal(kept[0].lp_lead_id, '1');
  assert.deepEqual(rejected, [{ key: 'k', fanout: 3 }]);
});

test('email is gone as a match key, and stays gone', async () => {
  // A canvasser's own address on 148 customer records is not identity. Across
  // the whole 306-opportunity cohort the email tier produced two matches and
  // both were the same false one. If you re-add it, this test should be the
  // thing that makes you justify it.
  const mod = await import('../src/lp-link-match.js');
  assert.equal('emailKey' in mod, false, 'email must not be a match key here');
});
