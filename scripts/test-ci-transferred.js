/**
 * Tests — vendor-side audio is not a retrieval failure
 * scripts/test-ci-transferred.js
 *
 * WHAT WAS MEASURED. Of 199 calls parked on `recording_missing`, 75 carry
 * disposition 'Transferred To 3rd Party' — all on 'Main Number', averaging 225
 * seconds, to DNIS 9548008906 (75) and 9548704474 (62). Add the 83
 * canvass-line calls and it is ONE cause, not two: real multi-minute
 * conversations that continued on a vendor platform after a transfer. Five9
 * records only its own leg. No SFTP search will ever find them.
 *
 * THE FOUR TRAPS THESE GUARD:
 *
 * 1. 'TRANSFERRED' MUST NOT MASK A RECOVERABLE FILE. Every verdict that means
 *    "we found a file for this number" — present, a day away, just outside the
 *    window — outranks it. A transferred call whose Five9 leg WAS recorded is
 *    still a real finding.
 * 2. NOR MUST IT BE MASKED. A transferred call with no recording row has
 *    expected_recording_count 0 and used to be filtered out as
 *    `no_audio_correctly_parked` — a phrase meaning "nothing to recover",
 *    which is exactly backwards. It is classified BEFORE that filter.
 * 3. `was_transferred` IS NOT A TRIGGER. isTransferGroup sets it true for ANY
 *    multi-leg group, re-dials included. Using it as the rule would classify
 *    unrelated calls as vendor-side and hide real retrieval failures.
 * 4. THE DESTINATION IS THE TRANSFER LEG'S DNIS, not ci_calls.dnis — that one
 *    is the PRIMARY leg's, the number the customer reached rather than the one
 *    they were handed to. Getting it wrong makes the rollup name the wrong
 *    vendor.
 *
 * AND THE VERDICT NAMES NO FIX. That is the point: there is no code change and
 * no archive search that recovers these. The rollup exists so the destinations
 * can be identified and a feed agreed with the vendor IN WRITING first.
 *
 * No network, no SFTP — the listings and the db are injected.
 *
 * Run: node --test scripts/test-ci-transferred.js
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  VERDICTS, classifyTransfer, summariseTransfers, diagnoseCall,
  summariseVerdicts, recommendation, diagnoseRecordingGap,
} from '../src/ci/recording-diagnosis.js';
import { isTransferLeg, isTransferGroup } from '../src/ci/discovery.js';

/** The live shape: an inbound call handed to a vendor mid-conversation. */
const LEGS = [
  { direction: 'Inbound', ani: '9419203087', dnis: '2394930774' },
  { direction: '3rd party transfer', ani: '9419203087', dnis: '9548008906' },
];

const TRANSFERRED_CALL = {
  id: 'c1',
  five9_call_id: '300000010274880',
  campaign: 'Main Number',
  customer_phone: '9419203087',
  ani: '9419203087',
  dnis: '2394930774',            // the PRIMARY leg's — not the destination
  call_start: '2026-08-22T00:30:00.000Z',
  duration_seconds: 225,
  disposition: 'Transferred To 3rd Party',
  was_transferred: true,
  raw_metadata: { legs: LEGS, expected_recording_count: 0 },
};

/** A recording as describeRecording returns it. */
const rec = (over = {}) => ({
  fullPath: '/Five9/Recordings/Main Number/8_21_2026/9419203087 by cdeer @ 7_30_00 PM.wav',
  fileName: '9419203087 by cdeer @ 7_30_00 PM.wav',
  campaignDir: 'Main Number',
  ani: '9419203087',
  recordedAt: new Date('2026-08-22T00:30:00.000Z'),
  ...over,
});

// ─── the classifier ─────────────────────────────────────────────────────────

test('the disposition alone classifies a transfer', () => {
  const r = classifyTransfer(TRANSFERRED_CALL);
  assert.equal(r.transferred, true);
  assert.equal(r.reason, 'disposition');
});

test('a 3rd-party transfer LEG classifies it too, with no disposition', () => {
  const r = classifyTransfer({ ...TRANSFERRED_CALL, disposition: 'Answered' });
  assert.equal(r.transferred, true);
  assert.equal(r.reason, 'transfer_leg');
});

test('the destination is the TRANSFER leg\'s dnis, never the primary leg\'s', () => {
  // ci_calls.dnis is 2394930774 — the number the customer called. The vendor
  // is 9548008906. Reporting the former would name the wrong destination in
  // the rollup, and the rollup is the whole deliverable.
  assert.equal(classifyTransfer(TRANSFERRED_CALL).dnis, '9548008906');
  assert.notEqual(classifyTransfer(TRANSFERRED_CALL).dnis, TRANSFERRED_CALL.dnis);
});

test('was_transferred alone is NOT a trigger', () => {
  // isTransferGroup sets it true for any multi-leg group — ordinary re-dials
  // included. Treating it as the rule would classify unrelated calls as
  // vendor-side and hide the retrieval failures underneath them.
  const redial = {
    ...TRANSFERRED_CALL,
    disposition: 'No Answer',
    was_transferred: true,
    raw_metadata: { legs: [{ direction: 'Outbound', dnis: '9419203087' }, { direction: 'Outbound', dnis: '9419203087' }] },
  };
  assert.ok(isTransferGroup(redial.raw_metadata.legs), 'the group heuristic still says true');
  assert.equal(classifyTransfer(redial).transferred, false, 'but the classifier must not');
});

test('an ordinary call is not a transfer, and reports no destination', () => {
  const plain = { ...TRANSFERRED_CALL, disposition: 'Answered', was_transferred: false, raw_metadata: { legs: [LEGS[0]] } };
  assert.deepEqual(classifyTransfer(plain), { transferred: false, reason: null, dnis: null });
  assert.deepEqual(classifyTransfer({}), { transferred: false, reason: null, dnis: null });
});

test('the transfer-leg pattern has ONE home, shared with discovery', () => {
  // A diagnostic that recognises a different set of legs from the code it is
  // diagnosing describes a different system, convincingly.
  assert.equal(isTransferLeg({ direction: '3rd party transfer' }), true);
  assert.equal(isTransferLeg({ direction: 'Third Party Transfer' }), true);
  assert.equal(isTransferLeg({ direction: 'Inbound' }), false);
  assert.equal(isTransferLeg({}), false);
});

// ─── precedence: never mask a recoverable file ──────────────────────────────

test('audio that is RIGHT THERE still outranks the transfer verdict', () => {
  const d = diagnoseCall(TRANSFERRED_CALL, { same: [rec()], prev: [], next: [] }, 180);
  assert.equal(d.verdict, VERDICTS.PRESENT_SHOULD_HAVE_MATCHED,
    'a transferred call whose Five9 leg WAS recorded is still recoverable');
});

test('audio a day away still outranks it', () => {
  const d = diagnoseCall(TRANSFERRED_CALL, { same: [], prev: [rec()], next: [] }, 180);
  assert.equal(d.verdict, VERDICTS.WRONG_DATE_DIR);
});

test('a file for this number outside the window still outranks it', () => {
  const far = rec({ recordedAt: new Date('2026-08-22T04:30:00.000Z') });
  const d = diagnoseCall(TRANSFERRED_CALL, { same: [far], prev: [], next: [] }, 180);
  assert.equal(d.verdict, VERDICTS.OUTSIDE_WINDOW);
});

test('with nothing found, the transfer is the answer — not a missing recording', () => {
  const d = diagnoseCall(TRANSFERRED_CALL, { same: [], prev: [], next: [] }, 180);
  assert.equal(d.verdict, VERDICTS.TRANSFERRED);
  assert.equal(d.transfer_dnis, '9548008906');
  assert.equal(d.transfer_basis, 'disposition');
  assert.match(d.detail, /\(954\) 800-8906/);
  assert.match(d.detail, /not a retrieval failure/);
});

test('a genuinely absent recording is still reported as absent', () => {
  const plain = { ...TRANSFERRED_CALL, disposition: 'Answered', raw_metadata: { legs: [LEGS[0]] } };
  assert.equal(diagnoseCall(plain, { same: [], prev: [], next: [] }, 180).verdict, VERDICTS.CAMPAIGN_DIR_EMPTY);
  assert.equal(
    diagnoseCall(plain, { same: [rec({ ani: '7275550000' })], prev: [], next: [] }, 180).verdict,
    VERDICTS.NO_FILE_FOR_NUMBER,
  );
});

test('an unreadable archive is still UNKNOWN, never a transfer', () => {
  // We could not look. That must never become a conclusion about the archive,
  // and a transfer marker on the row does not change that we could not look.
  const d = diagnoseCall(TRANSFERRED_CALL, { prev: [], next: [] }, 180);
  assert.equal(d.verdict, VERDICTS.UNKNOWN);
});

// ─── the rollup ─────────────────────────────────────────────────────────────

const t = (over) => ({ verdict: VERDICTS.TRANSFERRED, campaign: 'Main Number', ...over });

test('the per-DNIS rollup counts calls, minutes, campaigns and the date range', () => {
  const rows = [
    t({ transfer_dnis: '9548008906', duration_seconds: 240, call_start: '2026-08-20T10:00:00.000Z' }),
    t({ transfer_dnis: '9548008906', duration_seconds: 120, call_start: '2026-08-22T10:00:00.000Z', campaign: 'Rehash' }),
    t({ transfer_dnis: '9548704474', duration_seconds: 300, call_start: '2026-08-21T10:00:00.000Z' }),
    { verdict: VERDICTS.NO_FILE_FOR_NUMBER, transfer_dnis: '9999999999', duration_seconds: 999 },
  ];
  const out = summariseTransfers(rows);

  assert.equal(out.length, 2, 'only transferred rows are rolled up');
  const [first, second] = out;

  assert.equal(first.dnis, '9548008906', 'sorted by call count, busiest first');
  assert.equal(first.destination, '(954) 800-8906');
  assert.equal(first.calls, 2);
  assert.equal(first.total_minutes, 6);
  assert.equal(first.avg_seconds, 180);
  assert.deepEqual(first.campaigns, ['Main Number', 'Rehash']);
  assert.equal(first.first_call, '2026-08-20T10:00:00.000Z');
  assert.equal(first.last_call, '2026-08-22T10:00:00.000Z');

  assert.equal(second.dnis, '9548704474');
  assert.equal(second.calls, 1);
});

test('a transfer whose destination could not be read is COUNTED, not dropped', () => {
  // Dropping it would understate the volume, which is the one number this
  // rollup exists to get right.
  const out = summariseTransfers([t({ transfer_dnis: null, duration_seconds: 60, call_start: '2026-08-21T10:00:00.000Z' })]);
  assert.equal(out.length, 1);
  assert.equal(out[0].destination, 'unknown');
  assert.equal(out[0].calls, 1);
  assert.match(out[0].note, /no transfer-leg DNIS/);
});

test('an empty set rolls up to an empty list, not to a phantom row', () => {
  assert.deepEqual(summariseTransfers([]), []);
  assert.deepEqual(summariseTransfers(null), []);
});

// ─── the summary and the recommendation ─────────────────────────────────────

test('transferred is a DIAGNOSED verdict and can be the dominant one', () => {
  const rows = [t({}), t({}), t({}), { verdict: VERDICTS.NO_FILE_FOR_NUMBER }];
  const s = summariseVerdicts(rows);
  assert.equal(s.diagnosed, 4);
  assert.equal(s.dominant.verdict, VERDICTS.TRANSFERRED);
  const rec = recommendation(s);
  assert.match(rec, /TRANSFERRED/);
  assert.match(rec, /NO code fix/);
  assert.match(rec, /IN WRITING/, 'the vendor feed must be agreed before any ingest path');
});

test('an unreadable run still recommends nothing about transfers', () => {
  const s = summariseVerdicts([{ verdict: VERDICTS.UNKNOWN }, { verdict: VERDICTS.UNKNOWN }]);
  assert.equal(s.diagnosed, 0);
  assert.match(recommendation(s), /INCONCLUSIVE/);
  assert.equal(/TRANSFERRED/.test(recommendation(s)), false);
});

// ─── end to end, through the endpoint's function ────────────────────────────

/** A db double returning a fixed selection, recording every call made. */
function fakeDb(rows) {
  const log = [];
  return {
    log,
    from(table) {
      const chain = {
        select() { return chain; },
        in() { return chain; },
        order() { return chain; },
        limit: async () => { log.push({ table, op: 'select' }); return { data: rows, error: null }; },
        update(patch) { log.push({ table, op: 'update', patch }); return chain; },
        insert(row) { log.push({ table, op: 'insert', row }); return chain; },
        eq() { return chain; },
      };
      return chain;
    },
  };
}

/** An adapter that must never be asked about a transferred call. */
const countingAdapter = () => {
  const seen = [];
  return { seen, async list({ campaign, date }) { seen.push(`${campaign}/${date}`); return []; } };
};

test('A TRANSFER WITH NO RECORDING ROW IS REPORTED, not counted as correctly parked', async () => {
  // expected_recording_count is 0, which used to filter this call out of the
  // run entirely and count it under `no_audio_correctly_parked` — i.e.
  // "nothing to recover". The conversation lasted 225 seconds.
  const db = fakeDb([TRANSFERRED_CALL]);
  const adapter = countingAdapter();
  const out = await diagnoseRecordingGap({ db, adapter, limit: 25 });

  assert.equal(out.examined, 1);
  assert.equal(out.transferred, 1);
  assert.equal(out.no_audio_correctly_parked, 0, 'a transfer is NOT "nothing to recover"');
  assert.equal(out.results[0].verdict, VERDICTS.TRANSFERRED);
  assert.equal(out.results[0].duration_seconds, 225);
  assert.deepEqual(out.transfers[0].dnis, '9548008906');
  assert.equal(adapter.seen.length, 0, 'a transfer needs no archive listing at all');
});

test('a non-transferred call with no audio is still correctly parked', async () => {
  const plain = {
    ...TRANSFERRED_CALL, disposition: 'No Answer', was_transferred: false,
    raw_metadata: { legs: [LEGS[0]], expected_recording_count: 0 },
  };
  const out = await diagnoseRecordingGap({ db: fakeDb([plain]), adapter: countingAdapter(), limit: 25 });
  assert.equal(out.transferred, 0);
  assert.equal(out.no_audio_correctly_parked, 1);
  assert.equal(out.results.length, 0);
});

test('THE ENDPOINT WRITES NOTHING', async () => {
  const db = fakeDb([TRANSFERRED_CALL]);
  await diagnoseRecordingGap({ db, adapter: countingAdapter(), limit: 25 });
  assert.equal(db.log.every((l) => l.op === 'select'), true, JSON.stringify(db.log));
});
