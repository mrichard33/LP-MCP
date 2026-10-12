// 2026-10-12 — runAddressBackfillSweep called .or() straight on from() and
// threw "db.from(...).or is not a function" on every pass. This mock, like
// supabase-js, has no filter methods until .select() is called.
import test from 'node:test';
import assert from 'node:assert/strict';

process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://localhost:54321';
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'test-key';
process.env.GHL_API_KEY = process.env.GHL_API_KEY || 'test-ghl-key';

const { runAddressBackfillSweep } = await import('../src/jobs/lp-address-backfill.js');

const ROWS = [
  { lp_lead_id: 1, lp_prospect_id: 'P1', ghl_contact_id: 'C1', address: 'undefined', created_at_lp: '2026-10-01' },
  { lp_lead_id: 2, lp_prospect_id: 'P1', ghl_contact_id: 'C1', address: null, created_at_lp: '2026-09-01' },
  { lp_lead_id: 3, lp_prospect_id: 'P2', ghl_contact_id: 'C2', address: '12 Main St', created_at_lp: '2026-10-02' },
];

function strictDb() {
  return {
    from() {
      const filters = [];
      const q = {
        or() { return q; },
        not() { return q; },
        eq(k, v) { filters.push([k, v]); return q; },
        order() { return q; },
        limit: async () => ({ data: ROWS.filter((r) => filters.every(([k, v]) => r[k] === v)), error: null }),
      };
      // Like supabase-js: from() exposes select (and writes), never .or.
      return { select: () => q };
    },
  };
}

test('the sweep reads its candidates and repairs each prospect once', async () => {
  const repaired = [];
  const out = await runAddressBackfillSweep({
    supabase: strictDb(),
    skipDelay: true,
    getGHLContact: async () => ({ address1: '9 Oak Ave', city: 'Tampa', state: 'FL', postalCode: '33601' }),
    repairProspectAddress: async ({ prospectId }) => { repaired.push(prospectId); return { before: null, after: '9 Oak Ave' }; },
  });
  assert.equal(out.error, undefined);
  assert.equal(out.candidates, 1, 'P2 has a real address; P1 counted once');
  assert.equal(out.repaired, 1);
  assert.deepEqual(repaired, ['P1']);
});
