/**
 * The bot gate's scoring — scripts/test-sim-scoring.js
 *
 * 2026-10-06 (AI audit, F1): a simulation run is now scored, compared with the
 * last gate run and saved (src/simulator/sim-scoring.js, run_bot_eval). These
 * tests pin what counts as a failure, what counts as "worse", that a saved run
 * carries no customer text, and that a failed save never fails the run.
 *
 * Run: node --test scripts/test-sim-scoring.js
 */

process.env.SUPABASE_URL ||= 'http://localhost:54321';
process.env.SUPABASE_SERVICE_ROLE_KEY ||= 'test-key';

import test from 'node:test';
import assert from 'node:assert/strict';

const { scoreResult, scoreRun, compareScorecards, formatScorecard } = await import('../src/simulator/sim-scoring.js');
const { startSimulationJob, getSimulationJob } = await import('../src/simulator/bot-simulator.js');
const { evalRunPayload, registerSimulatorRoutes, EVAL_RUN_EVENT } = await import('../src/tools/simulator-tools.js');

const turn = (n, customer, bot, extra = {}) => ({ turn: n, customer, bot: bot == null ? null : [bot], ...extra });
const result = (scenario, transcript, extra = {}) => ({ channel: 'livechat', scenario, title: scenario, transcript, would_do: [], ...extra });

test('a clean conversation passes', () => {
  const s = scoreResult(result('discovery', [turn(1, 'Hi there', 'What got you looking at windows?'), turn(2, 'They are drafty', 'How long has that been going on?')]));
  assert.equal(s.pass, true, JSON.stringify(s.failures));
  assert.equal(s.replies, 2);
  assert.equal(s.key, 'discovery/livechat');
});

test('every reply is held to the hard checks, and a silent turn fails', () => {
  const s = scoreResult(result('price', [turn(1, 'How much for 12 windows?', 'Most projects run about $15,000. When works for a visit?'), turn(2, 'Just give me a number', null, { outcome: 'error' })]));
  assert.equal(s.pass, false);
  assert.deepEqual(s.failures.map(f => [f.code, f.turn]), [['money_figure', 1], ['no_reply', 2]]);
  assert.equal(scoreResult({ channel: 'sms', scenario: 'price', error: 'model timeout' }).failures[0].code, 'run_error');
});

test('a booking claim stands only on the turn that booked', () => {
  const claim = [turn(1, 'Tuesday at 2 works', "You're all set for Tuesday at 2 PM. Our team will reach out to confirm the details.")];
  assert.ok(scoreResult(result('think', claim)).failures.some(f => f.code === 'unbacked_booking_claim'));
  assert.equal(scoreResult(result('think', claim, { would_do: [{ turn: 1, kind: 'would_book', start: 'x' }] })).pass, true);
});

test('a moved appointment backs "You\'re now set for" (the cancel flow\'s reschedule)', () => {
  // 2026-10-07 gate run: cancel_reschedule/livechat failed once booking-claim.js read "now set for".
  const moved = [turn(1, 'The first one', "Done. You're now set for Thu, Oct 8 at 2:00 PM ET instead. Our team will call to go over the details.")];
  assert.equal(scoreResult(result('cancel_reschedule', moved, { would_do: [{ turn: 1, kind: 'would_move_same_appointment_in_ghl', new_start: 'x' }] })).failures.filter(f => f.code === 'unbacked_booking_claim').length, 0);
  assert.ok(scoreResult(result('think', moved)).failures.some(f => f.code === 'unbacked_booking_claim'), 'no move, still a claim');
});

test('a held time is not a fake booking; a "you\'re all set" with no hold or booking still is', () => {
  // 2026-10-06 gate run: "I'm holding Tue at 6 PM for you" on a confirm move was failed three times.
  const hold = [turn(1, 'The first one', "I'm holding Tue, Oct 6 at 6:00 PM ET for you. What's your first name?", { nepq: { move: 'confirm' } })];
  assert.equal(scoreResult(result('think', hold)).pass, true, JSON.stringify(scoreResult(result('think', hold)).failures));
  const claim = [turn(1, 'The first one', "I'm holding Tue, Oct 6 at 6:00 PM ET for you.", { nepq: { move: 'probe' } })];
  assert.ok(scoreResult(result('think', claim)).failures.some(f => f.code === 'unbacked_booking_claim'), 'a hold with no hold move is still a claim');
});

test('a hand-off that promises a call passes', () => {
  const s = scoreResult(result('complaint', [turn(1, 'Your rep never showed up yesterday', "I'm sorry. I've flagged this to our team, and someone will call you tomorrow at 9 AM ET.", { nepq: { move: 'handoff', handoff: 'complaint' } })], { would_do: [{ kind: 'would_file_callback_five9_and_contact_center' }] }));
  assert.equal(s.pass, true, JSON.stringify(s.failures));
});

test('each scenario adds its own rule', () => {
  const codes = (r) => scoreResult(r).failures.map(f => f.code);
  assert.ok(codes(result('not_interested', [turn(1, 'Not interested', 'Understood.'), turn(2, 'No', 'No problem. The next step is a free in-home measurement.')])).includes('pitch_after_no'));
  assert.ok(codes(result('product', [turn(1, 'Do you do single-hung windows?', "We don't carry single-hung windows. What got you looking?")])).includes('single_hung_denied'));
  assert.ok(codes(result('complaint', [turn(1, 'Your rep never showed up yesterday', "I'm sorry about that. What happened?")])).includes('complaint_not_handed_off'));
  assert.equal(codes(result('complaint', [turn(1, 'Your rep never showed up yesterday', "I'm sorry about that. A team member will reach out.")], { would_do: [{ kind: 'would_file_callback_five9_and_contact_center' }] })).includes('complaint_not_handed_off'), false);
  assert.ok(codes(result('cancel', [turn(1, 'Cancel it', 'Done, your appointment has been cancelled.')])).includes('cancel_claimed_without_cancel'));
  assert.deepEqual(codes(result('cancel_reschedule', [turn(1, 'Yes, a different day', 'I have Tuesday at 10 AM or Wednesday at 2 PM. Which works better?')], { would_do: [{ kind: 'would_cancel_in_ghl' }] })).filter(c => c.startsWith('reschedule')), ['reschedule_cancelled_instead', 'reschedule_not_moved']);
  assert.ok(codes(result('spanish', [turn(1, 'Hola', 'Thanks for reaching out. A team member will reach out.')])).includes('spanish_reply_not_spanish'));
  assert.ok(codes(result('burst', [{ turn: 1, customer: 'a + b', bot: ['What day works?', 'And what time?'] }])).includes('burst_not_one_reply'));
  assert.ok(codes(result('details', [turn(1, 'Hi, I need new windows', 'What got you looking?'), turn(2, 'Danh', 'Thanks Danh. What is the best phone number?'), turn(3, '657-242-0815', "What's your first name?")])).includes('reasked_name'));
});

test('the cancel identity ask is the one allowed two-item ask', () => {
  const ask = [turn(1, 'I need to cancel my appointment', "I can help with that. What's the name and phone number the appointment is under?")];
  assert.equal(scoreResult(result('cancel', ask)).failures.some(f => f.code === 'more_than_one_ask'), false);
});

test('a run is worse when the pass rate falls or a passing conversation now fails', () => {
  const good = scoreRun([result('discovery', [turn(1, 'Hi', 'What got you looking?')]), result('price', [turn(1, 'How much?', 'Every home is different. What got you looking?')])]);
  const bad = scoreRun([result('discovery', [turn(1, 'Hi', 'What got you looking?')]), result('price', [turn(1, 'How much?', 'About $15,000. What got you looking?')])]);
  assert.equal(good.pass_rate, 1);
  assert.equal(bad.pass_rate, 0.5);
  const cmp = compareScorecards(bad, good);
  assert.equal(cmp.worse, true);
  assert.ok(cmp.reasons.some(r => /price\/livechat passed last run and now fails \(money_figure\)/.test(r)), cmp.reasons.join(' | '));
  assert.deepEqual(compareScorecards(good, good), { compared: true, worse: false, reasons: [] });
  assert.equal(compareScorecards(good, null).worse, null, 'no earlier run → not compared');
  assert.equal(compareScorecards(good, { ...good, invariants_version: 'old' }).compared, false, 'new checks → a new baseline, not a regression');
  assert.equal(compareScorecards({ ...good, nepq_mode: 'off' }, { ...bad, nepq_mode: 'live' }).compared, false, 'NEPQ off is never judged against NEPQ live');
  assert.match(formatScorecard(bad, cmp), /WORSE THAN LAST RUN/);
  assert.match(formatScorecard(bad, cmp), /✗ price\/livechat: money_figure@1/);
});

test('a saved run carries codes and turns, never customer text', () => {
  const card = scoreRun([result('price', [turn(1, 'How much for my house at 12 Main St?', 'About $15,000 for 12 Main St. What got you looking?')])]);
  const saved = JSON.stringify(evalRunPayload(card, null));
  assert.doesNotMatch(saved, /12 Main St|15,000/);
  assert.match(saved, /money_figure/);
});

async function waitDone(id) {
  for (let i = 0; i < 200; i++) {
    const job = getSimulationJob(id);
    if (job.status !== 'running') return job;
    await new Promise(r => setTimeout(r, 20));
  }
  throw new Error('job did not finish');
}

// A live-chat lane over fakes (scripts/test-bot-simulator.js's pattern); the
// "spanish" scenario is live-chat only, so the SMS writer is never called.
const laneDeps = () => ({
  prewarmEmbedding: () => null,
  buildKbPack: async () => null,
  classify: async () => ({ intent_class: 'UNCLEAR', confidence: 0, classification_method: 'test' }),
  callLLM: async () => ({ text: JSON.stringify({ message: 'Hola, gracias. Nuestro equipo se comunicará con usted.', story_arc: 'none' }), model: 'fake' }),
  checkServiceArea: async () => ({ checked: false }),
  lookupPlace: async () => ({ checked: false }),
  zoneForZip: async () => null,
  hardTimeoutMs: () => 3000,
  contextCapMs: () => 200,
  sendMessage: async () => { throw new Error('REAL SEND CALLED'); },
  insertAction: async () => { throw new Error('REAL INSERT CALLED'); },
});

test('a gate run is scored, compared with the last run and saved', async () => {
  const saved = [];
  const previous = { invariants_version: scoreRun([]).invariants_version, pass_rate: 1, results: [{ key: 'spanish/livechat', pass: true, failures: [] }] };
  const job = startSimulationJob({ scenario: 'spanish', channel: 'both', nepqMode: 'live', gate: true }, {
    productionDeps: async () => laneDeps(),
    generate: async () => { throw new Error('SMS should not run'); },
    evalMeta: async () => ({ prompt_version: 'v-test', git_sha: 'abc1234' }),
    lastEvalRun: async () => previous,
    recordEvalRun: async (card, cmp) => { saved.push({ card, cmp }); },
  });
  const done = await waitDone(job.id);
  assert.equal(done.status, 'done');
  assert.equal(done.scorecard.conversations, 1);
  assert.equal(done.scorecard.prompt_version, 'v-test');
  assert.equal(done.comparison.compared, true);
  assert.equal(saved.length, 1, 'a gate run is saved once');
});

test('a run that cannot read or save the last run still finishes, and says so', async () => {
  const job = startSimulationJob({ scenario: 'spanish', channel: 'both', nepqMode: 'live', gate: true }, {
    productionDeps: async () => laneDeps(),
    generate: async () => { throw new Error('SMS should not run'); },
    lastEvalRun: async () => { throw new Error('db down'); },
    recordEvalRun: async () => { throw new Error('db down'); },
  });
  const done = await waitDone(job.id);
  assert.equal(done.status, 'done');
  assert.ok(done.scorecard);
  assert.equal(done.comparison.worse, null, 'could not tell → not compared, never "not worse"');
  assert.match(done.save_error, /not saved|unreadable/);
});

test('a plain simulation is scored but never saved', async () => {
  let saves = 0;
  const job = startSimulationJob({ scenario: 'spanish', channel: 'both', nepqMode: 'live' }, {
    productionDeps: async () => laneDeps(),
    generate: async () => { throw new Error('SMS should not run'); },
    recordEvalRun: async () => { saves++; },
  });
  const done = await waitDone(job.id);
  assert.ok(done.scorecard);
  assert.equal(done.comparison, undefined);
  assert.equal(saves, 0);
});

test('POST /admin/bot-eval is closed when ADMIN_API_TOKEN is unset, and needs the token when set', async () => {
  const routes = {};
  registerSimulatorRoutes({ post: (p, h) => { routes[`POST ${p}`] = h; }, get: (p, h) => { routes[`GET ${p}`] = h; } }, { productionDeps: async () => laneDeps(), generate: async () => null });
  const res = () => ({ code: null, body: null, status(c) { this.code = c; return this; }, json(b) { this.body = b; return this; } });
  const saved = process.env.ADMIN_API_TOKEN;
  try {
    delete process.env.ADMIN_API_TOKEN;
    const r1 = res(); routes['POST /admin/bot-eval']({ headers: {}, body: {} }, r1);
    assert.equal(r1.code, 503);
    process.env.ADMIN_API_TOKEN = 'tok';
    const r2 = res(); routes['POST /admin/bot-eval']({ headers: {}, body: {} }, r2);
    assert.equal(r2.code, 401);
  } finally {
    if (saved === undefined) delete process.env.ADMIN_API_TOKEN; else process.env.ADMIN_API_TOKEN = saved;
  }
  assert.equal(EVAL_RUN_EVENT, 'agentic.bot_eval_run');
});

test('a hand-off promising a call in any words passes when the callback was filed', () => {
  // 2026-10-06 baseline run: "Let me have someone from our team call you" on a
  // price_insist hand-off was failed; promisedCallback does not read that wording.
  const t = [turn(1, 'how much?', "Every home is different. Let me have someone from our team call you to walk through it. What's your first name?", { nepq: { move: 'handoff', handoff: 'price_insist' } })];
  assert.equal(scoreResult(result('quote', t, { would_do: [{ turn: 1, kind: 'would_file_callback_five9_and_contact_center' }] })).pass, true);
  // The same words with no hand-off and nothing filed are an unasked offer.
  const offer = [turn(1, 'my windows are drafty', 'Let me have someone from our team call you to walk through it.', { nepq: { move: 'probe' } })];
  assert.ok(scoreResult(result('discovery', offer)).failures.some(f => f.code === 'unasked_call_offer'));
});
