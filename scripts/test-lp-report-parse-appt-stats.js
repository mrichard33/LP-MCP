/**
 * Guards for src/jobs/lp-report-parse-appt-stats.js — LP report 138
 * Appointment Stats by Sales Rep with Source.
 *
 * The fixture is the REAL January 2026 export (345 rows, 79 reps, 17 sources),
 * redacted only in FullName, so every figure asserted below is a production
 * number rather than an invented one.
 *
 * Invariants under guard:
 *   • The six January sit rates by source reproduce to the unit.
 *   • Dispositions decode BY LABEL — shuffling Dsp1..Dsp10 moves the counts
 *     with their labels rather than re-attributing them.
 *   • The two control identities that replace the absent footer hold on every
 *     row, and a doctored row that breaks either one is rejected.
 *   • LP's '(SalesRep Unknown)' bucket survives intact — 12 rows, 59 issued,
 *     3 sat, 1,822 sets. Dropping or redistributing it is the defect.
 *   • GSA/NSA parse across the integer and 0.0000 notations LP mixes.
 *   • Footer is a static legend and never reaches content identity.
 */

process.env.SUPABASE_URL ||= 'http://localhost';
process.env.SUPABASE_SERVICE_ROLE_KEY ||= 'test-key';

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';

import {
  parseApptStatsCsv, validateApptStatsCsv, computeApptStatsTotals, sitRateBy,
  SALESREP_UNKNOWN, UNATTRIBUTED, APPT_STATS_PARSER_VERSION,
} from '../src/jobs/lp-report-parse-appt-stats.js';
import {
  detectReportFromHeader, csvToObjects, parseCsv, REPORT_FINGERPRINTS, CONTENT_SORT_KEYS,
} from '../src/jobs/lp-report-csv-common.js';
import { contentSha256 } from '../src/jobs/lp-report-common.js';

const FIXTURE = 'scripts/fixtures/lp-reports/report-138-appt-stats-jan.csv';
const F137 = 'scripts/fixtures/lp-reports/report-137-sales-efficiency-jan.csv';
const text = existsSync(FIXTURE) ? readFileSync(FIXTURE, 'utf8') : null;

/** Re-emit parsed cells as RFC-4180 so a doctored fixture round-trips. */
const emit = (rows) =>
  rows.map((r) => r.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(',')).join('\r\n') + '\r\n';

function mutate(fn) {
  const rows = parseCsv(text);
  fn(rows[0].map((h) => h.trim()), rows);
  return emit(rows);
}

// ── routing ────────────────────────────────────────────────────────────────

test('138 resolves from its own header', { skip: !text && 'fixture absent' }, () => {
  const { header } = csvToObjects(text);
  const hit = detectReportFromHeader(header);
  assert.equal(hit.reportType, 'appt_stats_by_rep_source');
  assert.equal(hit.lpReportId, '138');
});

test('137 and 138 fingerprints are disjoint IN BOTH DIRECTIONS', { skip: !text && 'fixture absent' }, () => {
  assert.ok(existsSync(F137), '137 January fixture is required for this test');
  const h138 = new Set(csvToObjects(text).header.map((h) => h.toLowerCase()));
  const h137 = new Set(csvToObjects(readFileSync(F137, 'utf8')).header.map((h) => h.toLowerCase()));
  const fp = (id) => REPORT_FINGERPRINTS.find((f) => f.lpReportId === id).discriminators;

  // Both reports count issued appointments, so this is the pair most likely to
  // collide. Neither set may be a subset of the other's header.
  assert.ok(!fp('137').every((d) => h138.has(d.toLowerCase())),
    "137's discriminators must not all appear on a 138 header");
  assert.ok(!fp('138').every((d) => h137.has(d.toLowerCase())),
    "138's discriminators must not all appear on a 137 header");
  assert.equal(detectReportFromHeader(csvToObjects(readFileSync(F137, 'utf8')).header).lpReportId, '137');
});

test('138 has a content sort key that names PARSED fields, so it actually sorts', () => {
  assert.deepEqual(CONTENT_SORT_KEYS.appt_stats_by_rep_source, ['salesrep_raw', 'src_id_raw'],
    'grain is (rep, source) — neither column alone is unique');

  // Not a style choice. contentSha256 is handed the parser's output, so a key
  // naming a raw CSV header matches no field and sorts nothing. The five older
  // entries are in exactly that state and are documented as inert; 138 has no
  // history to disturb, so it names the fields that are really there.
  const { rows } = parseApptStatsCsv(readFileSync(FIXTURE, 'utf8'));
  for (const k of CONTENT_SORT_KEYS.appt_stats_by_rep_source) {
    assert.ok(k in rows[0], `${k} is a real field on a parsed row`);
  }
});

// ── the January goldens ────────────────────────────────────────────────────

test('the six January sit rates by source reproduce exactly', { skip: !text && 'fixture absent' }, () => {
  const by = sitRateBy(parseApptStatsCsv(text).rows, 'src_id_raw');
  // Σ NumSat ÷ Σ NumIssued, GROSS issued — never LP's net-issue basis.
  const want = {
    Internet: [736, 914], Canvass: [607, 853], PrevCust: [38, 40],
    CustRef: [20, 21], Magazine: [35, 43], Affiliates: [38, 48],
  };
  for (const [src, [sat, issued]] of Object.entries(want)) {
    assert.equal(by[src].num_sat, sat, `${src} sat`);
    assert.equal(by[src].num_issued, issued, `${src} issued`);
    assert.equal(by[src].sit_rate, sat / issued, `${src} sit rate`);
  }
});

test('company totals and grain match the January export', { skip: !text && 'fixture absent' }, () => {
  const { rows } = parseApptStatsCsv(text);
  assert.equal(rows.length, 345);
  assert.equal(new Set(rows.map((r) => r.salesrep_raw)).size, 79, 'reps');
  assert.equal(new Set(rows.map((r) => r.src_id_raw)).size, 17, 'sources');
  const t = computeApptStatsTotals(rows);
  assert.deepEqual(
    { iss: t.num_issued, net: t.num_net_issued, sat: t.num_sat, sale: t.num_sale },
    { iss: 2023, net: 1782, sat: 1565, sale: 488 });
});

test('sit rate is also computable by rep — 138 is the only report that can', { skip: !text && 'fixture absent' }, () => {
  const byRep = sitRateBy(parseApptStatsCsv(text).rows, 'salesrep_raw');
  assert.equal(Object.keys(byRep).length, 79);
  for (const [rep, a] of Object.entries(byRep)) {
    if (a.num_issued > 0) {
      assert.equal(a.sit_rate, a.num_sat / a.num_issued, `${rep} is a ratio of sums`);
    } else {
      assert.equal(a.sit_rate, null, `${rep} has no issued — unmeasurable, not zero`);
    }
  }
});

// ── the (SalesRep Unknown) bucket ──────────────────────────────────────────

test('the (SalesRep Unknown) bucket survives whole', { skip: !text && 'fixture absent' }, () => {
  const rows = parseApptStatsCsv(text).rows.filter((r) => r.salesrep_raw === SALESREP_UNKNOWN);
  assert.equal(rows.length, 12, 'twelve rows, one per source that set before assignment');
  const sum = (k) => rows.reduce((a, r) => a + r[k], 0);
  assert.equal(sum('num_set'), 1822);
  assert.equal(sum('num_issued'), 59, 'it carries issued too — not only sets');
  assert.equal(sum('num_sat'), 3);
  assert.equal(sum('num_sale'), 0, 'and never a sale, which is why rep close rates look clean');

  // LP's own sentinel, not our empty-cell bucket. Conflating them would hide it.
  assert.notEqual(SALESREP_UNKNOWN, UNATTRIBUTED);
  const biggest = rows.slice().sort((a, b) => b.num_set - a.num_set)[0];
  assert.equal(biggest.src_id_raw, 'Canvass');
  assert.equal(biggest.num_set, 849);
});

// ── label-driven disposition decode ────────────────────────────────────────

test('dispositions decode by LABEL, not by position', { skip: !text && 'fixture absent' }, () => {
  const before = parseApptStatsCsv(text);
  assert.deepEqual(before.dispositionLabels,
    ['Sale', '1leg', 'NoHome', 'CCC', 'Reset', 'NIS', 'OPPFDN', 'NoRehash', 'No Demo', 'NOC']);

  // Reverse the Dsp slots — labels AND counts together, exactly as an upstream
  // reordering would. Every row's label→count map must come out identical.
  const shuffled = mutate((hdr, rows) => {
    const li = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((i) => hdr.indexOf(`Dsp${i}`));
    const ci = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((i) => hdr.indexOf(`NumDsp${i}`));
    for (let r = 1; r < rows.length; r++) {
      const labels = li.map((j) => rows[r][j]).reverse();
      const counts = ci.map((j) => rows[r][j]).reverse();
      li.forEach((j, k) => { rows[r][j] = labels[k]; });
      ci.forEach((j, k) => { rows[r][j] = counts[k]; });
    }
  });

  const after = parseApptStatsCsv(shuffled);
  for (let i = 0; i < before.rows.length; i++) {
    assert.deepEqual(after.rows[i].dispositions, before.rows[i].dispositions,
      `row ${i + 1} counts followed their labels`);
  }
});

test('LP fixed-name disposition columns agree with the label decode on every row', { skip: !text && 'fixture absent' }, () => {
  const p = parseApptStatsCsv(text);
  assert.equal(p.aliasDisagreements.length, 0);
  // Aliases are the cross-check, so a decode that ignored labels must be caught.
  // Move ONE label without its count and the disagreement has to surface.
  const drifted = mutate((hdr, rows) => {
    const a = hdr.indexOf('Dsp2'), b = hdr.indexOf('Dsp3');
    for (let r = 1; r < rows.length; r++) {
      const t = rows[r][a]; rows[r][a] = rows[r][b]; rows[r][b] = t;
    }
  });
  const v = validateApptStatsCsv(parseApptStatsCsv(drifted));
  assert.ok(v.warnings.some((w) => w.rule === 'disposition_alias_disagreement'),
    'a label that moved without its count is surfaced');
  assert.ok(v.ok, 'but as a warning — the label decode is still authoritative');
});

test('NumOther and NumOther2 stay distinct buckets', { skip: !text && 'fixture absent' }, () => {
  const t = computeApptStatsTotals(parseApptStatsCsv(text).rows);
  assert.equal(t.num_other, 2391);
  assert.equal(t.num_other2, 2593);
  assert.notEqual(t.num_other, t.num_other2, 'merging them would lose one');
});

// ── control gates (the footer replacement) ─────────────────────────────────

test('both control identities hold on every row of the real export', { skip: !text && 'fixture absent' }, () => {
  const p = parseApptStatsCsv(text);
  for (const r of p.rows) {
    const dsp = Object.values(r.dispositions).reduce((a, n) => a + n, 0);
    assert.equal(dsp, r.num_issued, `row ${r.row_num}: dispositions partition issued`);
    assert.equal(r.num_issued + r.num_other, r.num_set, `row ${r.row_num}: NumOther completes NumSet`);
    assert.ok(r.num_sat <= r.num_issued, `row ${r.row_num}: sat cannot exceed issued`);
  }
  assert.equal(validateApptStatsCsv(p).ok, true);
});

// ── the two arithmetic identities: WARN, do not reject ─────────────────────
//
// These asserted `v.ok === false` until 2026-08-10. Both identities were
// generalised from a single month (January 2026, 345 rows, zero breaches) and do
// not hold across all months — on 2026-08-10 they rejected 60 files in a day and
// report 138 had not landed since 08-08. A control total earns the right to fail
// a file closed by being a rule of the source system, not by having held in the
// one sample that was checked. The arithmetic is still recorded, per row.

test('a row that breaks Σ NumDsp == NumIssued still INGESTS, with the delta recorded',
  { skip: !text && 'fixture absent' }, () => {
    const broken = mutate((hdr, rows) => { rows[1][hdr.indexOf('NumDsp7')] = '999'; });
    const parsed = parseApptStatsCsv(broken);
    const v = validateApptStatsCsv(parsed);

    assert.equal(v.ok, true, 'the file is accepted');
    assert.ok(!v.violations.some((x) => x.rule === 'disposition_sum_mismatch'),
      'and this is no longer a violation');

    const w = v.warnings.find((x) => x.rule === 'disposition_sum_mismatch');
    assert.ok(w, 'it is surfaced as a warning');
    assert.equal(w.detail.rows, 1, 'exactly the row we broke');

    // 999 replaced NumDsp7 on row 1, so the delta is 999 minus what was there.
    const orig = parseApptStatsCsv(text).rows[0];
    const origDsp7 = orig.dispositions[parsed.dispositionLabels[6]] ?? 0;
    assert.equal(w.detail.net_delta, 999 - origDsp7, 'the delta is exact and signed');
    assert.equal(w.detail.abs_delta, Math.abs(999 - origDsp7));
    assert.equal(w.detail.deltas[parsed.rows[0].row_num], w.detail.net_delta,
      'and is recorded against the row that carries it');
    assert.equal(w.detail.sample[0].dispositions_total - w.detail.sample[0].num_issued,
      w.detail.net_delta, 'the sample carries both sides of the comparison');
  });

test('a row that breaks NumIssued + NumOther == NumSet still INGESTS, with the delta recorded',
  { skip: !text && 'fixture absent' }, () => {
    const broken = mutate((hdr, rows) => { rows[1][hdr.indexOf('NumOther')] = '12345'; });
    const parsed = parseApptStatsCsv(broken);
    const v = validateApptStatsCsv(parsed);

    assert.equal(v.ok, true, 'the file is accepted');
    assert.ok(!v.violations.some((x) => x.rule === 'set_partition_mismatch'),
      'and this is no longer a violation');

    const w = v.warnings.find((x) => x.rule === 'set_partition_mismatch');
    assert.ok(w, 'it is surfaced as a warning');
    assert.equal(w.detail.rows, 1);

    const r = parsed.rows[0];
    assert.equal(w.detail.net_delta, (r.num_issued + r.num_other) - r.num_set,
      'the delta is exact and signed');
    assert.equal(w.detail.deltas[r.row_num], w.detail.net_delta);
  });

test('a file breaking BOTH identities on many rows still ingests, deltas aggregated',
  { skip: !text && 'fixture absent' }, () => {
    // The case that matters operationally: not one doctored row but a month
    // whose shape simply differs from January's. It must land.
    const broken = mutate((hdr, rows) => {
      for (let i = 1; i < rows.length; i++) {
        rows[i][hdr.indexOf('NumDsp7')] = '7';
        rows[i][hdr.indexOf('NumOther')] = '3';
      }
    });
    const v = validateApptStatsCsv(parseApptStatsCsv(broken));
    assert.equal(v.ok, true, 'a wholly non-conforming month is still ingested');

    for (const rule of ['disposition_sum_mismatch', 'set_partition_mismatch']) {
      const w = v.warnings.find((x) => x.rule === rule);
      assert.ok(w, `${rule} is reported`);
      assert.ok(w.detail.rows > 1, 'across many rows');
      assert.equal(Object.keys(w.detail.deltas).length, w.detail.rows,
        'every breaching row has its delta recorded, not just the sampled ones');
      assert.ok(w.detail.sample.length <= 50, 'the full-detail sample stays bounded');
      assert.equal(w.detail.truncated_sample, w.detail.rows > 50,
        'and says so when it is truncated');
      assert.ok(w.detail.abs_delta >= Math.abs(w.detail.net_delta),
        'abs_delta cannot be smaller than |net_delta|');
    }
  });

test('structural faults are still REJECTED — the downgrade is scoped to the two identities',
  { skip: !text && 'fixture absent' }, () => {
    // sat_exceeds_issued is a BOUND, not an identity: more sat than issued is
    // impossible rather than merely unexplained. It stays fail-closed.
    const broken = mutate((hdr, rows) => { rows[1][hdr.indexOf('NumSat')] = '99999'; });
    const v = validateApptStatsCsv(parseApptStatsCsv(broken));
    assert.equal(v.ok, false);
    assert.ok(v.violations.some((x) => x.rule === 'sat_exceeds_issued'));
  });

test('an empty file is rejected, never accepted as zero', { skip: !text && 'fixture absent' }, () => {
  const headerOnly = emit([parseCsv(text)[0]]);
  const v = validateApptStatsCsv(parseApptStatsCsv(headerOnly));
  assert.equal(v.ok, false);
  assert.equal(v.violations[0].rule, 'empty_file');
});

// ── money, period, identity ────────────────────────────────────────────────

test('GSA/NSA parse across both notations LP mixes', { skip: !text && 'fixture absent' }, () => {
  const raw = csvToObjects(text).rows;
  const shapes = (c) => new Set(raw.map((r) => (/^\d+\.\d{4}$/.test(r[c]) ? '4dec' : 'int')));
  assert.deepEqual([...shapes('GSA')].sort(), ['4dec', 'int'], 'both forms are really present');

  const t = computeApptStatsTotals(parseApptStatsCsv(text).rows);
  assert.equal(t.gsa_cents, 1217799300);
  assert.equal(t.nsa_cents, 898105700);
  assert.equal(parseApptStatsCsv(text).subCentColumns.length, 0, 'no sub-cent loss on this file');
});

test('SDate/EDate and the full CurrentDateTime come from the data', { skip: !text && 'fixture absent' }, () => {
  const { header } = parseApptStatsCsv(text);
  assert.equal(header.periodStart, '2026-01-01');
  assert.equal(header.periodEnd, '2026-01-31');
  // 3:15:49 PM America/New_York on 2026-08-07 → 19:15:49Z. The time is the
  // whole point: truncating it to midnight is what broke is_partial_month.
  assert.equal(header.generatedAt, '2026-08-07T19:15:49.000Z');
  assert.equal(header.generatedAtTruncated, false);
});

test('the Footer legend is static and never reaches content identity', { skip: !text && 'fixture absent' }, () => {
  const footers = new Set(csvToObjects(text).rows.map((r) => r.Footer));
  assert.equal(footers.size, 1, 'one legend, repeated on all 345 rows — documentation, not data');

  const digest = (t) => {
    const p = parseApptStatsCsv(t);
    return contentSha256({
      reportType: 'appt_stats_by_rep_source',
      periodStart: p.header.periodStart, periodEnd: p.header.periodEnd,
      scope: null, rows: p.rows, parserVersion: APPT_STATS_PARSER_VERSION,
      includeAsOf: false, sortKeys: CONTENT_SORT_KEYS.appt_stats_by_rep_source,
    });
  };
  const base = digest(text);

  const reworded = mutate((hdr, rows) => {
    const j = hdr.indexOf('Footer');
    for (let r = 1; r < rows.length; r++) rows[r][j] = 'NoHome=Did Not Show; CCC=Cancelled After Issue';
  });
  assert.equal(digest(reworded), base, 'LP rewording the legend must not fork the digest');

  const restamped = mutate((hdr, rows) => {
    const j = hdr.indexOf('CurrentDateTime');
    for (let r = 1; r < rows.length; r++) rows[r][j] = '8/8/2026 4:00:00 AM';
  });
  assert.equal(digest(restamped), base, 'nor a re-pull of the same period');

  const edited = mutate((hdr, rows) => { rows[1][hdr.indexOf('NumSat')] = '1'; });
  assert.notEqual(digest(edited), base, 'but one changed data cell IS a different report');
});

test('row order does not fork identity — Salesrep+Src_id sorts it', { skip: !text && 'fixture absent' }, () => {
  const digest = (t) => {
    const p = parseApptStatsCsv(t);
    return contentSha256({
      reportType: 'appt_stats_by_rep_source',
      periodStart: p.header.periodStart, periodEnd: p.header.periodEnd,
      scope: null, rows: p.rows.map(({ row_num, ...rest }) => rest),
      includeAsOf: false, sortKeys: CONTENT_SORT_KEYS.appt_stats_by_rep_source,
    });
  };
  const reversed = mutate((hdr, rows) => {
    const data = rows.splice(1, rows.length - 1);
    rows.push(...data.reverse());
  });
  assert.equal(digest(reversed), digest(text));
});

// ── blanks are data ────────────────────────────────────────────────────────

test('a blank Salesrep or Src_id is bucketed, never dropped', { skip: !text && 'fixture absent' }, () => {
  const blanked = mutate((hdr, rows) => {
    rows[1][hdr.indexOf('Salesrep')] = '';
    rows[2][hdr.indexOf('Src_id')] = '';
  });
  const { rows } = parseApptStatsCsv(blanked);
  assert.equal(rows.length, 345, 'row count is unchanged — nothing was skipped');
  assert.equal(rows[0].salesrep_raw, UNATTRIBUTED);
  assert.equal(rows[1].src_id_raw, UNATTRIBUTED);
});

// ── tolerance for a header we have seen once ───────────────────────────────

test('column reads are case-insensitive, like the router that dispatches here', { skip: !text && 'fixture absent' }, () => {
  const recased = mutate((hdr, rows) => {
    const map = { Salesrep: 'SALESREP', Src_id: 'src_ID', NumIssued: 'numissued', Dsp1: 'DSP1' };
    rows[0] = rows[0].map((h) => map[h.trim()] ?? h);
  });
  const p = parseApptStatsCsv(recased);
  assert.equal(p.rows.length, 345);
  assert.equal(computeApptStatsTotals(p.rows).num_issued, 2023);
  assert.equal(validateApptStatsCsv(p).ok, true);
});

test('an unknown extra column is carried, not fatal', { skip: !text && 'fixture absent' }, () => {
  const widened = mutate((hdr, rows) => {
    rows[0].push('SomeNewLPColumn');
    for (let r = 1; r < rows.length; r++) rows[r].push('x');
  });
  assert.equal(parseApptStatsCsv(widened).rows.length, 345);
});

test('a genuinely missing required column fails CLOSED', { skip: !text && 'fixture absent' }, () => {
  const stripped = mutate((hdr, rows) => {
    const j = hdr.indexOf('NumIssued');
    for (const row of rows) row.splice(j, 1);
  });
  assert.throws(() => parseApptStatsCsv(stripped), /missing required columns/);
});

// ── cross-report ───────────────────────────────────────────────────────────

test('137 and 138 nearly tie on January — recorded, never gated', { skip: !text && 'fixture absent' }, () => {
  assert.ok(existsSync(F137), '137 January fixture is required for this test');
  const a = computeApptStatsTotals(parseApptStatsCsv(text).rows);
  const se = csvToObjects(readFileSync(F137, 'utf8')).rows.reduce((acc, r) => ({
    num_issued: acc.num_issued + (+r.NumIssued || 0),
    num_net_issued: acc.num_net_issued + (+r.NumNetIssued || 0),
    num_sat: acc.num_sat + (+r.NumSat || 0),
    num_sale: acc.num_sale + (+r.NumSale || 0),
  }), { num_issued: 0, num_net_issued: 0, num_sat: 0, num_sale: 0 });

  assert.deepEqual(se, { num_issued: 2029, num_net_issued: 1786, num_sat: 1566, num_sale: 488 });
  // Both are activity-based over the same window, so they should very nearly
  // agree. Sales tie exactly; issued is short by 6, most plausibly appointments
  // with no rep assignment — 137 still places those by market, 138 cannot place
  // them at all. Worth surfacing, never worth failing a good file over.
  assert.equal(a.num_issued - se.num_issued, -6);
  assert.equal(a.num_net_issued - se.num_net_issued, -4);
  assert.equal(a.num_sat - se.num_sat, -1);
  assert.equal(a.num_sale - se.num_sale, 0, 'sales tie exactly');
});

test('138 carries no market column — market attribution must not be attempted', { skip: !text && 'fixture absent' }, () => {
  const header = csvToObjects(text).header.map((h) => h.toLowerCase());
  for (const c of ['brn_id', 'market', 'grouper', 'branch', 'district']) {
    assert.ok(!header.includes(c), `138 has no ${c}`);
  }
  const { rows } = parseApptStatsCsv(text);
  assert.ok(!('market' in rows[0]), 'and the parser invents none');
});
