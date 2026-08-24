/**
 * Tests — the global canvasser-ANI guard and its roster seed
 * scripts/test-ci-canvasser-guard.js
 *
 * THE FAILURE THIS GUARDS. On canvass work the ANI is the CANVASSER standing
 * at the door, not the customer. Phone-matching such a call attaches an AI
 * call note either to an EMPLOYEE's record or to a stranger who happens to own
 * that number — and nobody reading that record afterwards can tell the note
 * does not belong there. It is a corruption risk, not a miss.
 *
 * It was guarded on exactly ONE campaign ('Canvass Confirmation - Inbound',
 * via match_strategy='canvass_correlation'). The other 97 match on phone.
 * Proven live: recording ANI 3213050187 belongs to Pro ID 5296, GIAN CROSS,
 * ORL market — a canvasser, matched as a customer.
 *
 * So these tests assert the SAFE direction: the guard may only ever WITHHOLD a
 * match, never invent one, and never silently disarm itself.
 *
 * No network, no DB — the Supabase client is injected and the roster CSV is
 * parsed from a string.
 *
 * Run: node --test scripts/test-ci-canvasser-guard.js
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  loadCanvasserPhones,
  canvasserMatches,
  matchCall,
  reviewReasonFor,
  WRITABLE_TIERS,
} from '../src/ci/match.js';
import { stageMatch } from '../src/ci/worker.js';
import { parseRoster, normalizePhone, splitCsvLine, csvPathFromArgv } from './seed-ci-canvassers.js';
import { parseConfig } from '../src/ci/config.js';

const CFG = parseConfig({});

/** The proven live case, verbatim from the roster. */
const GIAN = { pro_id: 5296, name: 'GIAN - ORL CROSS', market: 'ORL', phone_last10: '3213050187', active: true };

const ROSTER = new Map([
  ['3213050187', [{ pro_id: 5296, name: 'GIAN - ORL CROSS', market: 'ORL' }]],
  // One of the 11 numbers carried by two Pro IDs.
  ['2392468866', [
    { pro_id: 4862, name: 'DT Marketing Affiliate', market: 'FTMYR' },
    { pro_id: 5297, name: 'Douglas - FTM Thompson', market: 'FTMYR' },
  ]],
]);

const CALL = {
  id: 'call-uuid-1',
  five9_call_id: '300000010270792',
  call_start: '2026-08-21T16:00:00.000Z',
  campaign: 'Rehash',
  eligible: true,
  ani: '3213050187',
  customer_phone: '3213050187',
  raw_metadata: {},
};

/**
 * PostgREST-shaped double. Every terminal is awaitable, so the chain shapes
 * used by findLpByPhone / findLpLeads / the worker stage all resolve.
 */
function fakeDb({ prospects = [], leads = [], canvassers = [], summary = null, campaignRow = null } = {}) {
  const log = [];
  const tables = {
    lp_prospects: prospects,
    lp_leads: leads,
    ci_canvassers: canvassers,
  };
  return {
    log,
    from(table) {
      let data = tables[table] ?? [];
      const chain = {
        select() { return chain; },
        or() { return chain; },
        eq() { return chain; },
        gte() { return chain; },
        lte() { return chain; },
        ilike() { return chain; },
        limit() { return chain; },
        maybeSingle: async () => ({
          data: table === 'ci_summaries' ? summary : table === 'ci_campaign_map' ? campaignRow : null,
          error: null,
        }),
        insert: async (row) => { log.push({ table, op: 'insert', row }); return { error: null }; },
        update(patch) {
          const thenable = {
            eq() { return thenable; },
            then: (res, rej) => {
              log.push({ table, op: 'update', patch });
              return Promise.resolve({ error: null }).then(res, rej);
            },
          };
          return thenable;
        },
        then: (res, rej) => Promise.resolve({ data, error: null }).then(res, rej),
      };
      return chain;
    },
  };
}

// ─── the lookup itself ──────────────────────────────────────────────────────

test('LAST-10 NORMALIZATION: every spelling of the number hits the same row', () => {
  // A guard that only fires on one formatting of the number is not a guard.
  for (const spelling of ['321-305-0187', '13213050187', '3213050187', '+1 (321) 305-0187', '1-321-305-0187']) {
    const hits = canvasserMatches(ROSTER, spelling);
    assert.equal(hits.length, 1, `'${spelling}' must resolve`);
    assert.equal(hits[0].pro_id, 5296);
  }
});

test('a number nobody on the roster owns returns no hit', () => {
  assert.deepEqual(canvasserMatches(ROSTER, '7273302574'), []);
  assert.deepEqual(canvasserMatches(ROSTER, '555'), []);
  assert.deepEqual(canvasserMatches(ROSTER, null), []);
});

test('an absent roster is a NO-OP, never a throw', () => {
  // The guard degrades to exactly today's behaviour before the seed has run.
  assert.deepEqual(canvasserMatches(null, '3213050187'), []);
  assert.deepEqual(canvasserMatches(undefined, '3213050187'), []);
  assert.deepEqual(canvasserMatches(new Map(), '3213050187'), []);
});

test('a phone shared by two Pro IDs returns BOTH and does not throw', () => {
  const hits = canvasserMatches(ROSTER, '2392468866');
  assert.equal(hits.length, 2);
  assert.deepEqual(hits.map((h) => h.pro_id), [4862, 5297], 'sorted by pro_id, so evidence is deterministic');
});

// ─── loading the roster ─────────────────────────────────────────────────────

test('loadCanvasserPhones groups by phone and keeps every Pro ID', async () => {
  const map = await loadCanvasserPhones(fakeDb({
    canvassers: [
      GIAN,
      { pro_id: 5297, name: 'Douglas - FTM Thompson', market: 'FTMYR', phone_last10: '2392468866', active: true },
      { pro_id: 4862, name: 'DT Marketing Affiliate', market: 'FTMYR', phone_last10: '2392468866', active: true },
    ],
  }));
  assert.equal(map.size, 2, 'two distinct numbers');
  assert.deepEqual(map.get('2392468866').map((r) => r.pro_id), [4862, 5297], 'both kept, sorted');
  assert.equal(map.get('3213050187')[0].name, 'GIAN - ORL CROSS');
});

test('loadCanvasserPhones normalizes stored numbers and drops unusable ones', async () => {
  const map = await loadCanvasserPhones(fakeDb({
    canvassers: [
      { pro_id: 1, phone_last10: '321-305-0187' },
      { pro_id: 2, phone_last10: '13213050188' },
      { pro_id: 3, phone_last10: '555' },
      { pro_id: 4, phone_last10: null },
    ],
  }));
  assert.ok(map.has('3213050187'), 'punctuation stripped');
  assert.ok(map.has('3213050188'), 'leading 1 dropped');
  assert.equal(map.size, 2, 'a 7-digit fragment and a null are not keys');
});

test('an explicitly deactivated canvasser is not guarded', async () => {
  // They are off the doors; the number is theirs again and matches normally.
  const map = await loadCanvasserPhones(fakeDb({ canvassers: [{ ...GIAN, active: false }] }));
  assert.equal(map.size, 0);
});

test('loadCanvasserPhones reports a read failure rather than returning empty', async () => {
  // An empty map silently DISARMS the guard — the exact failure this exists to
  // prevent, arriving as a success.
  const db = { from: () => ({ select: async () => ({ data: null, error: { message: 'permission denied' } }) }) };
  await assert.rejects(() => loadCanvasserPhones(db), /ci_canvassers read failed: permission denied/);
});

// ─── the guard inside matchCall ─────────────────────────────────────────────

test('a canvasser ANI NEVER produces a phone-tier match', async () => {
  const db = fakeDb({ prospects: [{ lp_prospect_id: 999, ghl_contact_id: 'ghl-1' }] });
  const out = await matchCall(CALL, { db, cfg: CFG, canvasserPhones: ROSTER });

  assert.equal(out.lp.tier, 'none', 'not high, not probable — nothing');
  assert.equal(out.lp.method, 'canvasser_ani');
  assert.equal(out.lp.prospectId, null, 'the LP prospect on that number is NOT adopted');
  assert.equal(WRITABLE_TIERS.has(out.lp.tier), false, 'no CRM write may ever consider this');
  assert.equal(out.target.rectype, null, 'no note target');
  // The phone lookup must not even run — the prospect above would otherwise
  // have been a clean single-candidate 'high'.
  assert.equal(db.log.some((l) => l.table === 'lp_prospects'), false);
});

test('it routes to review with reason canvasser_ani, and carries the canvasser', async () => {
  const out = await matchCall(CALL, { db: fakeDb(), cfg: CFG, canvasserPhones: ROSTER });
  assert.equal(out.review, 'canvasser_ani');
  assert.equal(out.lp.canvassers[0].pro_id, 5296);
  assert.equal(out.lp.canvassers[0].name, 'GIAN - ORL CROSS');
  assert.equal(out.lp.canvassers[0].market, 'ORL');
});

test('canvasser_ani outranks the tier reasons and ignores eligibility', () => {
  const lp = { tier: 'none', canvassers: [{ pro_id: 5296 }] };
  assert.equal(reviewReasonFor(lp, { eligible: true }), 'canvasser_ani');
  // A plain 'none' on an ineligible call is not queue-worthy; a call we
  // deliberately REFUSED to match is, either way.
  assert.equal(reviewReasonFor(lp, { eligible: false }), 'canvasser_ani');
  assert.equal(reviewReasonFor({ tier: 'none' }, { eligible: false }), null);
});

test('A NORMAL ANI IS UNAFFECTED and still matches', async () => {
  const db = fakeDb({ prospects: [{ lp_prospect_id: 4242, ghl_contact_id: 'ghl-9', latest_lead_date: CALL.call_start }] });
  const out = await matchCall(
    { ...CALL, ani: '7273302574', customer_phone: '7273302574' },
    { db, cfg: CFG, canvasserPhones: ROSTER },
  );
  assert.equal(out.lp.tier, 'high');
  assert.equal(out.lp.method, 'phone_exact');
  assert.equal(out.lp.prospectId, 4242);
  assert.equal(out.review, null);
});

test('the guard does NOT override list-carried LP ids', async () => {
  // Those are real ids the dialing record supplied — tier 'exact', nothing
  // inferred from the ANI at all. A canvasser's phone in the ANI does not make
  // them wrong; the guard is about the PHONE tier specifically.
  const out = await matchCall(
    { ...CALL, raw_metadata: { list_ids: { cst_id: 453297, lds_id: 568419 } } },
    { db: fakeDb(), cfg: CFG, canvasserPhones: ROSTER },
  );
  assert.equal(out.lp.tier, 'exact');
  assert.equal(out.lp.prospectId, 453297);
  assert.equal(out.review, null);
});

test('a canvass_correlation campaign is unchanged — it never read the ANI anyway', async () => {
  const out = await matchCall(CALL, {
    db: fakeDb(),
    cfg: CFG,
    campaignRow: { match_strategy: 'canvass_correlation' },
    canvasserPhones: ROSTER,
  });
  assert.equal(out.lp.method, 'canvass_correlation');
  assert.equal(out.review, 'match_ambiguous', 'its own no-lead-in-window path, not the guard');
});

test('with no roster supplied the matcher behaves exactly as before', async () => {
  const db = fakeDb({ prospects: [{ lp_prospect_id: 4242, latest_lead_date: CALL.call_start }] });
  const out = await matchCall(CALL, { db, cfg: CFG });
  assert.equal(out.lp.tier, 'high', 'unseeded roster degrades to todays behaviour');
});

// ─── the pro_id lands in ci_matches evidence ────────────────────────────────

test('THE PRO_ID AND NAME LAND IN ci_matches EVIDENCE', async () => {
  // Without this a reviewer sees only that the call was withheld, with no way
  // to confirm the roster was right about the number.
  const db = fakeDb({ canvassers: [GIAN] });
  const out = await stageMatch(CALL, { db, cfg: CFG, canvasserPhones: ROSTER });

  assert.equal(out.outcome, 'review');
  assert.equal(out.reason, 'canvasser_ani');

  const inserted = db.log.find((l) => l.table === 'ci_matches' && l.op === 'insert');
  assert.ok(inserted, 'a ci_matches row is written even though nothing matched');
  assert.equal(inserted.row.tier, 'none');
  assert.equal(inserted.row.lp_cst_id, null);

  const ev = inserted.row.evidence.canvasser_ani;
  assert.equal(ev.pro_id, 5296);
  assert.equal(ev.name, 'GIAN - ORL CROSS');
  assert.equal(ev.market, 'ORL');
  assert.equal(ev.phone_last10, '3213050187');

  // And the call is parked for review with the reason on the row.
  const review = db.log.find((l) => l.table === 'ci_calls' && l.op === 'update' && l.patch.status === 'review');
  assert.ok(review, 'the call is parked for review');
  assert.equal(review.patch.review_reason, 'canvasser_ani');
});

test('a shared number records every Pro ID it hit, not just the first', async () => {
  const db = fakeDb();
  await stageMatch(
    { ...CALL, ani: '2392468866', customer_phone: '2392468866' },
    { db, cfg: CFG, canvasserPhones: ROSTER },
  );
  const ev = db.log.find((l) => l.table === 'ci_matches').row.evidence.canvasser_ani;
  assert.equal(ev.pro_id, 4862, 'the lowest pro_id is the headline, deterministically');
  assert.deepEqual(ev.matched.map((m) => m.pro_id), [4862, 5297], 'both are recorded');
});

test('an ordinary call writes NO canvasser_ani key at all', async () => {
  const db = fakeDb({ prospects: [{ lp_prospect_id: 4242, latest_lead_date: CALL.call_start }] });
  await stageMatch({ ...CALL, ani: '7273302574', customer_phone: '7273302574' }, { db, cfg: CFG, canvasserPhones: ROSTER });
  const ev = db.log.find((l) => l.table === 'ci_matches').row.evidence;
  assert.equal('canvasser_ani' in ev, false, 'absent, not null — the key means something happened');
});

// ─── the roster seed ────────────────────────────────────────────────────────

const CSV_HEADER = 'pro_id,name,market,phone_last10,phone_source';

test('normalizePhone reduces every spelling to the same 10 digits', () => {
  for (const v of ['321-305-0187', '13213050187', '3213050187', '+1 (321) 305-0187']) {
    assert.equal(normalizePhone(v), '3213050187', v);
  }
  // Anything short is SKIPPED, never stored truncated: a 7-digit fragment
  // would match nothing, or be extended by a later reader into someone else's
  // number.
  assert.equal(normalizePhone('555'), null);
  assert.equal(normalizePhone('3050187'), null);
  assert.equal(normalizePhone(''), null);
  assert.equal(normalizePhone(null), null);
});

test('splitCsvLine honours the quoted comma the real roster contains', () => {
  // 'Edward Kuriger, Jr' — a bare split(',') shifts every later column on that
  // row and the record is dropped as phone-less.
  assert.deepEqual(
    splitCsvLine('3508,"Edward Kuriger, Jr",FTLAU,7868488771,CellPhone'),
    ['3508', 'Edward Kuriger, Jr', 'FTLAU', '7868488771', 'CellPhone'],
  );
  assert.deepEqual(splitCsvLine('1,Plain Name,STPET,7272249047,HomePhone')[1], 'Plain Name');
});

test('parseRoster shapes rows and normalizes every phone', () => {
  const { rows, skipped } = parseRoster([
    CSV_HEADER,
    '5296,GIAN - ORL CROSS,ORL,321-305-0187,HomePhone',
    '1688,Cayla Rochelle,,7272249047,HomePhone',
  ].join('\n'));
  assert.equal(rows.length, 2);
  assert.deepEqual(rows[0], {
    pro_id: 5296, name: 'GIAN - ORL CROSS', market: 'ORL',
    phone_last10: '3213050187', phone_source: 'HomePhone', active: true,
  });
  assert.equal(rows[1].market, null, 'an empty market is null, not ""');
  assert.equal(skipped.length, 0);
});

test('A PHONE SHARED BY TWO PRO IDS DOES NOT DOUBLE-INSERT and does not throw', () => {
  // The composite PK exists for exactly this. Keying on phone alone would drop
  // one side of the pair and leave that canvasser unguarded.
  const { rows, sharedPhones, duplicates } = parseRoster([
    CSV_HEADER,
    '4862,DT Marketing Affiliate,FTMYR,2392468866,CellPhone',
    '5297,Douglas - FTM Thompson,FTMYR,2392468866,CellPhone',
  ].join('\n'));
  assert.equal(rows.length, 2, 'BOTH rows survive — they are distinct keys');
  assert.equal(duplicates.length, 0, 'different Pro IDs are not duplicates');
  assert.deepEqual(sharedPhones, [{ phone_last10: '2392468866', pro_ids: [4862, 5297] }]);
  // The upsert payload must carry no repeated key — Postgres rejects that
  // outright rather than merging.
  const keys = rows.map((r) => `${r.pro_id}|${r.phone_last10}`);
  assert.equal(new Set(keys).size, keys.length);
});

test('an exactly repeated (pro_id, phone) pair collapses to ONE row', () => {
  const { rows, duplicates } = parseRoster([
    CSV_HEADER,
    '5296,GIAN - ORL CROSS,ORL,3213050187,HomePhone',
    '5296,GIAN - ORL CROSS,ORL,321-305-0187,HomePhone',
  ].join('\n'));
  assert.equal(rows.length, 1, 'one payload row, so the upsert has no duplicate key');
  assert.equal(duplicates.length, 1);
});

test('one Pro ID with two numbers keeps both', () => {
  const { rows } = parseRoster([
    CSV_HEADER,
    '1896,Chris Rech,STPET,7279535784,HomePhone',
    '1896,Chris Rech,STPET,7273556075,CellPhone',
  ].join('\n'));
  assert.equal(rows.length, 2, 'both of his numbers are guarded');
});

test('rows with no usable phone or pro_id are REPORTED, never repaired', () => {
  const { rows, skipped } = parseRoster([
    CSV_HEADER,
    '5296,GIAN - ORL CROSS,ORL,3213050187,HomePhone',
    '1234,No Phone Person,ORL,,CellPhone',
    '1235,Short Phone,ORL,555,CellPhone',
    ',Nameless Pro,ORL,7272249047,CellPhone',
  ].join('\n'));
  assert.equal(rows.length, 1);
  assert.equal(skipped.length, 3);
  assert.deepEqual(skipped.map((s) => s.reason).sort(), ['no usable phone', 'no usable phone', 'no usable pro_id']);
});

test('a missing required column is a hard error, not 0 rows', () => {
  assert.throws(
    () => parseRoster('pro_id,name,market\n5296,GIAN,ORL'),
    /missing required column\(s\): phone_last10/,
  );
});

test('the CSV path is the first non-flag argument, in either order', () => {
  assert.equal(csvPathFromArgv(['node', 'seed.js', './roster.csv', '--execute']), './roster.csv');
  assert.equal(csvPathFromArgv(['node', 'seed.js', '--execute', './roster.csv']), './roster.csv');
  assert.equal(csvPathFromArgv(['node', 'seed.js']), null);
  assert.equal(csvPathFromArgv(['node', 'seed.js', '--execute']), null, 'a flag alone is not a path');
});
