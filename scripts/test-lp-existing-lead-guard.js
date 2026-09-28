import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  decideExistingLeadAction, existingLeadGuardMode, existingLeadWindowDays,
  flattenLpLeads, pickNewestLead,
} from '../src/services/lp-existing-lead-guard.js';

const NOW = new Date('2026-09-28T16:00:00Z');
const daysAgo = (d) => new Date(NOW.getTime() - d * 86400000).toISOString();

test('not yet cached = brand new → reuse', () => {
  assert.equal(decideExistingLeadAction({ createdAtLp: null, now: NOW }), 'reuse');
});
test('unparseable date → reuse (fail toward no duplicate)', () => {
  assert.equal(decideExistingLeadAction({ createdAtLp: 'garbage', now: NOW }), 'reuse');
});
test('vendor lead 34 seconds old → reuse (XUMXkt7OvL6IDCMWUKow case)', () => {
  assert.equal(decideExistingLeadAction({ createdAtLp: new Date(NOW.getTime() - 34000).toISOString(), now: NOW }), 'reuse');
});
test('exactly 15 days → reuse', () => {
  assert.equal(decideExistingLeadAction({ createdAtLp: daysAgo(15), now: NOW, windowDays: 15 }), 'reuse');
});
test('16 days → create', () => {
  assert.equal(decideExistingLeadAction({ createdAtLp: daysAgo(16), now: NOW, windowDays: 15 }), 'create');
});
test('default window is 15 days', () => {
  assert.equal(decideExistingLeadAction({ createdAtLp: daysAgo(16), now: NOW }), 'create');
  assert.equal(decideExistingLeadAction({ createdAtLp: daysAgo(14), now: NOW }), 'reuse');
});
test('mode defaults to shadow, accepts live/off, rejects junk', () => {
  delete process.env.LP_CREATE_EXISTING_LEAD_GUARD_MODE;
  assert.equal(existingLeadGuardMode(), 'shadow');
  process.env.LP_CREATE_EXISTING_LEAD_GUARD_MODE = 'LIVE';
  assert.equal(existingLeadGuardMode(), 'live');
  process.env.LP_CREATE_EXISTING_LEAD_GUARD_MODE = 'off';
  assert.equal(existingLeadGuardMode(), 'off');
  process.env.LP_CREATE_EXISTING_LEAD_GUARD_MODE = 'bogus';
  assert.equal(existingLeadGuardMode(), 'shadow');
  delete process.env.LP_CREATE_EXISTING_LEAD_GUARD_MODE;
});
test('window env defaults to 15 and ignores junk', () => {
  delete process.env.LP_CREATE_EXISTING_LEAD_WINDOW_DAYS;
  assert.equal(existingLeadWindowDays(), 15);
  process.env.LP_CREATE_EXISTING_LEAD_WINDOW_DAYS = '-5';
  assert.equal(existingLeadWindowDays(), 15);
  process.env.LP_CREATE_EXISTING_LEAD_WINDOW_DAYS = '30';
  assert.equal(existingLeadWindowDays(), 30);
  delete process.env.LP_CREATE_EXISTING_LEAD_WINDOW_DAYS;
});

// Shapes below are trimmed from live LP GetLead responses (2026-09-28).
// The vendor lead carries an EMPTY lognumber — the reason the guard cannot
// require a GHL-contact match.
const vendorProspect = {
  cst_id: '450708',
  leads: [{ id: '565033', dateentered: '2026-08-06T18:14:08.96', source: 'Internet', sourcesubdescr: 'MyHomePros', lognumber: '', disposition: 'Data' }],
};
const chatbotProspect = {
  cst_id: '450709',
  leads: [{ id: '565034', dateentered: '2026-08-06T18:14:43.197', source: 'Website', sourcesubdescr: 'Reece ChatBot', lognumber: 'XUMXkt7OvL6IDCMWUKow' }],
};

test('flattenLpLeads keeps each lead\'s prospect id', () => {
  const flat = flattenLpLeads([vendorProspect, chatbotProspect, null]);
  assert.equal(flat.length, 2);
  assert.equal(flat[0]._prospectId, '450708');
  assert.equal(flat[1]._prospectId, '450709');
});
test('flattenLpLeads accepts a single object and junk', () => {
  assert.equal(flattenLpLeads(vendorProspect).length, 1);
  assert.deepEqual(flattenLpLeads(null), []);
  assert.deepEqual(flattenLpLeads([{ cst_id: '1' }]), []);
});
test('vendor lead with empty lognumber is found (the case resolveLPLeadId misses)', () => {
  const r = pickNewestLead(flattenLpLeads([vendorProspect]));
  assert.equal(r.ldsId, '565033');
  assert.equal(r.prospectId, '450708');
  assert.equal(r.lpSourceDetail, 'MyHomePros');
  assert.equal(r.createdAtLp, '2026-08-06T18:14:08.96');
});
test('newest lead wins across prospects', () => {
  const r = pickNewestLead(flattenLpLeads([vendorProspect, chatbotProspect]));
  assert.equal(r.ldsId, '565034');
});
test('an old lead does not hide a recent one', () => {
  const r = pickNewestLead([
    { id: '400000', dateentered: '2024-01-01T10:00:00' },
    { id: '578900', dateentered: '2026-09-26T11:30:59.3' },
  ]);
  assert.equal(r.ldsId, '578900');
});
test('missing dates fall back to the higher lead id; dated beats undated', () => {
  assert.equal(pickNewestLead([{ id: '5' }, { id: '9' }, { id: '7' }]).ldsId, '9');
  assert.equal(pickNewestLead([{ id: '9' }, { id: '5', dateentered: '2026-01-01T00:00:00' }]).ldsId, '5');
  assert.equal(pickNewestLead([{ id: '9' }]).createdAtLp, null);
});
test('no usable lead → null', () => {
  assert.equal(pickNewestLead([]), null);
  assert.equal(pickNewestLead([{ dateentered: '2026-01-01' }]), null);
  assert.equal(pickNewestLead(undefined), null);
});
