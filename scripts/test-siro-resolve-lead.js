/**
 * Siro recording → LP lead — scripts/test-siro-resolve-lead.js (2026-10-16)
 * Run: node --test scripts/test-siro-resolve-lead.js
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveLead, leadIdCandidates } from '../src/siro/resolve-lead.js';

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

test('opportunity → the lead id (exact, then without LDS, then digits)', async () => {
  const calls = [];
  const r = await resolveLead({ ...base, opportunity_external_id: 'LDS583321', account_external_id: '470111' }, { readLeads: reader(calls) });
  assert.equal(r.match_method, 'opportunity');
  assert.equal(r.lp_lead_id, '583321');
  assert.equal(r.ghl_contact_id, 'c1');
  assert.deepEqual(calls[0], { by: 'lp_lead_id', values: ['LDS583321', '583321'] });
  assert.deepEqual(leadIdCandidates('appt-583321'), ['appt-583321', '583321']);
});

test('the engagement id is LP\'s appointment id: never read as a lead (2026-10-16)', async () => {
  // Live: engagement 179053 matched a 2019 lead; the visit's lead was opportunity 583833.
  const calls = [];
  const r = await resolveLead({ ...base, engagement_external_id: '500001', opportunity_external_id: '583321', account_external_id: '470111' }, { readLeads: reader(calls) });
  assert.equal(r.lp_lead_id, '583321');
  assert.ok(!calls.some(c => c.values.includes('500001')));
  const only = await resolveLead({ ...base, engagement_external_id: '500001' }, { readLeads: reader() });
  assert.equal(only.match_method, 'none');
});

test('an opportunity lead on another prospect than the account is not taken', async () => {
  const r = await resolveLead({ ...base, opportunity_external_id: '500001', account_external_id: '470111' }, { readLeads: reader() });
  assert.equal(r.match_method, 'account');
  assert.equal(r.lp_lead_id, '583321'); // the account's lead whose visit is near the recording
});

test('account → the lead with a visit near the recording, else the newest', async () => {
  const r = await resolveLead({ ...base, account_external_id: '470111' }, { readLeads: reader() });
  assert.equal(r.match_method, 'account');
  assert.equal(r.lp_lead_id, '583321');
  const later = await resolveLead({ recorded_at: '2027-03-01T00:00:00Z', account_external_id: '470111' }, { readLeads: reader() });
  assert.equal(later.lp_lead_id, '590000');
});

test('phone needs a demo or appointment within 3 days of the recording', async () => {
  const r = await resolveLead({ ...base, customer_phone: '3525550188' }, { readLeads: reader() });
  assert.equal(r.match_method, 'phone');
  assert.equal(r.lp_lead_id, '583321'); // the 12-01 appointment is out of the window
  const far = await resolveLead({ recorded_at: '2026-11-20T00:00:00Z', customer_phone: '9545550100' }, { readLeads: reader() });
  assert.equal(far.match_method, 'none');
});

test('nothing to go on → none', async () => {
  const r = await resolveLead({ ...base }, { readLeads: reader() });
  assert.deepEqual(r, { lp_lead_id: null, lp_prospect_id: null, ghl_contact_id: null, match_method: 'none' });
});
