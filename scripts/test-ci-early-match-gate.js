/**
 * Tests — the early match gate — scripts/test-ci-early-match-gate.js
 *
 * WHAT THIS PROTECTS. The pipeline ran fetch → transcribe → analyze → match →
 * sync, so every call bought a Whisper transcript before anyone asked whether
 * its note had anywhere to go. Matching does not read the transcript — it keys
 * on campaign + customer phone against LP — and over 4,154 transcripts /
 * 113.5 audio-hours (~$40.86 at whisper-1's $0.006/min), 2,120 calls produced
 * no writable match, i.e. 51% of the spend bought nothing that ever reached a
 * customer record. Matching now runs at `fetched`, before the audio is sent.
 *
 * WHY THESE TESTS ASSERT ON THE TRANSCRIBER STUB AND NOT ON A STATUS. A status
 * that changed the way we hoped proves nothing about whether OpenAI was
 * called; the money is spent inside transcribeCall, not inside an UPDATE. So
 * the transcriber double COUNTS ITS INVOCATIONS and every saving assertion is
 * `calls === 0`. A test that only read ci_calls.status would still pass with
 * the gate wired up backwards and the bill unchanged.
 *
 * THE THREE BYPASSES ARE THE POINT. Each is a case where "no writable target"
 * is true and gating anyway destroys something that has value today:
 * canvasser_ani calls (the canvasser routing design NEEDS the transcript),
 * unknown callers while CI_TRANSCRIBE_UNMATCHED is on (the default — some are
 * new leads), and any call whose audio is already paid for.
 *
 * No network, no DB, no OpenAI — every dependency is a double.
 *
 * Run: node --test scripts/test-ci-early-match-gate.js
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  stageEarlyMatch,
  stageTranscribe,
  stageMatch,
  advanceOne,
  lpDecisionFromMatchRow,
  CLAIMABLE,
} from '../src/ci/worker.js';
import { transcribeGate, GATE_STAGE, GATE_EVENT, GATE_REASONS } from '../src/ci/match-gate.js';
import { parseConfig } from '../src/ci/config.js';
import { matchGateHealth } from '../src/ci/reconcile.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

/** Default posture: the flag unset, i.e. today's behaviour. */
const CFG_DEFAULT = parseConfig({});
/** The gate armed — what Mark flips once he has read the unmatched calls. */
const CFG_GATED = parseConfig({ CI_TRANSCRIBE_UNMATCHED: 'false' });

const CALL = {
  id: 'call-uuid-1',
  five9_call_id: '300000010270798',
  call_start: '2026-08-26T16:00:00.000Z',
  duration_seconds: 240,
  campaign: 'Rehash',
  eligible: true,
  ani: '7273302574',
  customer_phone: '7273302574',
  raw_metadata: {},
};

/**
 * PostgREST-shaped double.
 *
 * `prospects` drives the LP phone lookup, so the tier is produced by the REAL
 * matcher rather than injected — a gate tested against a hand-written tier
 * would not notice decideLpTier changing under it.
 */
function fakeDb({
  prospects = [],
  leads = [],
  matchRow = null,
  transcriptRow = null,
  summary = null,
  campaignRow = null,
  canvassers = [],
} = {}) {
  const log = [];
  const tables = { lp_prospects: prospects, lp_leads: leads, ci_canvassers: canvassers };
  const singles = {
    ci_matches: matchRow,
    ci_transcripts: transcriptRow,
    ci_summaries: summary,
    ci_campaign_map: campaignRow,
  };
  return {
    log,
    events: () => log.filter((l) => l.table === 'ci_events').map((l) => l.row),
    patches: () => log.filter((l) => l.table === 'ci_calls' && l.op === 'update').map((l) => l.patch),
    from(table) {
      const data = tables[table] ?? [];
      const chain = {
        select() { return chain; },
        or() { return chain; },
        eq() { return chain; },
        gte() { return chain; },
        lte() { return chain; },
        ilike() { return chain; },
        order() { return chain; },
        limit() { return chain; },
        maybeSingle: async () => ({ data: singles[table] ?? null, error: null }),
        insert: async (row) => { log.push({ table, op: 'insert', row }); return { error: null }; },
        upsert: async (row, opts) => { log.push({ table, op: 'upsert', row, opts }); return { error: null }; },
        update(patch) {
          const thenable = {
            eq() { return thenable; },
            then: (res, rej) => { log.push({ table, op: 'update', patch }); return Promise.resolve({ error: null }).then(res, rej); },
          };
          return thenable;
        },
        then: (res, rej) => Promise.resolve({ data, error: null }).then(res, rej),
      };
      return chain;
    },
  };
}

/** A transcriber that records every time it was asked to spend money. */
function countingTranscriber() {
  const stub = {
    calls: 0,
    async transcribe() {
      stub.calls++;
      return { text: 'nope', segments: [], duration: 1 };
    },
  };
  return stub;
}

const loadAudioStub = async () => Buffer.from('RIFF');

/** A stored ci_matches row at the given tier. */
const matchAt = (tier, evidence = {}) => ({
  call_id: CALL.id,
  tier,
  method: tier === 'none' ? 'none' : 'phone_exact',
  lp_cst_id: tier === 'none' ? null : 453297,
  candidates: [],
  evidence: { reason: 'test', ...evidence },
  decided_by: 'auto',
});

// ─── the rules, in isolation ────────────────────────────────────────────────

test('ONLY a definitive tier none is ever gated out', () => {
  // 'ambiguous' means several candidates and the transcript may yet be what
  // chooses between them; 'probable' is one flag away from writable. Gating on
  // anything short of 'none' trades real notes for small savings.
  for (const tier of ['exact', 'high', 'probable', 'ambiguous']) {
    assert.equal(
      transcribeGate({ tier, cfg: CFG_GATED }).transcribe,
      true,
      `tier '${tier}' must still transcribe even with the gate armed`,
    );
  }
  assert.equal(transcribeGate({ tier: 'none', cfg: CFG_GATED }).transcribe, false);
});

test('the gate consults tierWritable rather than re-implementing the tier rules', () => {
  // 'probable' is writable only behind CALL_INTEL_ALLOW_PROBABLE, and the gate
  // must report the same answer sync.js would — not a second copy of it.
  const off = transcribeGate({ tier: 'probable', cfg: CFG_GATED });
  assert.equal(off.writable, false);
  assert.equal(off.reason, GATE_REASONS.TIER_NOT_DEFINITIVE, 'still transcribes, but not as a writable tier');

  const on = transcribeGate({
    tier: 'probable',
    cfg: parseConfig({ CALL_INTEL_MODE: 'live', CALL_INTEL_LP_WRITES: 'true', CALL_INTEL_ALLOW_PROBABLE: 'true' }),
  });
  assert.equal(on.writable, true);
  assert.equal(on.reason, GATE_REASONS.TIER_WRITABLE);
  // The source file must not carry its own copy of the writable set.
  assert.match(read('src/ci/match-gate.js'), /import \{ tierWritable \} from '\.\/sync\.js'/);
});

test('BYPASS 1 — a canvasser hit transcribes regardless of tier or flag', () => {
  const g = transcribeGate({ tier: 'none', canvassers: [{ pro_id: 5296 }], cfg: CFG_GATED });
  assert.equal(g.transcribe, true);
  assert.equal(g.reason, GATE_REASONS.CANVASSER_ANI);
});

test('BYPASS 2 — CI_TRANSCRIBE_UNMATCHED defaults ON, so tier none still transcribes', () => {
  const g = transcribeGate({ tier: 'none', cfg: CFG_DEFAULT });
  assert.equal(g.transcribe, true);
  assert.equal(g.reason, GATE_REASONS.UNMATCHED_TRANSCRIPTION_ENABLED);
});

test('BYPASS 3 — an existing transcript is never re-bought', () => {
  const g = transcribeGate({ tier: 'none', hasTranscript: true, cfg: CFG_GATED });
  assert.equal(g.transcribe, true);
  assert.equal(g.reason, GATE_REASONS.TRANSCRIPT_EXISTS);
});

test('CI_TRANSCRIBE_UNMATCHED is an OPT-OUT: only the literal false arms the gate', () => {
  // An unset or misspelled variable must land on "keep transcribing", never on
  // "stop" — the failure direction that silently loses leads.
  for (const v of [undefined, '', 'TRUE', 'yes', 'flase', '0', 'off']) {
    assert.equal(
      parseConfig({ CI_TRANSCRIBE_UNMATCHED: v }).transcribeUnmatched,
      true,
      `CI_TRANSCRIBE_UNMATCHED=${JSON.stringify(v)} must NOT arm the gate`,
    );
  }
  for (const v of ['false', 'FALSE', ' False ']) {
    assert.equal(parseConfig({ CI_TRANSCRIBE_UNMATCHED: v }).transcribeUnmatched, false);
  }
});

// ─── the stage, and whether OpenAI was actually called ──────────────────────

test('THE MONEY TEST: a tier-none call never reaches the transcriber', async () => {
  // No LP prospect on the number, so the real matcher resolves 'none'.
  const db = fakeDb();
  const out = await stageEarlyMatch(CALL, { db, cfg: CFG_GATED, canvasserPhones: new Map() });
  assert.equal(out.outcome, 'review');
  assert.equal(out.reason, 'match_none');

  // And now prove the transcriber is unreachable for it: the call parked in
  // 'review', which advanceOne does not dispatch at all.
  const transcriber = countingTranscriber();
  const parked = await advanceOne({ ...CALL, status: 'review' }, {
    db: fakeDb(), cfg: CFG_GATED, transcriber, loadAudio: loadAudioStub, canvasserPhones: new Map(),
  });
  assert.equal(parked.outcome, 'noop');
  assert.equal(transcriber.calls, 0, 'not one Whisper call for a call with nowhere to write');
});

test("a gated-out call reaches 'review' with the SAME reason string as before", async () => {
  // scripts/requeue-ci-review.js selects on these strings by name. A gate that
  // invented a new reason would strand every one of those calls.
  const db = fakeDb();
  await stageEarlyMatch(CALL, { db, cfg: CFG_GATED, canvasserPhones: new Map() });
  const patch = db.patches().find((p) => p.status === 'review');
  assert.ok(patch, 'the call parks');
  assert.equal(patch.review_reason, 'match_none');
});

test("tier 'ambiguous' and 'probable' DO transcribe — they advance to matched", async () => {
  // Two prospects on the number, neither narrowable ⇒ 'ambiguous' from the
  // real matcher. It must pass the gate even with the gate armed.
  const db = fakeDb({
    prospects: [
      { lp_prospect_id: 1, latest_lead_date: null },
      { lp_prospect_id: 2, latest_lead_date: null },
    ],
  });
  const out = await stageEarlyMatch(CALL, { db, cfg: CFG_GATED, canvasserPhones: new Map() });
  assert.equal(out.tier, 'ambiguous');
  assert.equal(out.outcome, 'advanced');
  assert.equal(out.to, 'matched', 'ambiguous is not a reason to withhold the transcript');

  // And it must NOT park here: the review verdict is still the LATE stage's,
  // so the queue keeps receiving these calls after analysis, as it does today.
  assert.equal(db.patches().some((p) => p.status === 'review'), false);
});

test('a canvasser_ani call transcribes regardless of match tier', async () => {
  // The canvasser routing design DELIBERATELY uses the transcript to identify
  // the customer, precisely because the ANI is the canvasser's phone. Gating
  // these would not trim waste, it would make that project impossible.
  const roster = new Map([['7273302574', [{ pro_id: 5296, name: 'GIAN - ORL CROSS', market: 'ORL' }]]]);
  const db = fakeDb({ prospects: [{ lp_prospect_id: 999 }] });
  const out = await stageEarlyMatch(CALL, { db, cfg: CFG_GATED, canvasserPhones: roster });

  assert.equal(out.tier, 'none', 'the guard still withholds the match');
  assert.equal(out.outcome, 'advanced');
  assert.equal(out.to, 'matched');
  assert.equal(out.gate, GATE_REASONS.CANVASSER_ANI);
});

test('REGRESSION GUARD: with the default config, nothing is gated out at all', async () => {
  // CI_TRANSCRIBE_UNMATCHED unset must preserve today's behaviour EXACTLY.
  // This is the assertion that says the change ships inert.
  const cases = [
    ['no match at all', fakeDb()],
    ['one candidate', fakeDb({ prospects: [{ lp_prospect_id: 453297 }] })],
    ['two candidates', fakeDb({ prospects: [{ lp_prospect_id: 1 }, { lp_prospect_id: 2 }] })],
  ];
  for (const [label, db] of cases) {
    const out = await stageEarlyMatch(CALL, { db, cfg: CFG_DEFAULT, canvasserPhones: new Map() });
    assert.equal(out.outcome, 'advanced', `${label}: must advance`);
    assert.equal(out.to, 'matched', `${label}: must still transcribe`);
    assert.equal(db.patches().some((p) => p.status === 'review'), false, `${label}: nothing parks early`);
  }
});

// ─── never pay for the same audio twice ─────────────────────────────────────

test('a call that already has a ci_transcripts row is never re-transcribed', async () => {
  const transcriber = countingTranscriber();
  const db = fakeDb({ transcriptRow: { call_id: CALL.id, audio_seconds: 240 } });

  const out = await stageTranscribe({ ...CALL, status: 'matched' }, {
    db, cfg: CFG_DEFAULT, transcriber, loadAudio: loadAudioStub,
  });

  assert.equal(transcriber.calls, 0, 'the audio was already paid for');
  assert.equal(out.outcome, 'advanced');
  assert.equal(out.to, 'transcribed');
  assert.equal(out.reused, true);
  // And it must not quietly rewrite the row it just decided to keep.
  assert.equal(db.log.some((l) => l.table === 'ci_transcripts' && l.op !== 'select'), false);
});

test('the reuse is visible in ci_events, not silent', async () => {
  // An unexplained jump from matched to transcribed with no Whisper call is
  // exactly the kind of silence this subsystem has been bitten by.
  const db = fakeDb({ transcriptRow: { call_id: CALL.id, audio_seconds: 240 } });
  await stageTranscribe({ ...CALL, status: 'matched' }, {
    db, cfg: CFG_DEFAULT, transcriber: countingTranscriber(), loadAudio: loadAudioStub,
  });
  const ev = db.events().find((e) => e.stage === 'transcribe');
  assert.ok(ev, 'the transition is logged');
  assert.equal(ev.detail.reused, true);
});

// ─── the late stage must not insert a second time ───────────────────────────

test('the late match stage is a NO-OP when a match row already exists', async () => {
  // ci_matches.call_id is UNIQUE. A second insert does not append a row, it
  // throws — and recordFailure then walks the call to 'failed'. That is
  // exactly what sent 88 calls to 'failed' on ci_matches_call_id_key on
  // 2026-08-26.
  const db = fakeDb({ matchRow: matchAt('high') });
  const out = await stageMatch({ ...CALL, status: 'analyzed' }, {
    db, cfg: CFG_DEFAULT, canvasserPhones: new Map(),
  });

  assert.equal(db.log.some((l) => l.table === 'ci_matches' && l.op === 'insert'), false,
    'NOT ONE insert against a call that already has a match row');
  assert.equal(out.outcome, 'advanced');
  assert.equal(out.to, 'syncing');
  assert.equal(out.tier, 'high', 'the stored verdict is what carries forward');
});

test('the late stage does not re-run the matcher either — no LP lookup happens', async () => {
  // Re-resolving would be a second opinion that could disagree with the row
  // the pipeline already acted on.
  const db = fakeDb({ matchRow: matchAt('high'), prospects: [{ lp_prospect_id: 111 }] });
  await stageMatch({ ...CALL, status: 'analyzed' }, { db, cfg: CFG_DEFAULT, canvasserPhones: new Map() });
  assert.equal(db.log.some((l) => l.table === 'lp_prospects'), false);
});

test('the late stage STILL files the review verdict, off the stored row', async () => {
  // The early stage deliberately does not park ambiguous or canvasser calls.
  // If the late stage did not read the verdict back, those calls would sail
  // through to sync and the review queue would silently empty out.
  for (const [row, expected] of [
    [matchAt('ambiguous'), 'match_ambiguous'],
    [matchAt('none'), 'match_none'],
    [matchAt('none', { canvasser_ani: { matched: [{ pro_id: 5296 }] } }), 'canvasser_ani'],
  ]) {
    const db = fakeDb({ matchRow: row });
    const out = await stageMatch({ ...CALL, status: 'analyzed' }, { db, cfg: CFG_DEFAULT, canvasserPhones: new Map() });
    assert.equal(out.outcome, 'review');
    assert.equal(out.reason, expected);
  }
});

test('lpDecisionFromMatchRow reads a human set_match row as needing no review', () => {
  const human = { tier: 'exact', method: 'human_review', lp_cst_id: 453297, candidates: [], evidence: {} };
  const lp = lpDecisionFromMatchRow(human);
  assert.equal(lp.tier, 'exact');
  assert.deepEqual(lp.canvassers, [], 'no evidence block is not a canvasser hit');
});

test('lpDecisionFromMatchRow degrades a missing row to none, never to a match', () => {
  assert.equal(lpDecisionFromMatchRow(null).tier, 'none');
  assert.equal(lpDecisionFromMatchRow(undefined).prospectId, null);
  assert.deepEqual(lpDecisionFromMatchRow({}).candidates, []);
});

// ─── the wiring ─────────────────────────────────────────────────────────────

test('advanceOne dispatches fetched to the GATE, not to the transcriber', async () => {
  const transcriber = countingTranscriber();
  const db = fakeDb();
  const out = await advanceOne({ ...CALL, status: 'fetched' }, {
    db, cfg: CFG_GATED, transcriber, loadAudio: loadAudioStub, canvasserPhones: new Map(),
  });
  assert.equal(transcriber.calls, 0, 'the fetch stage must not hand straight to Whisper');
  assert.equal(out.outcome, 'review', 'unmatched, gate armed');
});

test('advanceOne dispatches matched to the transcriber and analyzed to the matcher', async () => {
  const t = countingTranscriber();
  const viaMatched = await advanceOne({ ...CALL, status: 'matched' }, {
    db: fakeDb({ transcriptRow: { call_id: CALL.id } }), cfg: CFG_DEFAULT, transcriber: t, loadAudio: loadAudioStub,
  });
  assert.equal(viaMatched.to, 'transcribed');

  const viaAnalyzed = await advanceOne({ ...CALL, status: 'analyzed' }, {
    db: fakeDb({ matchRow: matchAt('high') }), cfg: CFG_DEFAULT, canvasserPhones: new Map(),
  });
  assert.equal(viaAnalyzed.to, 'syncing');
});

test('every status the pipeline now advances THROUGH is claimable', () => {
  // 'syncing' was declared in sql/061 and never used; the late match stage
  // advances to it now. A status the worker can reach but never claim is a
  // call parked forever with nothing saying why.
  for (const s of ['discovered', 'fetched', 'matched', 'transcribed', 'analyzed', 'syncing']) {
    assert.ok(CLAIMABLE.includes(s), `'${s}' must be claimable`);
  }
});

test('the stage order in sql/061 admits every status the worker writes', () => {
  // The CHECK is the real authority. A status the code advances to and the
  // constraint rejects fails the UPDATE, and recordFailure walks the call to
  // 'failed' with a message nobody connects to a stage rename.
  const sql = read('sql/061_call_intel_schema.sql');
  const m = /status[\s\S]*?CHECK \(status IN \(([\s\S]*?)\)\)/.exec(sql);
  assert.ok(m, 'the ci_calls status CHECK must still be findable');
  const allowed = m[1].split(',').map((s) => s.trim().replace(/^'|'$/g, '')).filter(Boolean);
  for (const s of ['fetched', 'matched', 'transcribed', 'analyzed', 'syncing', 'skipped', 'review']) {
    assert.ok(allowed.includes(s), `sql/061 must admit status '${s}'`);
  }
});

// ─── observability ──────────────────────────────────────────────────────────

test('EVERY gate decision writes a ci_events row, in both directions', () => {
  // A gate that is too aggressive looks exactly like a pipeline that is
  // working fine but quiet — the failure mode that hid the 2026-08-22 filename
  // break for three days. Counting only the refusals would make the pass rate
  // unobservable, and the pass rate is how "too aggressive" is detected.
  const both = [
    ['gated out', CFG_GATED, false],
    ['let through', CFG_DEFAULT, true],
  ];
  return Promise.all(both.map(async ([label, cfg, transcribed]) => {
    const db = fakeDb();
    await stageEarlyMatch(CALL, { db, cfg, canvasserPhones: new Map() });
    const ev = db.events().find((e) => e.stage === GATE_STAGE && e.event === GATE_EVENT);
    assert.ok(ev, `${label}: a gate event must be written`);
    assert.equal(ev.detail.transcribed, transcribed);
    assert.equal(ev.detail.tier, 'none');
    assert.equal(ev.detail.audio_seconds, 240, `${label}: the seconds at stake are recorded either way`);
    assert.ok(ev.detail.reason, `${label}: the reason is named`);
  }));
});

test('the gate event carries no full phone number', () => {
  // §10: last-4 only, never the whole number, in anything that lands in a log
  // or an events table.
  const db = fakeDb();
  return stageEarlyMatch(CALL, { db, cfg: CFG_GATED, canvasserPhones: new Map() }).then(() => {
    const ev = db.events().find((e) => e.stage === GATE_STAGE);
    assert.equal(JSON.stringify(ev.detail).includes('7273302574'), false);
    assert.equal(ev.detail.phone, 'x2574', 'the house last4() form, same as every other stage');
  });
});

test('/ci/health counts the gate in BOTH directions and sums the seconds saved', async () => {
  // This number is the entire justification for the change and has to be
  // readable off the live system after deploy, not asserted in a PR body.
  const rows = [
    { detail: { transcribed: false, reason: GATE_REASONS.NO_WRITABLE_TARGET, audio_seconds: 240 } },
    { detail: { transcribed: false, reason: GATE_REASONS.NO_WRITABLE_TARGET, audio_seconds: 60 } },
    { detail: { transcribed: true, reason: GATE_REASONS.TIER_WRITABLE, audio_seconds: 300 } },
  ];
  const db = { from: () => ({ select: () => ({ eq: () => ({ eq: () => ({ gte: async () => ({ data: rows, error: null }) }) }) }) }) };

  const h = await matchGateHealth({ db, since: '2026-08-26T00:00:00.000Z' });
  assert.equal(h.gated_out, 2);
  assert.equal(h.transcribed, 1, 'the denominator matters as much as the numerator');
  assert.equal(h.audio_seconds_not_transcribed, 300);
  assert.equal(h.reasons[GATE_REASONS.NO_WRITABLE_TARGET], 2);
});

test('a health-read failure degrades to zeroes rather than 500ing /ci/health', async () => {
  // /ci/health is what a human opens when something looks wrong. A new counter
  // must never be the reason the whole endpoint stops answering.
  const db = { from: () => ({ select: () => ({ eq: () => ({ eq: () => ({ gte: async () => ({ data: null, error: { message: 'relation missing' } }) }) }) }) }) };
  const h = await matchGateHealth({ db, since: '2026-08-26T00:00:00.000Z' });
  assert.equal(h.gated_out, 0);
  assert.match(h.error, /relation missing/);
});

test('an unmeasurable call contributes 0 seconds, never a guess', async () => {
  // The saving must UNDER-report. A duration invented for a call with none
  // would inflate exactly the number the change is being judged on.
  const db = fakeDb();
  await stageEarlyMatch({ ...CALL, duration_seconds: null }, { db, cfg: CFG_GATED, canvasserPhones: new Map() });
  const ev = db.events().find((e) => e.stage === GATE_STAGE);
  assert.equal(ev.detail.audio_seconds, 0);
});

// ─── the trade that was already made and reversed ───────────────────────────

test('the gate does NOT reach for a cheaper transcription model', () => {
  // gpt-4o-mini-transcribe does not support verbose_json and the segments are
  // load-bearing for diarization. That trade was made once and reversed; it is
  // revisitable ONLY if Five9 delivers dual-channel stereo, where speaker
  // identity comes from the channel instead of segment analysis.
  const src = read('src/ci/match-gate.js') + read('src/ci/worker.js');
  assert.equal(/CI_TRANSCRIBE_MODEL/.test(src), false, 'the gate must not touch the model choice');
});
