// Every lead handed to a partner is kept (Mark, 2026-10-22: "keep track of every lead we
// assign to Ross ... run the metrics"): src/partners/lead-ledger.js, written by the sweep.
import test from 'node:test';
import assert from 'node:assert/strict';
import { fakeSupabase } from './lib/fake-supabase.js';
import { ledgerRowFor, recordPartnerLead, markPartnerLeadReturned } from '../src/partners/lead-ledger.js';
import { runPartnerFive9Sweep, __resetForTests } from '../src/jobs/partner-five9-sweep.js';
import { clearCache } from '../src/partners/owner-resolver.js';
import { __resetForTests as resetOwnerSync } from '../src/partners/owner-sync.js';

const ROSS = 'TxbMrITSVyTJtJvGD9vk';
const C1 = 'cAAAAAAAAAAAAAAAAAA1';
const ROW = { partner_name: 'Ross Erstling', lp_branch_id: 'RFED', ghl_user_id: ROSS, active: true, ghl_tag: 'phone-team' };
const rfed = { lp_lead_id: '585100', lp_prospect_id: '450001', lp_branch_id: 'RFED', lead_source: 'Canvass', lead_source_detail: 'Canvass ORL', promoter_name: 'Canvass, Jane Doe', created_at_lp: '2026-10-23T10:00:00+00:00' };
const oneLeg = { lp_lead_id: '569069', lp_prospect_id: '450001', lp_branch_id: 'ORL', disposition_code: '1Leg', created_at_lp: '2026-08-01T10:00:00+00:00' };

test('ledgerRowFor: the RFED lead, its origin and how it was assigned', () => {
  const state = { row: ROW, newest: rfed, prospectLeads: [oneLeg, rfed], batchRow: null };
  const r = ledgerRowFor({ contactId: C1, state, origin: { lp_lead_id: '569069' } });
  assert.equal(r.lead_key, '585100');
  assert.equal(r.origin_branch, 'ORL');
  assert.equal(r.promoter, 'Canvass, Jane Doe');
  assert.equal(r.assigned_how, 'ghl_or_manual');
  assert.equal(ledgerRowFor({ contactId: C1, state, assignment: { ghl_user_id: ROSS } }).assigned_how, 'lp_sync');
  assert.equal(ledgerRowFor({ contactId: C1, state: { ...state, batchRow: { origin_lp_lead_id: '569069' } } }).assigned_how, 'batch');
  // An owner with no RFED lead yet is kept too (lead_key '').
  const off = ledgerRowFor({ contactId: C1, state: { row: ROW, newest: oneLeg, prospectLeads: [oneLeg] } });
  assert.equal(off.lead_key, '');
  assert.equal(off.lead_branch, 'ORL');
});

test('recordPartnerLead: inserted once, then seen; first_seen_at never moves; returned closes it', async () => {
  const db = fakeSupabase({ partner_owner_assignments: [], partner_lead_ledger: [] });
  const state = { row: ROW, newest: rfed, prospectLeads: [rfed], batchRow: null };
  const t0 = Date.parse('2026-10-22T15:00:00Z');
  assert.equal((await recordPartnerLead({ contactId: C1, state, nowMs: t0, deps: { supabase: db } })).outcome, 'inserted');
  assert.equal((await recordPartnerLead({ contactId: C1, state, nowMs: t0 + 18e5, deps: { supabase: db } })).outcome, 'seen');
  const [row] = db.tables.partner_lead_ledger;
  assert.equal(row.first_seen_at, new Date(t0).toISOString());
  assert.equal(row.last_seen_at, new Date(t0 + 18e5).toISOString());
  await markPartnerLeadReturned({ contactId: C1, nowMs: t0 + 36e5, deps: { supabase: db } });
  assert.equal(db.tables.partner_lead_ledger[0].returned_at, new Date(t0 + 36e5).toISOString());
});

test('the sweep writes the ledger for a partner owner, and a dry run writes nothing', async () => {
  const mk = () => {
    clearCache(); resetOwnerSync(); __resetForTests();
    return fakeSupabase({
      partner_owner_map: [{ id: 'm1', ...ROW, lp_rep_name: null }],
      partner_owner_assignments: [{ ghl_contact_id: C1, ghl_user_id: ROSS, released_at: null }],
      lp_leads: [{ ...rfed, ghl_contact_id: C1, lp_deleted_at: null }],
      partner_lead_ledger: [],
    });
  };
  const deps = (db) => ({
    supabase: db,
    ghlFetch: async (_m, path) => (path === `/contacts/${C1}` ? { contact: { id: C1, assignedTo: ROSS, tags: ['phone-team'] } } : null),
    hlRunSQL: async () => [], getListsInfo: async () => ({ lists: [{ name: 'DIAL ASAP', size: 1 }] }),
    postToSlack: async () => ({ ok: true }), alertPosted: { filterNew: async ({ items }) => ({ fresh: items }), recordPosted: async () => ({}) },
    env: { PARTNER_SYNC_ENABLED: 'true', PARTNER_GO_LIVE_AT: '2026-10-20T12:00:00-04:00', PARTNER_FIVE9_REMOVAL_MODE: 'log' },
    now: () => Date.parse('2026-10-22T15:00:00Z'), log: () => {},
  });
  const dry = mk();
  await runPartnerFive9Sweep(deps(dry), { dryRun: true, integrityOnly: true });
  assert.equal(dry.tables.partner_lead_ledger.length, 0);
  const live = mk();
  const r = await runPartnerFive9Sweep(deps(live), { integrityOnly: true });
  assert.equal(r.ledger.inserted, 1);
  assert.equal(live.tables.partner_lead_ledger[0].lp_lead_id, '585100');
  assert.equal(live.tables.partner_lead_ledger[0].assigned_how, 'lp_sync');
});
