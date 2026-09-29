/**
 * scripts/test-lead-leak-explain.js
 *
 * The per-lead "why" sentence the Lead Leaks page shows (src/lead-leak-explain.js).
 * What these guard:
 *   - a fact the pass could not read says "couldn't check" — never a guess,
 *   - the DNC line names WHERE the DNC comes from, and flags LP disagreeing,
 *   - every reason the classifier can produce gets a sentence.
 *
 * Run: node --test scripts/test-lead-leak-explain.js
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { explainUncalled } from '../src/lead-leak-explain.js';
import { REASONS } from '../src/lead-leak-classify.js';

test('in Five9 but never dialled: names the list, attempts, LP queue and history', () => {
  const why = explainUncalled('routing_or_automation_failure', {
    five9_lookup: 'present',
    five9_record: { list: 'Data - Hot - SAR less than 7', campaign: 'Data - Hot Leads less than 7', attempts: 0 },
    lp_queue: { cqd_id: 8, attempts: 0, last_result: null },
    ever_dnc: false, market: 'SAR', age_days: 12,
  });
  assert.equal(why, 'Five9 has it on list "Data - Hot - SAR less than 7" (campaign Data - Hot Leads less than 7), 0 dial attempts.'
    + ' Five9 has never dialled it. LP has it in "Data - Hot Leads <7", 0 dial attempts. No DNC history. Market SAR, 12 days old.');
});

test('in Five9 on no list', () => {
  const why = explainUncalled('not_on_dial_list', { five9_lookup: 'present', five9_record: { list: null, attempts: 0 } });
  assert.match(why, /^Five9 has the number but it is on no dialing list, 0 dial attempts\. Five9 has never dialled it\./);
});

test('never loaded into Five9, and LP is not feeding it', () => {
  const why = explainUncalled('not_in_five9', { five9_lookup: 'absent', lp_queue: 'none', ever_dnc: false, market: null, age_days: 1 });
  assert.equal(why, "Never loaded into Five9. LP has it in none of its Data call queues, so LP isn't feeding it to the dialer."
    + ' No DNC history. No LP market, 1 day old.');
});

test('facts that could not be read say so, never guess', () => {
  const why = explainUncalled('not_in_five9', { lp_queue: null, ever_dnc: null });
  assert.match(why, /Couldn't check LP's call queues\./);
  assert.doesNotMatch(why, /DNC history/);
  assert.match(explainUncalled('not_in_five9', { lp_queue: 'unknown' }), /too long to read fully/);
  assert.match(explainUncalled('routing_or_automation_failure', { five9_lookup: 'error' }), /Couldn't check Five9 today/);
});

test('DNC names its source and flags LP disagreeing', () => {
  assert.equal(explainUncalled('dnc', { dnc_source: 'five9_list', disposition: 'Data', ever_dnc: false }),
    'Not called because the phone is on the Five9 do-not-call list. LP still codes it Data.');
  assert.equal(explainUncalled('dnc', { dnc_source: 'lp_code', disposition: 'DNC' }), 'Not called because LP codes it DNC.');
  assert.match(explainUncalled('dnc', { dnc_source: 'five9_list', disposition: 'Data', ever_dnc: true }), /marked DNC before/);
  assert.match(explainUncalled('dnc', {}), /on a do-not-call list/);
});

test('every classifier reason has a sentence', () => {
  for (const r of [...REASONS, 'called_no_retry']) {
    assert.ok(explainUncalled(r, {}).length > 0, r);
  }
  assert.equal(explainUncalled('something_new', {}), '', 'an unknown reason says nothing rather than something wrong');
});
