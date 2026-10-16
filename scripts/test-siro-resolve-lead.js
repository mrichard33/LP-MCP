/**
 * Siro recording → LP lead — scripts/test-siro-resolve-lead.js (2026-10-16)
 * Run: node --test scripts/test-siro-resolve-lead.js
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveLead, engagementCandidates, _resetResolveLogForTests } from '../src/siro/resolve-lead.js';

const LEADS = [
  { lp_lead_id: '583321', lp_prospect_id: '470111', ghl_contact_id: 'c1', phone: '3525550188', demo_date: '2026-10-14T22:00:00Z', created_at_lp: '2026-10-01T10:00:00Z' },
  { lp_lead_id: '590000', lp_prospect_id: '470111', ghl_contact_id: 'c1', phone: '3525550188', appointment_date: '2026-12-01T15:00:00Z', created_at_lp: '2026-10-15T10:00:00Z' },
  { lp_lead_id: '500001', lp_prospect_id: '400001', ghl_contact_id: 'c9', phone: '9545550100', demo_date: '2026-10-14T18:00:00Z', created_at_lp: '2026-09-01T10:00:00Z' },
];
function reader(calls = []) {
  return async ({ by, values }) => {
    calls.push({ by, values });
    if (by === 'lp_lead_id') return LEADS.filter(l => values.includes(l.lp_lead_id));
    if (by === 'lp_prospect_id') return LEADS.filter(l => values.includes(l.lp_prospect_id));
    if (by === 'phone') return LEADS.filter(l => values.includes(l.phone));
    return [];
  };
}
const base = { recorded_at: '2026-10-14T22:05:00Z' };

test('engagement: exact, then without LDS, then digits; the first value is logged verbatim', async () => {
  _resetResolveLogForTests();
  const logs = [];
  const calls = [];
  const r = await resolveLead({ ...base, engagement_external_id: 'LDS583321' }, { readLeads: reader(calls), log: (l) => logs.push(l) });
  assert.equal(r.match_method, 'engagement');
  assert.equal(r.lp_lead_id, '583321');
  assert.equal(r.ghl_contact_id, 'c1');
  assert.deepEqual(calls.map(c => c.values[0]), ['LDS583321', '583321']);
  assert.match(logs[0], /"LDS583321"/);
  assert.deepEqual(engagementCandidates('appt-583321'), ['appt-583321', '583321']);
});

test('account → newest lead on the prospect', async () => {
  const r = await resolveLead({ ...base, engagement_external_id: 'nomatch', account_external_id: '470111' }, { readLeads: reader(), log() {} });
  assert.equal(r.match_method, 'account');
  assert.equal(r.lp_lead_id, '590000');
});

test('opportunity → lead id', async () => {
  const r = await resolveLead({ ...base, opportunity_external_id: '500001' }, { readLeads: reader(), log() {} });
  assert.equal(r.match_method, 'opportunity');
  assert.equal(r.lp_prospect_id, '400001');
});

test('phone needs a demo or appointment within 3 days of the recording', async () => {
  const r = await resolveLead({ ...base, customer_phone: '3525550188' }, { readLeads: reader(), log() {} });
  assert.equal(r.match_method, 'phone');
  assert.equal(r.lp_lead_id, '583321'); // the 12-01 appointment is out of the window
  const far = await resolveLead({ recorded_at: '2026-11-20T00:00:00Z', customer_phone: '9545550100' }, { readLeads: reader(), log() {} });
  assert.equal(far.match_method, 'none');
});

test('nothing to go on → none', async () => {
  const r = await resolveLead({ ...base }, { readLeads: reader(), log() {} });
  assert.deepEqual(r, { lp_lead_id: null, lp_prospect_id: null, ghl_contact_id: null, match_method: 'none' });
});
