/**
 * test-post-demo-owner.js — after an unsold demo the rehash team owns the
 * lead, never the sales rep (the user, 2026-10-11): "after the appointment
 * demos the sales rep does not own the lead anymore if they did not sale it.
 * It goes to the Rehash team so we should not continue to say the sales rep
 * will follow up."
 *
 * Run: node --test scripts/test-post-demo-owner.js
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { isUnsoldPostDemo, lpSold, postDemoOwnerName, replaceSalesRepFollowUp, FOLLOW_UP_TEAM } from '../src/agentic/post-demo-owner.js';
import { acknowledgmentOnlyConduct, POST_APPOINTMENT_CLOSE_FOLLOW_UP_TEAM, postDemoRehash } from '../src/prompts/response-generator/playbooks.js';
import { lpSalesRep } from '../src/prompts/response-generator/context-frame.js';

test('who owns it: unsold after the demo → the follow-up team; sold → still the rep', () => {
  assert.equal(isUnsoldPostDemo({ postAppointment: true }), true);
  assert.equal(isUnsoldPostDemo({ rehash: true }), true);
  assert.equal(isUnsoldPostDemo({ postAppointment: true, sold: true }), false);
  assert.equal(isUnsoldPostDemo({}), false, 'before the demo nothing changes');
  assert.equal(lpSold({ disposition: 'Sale' }), true);
  assert.equal(lpSold({ closed_won: true, disposition: 'OPPFDN' }), true);
  assert.equal(lpSold({ disposition: 'OPPFDN' }), false);
  assert.equal(postDemoOwnerName(null), FOLLOW_UP_TEAM);
  assert.equal(postDemoOwnerName('John'), 'John');
});

test('a reply that says the sales rep will follow up names our follow-up team', () => {
  const r = (t) => replaceSalesRepFollowUp(t, { salesRep: 'Beverly', keepName: 'John' }).text;
  assert.equal(r('Your rep will be in touch with the numbers.'), 'Our follow-up team will be in touch with the numbers.');
  assert.equal(r('Thanks Pat. Beverly will call you tomorrow.'), 'Thanks Pat. Our follow-up team will call you tomorrow.');
  assert.equal(r("I'll have Beverly call you."), "I'll have our follow-up team call you.");
  assert.equal(r('The rep is going to send the proposal over.'), 'Our follow-up team is going to send the proposal over.');
  // Not a follow-up, and never the rehash rep the line speaks as.
  assert.equal(r('Beverly did a great job at the visit.'), 'Beverly did a great job at the visit.');
  assert.equal(r('John will give you a call then.'), 'John will give you a call then.');
  // Same first name for both: the line's own rep is kept.
  assert.equal(replaceSalesRepFollowUp('John will call you Monday.', { salesRep: 'John', keepName: 'John' }).changed, false);
});

test('the prompt never hands an unsold lead back to the sales rep', () => {
  const close = POST_APPOINTMENT_CLOSE_FOLLOW_UP_TEAM.join('\n');
  assert.match(close, /our follow-up team/);
  assert.doesNotMatch(close, /their rep sending/);
  assert.match(lpSalesRep('Dorsett, Beverly', { unsoldPostDemo: true })[0], /NO LONGER owns this lead/);
  assert.match(lpSalesRep('Dorsett, Beverly')[0], /who owns this deal/, 'a sold or pre-demo lead keeps the old label');
  const ack = acknowledgmentOnlyConduct('pricing', postDemoOwnerName(null)).join('\n');
  assert.match(ack, /name the person who now owns it \(our follow-up team\)/);
  const rehash = postDemoRehash('John').join('\n');
  assert.match(rehash, /say our follow-up team will be in touch/);
  assert.doesNotMatch(rehash, /say the rep will be in touch/);
});
