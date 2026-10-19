/**
 * test-post-demo-lead.js — a lead past its demo already meets the job
 * requirements (the user, 2026-10-13: "If the appointment is post demo then we
 * do not need to worry about these requirements").
 *
 * Run: node --test scripts/test-post-demo-lead.js
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { isPostDemoLead } from '../src/agentic/post-demo-lead.js';
import { buildLeadFacts } from '../src/agentic/lead-facts.js';
import { checkReply } from '../src/eval/reply-invariants.js';

test('a demo disposition, a sale or a post-demo tag is post demo', () => {
  for (const d of ['Sale', 'OPPFDN', 'NoRehash', 'FDNS', 'SW', 'PM']) assert.equal(isPostDemoLead({ lp: { disposition: d } }), true, d);
  assert.equal(isPostDemoLead({ lp: { disposition: 'Set', closed_won: true } }), true);
  for (const t of ['lp-demo-completed', 'stage:post-appointment', 'rehash', 'active-f.0', 'Rehash']) assert.equal(isPostDemoLead({ tags: [t] }), true, t);
  assert.equal(isPostDemoLead({ stageTag: 'stage:post-appointment' }), true);
});

test('before the demo, or NOC, is not', () => {
  for (const d of ['Set', 'Cnf', 'CXL', 'NOC', 'Data', null]) assert.equal(isPostDemoLead({ lp: { disposition: d } }), false, String(d));
  // LP's demo_completed flag is set for NOC too, where no demo happened.
  assert.equal(isPostDemoLead({ lp: { disposition: 'NOC', demo_completed: true } }), false);
  assert.equal(isPostDemoLead({ tags: ['stage:new-lead'] }), false);
  assert.equal(isPostDemoLead({}), false);
});

test('an LP note that says renter or below minimum is not a DQ after the demo', () => {
  const rentalNote = { notes: [{ text: 'Customer rents the house', entered_by: 'Kaley' }] };
  assert.equal(buildLeadFacts({ lp: { ...rentalNote, disposition: 'Set' } }).note_dq?.signal, 'renter', 'before the demo it still is');
  assert.equal(buildLeadFacts({ lp: { ...rentalNote, disposition: 'OPPFDN' } }).note_dq, null);
  assert.equal(buildLeadFacts({ lp: { notes: [{ text: 'Customer is below our minimum.' }], disposition: 'Set' } }).note_dq?.signal, 'below_minimum');
  assert.equal(buildLeadFacts({ lp: { notes: [{ text: 'Customer is below our minimum.' }], disposition: 'OPPFDN' } }).note_dq, null);
  // Out of area still stops the bot after a demo.
  assert.equal(buildLeadFacts({ lp: { notes: [{ text: 'Out of area, we do not service it.' }], disposition: 'OPPFDN' } }).note_dq?.signal, 'out_of_area');
});

test('checkReply does not hold a post-demo reply to the lead-side job checks', () => {
  const conversation = [{ direction: 'inbound', text: 'we rent it out' }];
  const reply = 'Thanks for checking in. Is anything holding you back from moving forward?';
  assert.ok(checkReply(reply, { channel: 'sms', inbound: 'we rent it out', conversation }).violations.some(v => v.code === 'job_scope'));
  assert.ok(!checkReply(reply, { channel: 'sms', inbound: 'we rent it out', conversation, postDemoLead: true }).violations.some(v => v.code === 'job_scope'));
  // Our own false claim is still caught.
  assert.ok(checkReply('Yes, we do commercial work too.', { channel: 'sms', inbound: 'hi', conversation, postDemoLead: true }).violations.some(v => v.code === 'job_scope'));
});

// 2026-10-19 (Sam, IMWge24jxc0xO0ppy7OR): the home type and height are the rep's to answer after a demo.
test('checkReply: past the demo the lead-side property check is skipped; a scope sentence still fails', () => {
  const inbound = "I'm waiting for Chris to give me a list of high-rises that your company has done in the past.";
  const reply = "Good question, Sam. I'll have our team look into that and reach out.";
  assert.ok(checkReply(reply, { channel: 'sms', inbound }).violations.some(v => v.code === 'property_scope'));
  const post = checkReply(reply, { channel: 'sms', inbound, postDemoLead: true });
  assert.ok(!post.violations.some(v => v.code === 'property_scope'));
  assert.ok(post.skipped.includes('property_scope_lead_side'));
  assert.ok(checkReply('Sorry, we only work on buildings that are two stories or lower.', { channel: 'sms', inbound, postDemoLead: true }).violations.some(v => v.code === 'property_scope'));
});

test('a mobile-home LP note does not stop the bot after the demo (2026-10-19)', () => {
  const note = { notes: [{ text: 'Customer lives in a mobile home.' }] };
  assert.equal(buildLeadFacts({ lp: { ...note, disposition: 'Set' } }).note_dq?.signal, 'mobile_home');
  assert.equal(buildLeadFacts({ lp: { ...note, disposition: 'OPPFDN' } }).note_dq, null);
});
