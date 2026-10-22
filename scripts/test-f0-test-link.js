/**
 * F.0 test link — scripts/test-f0-test-link.js (the user, 2026-10-21)
 *
 * A contact tagged aios-test and listed in F0_TEST_LINKS reads a real lead's
 * Siro visit (read-only) and is treated as an unsold post-demo lead in rehash,
 * so F.0 v2 can be tested end to end on Mark Test. Nothing is ever written to
 * the real lead.
 * Run: node --test scripts/test-f0-test-link.js
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { fakeSupabase } from './lib/fake-supabase.js';
import { parseTestLinks, testLinkFor, testLinkedContactIds, TEST_LINK_TAG } from '../src/siro/f0-test-link.js';
import { loadF0Context } from '../src/siro/f0-context.js';
import { siroForContext } from '../src/siro/context-read.js';
import { postDemoInterrupt } from '../src/siro/f0-interrupts.js';
import { emailGate } from '../src/siro/f0-email.js';
import { isShadowTurn, buildF0ApprovalCard, f0RowMeta } from '../src/nurture/nurture-orchestrator.js';

const NOW = Date.parse('2026-10-22T14:00:00Z');
const TEST = 'hZOcPk6XmMvWVvjZJ7mz';
const REAL_LEAD = '583780';
const LINKS = `${TEST}:${REAL_LEAD}`;

const VISIT = {
  recording_id: 'rec_real', processed: true, deleted: false, context_ready: true, lp_lead_id: REAL_LEAD, lp_prospect_id: '470555',
  ghl_contact_id: 'realContactAbCdEfGh12', recorded_at: '2026-10-14T22:00:00Z', rep_name: 'Brian Kowalski', result: 'not closed',
  summary: [{ name: 'Need & Motivation', content: 'They want the lanai slider replaced before storm season.' }],
  moments: [{ kind: 'objection', objection_type: 'decision_maker', customer_said: 'My wife needs to see it first' }],
};

// Mark Test: its own LP lead is 'Data' (583364), so it is past no demo of its own.
const CONTEXT = {
  lp: { lead_id: '583364', prospect_id: '470999', disposition: 'Data' },
  lead: { first_name: 'Mark', current_tags: ['aios-test'], phone: '3525550100' },
  conversation_recent: [],
  lead_facts: { note_dq: 'not something we can run' },
};

function deps(db, reads, extra = {}) {
  return {
    supabase: db,
    readSiroRows: async (args) => { reads.push(args); return [VISIT]; },
    ensureRecordingForLead: async () => { throw new Error('ensure must not run for a linked contact'); },
    getCustomValue: async () => 'John Manieri',
    getContact: async () => null,
    ...extra,
  };
}

test('the link: listed AND tagged aios-test, or nothing; never throws', () => {
  const env = { F0_TEST_LINKS: `${LINKS}, bad, :1, x:2, ${'a'.repeat(20)}:notdigits` };
  assert.deepEqual([...parseTestLinks(env.F0_TEST_LINKS)], [[TEST, REAL_LEAD]]);
  assert.deepEqual(testLinkFor(TEST, [TEST_LINK_TAG], env), { lpLeadId: REAL_LEAD });
  assert.deepEqual(testLinkFor(TEST, ['AIOS-TEST '], env), { lpLeadId: REAL_LEAD });
  assert.equal(testLinkFor(TEST, ['rehash'], env), null, 'no tag, no link');
  assert.equal(testLinkFor('otherContact12345678', [TEST_LINK_TAG], env), null, 'not listed, no link');
  assert.equal(testLinkFor(TEST, [TEST_LINK_TAG], {}), null, 'empty = off');
  assert.equal(testLinkFor(TEST, null, { F0_TEST_LINKS: { toString() { throw new Error('x'); } } }), null);
  assert.deepEqual([...testLinkedContactIds(env)], [TEST]);
});

test('a linked text reads the real visit, clears the interrupts, and keeps the test contact\'s name', async () => {
  const db = fakeSupabase({ agentic_messages: [] });
  const reads = [];
  const out = await loadF0Context(CONTEXT, { contact_id: TEST, workflow_code: 'F.0', channel: 'sms', sequence_position: 1 }, {
    env: { F0_TEST_LINKS: LINKS, F0_FORMULA_MODE: 'four_step' }, nowMs: NOW, deps: deps(db, reads),
  });
  assert.deepEqual(out.testLink, { lpLeadId: REAL_LEAD });
  assert.deepEqual(reads.map(r => [r.contactId, r.leadIds, r.prospectId]), [[null, [REAL_LEAD], null]]);
  assert.equal(out.recordingId, 'rec_real');
  const i = out.interruptInput;
  assert.equal(i.unsoldPostDemo, true);
  assert.equal(i.rehashActive, true);
  assert.equal(i.newerLead, false);
  assert.equal(i.appointmentOnFile, false);
  assert.equal(i.noteDq, false, 'the test contact\'s own note is not the real lead\'s');
  assert.equal(i.lpSold, false);
  assert.equal(i.demoAgeH, 2);
  assert.equal(postDemoInterrupt(i), null, 'generate');
  assert.equal(out.vars.first_name, 'Mark');
  assert.match(out.vars.visit_facts, /Mark/);
});

test('a linked email never waits for Siro and never reads no_recording while the visit is on file', async () => {
  const db = fakeSupabase({ agentic_messages: [] });
  const reads = [];
  const out = await loadF0Context(CONTEXT, { contact_id: TEST, workflow_code: 'F.0', channel: 'email', sequence_position: 0 }, {
    env: { F0_TEST_LINKS: LINKS }, nowMs: NOW, deps: deps(db, reads),
  });
  const pd = postDemoInterrupt(out.interruptInput);
  assert.equal(pd, null);
  assert.equal(emailGate({ pd, facts: out.facts }), null, 'generate');
  assert.ok(out.interruptInput.waitMaxH > 2, 'the cap is the day after a demo two hours ago');
  assert.equal(out.vars.first_name, 'Mark');
});

test('sold only by the test contact\'s own tag', async () => {
  const db = fakeSupabase({ agentic_messages: [] });
  const out = await loadF0Context({ ...CONTEXT, lead: { ...CONTEXT.lead, current_tags: ['aios-test', 'deal-won'] } },
    { contact_id: TEST, workflow_code: 'F.0', channel: 'sms', sequence_position: 1 },
    { env: { F0_TEST_LINKS: LINKS }, nowMs: NOW, deps: deps(db, []) });
  assert.equal(postDemoInterrupt(out.interruptInput).suppress, 'sold');
});

test('guard: nothing is written, and nothing of the real lead is read but its visit', async () => {
  const db = fakeSupabase({ agentic_messages: [], rehash_stage: [], lp_leads: [] });
  const reads = [];
  await loadF0Context(CONTEXT, { contact_id: TEST, workflow_code: 'F.0', channel: 'email', sequence_position: 0 }, {
    env: { F0_TEST_LINKS: LINKS }, nowMs: NOW, deps: deps(db, reads),
  });
  assert.deepEqual(db.calls.filter(c => c.op !== 'select'), [], 'no write of any kind');
  assert.deepEqual(db.calls.map(c => c.table), ['agentic_messages'], 'only the test contact\'s own F.0 rows');
  assert.ok(reads.every(r => r.contactId === null && r.prospectId === null), 'the visit is read by lead id only');
  assert.doesNotMatch(JSON.stringify(db.calls), /realContactAbCdEfGh12/);
});

test('not linked (no tag): the contact\'s own lead, exactly as before', async () => {
  const db = fakeSupabase({ agentic_messages: [], rehash_stage: [], lp_leads: [] });
  const reads = [];
  const out = await loadF0Context({ ...CONTEXT, lead: { ...CONTEXT.lead, current_tags: [] } },
    { contact_id: TEST, workflow_code: 'F.0', channel: 'sms', sequence_position: 1 },
    { env: { F0_TEST_LINKS: LINKS }, nowMs: NOW, deps: deps(db, reads, { readSiroRows: async (a) => { reads.push(a); return []; } }) });
  assert.equal(out.testLink, null);
  assert.deepEqual(reads[0].leadIds, ['583364']);
  assert.equal(postDemoInterrupt(out.interruptInput).suppress, 'not_post_demo');
});

test('the reply path reads the linked visit too (live), and never ensures one', async () => {
  const reads = [];
  const res = await siroForContext({ contactId: TEST, lp: CONTEXT.lp, lead: CONTEXT.lead }, {
    env: { SIRO_CONTEXT_MODE: 'live', F0_TEST_LINKS: LINKS },
    deps: { readSiroRows: async (a) => { reads.push(a); return [VISIT]; }, ensureRecordingForLead: async () => { throw new Error('no ensure'); } },
  });
  assert.equal(res.applied, true);
  assert.equal(res.facts.recording_id, 'rec_real');
  assert.deepEqual(reads[0].leadIds, [REAL_LEAD]);
  const off = await siroForContext({ contactId: TEST, lp: CONTEXT.lp, lead: { ...CONTEXT.lead, current_tags: [] } }, {
    env: { SIRO_CONTEXT_MODE: 'live', F0_TEST_LINKS: LINKS }, deps: { readSiroRows: async () => [VISIT] },
  });
  assert.equal(off.applied, false, 'untagged: a Data lead needs no visit');
});

test('shadow override: a linked contact is live for F.0 whatever the F.0 shadow settings', () => {
  const link = { lpLeadId: REAL_LEAD };
  const shadowEnv = { F0_V2_MODE: 'shadow', NURTURE_SHADOW_WORKFLOWS: 'F.0', F0_EMAIL_MODE: 'shadow' };
  assert.equal(isShadowTurn({ workflowCode: 'F.0', isF0Email: false, testLink: link }, shadowEnv, false), false);
  assert.equal(isShadowTurn({ workflowCode: 'F.0', isF0Email: true, testLink: link }, shadowEnv, false), false);
  assert.equal(isShadowTurn({ workflowCode: 'F.0', isF0Email: true, testLink: link }, shadowEnv, true), true, 'global NURTURE_SHADOW_MODE still holds it');
  assert.equal(isShadowTurn({ workflowCode: 'F.0', isF0Email: false, testLink: null }, shadowEnv, false), true, 'only for linked');
  assert.equal(isShadowTurn({ workflowCode: 'F.0', isF0Email: true, testLink: null }, shadowEnv, false), true);
  assert.equal(isShadowTurn({ workflowCode: 'S4.5', testLink: link }, { NURTURE_SHADOW_WORKFLOWS: 'S4.5' }, false), true, 'F.0 only');
});

test('a test contact\'s card says TEST, and its rows carry the link', () => {
  const card = buildF0ApprovalCard({
    request: { contact_id: TEST, workflow_code: 'F.0', channel: 'sms', sequence_position: 1, ghl_position: 2 },
    context: { lead: { first_name: 'Mark' }, lp: { prospect_id: '470999' } }, generationId: 'gen_1',
    output: { sms_body: 'Hi Mark' }, prompt: { prompt_code: 'x' }, recordingId: 'rec_real', testLink: { lpLeadId: REAL_LEAD },
  });
  assert.match(card, /^TEST — ✅ F\.0 POST-DEMO TEXT READY/);
  assert.match(card, /Prospect 470999/, 'the test contact\'s own prospect');
  assert.doesNotMatch(card, /470555|583780/, 'never the real lead or its prospect');
  assert.deepEqual(f0RowMeta({ workflow_code: 'F.0', sequence_position: 1 }, { lpLeadId: REAL_LEAD }).test_link, { lp_lead_id: REAL_LEAD });
});
