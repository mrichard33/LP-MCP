/**
 * Tests — PR 3: transcription, analysis, and the §7 schema contract
 * scripts/test-ci-transcribe-analyze.js
 *
 * The three behaviours the handoff names for this PR are all here and all
 * assert on the failure mode, not just the happy path:
 *
 *   1. STEREO MERGE ORDERING — the merge must reconstruct the conversation in
 *      time order and label speakers deterministically. Wrong, every note
 *      quotes the customer as the agent.
 *   2. VALIDATION FAILURE → REVIEW AFTER 2 — an invalid AI output must never
 *      be repaired into something that looks valid.
 *   3. IS_CURRENT UNIQUENESS — ci_summaries_current_uq is UNIQUE(call_id)
 *      WHERE is_current, so a re-analysis must demote before inserting.
 *
 * No network, no API key, no audio fixtures: the transcriber, audio loader and
 * LLM are injected, and WAV buffers are built byte-by-byte.
 *
 * Run: node --test scripts/test-ci-transcribe-analyze.js
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  orderSegments,
  mergeStereoSegments,
  rebaseSegments,
  renderTurns,
  assessConfidence,
  wordsPerTenSeconds,
  agentChannel,
  transcribeCall,
} from '../src/ci/transcribe.js';
import { parseWav, channelCount, extractChannel, buildWav, WAV_FORMAT_PCM } from '../src/ci/wav.js';
import {
  validateAnalysis,
  analysisReviewFlags,
  ANALYSIS_SCHEMA_VERSION,
  OUTCOMES,
  FLAG_KEYS,
} from '../src/ci/analysis-schema.js';
import {
  analyzeTranscript, extractJson, buildUserMessage, buildSystemPrompt,
  agentContextLine, MAX_ANALYSIS_ATTEMPTS,
} from '../src/ci/analyze.js';
import { insertCurrentSummary, stageAnalyze } from '../src/ci/worker.js';
import { parseConfig } from '../src/ci/config.js';

const CFG = parseConfig({});
const CALL = { id: 'call-uuid-1', ani: '7273302574', campaign: 'Rehash', direction: 'Outbound', team: 'reece' };

/** A minimal valid §7 output. */
function validAnalysis(over = {}) {
  const triple = () => ({ value: null, source: 'unknown', confidence: 0 });
  return {
    schema_version: ANALYSIS_SCHEMA_VERSION,
    summary: 'The agent reached the customer and confirmed the appointment.',
    outcome: 'appointment_confirmed',
    outcome_confidence: 0.91,
    outcome_basis: 'stated',
    customer: { name: triple(), phone_mentioned: triple(), email: triple(), address: triple() },
    appointment: { discussed: true, date: triple(), time: triple(), notes: null },
    follow_up: { required: false, when: null, action: null },
    key_details: [],
    flags: Object.fromEntries(FLAG_KEYS.map((k) => [k, false])),
    quality: { transcript_intelligible: true, uncertainty_notes: null },
    ...over,
  };
}

// ─── 1. stereo merge ordering ───────────────────────────────────────────────

test('STEREO MERGE reconstructs the conversation in time order across channels', () => {
  const agentSide = { segments: [
    { start: 0.0, end: 2.0, text: 'Hi, this is John from Reece Windows.' },
    { start: 6.0, end: 8.0, text: 'Great, I have you down for Thursday.' },
  ] };
  const customerSide = { segments: [
    { start: 2.5, end: 5.5, text: 'Oh hi, yes I was expecting your call.' },
    { start: 8.5, end: 9.5, text: 'Thursday works.' },
  ] };

  const turns = mergeStereoSegments(agentSide, customerSide);
  assert.deepEqual(turns.map((t) => t.speaker), ['agent', 'customer', 'agent', 'customer']);
  assert.deepEqual(turns.map((t) => t.start), [0, 2.5, 6, 8.5]);
  // The labels must follow the CHANNEL, not the content.
  assert.equal(turns[1].text, 'Oh hi, yes I was expecting your call.');
  assert.equal(renderTurns(turns).split('\n')[1], 'customer: Oh hi, yes I was expecting your call.');
});

test('simultaneous speech breaks toward the agent, deterministically', () => {
  // Both sides talking at the same offset is normal on a live call. What
  // matters is that re-running the same audio cannot reorder the transcript.
  const a = { segments: [{ start: 4, end: 5, text: 'Sorry, go ahead—' }] };
  const c = { segments: [{ start: 4, end: 6, text: 'No, you first—' }] };
  const once = mergeStereoSegments(a, c);
  const twice = mergeStereoSegments(a, c);
  assert.deepEqual(once, twice);
  assert.equal(once[0].speaker, 'agent');
});

test('empty segments are dropped rather than emitted as blank turns', () => {
  const turns = mergeStereoSegments(
    { segments: [{ start: 0, end: 1, text: '   ' }, { start: 2, end: 3, text: 'Hello?' }] },
    { segments: [] },
  );
  assert.equal(turns.length, 1);
  assert.equal(turns[0].text, 'Hello?');
});

test('the agent channel is configurable, and swapping it swaps the labels', () => {
  assert.equal(agentChannel(parseConfig({})), 0);
  assert.equal(agentChannel(parseConfig({ CI_STEREO_AGENT_CHANNEL: '1' })), 1);
  // Anything that is not 1 means channel 0 — an unset or garbled value must
  // not produce a third state.
  assert.equal(agentChannel(parseConfig({ CI_STEREO_AGENT_CHANNEL: 'left' })), 0);
});

// ─── segment ordering across multiple files ─────────────────────────────────

test('multi-file calls order by recorded_at, not by the clock string', () => {
  // A call that crosses midnight sorts wrong on clock text alone: '11_58_00 PM'
  // vs '12_02_00 AM'. recorded_at is a real timestamp and must win.
  const before = { source_path: '/a.wav', recorded_at: '2026-08-21T03:58:00Z', filename_clock_text: '11_58_00 PM' };
  const after = { source_path: '/b.wav', recorded_at: '2026-08-21T04:02:00Z', filename_clock_text: '12_02_00 AM' };
  const ordered = orderSegments([after, before]);
  assert.deepEqual(ordered.map((r) => r.source_path), ['/a.wav', '/b.wav']);
});

test('ordering is stable for identical timestamps, so re-runs match', () => {
  const x = { source_path: '/z.wav', recorded_at: '2026-08-21T04:00:00Z' };
  const y = { source_path: '/a.wav', recorded_at: '2026-08-21T04:00:00Z' };
  assert.deepEqual(orderSegments([x, y]).map((r) => r.source_path), ['/a.wav', '/z.wav']);
  assert.deepEqual(orderSegments([y, x]).map((r) => r.source_path), ['/a.wav', '/z.wav']);
});

test('later files are rebased onto one timeline instead of restarting at zero', () => {
  const rebased = rebaseSegments([
    { source_path: '/1.wav', audio_seconds: 30, segments: [{ start: 0, end: 5, text: 'part one' }] },
    { source_path: '/2.wav', audio_seconds: 20, segments: [{ start: 0, end: 4, text: 'part two' }] },
  ]);
  assert.deepEqual(rebased.map((s) => s.start), [0, 30]);
  assert.deepEqual(rebased.map((s) => s.end), [5, 34]);
  assert.equal(rebased[1].source_path, '/2.wav');
});

// ─── low confidence heuristics ──────────────────────────────────────────────

test('sparse output is low confidence — <2 words per 10s of audio', () => {
  assert.equal(Math.round(wordsPerTenSeconds('one two three four', 60)), 1);
  const sparse = assessConfidence({ text: 'one two three four', audioSeconds: 60 });
  assert.equal(sparse.low, true);
  assert.match(sparse.reasons.join(), /sparse_output/);

  const normal = assessConfidence({ text: Array(120).fill('word').join(' '), audioSeconds: 60 });
  assert.equal(normal.low, false);
});

test('an empty transcript and an engine flag are both low confidence', () => {
  assert.equal(assessConfidence({ text: '   ', audioSeconds: 30 }).low, true);
  assert.equal(assessConfidence({ text: 'plenty of words here now', audioSeconds: 5, engineLowConfidence: true }).low, true);
});

// ─── transcribeCall end to end, with injected I/O ───────────────────────────

test('a stereo call produces labelled turns and diarization stereo_channels', async () => {
  const rec = { id: 'r1', source_path: '/x/a.wav', recorded_at: '2026-08-21T16:00:00Z', storage_path: 'p' };
  const row = await transcribeCall(CALL, [rec], {
    cfg: CFG,
    loadAudio: async () => ({ buffer: Buffer.alloc(4), channels: 2, audio_seconds: 40 }),
    transcriber: async ({ channel }) => (channel === 0
      ? { segments: [{ start: 0, end: 2, text: 'Agent speaking.' }], language: 'en' }
      : { segments: [{ start: 3, end: 5, text: 'Customer speaking.' }], language: 'en' }),
  });
  assert.equal(row.diarization_method, 'stereo_channels');
  assert.equal(row.transcript_text, 'agent: Agent speaking.\ncustomer: Customer speaking.');
  assert.equal(row.call_id, CALL.id);
  assert.equal(row.audio_seconds, 40);
});

test('a mono call is transcribed whole and does NOT claim speaker labels', async () => {
  const rec = { id: 'r1', source_path: '/x/a.wav', recorded_at: '2026-08-21T16:00:00Z' };
  const row = await transcribeCall(CALL, [rec], {
    cfg: CFG,
    loadAudio: async () => ({ buffer: Buffer.alloc(4), channels: 1, audio_seconds: 20 }),
    transcriber: async () => ({ text: 'Hello there, plenty of words in this one.', segments: [{ start: 0, end: 3, text: 'Hello there' }] }),
  });
  // Claiming stereo_channels on a mono file would tell the analyzer the
  // speaker labels are reliable when there are none.
  assert.equal(row.diarization_method, 'none');
  assert.equal(row.segments[0].speaker, null);
});

// ─── 2. validation, and review after two attempts ───────────────────────────

test('a well-formed §7 output validates', () => {
  const { valid, errors } = validateAnalysis(validAnalysis());
  assert.deepEqual(errors, []);
  assert.equal(valid, true);
});

test('an outcome outside the taxonomy is rejected, never coerced', () => {
  const { valid, errors } = validateAnalysis(validAnalysis({ outcome: 'customer_was_happy' }));
  assert.equal(valid, false);
  assert.match(errors.join(), /root\.outcome/);
});

test('extra properties are rejected — additionalProperties:false everywhere', () => {
  const bad = validAnalysis();
  bad.invented_field = 'hello';
  bad.flags.made_up_flag = true;
  const { valid, errors } = validateAnalysis(bad);
  assert.equal(valid, false);
  assert.match(errors.join(), /invented_field: unexpected property/);
  assert.match(errors.join(), /flags\.made_up_flag: unexpected property/);
});

test('confidence must be a number in 0..1, not a word and not 1.4', () => {
  assert.equal(validateAnalysis(validAnalysis({ outcome_confidence: 'high' })).valid, false);
  assert.equal(validateAnalysis(validAnalysis({ outcome_confidence: 1.4 })).valid, false);
  assert.equal(validateAnalysis(validAnalysis({ outcome_confidence: 0 })).valid, true);
});

test("a 'stated' value that is null is rejected — that is a claim with no content", () => {
  const bad = validAnalysis();
  bad.customer.name = { value: null, source: 'stated', confidence: 0.9 };
  const { valid, errors } = validateAnalysis(bad);
  assert.equal(valid, false);
  assert.match(errors.join(), /customer\.name: source 'stated' with a null value/);
});

test('a summary over 120 words is rejected — notes must not become transcripts', () => {
  const long = validAnalysis({ summary: Array(121).fill('word').join(' ') });
  assert.equal(validateAnalysis(long).valid, false);
  assert.equal(validateAnalysis(validAnalysis({ summary: Array(120).fill('word').join(' ') })).valid, true);
});

test('every outcome in the taxonomy actually validates', () => {
  for (const o of OUTCOMES) {
    assert.equal(validateAnalysis(validAnalysis({ outcome: o })).valid, true, `${o} should validate`);
  }
});

test('VALIDATION FAILURE → exactly 2 attempts, then ai_output_invalid', async () => {
  let calls = 0;
  const res = await analyzeTranscript(CALL, { transcript_text: 'hello' }, {
    cfg: CFG,
    callJson: async () => {
      calls++;
      return { json: validAnalysis({ outcome: 'nonsense_outcome' }) };
    },
  });
  assert.equal(calls, MAX_ANALYSIS_ATTEMPTS, 'must retry once, and only once');
  assert.equal(res.ok, false);
  assert.equal(res.reason, 'ai_output_invalid');
  assert.ok(res.errors.length > 0, 'the schema errors ride along for the reviewer');
});

test('a second attempt that comes back valid is accepted', async () => {
  let calls = 0;
  const res = await analyzeTranscript(CALL, { transcript_text: 'hello' }, {
    cfg: CFG,
    callJson: async () => {
      calls++;
      return { json: calls === 1 ? { garbage: true } : validAnalysis() };
    },
  });
  assert.equal(calls, 2);
  assert.equal(res.ok, true);
  assert.equal(res.row.outcome, 'appointment_confirmed');
  assert.equal(res.row.is_current, true);
});

test('an unparseable response is a review outcome, not a thrown error', async () => {
  const res = await analyzeTranscript(CALL, { transcript_text: 'hello' }, {
    cfg: CFG,
    callJson: async () => ({ text: 'I am sorry, I cannot help with that.' }),
  });
  assert.equal(res.ok, false);
  assert.equal(res.reason, 'ai_output_invalid');
});

test('a fenced JSON response is unwrapped rather than rejected', () => {
  assert.deepEqual(extractJson('```json\n{"a":1}\n```'), { a: 1 });
  assert.deepEqual(extractJson('Here you go: {"a":1} hope that helps'), { a: 1 });
  assert.equal(extractJson('no json at all'), null);
});

test('the prompt tells the model whether speaker labels can be trusted', () => {
  const stereo = buildUserMessage({ transcript_text: 't', diarization_method: 'stereo_channels' }, CALL);
  const mono = buildUserMessage({ transcript_text: 't', diarization_method: 'none' }, CALL);
  assert.match(stereo, /reliable/);
  assert.match(mono, /NOT labelled/);
  // The customer's phone number must not be handed to the model — §7 asks it
  // whether a number was SPOKEN, and priming it invites a false 'stated'.
  assert.equal(stereo.includes(CALL.ani), false);
});

// ─── the agent is TOLD, not inferred ────────────────────────────────────────
//
// THE TRAP THIS GUARDS. The audio is mono with no speaker labels, so the model
// works out roles from context and gets them wrong. Live example, call
// 300000010270792: Jamal Flanders is a Reece CALL-CENTER agent, and the
// summary called him "a field representative (Jamal)". In shadow that text sat
// in ci_summaries; with the write flags on it would have posted to both CRMs.

const AGENT_CALL = { ...CALL, agent_name: 'Jamal Flanders', team: 'reece' };
const TRANSCRIPT = { transcript_text: 't', diarization_method: 'none' };

test('the prompt names the known agent and anchors their role', () => {
  const msg = buildUserMessage(TRANSCRIPT, AGENT_CALL);
  assert.match(msg, /The agent on this call is Jamal Flanders, an internal Reece call-center agent\./);
  assert.match(msg, /Any other speaker is the customer or a third party\./);
  assert.match(msg, /Do not describe the agent as a\s+field representative, canvasser, or installer unless the transcript says so explicitly\./);
});

test('the agent line sits ABOVE direction and campaign', () => {
  // It is the one fact here we actually know. Buried among the hints it reads
  // as another thing to weigh rather than a premise to anchor on.
  const msg = buildUserMessage(TRANSCRIPT, AGENT_CALL);
  assert.ok(
    msg.indexOf('The agent on this call is') < msg.indexOf('Call direction:'),
    'identity must precede direction',
  );
  assert.ok(
    msg.indexOf('The agent on this call is') < msg.indexOf('Campaign:'),
    'identity must precede campaign',
  );
});

test('the descriptor follows the resolved team', () => {
  const line = (team) => agentContextLine({ agent_name: 'Jamal Flanders', team });
  assert.equal(line('reece'), 'The agent on this call is Jamal Flanders, an internal Reece call-center agent.');
  assert.equal(line('lightfire'), 'The agent on this call is Jamal Flanders, a LightFire Partners call-center agent.');
  assert.equal(line('north_carolina'), 'The agent on this call is Jamal Flanders, a North Carolina call-center agent.');
});

test('an unresolved team names the agent and claims NOTHING about their employer', () => {
  // Inventing a plausible employer for an agent we could not place is the same
  // class of error this change exists to stop.
  for (const team of ['unknown', 'ftm', '', null, undefined]) {
    const line = agentContextLine({ agent_name: 'Jamal Flanders', team });
    assert.equal(line, 'The agent on this call is Jamal Flanders.', `team ${JSON.stringify(team)}`);
    assert.equal(/call-center|Reece|LightFire|North Carolina/.test(line), false);
  }
});

test('no agent name means NO agent line — never the word undefined', () => {
  for (const agentName of [null, undefined, '', '   ']) {
    const msg = buildUserMessage(TRANSCRIPT, { ...CALL, agent_name: agentName });
    assert.equal(agentContextLine({ ...CALL, agent_name: agentName }), null);
    assert.equal(msg.includes('The agent on this call is'), false, `agent_name ${JSON.stringify(agentName)}`);
    // 'null' appears legitimately inside the schema skeleton JSON; 'undefined'
    // is the one that could only come from a stringified empty agent.
    assert.equal(msg.includes('undefined'), false, 'a stringified empty must never reach the prompt');
  }
  // A null call object at all is still fine.
  assert.equal(buildUserMessage(TRANSCRIPT, null).includes('The agent on this call is'), false);
  assert.equal(agentContextLine(null), null);
});

test('the customer phone number is STILL never handed to the model', () => {
  // Pre-existing guarantee — asserted here because this change adds the first
  // new identity context the prompt has carried. §7 asks whether a number was
  // SPOKEN, and priming the model invites a false 'stated'.
  for (const call of [AGENT_CALL, { ...AGENT_CALL, team: 'unknown' }, CALL]) {
    const msg = buildUserMessage(TRANSCRIPT, call);
    assert.equal(msg.includes(CALL.ani), false, 'ANI must not reach the prompt');
    assert.equal(msg.includes('7273302574'), false);
  }
});

test('system prompt rule 6 forbids inventing a role, not just naming a team', () => {
  const sys = buildSystemPrompt();
  assert.match(sys, /you are told who the agent is/);
  assert.match(sys, /Do not invent a role for any speaker\./);
});

// ─── review triggers ────────────────────────────────────────────────────────

test('§7 review triggers fire, and name themselves', () => {
  assert.deepEqual(analysisReviewFlags({ analysis: validAnalysis(), call: CALL }), []);

  assert.deepEqual(
    analysisReviewFlags({ analysis: validAnalysis({ outcome_confidence: 0.69 }), call: CALL }),
    ['low_outcome_confidence'],
  );
  // 0.70 is the floor and is ACCEPTED — an off-by-one here sends a stream of
  // perfectly good calls to review.
  assert.deepEqual(analysisReviewFlags({ analysis: validAnalysis({ outcome_confidence: 0.7 }), call: CALL }), []);

  const dnc = validAnalysis();
  dnc.flags.dnc_request = true;
  assert.ok(analysisReviewFlags({ analysis: dnc, call: CALL }).includes('dnc_request'));

  assert.ok(analysisReviewFlags({
    analysis: validAnalysis(), transcript: { low_confidence: true }, call: CALL,
  }).includes('low_confidence_transcript'));

  assert.ok(analysisReviewFlags({
    analysis: validAnalysis(), call: { ...CALL, team: 'unknown' },
  }).includes('unknown_team'));
});

// ─── 3. is_current uniqueness ───────────────────────────────────────────────

/** Minimal PostgREST-shaped fake that records the calls made against it. */
function fakeDb({ transcript = null } = {}) {
  const log = [];
  return {
    log,
    from(table) {
      const chain = {
        _eq: {},
        select() { return chain; },
        eq(col, val) { chain._eq[col] = val; return chain; },
        maybeSingle: async () => ({ data: transcript, error: null }),
        update(patch) {
          chain._update = patch;
          const p = Promise.resolve({ error: null });
          // .update().eq().eq() must still be awaitable at the end.
          const thenable = {
            eq(col, val) { chain._eq[col] = val; return thenable; },
            then: (res, rej) => {
              log.push({ table, op: 'update', patch, where: { ...chain._eq } });
              return p.then(res, rej);
            },
          };
          return thenable;
        },
        insert: async (row) => {
          log.push({ table, op: 'insert', row });
          return { error: null };
        },
      };
      return chain;
    },
  };
}

test('IS_CURRENT UNIQUENESS: a re-analysis demotes the old row BEFORE inserting', async () => {
  // ci_summaries_current_uq is UNIQUE(call_id) WHERE is_current. Insert first
  // and the second analysis of any call violates the index every time.
  const db = fakeDb();
  await insertCurrentSummary(db, CALL.id, { call_id: CALL.id, outcome: 'not_interested' });

  assert.equal(db.log.length, 2);
  assert.equal(db.log[0].op, 'update', 'the demote must come first');
  assert.deepEqual(db.log[0].patch, { is_current: false });
  assert.equal(db.log[0].where.call_id, CALL.id);
  assert.equal(db.log[0].where.is_current, true, 'only the current row is demoted');

  assert.equal(db.log[1].op, 'insert');
  assert.equal(db.log[1].row.is_current, true);
});

test('the superseded analysis is demoted, never deleted — it is the audit trail', async () => {
  const db = fakeDb();
  await insertCurrentSummary(db, CALL.id, { call_id: CALL.id });
  assert.equal(db.log.some((l) => l.op === 'delete'), false);
});

test('stageAnalyze stores a flagged summary AND sends the call to review', async () => {
  // A BLOCKING flag. dnc_request used to park here too, and that was the bug:
  // it meant the reasons that most need a rep's eyes were the only ones that
  // never produced a note. Those now advance and are queued after the write —
  // see scripts/test-ci-deferred-review.js. An unintelligible transcript is
  // still a hard stop, because there is nothing worth delivering.
  const unreadable = validAnalysis();
  unreadable.quality.transcript_intelligible = false;
  const db = fakeDb({ transcript: { call_id: CALL.id, transcript_text: '...' } });

  const r = await stageAnalyze(CALL, {
    db,
    cfg: CFG,
    callJson: async () => ({ json: unreadable }),
  });

  assert.equal(r.outcome, 'review');
  assert.equal(r.reason, 'transcript_unintelligible');
  // The summary must still be on disk — a reviewer has to read what was said.
  assert.ok(db.log.some((l) => l.table === 'ci_summaries' && l.op === 'insert'),
    'a flagged analysis is stored, not discarded');
});

test('a DNC request no longer parks at analysis — it advances to be delivered', async () => {
  const dnc = validAnalysis();
  dnc.flags.dnc_request = true;
  const db = fakeDb({ transcript: { call_id: CALL.id, transcript_text: 'take me off your list' } });

  const r = await stageAnalyze(CALL, { db, cfg: CFG, callJson: async () => ({ json: dnc }) });

  assert.equal(r.outcome, 'advanced');
  assert.equal(r.deferred_review, 'dnc_request', 'the reason rides along to sync');
  assert.ok(db.log.some((l) => l.table === 'ci_summaries' && l.op === 'insert'));
});

// ─── WAV handling, which is what makes stereo splitting possible ────────────

test('a stereo PCM file reports 2 channels and splits into two mono files', () => {
  // Two frames, 16-bit stereo: L=0x0101,R=0x0202 then L=0x0303,R=0x0404.
  const samples = Buffer.from([0x01, 0x01, 0x02, 0x02, 0x03, 0x03, 0x04, 0x04]);
  const wav = buildWav(samples, { channels: 2, sampleRate: 8000, bitsPerSample: 16 });

  assert.equal(channelCount(wav), 2);
  const info = parseWav(wav);
  assert.equal(info.ok, true);
  assert.equal(info.blockAlign, 4);

  const left = extractChannel(wav, 0);
  const right = extractChannel(wav, 1);
  assert.equal(channelCount(left), 1);
  assert.deepEqual([...parseWavData(left)], [0x01, 0x01, 0x03, 0x03]);
  assert.deepEqual([...parseWavData(right)], [0x02, 0x02, 0x04, 0x04]);
});

test('an unsupported or unparseable file yields null rather than corrupt audio', () => {
  assert.equal(extractChannel(Buffer.from('this is not a wav file at all'), 0), null);
  assert.equal(extractChannel(null, 0), null);
  // A channel index that does not exist must not read past the frame.
  const mono = buildWav(Buffer.from([0x01, 0x01]), { channels: 1, bitsPerSample: 16 });
  assert.equal(extractChannel(mono, 1), null);
  // Unparseable files are treated as mono, so the call is still transcribed.
  assert.equal(channelCount(Buffer.from('garbage')), 1);
});

test('the data chunk is located by walking, not assumed at byte 44', () => {
  // A LIST chunk between fmt and data is common; a fixed-offset reader would
  // transcribe the metadata as audio.
  const base = buildWav(Buffer.from([0x11, 0x22, 0x33, 0x44]), { channels: 1, bitsPerSample: 16 });
  const list = Buffer.alloc(8 + 4);
  list.write('LIST', 0, 'ascii');
  list.writeUInt32LE(4, 4);
  list.write('INFO', 8, 'ascii');
  const spliced = Buffer.concat([base.subarray(0, 36), list, base.subarray(36)]);
  spliced.writeUInt32LE(spliced.length - 8, 4);

  const info = parseWav(spliced);
  assert.equal(info.ok, true);
  assert.equal(info.channels, 1);
  assert.deepEqual([...spliced.subarray(info.dataStart, info.dataStart + info.dataLength)], [0x11, 0x22, 0x33, 0x44]);
});

test('duration is computed from the data length and the block rate', () => {
  // 8000 Hz, 16-bit mono => 16000 bytes per second.
  const wav = buildWav(Buffer.alloc(16000), { channels: 1, sampleRate: 8000, bitsPerSample: 16 });
  assert.equal(parseWav(wav).durationSeconds, 1);
});

test('the format tag is honoured — a compressed file is not silently split', () => {
  const compressed = buildWav(Buffer.alloc(8), { formatTag: 0x11, channels: 2, bitsPerSample: 16 });
  assert.equal(parseWav(compressed).supported, false);
  assert.equal(extractChannel(compressed, 0), null, 'refuse rather than de-interleave a codec we cannot read');
  assert.equal(parseWav(buildWav(Buffer.alloc(8), { formatTag: WAV_FORMAT_PCM })).supported, true);
});

/** Read just the sample bytes back out of a WAV we built. */
function parseWavData(wav) {
  const info = parseWav(wav);
  return wav.subarray(info.dataStart, info.dataStart + info.dataLength);
}
