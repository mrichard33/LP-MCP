/**
 * F.0 v2 post-demo interrupts — scripts/test-siro-f0-interrupts.js (2026-10-16)
 * Run: node --test scripts/test-siro-f0-interrupts.js
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { postDemoInterrupt } from '../src/siro/f0-interrupts.js';

const ok = { unsoldPostDemo: true, rehashActive: true, siroFacts: { recording_id: 'r' }, demoAgeH: 15 };

test('a clean post-demo lead with visit data generates', () => {
  assert.equal(postDemoInterrupt(ok), null);
});

test('each ending fact suppresses, terminal, in order of certainty', () => {
  assert.deepEqual(postDemoInterrupt({ ...ok, lpSold: true, newerLead: true }), { suppress: 'sold', terminal: true });
  assert.deepEqual(postDemoInterrupt({ ...ok, tags: ['Deal-Won'] }), { suppress: 'sold', terminal: true });
  assert.equal(postDemoInterrupt({ ...ok, unsoldPostDemo: false }).suppress, 'not_post_demo');
  assert.equal(postDemoInterrupt({ ...ok, rehashActive: false }).suppress, 'rehash_ended');
  assert.equal(postDemoInterrupt({ ...ok, newerLead: true }).suppress, 'newer_lead');
  assert.equal(postDemoInterrupt({ ...ok, appointmentOnFile: true }).suppress, 'booked');
  assert.equal(postDemoInterrupt({ ...ok, noteDq: true }).suppress, 'note_dq');
  assert.equal(postDemoInterrupt({ ...ok, tags: ['lp-disqualified'] }).suppress, 'disqualified');
  assert.equal(postDemoInterrupt({ ...ok, postDemoStop: true }).suppress, 'post_demo_stop');
});

test('a reply since the last touch suppresses this cycle only', () => {
  assert.deepEqual(postDemoInterrupt({ ...ok, repliedSinceLastTouch: true }), { suppress: 'lead_replied_since_last_touch', terminal: false });
});

test('no visit data inside 24h holds 2h; past 24h generates from LP notes alone', () => {
  assert.deepEqual(postDemoInterrupt({ ...ok, siroFacts: null, demoAgeH: 15 }), { hold: 2, reason: 'awaiting_siro' });
  assert.equal(postDemoInterrupt({ ...ok, siroFacts: null, demoAgeH: 30 }), null);
  assert.deepEqual(postDemoInterrupt({ ...ok, siroFacts: null, demoAgeH: 1, waitMaxH: 12, waitHoldH: 3 }), { hold: 3, reason: 'awaiting_siro' });
  // Unknown demo age: do not wait forever, generate.
  assert.equal(postDemoInterrupt({ ...ok, siroFacts: null, demoAgeH: null }), null);
});
