/**
 * Sim jobs survive deploys — scripts/test-sim-job-persist.js
 *
 * 2026-10-23: simulate_bot_conversation / run_bot_eval jobs lived in memory
 * and a deploy killed a 20-30 minute gate run. Every finished conversation is
 * now saved in sim_jobs and a new instance resumes a job whose heartbeat
 * stopped (src/simulator/sim-job-store.js, bot-simulator.js). These tests pin:
 * a resume skips finished conversations, the claim is atomic, a stale
 * heartbeat is the only way in, the resume cap, SIM_JOB_PERSIST_MODE=off is
 * the old behaviour, and a resumed gate scores exactly like an uninterrupted one.
 *
 * Run: node --test scripts/test-sim-job-persist.js
 */

process.env.SUPABASE_URL ||= 'http://localhost:54321';
process.env.SUPABASE_SERVICE_ROLE_KEY ||= 'test-key';

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const {
  startSimulationJob, getSimulationJob, findSimulationJob, resumeStaleJobs, jobUnits, assembleRuns, listActiveSimJobs,
  __resetSimJobsForTests, __setSimJobsStoppingForTests,
} = await import('../src/simulator/bot-simulator.js');
const { createMemorySimJobStore, isStale, resumeVerdict, resultKey, pendingUnits, persistableResult, versionSummary, simJobPersistMode, MAX_RESUMES } = await import('../src/simulator/sim-job-store.js');
const { scoreRun, combineRuns } = await import('../src/simulator/sim-scoring.js');

// A live-chat lane over fakes (test-sim-scoring.js's pattern): "spanish" is
// live-chat only, so the SMS writer never runs. Nothing real is sent or written.
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

function makeDeps(store, { onConversation = null, saved = [], exists = false } = {}) {
  const calls = { conversations: 0, recordEvalRun: 0, evalRunExists: 0 };
  const deps = {
    jobStore: store,
    productionDeps: async () => { calls.conversations++; onConversation?.(calls.conversations); return laneDeps(); },
    generate: async () => { throw new Error('SMS should not run'); },
    evalMeta: async () => ({ prompt_version: 'v-test', git_sha: process.env.TEST_GIT_SHA || 'abc1234' }),
    lastEvalRun: async () => null,
    recordEvalRun: async (card) => { calls.recordEvalRun++; saved.push(card); },
    evalRunExists: async () => { calls.evalRunExists++; return exists; },
  };
  return { deps, calls };
}

const GATE = { scenario: 'spanish', channel: 'both', nepqMode: 'live', gate: true, runs: 3 };

async function waitFor(id, statuses = ['done', 'failed']) {
  for (let i = 0; i < 1500; i++) {
    const job = getSimulationJob(id);
    if (job && statuses.includes(job.status)) return job;
    await new Promise(r => setTimeout(r, 20));
  }
  throw new Error(`job ${id} did not reach ${statuses.join('/')}`);
}

// A clock the memory store reads, so a heartbeat can be made stale.
let offset = 0;
const clock = () => Date.now() + offset;
const strip = ({ job_id, resume_count, resumed_across_versions, versions, ...card }) => card;

test.beforeEach(() => { __resetSimJobsForTests(); offset = 0; delete process.env.SIM_JOB_PERSIST_MODE; process.env.RAILWAY_DEPLOYMENT_ID = 'dep-A'; delete process.env.TEST_GIT_SHA; });

test('keys, units and plan order: run#/scenario/channel, as the in-memory job runs them', () => {
  assert.equal(resultKey(2, 'spanish', 'livechat'), '2/spanish/livechat');
  assert.deepEqual(jobUnits(GATE).map(u => u.key), ['1/spanish/livechat', '2/spanish/livechat', '3/spanish/livechat']);
  // A scenario on both channels gets one unit per channel; a channel filter keeps one.
  assert.deepEqual(jobUnits({ scenario: 'price' }).map(u => u.key), ['1/price/livechat', '1/price/sms']);
  assert.deepEqual(jobUnits({ scenario: 'price', channel: 'sms' }).map(u => u.key), ['1/price/sms']);
  assert.deepEqual(jobUnits({ scenario: 'spanish', channel: 'sms' }), [], 'a channel the scenario does not run on is no unit');
  // Messages of your own are the "custom" plan.
  assert.deepEqual(jobUnits({ scenario: null, turns: ['hi'], channel: 'livechat' }).map(u => u.key), ['1/custom/livechat']);
  // The gate's "all" covers every scenario twice by default.
  const all = jobUnits({ scenario: 'all', gate: true });
  assert.equal(new Set(all.map(u => u.key)).size, all.length, 'every key is unique');
  assert.equal(all.filter(u => u.run === 2).length, all.filter(u => u.run === 1).length);
  assert.deepEqual(pendingUnits(jobUnits(GATE), { '1/spanish/livechat': [] }).map(u => u.key), ['2/spanish/livechat', '3/spanish/livechat']);
});

test('stale-heartbeat detection and the resume cap', () => {
  const now = Date.parse('2026-10-23T12:00:00Z');
  assert.equal(isStale('2026-10-23T11:59:30Z', now), false, '30 s old is alive');
  assert.equal(isStale('2026-10-23T11:59:00Z', now), true, '60 s old is stale');
  assert.equal(isStale(null, now), true);
  assert.equal(resumeVerdict({ resume_count: MAX_RESUMES - 1, created_at: '2026-10-23T11:30:00Z' }, now).resume, true);
  assert.equal(resumeVerdict({ resume_count: MAX_RESUMES, created_at: '2026-10-23T11:30:00Z' }, now).resume, false, 'three resumes spent → error');
  assert.match(resumeVerdict({ resume_count: 0, created_at: '2026-10-23T09:00:00Z' }, now).reason, /older than 2 hours/);
});

test('the claim is atomic: two claimers, one wins; a live heartbeat is never claimed', async () => {
  const store = createMemorySimJobStore({ now: clock });
  await store.insert({ id: 'sim_x', kind: 'gate', status: 'running', request: GATE, owner_deployment_id: 'dep-old' });
  assert.equal(await store.claimStale('dep-B'), null, 'heartbeat is fresh: not claimable');
  offset = 60_000;
  const [a, b] = await Promise.all([store.claimStale('dep-B'), store.claimStale('dep-C')]);
  assert.equal([a, b].filter(Boolean).length, 1, 'exactly one claimer wins');
  assert.equal((await store.get('sim_x')).owner_deployment_id, (a || b).owner_deployment_id);
  // The loser cannot write to it.
  const loser = a ? 'dep-C' : 'dep-B';
  assert.equal(await store.record('sim_x', loser, '1/spanish/livechat', []), false);
  // The SQL claim locks the row and re-checks it (sim_job_claim).
  const sql = readFileSync(new URL('../supabase/migrations/20261023180000_sim_jobs.sql', import.meta.url), 'utf8');
  assert.match(sql, /for update skip locked/i);
  assert.match(sql, /owner_deployment_id = p_owner and status = 'running'/);
});

test('a persisted job saves every conversation and finishes as before', async () => {
  const store = createMemorySimJobStore({ now: clock });
  const { deps, calls } = makeDeps(store);
  const job = startSimulationJob(GATE, deps);
  const done = await waitFor(job.id);
  assert.equal(done.status, 'done');
  assert.equal(calls.conversations, 3);
  const row = await store.get(job.id);
  assert.equal(row.status, 'done');
  assert.equal(row.kind, 'gate');
  assert.deepEqual(Object.keys(row.completed).sort(), ['1/spanish/livechat', '2/spanish/livechat', '3/spanish/livechat']);
  assert.equal(row.done_units, 3);
  assert.equal(row.total_units, 3);
  assert.equal(row.scorecard.job_id, job.id);
  assert.equal(calls.recordEvalRun, 1, 'the gate event is saved once');
  assert.equal(done.scorecard.runs, 3);
});

test('SIGTERM: the conversation in flight finishes, the job is left interrupted, and a new instance resumes only the rest', async () => {
  const store = createMemorySimJobStore({ now: clock });
  // As the shutdown's start hook would, during the first conversation.
  const first = makeDeps(store, { onConversation: (n) => { if (n === 1) __setSimJobsStoppingForTests(true); } });
  const job = startSimulationJob(GATE, first.deps);
  await waitFor(job.id, ['interrupted']);
  let row = await store.get(job.id);
  assert.equal(row.status, 'interrupted');
  assert.deepEqual(Object.keys(row.completed), ['1/spanish/livechat'], 'the conversation in flight was saved');
  assert.equal(first.calls.recordEvalRun, 0);

  // The new deployment: the old heartbeat goes stale, the resumer claims it.
  __resetSimJobsForTests();
  process.env.RAILWAY_DEPLOYMENT_ID = 'dep-B';
  assert.deepEqual(await resumeStaleJobs(makeDeps(store).deps), [], 'not before the heartbeat is stale');
  offset = 60_000;
  const second = makeDeps(store);
  const out = await resumeStaleJobs(second.deps);
  assert.deepEqual(out.map(o => [o.id, o.resumed, o.resume_count, o.skipped, o.pending]), [[job.id, true, 1, 1, 2]]);
  const done = await waitFor(job.id);
  assert.equal(done.status, 'done');
  assert.equal(second.calls.conversations, 2, 'the finished conversation was not re-run');
  row = await store.get(job.id);
  assert.equal(row.status, 'done');
  assert.equal(row.resume_count, 1);
  assert.equal(row.owner_deployment_id, 'dep-B');
  assert.equal(second.calls.recordEvalRun, 1, 'one gate event across the deploy');
  assert.equal(done.scorecard.resume_count, 1);
  assert.equal(done.scorecard.resumed_across_versions, undefined, 'same build: not flagged');
});

test('a resume past the cap, or too old, is marked error and never run', async () => {
  const store = createMemorySimJobStore({ now: clock });
  await store.insert({ id: 'sim_cap', kind: 'gate', status: 'interrupted', request: GATE, owner_deployment_id: 'dep-old', resume_count: MAX_RESUMES, created_at: new Date().toISOString() });
  await store.insert({ id: 'sim_old', kind: 'gate', status: 'running', request: GATE, owner_deployment_id: 'dep-old', resume_count: 0, created_at: new Date(Date.now() - 3 * 3600_000).toISOString() });
  offset = 60_000;
  const { deps, calls } = makeDeps(store);
  const out = await resumeStaleJobs(deps);
  assert.deepEqual(out.map(o => o.resumed), [false, false]);
  assert.equal(calls.conversations, 0);
  assert.equal((await store.get('sim_cap')).status, 'error');
  assert.match((await store.get('sim_cap')).error, /resume limit/);
  assert.match((await store.get('sim_old')).error, /older than 2 hours/);
});

test('the combined scorecard of a resumed gate equals an uninterrupted run on the same results', async () => {
  const store = createMemorySimJobStore({ now: clock });
  const a = startSimulationJob(GATE, makeDeps(store).deps);
  const doneA = await waitFor(a.id);
  const rowA = await store.get(a.id);
  // The same results, two of them "from before the deploy".
  await store.insert({ id: 'sim_b', kind: 'gate', status: 'interrupted', request: GATE, owner_deployment_id: 'dep-old', total_units: 3,
    versions: [{ deployment: 'dep-old', git_sha: 'abc1234', prompt_version: 'v-test' }],
    completed: { '1/spanish/livechat': rowA.completed['1/spanish/livechat'], '3/spanish/livechat': rowA.completed['3/spanish/livechat'] } });
  offset = 60_000;
  process.env.RAILWAY_DEPLOYMENT_ID = 'dep-B';
  process.env.TEST_GIT_SHA = 'def5678';
  const b = makeDeps(store);
  await resumeStaleJobs(b.deps);
  const doneB = await waitFor('sim_b');
  assert.equal(b.calls.conversations, 1, 'only run 2 ran');
  assert.deepEqual(strip(doneB.scorecard).results.map(r => [r.key, r.pass]), strip(doneA.scorecard).results.map(r => [r.key, r.pass]));
  assert.equal(doneB.scorecard.passed, doneA.scorecard.passed);
  assert.equal(doneB.scorecard.pass_rate, doneA.scorecard.pass_rate);
  // Pure: the results assemble in plan order whatever order they finished in.
  const units = jobUnits(GATE);
  const shuffled = Object.fromEntries(Object.entries(rowA.completed).reverse());
  const cards = (c) => combineRuns(assembleRuns(units, c, 3).map(r => scoreRun(r, { prompt_version: 'v' })));
  assert.deepEqual(cards(shuffled), cards(rowA.completed));
  // A build change mid-run (abc1234 → def5678) is said on the scorecard.
  const vs = versionSummary([{ git_sha: 'abc1234', prompt_version: 'v-test' }, { git_sha: 'def5678', prompt_version: 'v-test' }]);
  assert.equal(vs.resumed_across_versions, true);
  assert.equal(doneB.scorecard.resumed_across_versions, true);
  assert.deepEqual(doneB.scorecard.versions.map(v => v.git_sha), ['abc1234', 'def5678']);
});

test('a resumed gate whose event was already saved does not save it twice', async () => {
  const store = createMemorySimJobStore({ now: clock });
  const a = startSimulationJob(GATE, makeDeps(store).deps);
  await waitFor(a.id);
  const rowA = await store.get(a.id);
  // Its done write was lost: the row is still running, every conversation saved.
  await store.insert({ id: 'sim_c', kind: 'gate', status: 'running', request: GATE, owner_deployment_id: 'dep-old', total_units: 3, completed: rowA.completed });
  offset = 60_000;
  const c = makeDeps(store, { exists: true });
  await resumeStaleJobs(c.deps);
  const done = await waitFor('sim_c');
  assert.equal(c.calls.conversations, 0);
  assert.equal(c.calls.evalRunExists, 1);
  assert.equal(c.calls.recordEvalRun, 0);
  assert.equal(done.eval_run, 'already saved');
});

test('get_bot_simulation reads a job from its row after a deploy', async () => {
  const store = createMemorySimJobStore({ now: clock });
  const a = startSimulationJob(GATE, makeDeps(store).deps);
  await waitFor(a.id);
  __resetSimJobsForTests(); // the new instance's memory is empty
  const job = await findSimulationJob(a.id, { jobStore: store });
  assert.equal(job.status, 'done');
  assert.equal(job.results.length, 1, 'run 1 transcripts');
  assert.ok(job.scorecard);
  assert.equal(await findSimulationJob('sim_nope', { jobStore: store }), null);
});

test('the deploy warning lists running jobs with their progress', async () => {
  const store = createMemorySimJobStore({ now: clock });
  await store.insert({ id: 'sim_r', kind: 'gate', status: 'running', request: GATE, owner_deployment_id: 'dep-A', total_units: 4, done_units: 1 });
  const list = await listActiveSimJobs({ jobStore: store });
  assert.deepEqual(list.map(j => [j.id, j.kind, j.pct, j.persisted]), [['sim_r', 'gate', 25, true]]);
});

test('a run on a real contact stores the id, never the contact\'s details', () => {
  const [r] = persistableResult([{ contact_id: 'AbCdEf1234567890', would_do: [{ kind: 'would_book', start: 'x', address: '1 Real St', contact_name: 'Real Person' }] }]);
  assert.deepEqual(r.would_do, [{ kind: 'would_book', start: 'x' }]);
  const [sim] = persistableResult([{ contact_id: null, would_do: [{ kind: 'would_book', address: '1200 Palm Ave' }] }]);
  assert.equal(sim.would_do[0].address, '1200 Palm Ave', 'a simulated persona keeps its fields');
});

test('SIM_JOB_PERSIST_MODE=off is the in-memory job exactly as before', async () => {
  process.env.SIM_JOB_PERSIST_MODE = 'off';
  assert.equal(simJobPersistMode(), 'off');
  const store = createMemorySimJobStore({ now: clock });
  const { deps, calls } = makeDeps(store);
  const job = startSimulationJob(GATE, deps);
  const done = await waitFor(job.id);
  assert.equal(done.status, 'done');
  assert.equal(store.rows.size, 0, 'nothing is written');
  assert.equal(done.persisted, undefined);
  assert.equal(done.scorecard.job_id, undefined);
  assert.equal(calls.recordEvalRun, 1);
  assert.equal(calls.evalRunExists, 0);
  assert.deepEqual(await resumeStaleJobs(deps), []);
  assert.equal(await findSimulationJob('sim_nope', deps), null);
  delete process.env.SIM_JOB_PERSIST_MODE;
  assert.equal(simJobPersistMode(), 'live', 'unset = live');
});

test('a store that cannot be reached never fails the run', async () => {
  const broken = createMemorySimJobStore({ now: clock });
  broken.insert = async () => { throw new Error('db down'); };
  const { deps } = makeDeps(broken);
  const job = startSimulationJob(GATE, deps);
  const done = await waitFor(job.id);
  assert.equal(done.status, 'done');
  assert.match(done.persist_error, /lost on a deploy/);
});
