/**
 * F.0 v2 in the nurture orchestrator — scripts/test-siro-f0-orchestrator.js (2026-10-16)
 * Run: node --test scripts/test-siro-f0-orchestrator.js
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { fakeSupabase } from './lib/fake-supabase.js';
import { isShadowWorkflow, buildF0ApprovalCard } from '../src/nurture/nurture-orchestrator.js';
import { loadF0Context, postDemoStopFrom, repliedSince, demoAgeHours } from '../src/siro/f0-context.js';
import { postDemoInterrupt } from '../src/siro/f0-interrupts.js';
import { pickDominantObjection } from '../src/nurture/nurture-prompt-selector.js';
import { applyAutofix } from '../src/nurture/nurture-autofix.js';

const NOW = Date.parse('2026-10-16T14:00:00Z');

test('shadow per workflow: F.0 is in shadow by default; F0_V2_MODE=shadow forces it', () => {
  assert.equal(isShadowWorkflow('F.0', {}, false), true);
  assert.equal(isShadowWorkflow('S4.5', {}, false), false);
  assert.equal(isShadowWorkflow('F.0', { F0_V2_MODE: 'live', NURTURE_SHADOW_WORKFLOWS: '' }, false), false);
  assert.equal(isShadowWorkflow('F.0', { F0_V2_MODE: 'shadow', NURTURE_SHADOW_WORKFLOWS: '' }, false), true);
  assert.equal(isShadowWorkflow('S4.5', {}, true), true, 'NURTURE_SHADOW_MODE still wins');
});

test('the approval card names the prospect, never a lead id, and a 10-digit phone', () => {
  const card = buildF0ApprovalCard({
    request: { contact_id: 'c1', sequence_position: 2 },
    context: { lead: { first_name: 'Dana', phone: '+1 (352) 555-0188' }, lp: { prospect_id: '470111', lead_id: '583321' } },
    generationId: 'gen_1', output: { sms_body: 'Hi Dana, … - John', next_wait_hours: 48 }, prompt: { prompt_code: 'F.0-P2-price-V1' }, recordingId: 'rec_1',
  });
  assert.match(card, /Prospect 470111/);
  assert.match(card, /3525550188/);
  assert.doesNotMatch(card, /583321/);
  assert.match(card, /AI SMS Send Ready/);
  assert.match(card, /https:\/\/app\.siro\.ai\/analyze\/rec_1/);
});

test('the visit objection beats an old tag; no visit data picks its variant', () => {
  assert.equal(pickDominantObjection({ lead: { objection_tags: ['timing'] }, siro: { presentation: { objections: [{ type: 'price' }] } } }), 'price');
  assert.equal(pickDominantObjection({ lead: { objection_tags: ['timing'] }, siro: { presentation: { objections: [{ type: 'other' }] } } }), 'timing');
  assert.equal(pickDominantObjection({ siro: { selector_objection: 'no-visit-data' } }), 'no-visit-data');
});

test('F.0 never truncates the SMS', () => {
  const long = 'x'.repeat(250);
  assert.equal(applyAutofix({ sms_body: long }, { smsMax: null }).output.sms_body, long);
  assert.notEqual(applyAutofix({ sms_body: long }).output.sms_body, long);
});

test('sticky stop, replied since, demo age', () => {
  const conv = [
    { direction: 'outbound', text: "Totally fair. I'm here if anything changes. - John" },
    { direction: 'inbound', text: 'ok thanks', timestamp: '2026-10-15T10:00:00Z' },
  ];
  assert.equal(postDemoStopFrom({ conversation: conv }), true);
  assert.equal(postDemoStopFrom({ conversation: [...conv, { direction: 'inbound', text: 'Actually, can we talk?' }] }), false);
  assert.equal(postDemoStopFrom({ tags: ['nepq:handoff:rehash_stop'] }), true);
  assert.equal(repliedSince({ conversation: conv, lastTouchAt: '2026-10-15T09:00:00Z' }), true);
  assert.equal(repliedSince({ conversation: conv, lastTouchAt: '2026-10-15T11:00:00Z' }), false);
  assert.equal(repliedSince({ conversation: conv, lastTouchAt: null }), false);
  assert.equal(Math.round(demoAgeHours({ lp: { demo_date: '2026-10-15T22:00:00Z' }, nowMs: NOW })), 16);
});

const ROW = {
  recording_id: 'rec_1', processed: true, deleted: false, lp_lead_id: '583321', recorded_at: '2026-10-15T22:00:00Z',
  rep_name: 'Brian Kowalski', result: 'not closed', summary: [{ name: 'Need', content: 'Lanai slider sticks' }],
  moments: [{ kind: 'objection', objection_type: 'price', customer_said: 'Too expensive' }],
};
const CONTEXT = {
  lp: { lead_id: '583321', prospect_id: '470111', disposition: 'OPPFDN', demo_date: '2026-10-15T22:00:00Z', demo_completed: true },
  lead: { current_tags: ['active-f.0'], phone: '3525550188' },
  conversation_recent: [],
  lead_facts: { note_dq: null },
};

test('loadF0Context: an unsold OPPFDN lead with a recording generates, written as the rehash rep', async () => {
  const db = fakeSupabase({ rehash_stage: [], lp_leads: [{ lp_lead_id: '583321', lp_prospect_id: '470111', created_at_lp: '2026-10-01' }], agentic_messages: [] });
  const out = await loadF0Context(CONTEXT, { contact_id: 'c1', sequence_position: 1 }, {
    env: {}, nowMs: NOW, deps: { supabase: db, readSiroRows: async () => [ROW], getCustomValue: async () => 'John Manieri' },
  });
  assert.equal(out.recordingId, 'rec_1');
  assert.equal(out.vars.rehash_rep_first_name, 'John');
  assert.equal(out.vars.presentation_objections, 'price');
  assert.equal(out.vars.days_since_demo, '0');
  assert.equal(postDemoInterrupt(out.interruptInput), null);
});

test('loadF0Context: no recording 16h after the demo holds; no rep name signs Reece Team; a newer lead ends it', async () => {
  const db = fakeSupabase({ rehash_stage: [], lp_leads: [], agentic_messages: [] });
  const out = await loadF0Context(CONTEXT, { contact_id: 'c1', sequence_position: 1 }, {
    env: {}, nowMs: NOW, deps: { supabase: db, readSiroRows: async () => [], getCustomValue: async () => null, ensureRecordingForLead: async () => 'none' },
  });
  assert.equal(out.vars.rehash_rep_first_name, 'Reece Team');
  assert.deepEqual(postDemoInterrupt(out.interruptInput), { hold: 2, reason: 'awaiting_siro' });

  const db2 = fakeSupabase({ rehash_stage: [], lp_leads: [{ lp_lead_id: '590000', lp_prospect_id: '470111', created_at_lp: '2026-10-16' }], agentic_messages: [] });
  const out2 = await loadF0Context(CONTEXT, { contact_id: 'c1', sequence_position: 2 }, {
    env: {}, nowMs: NOW, deps: { supabase: db2, readSiroRows: async () => [ROW], getCustomValue: async () => null },
  });
  assert.equal(postDemoInterrupt(out2.interruptInput).suppress, 'newer_lead');
});

test('loadF0Context: a sold lead and an ended rehash stage are suppressed', async () => {
  const db = fakeSupabase({ rehash_stage: [], lp_leads: [], agentic_messages: [] });
  const sold = await loadF0Context({ ...CONTEXT, lp: { ...CONTEXT.lp, disposition: 'Sale', closed_won: true } }, { contact_id: 'c1', sequence_position: 1 }, {
    env: {}, nowMs: NOW, deps: { supabase: db, readSiroRows: async () => [ROW], getCustomValue: async () => null },
  });
  assert.equal(postDemoInterrupt(sold.interruptInput).suppress, 'sold');
  const ended = fakeSupabase({ rehash_stage: [{ ghl_contact_id: 'c1', lp_lead_id: '583321', ended_at: '2026-10-16T00:00:00Z', started_at: '2026-10-15' }], lp_leads: [], agentic_messages: [] });
  const out = await loadF0Context(CONTEXT, { contact_id: 'c1', sequence_position: 3 }, {
    env: {}, nowMs: NOW, deps: { supabase: ended, readSiroRows: async () => [ROW], getCustomValue: async () => null },
  });
  assert.equal(postDemoInterrupt(out.interruptInput).suppress, 'rehash_ended');
});
