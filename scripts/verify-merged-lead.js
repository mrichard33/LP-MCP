// Local verification for buildMergedLead() newest-lead resolution.
//
// Regression guard for the LP→GHL field-writeback fix: a prospect with
// multiple leads must surface the NEWEST lead's disposition/identity while
// aggregating "ever" flags across all leads. Uses the real prospect-254393
// rows (Antonio Banks) captured from the live LP Supabase.
//
// Run: node scripts/verify-merged-lead.js
import assert from 'node:assert/strict';
import { buildMergedLead } from '../src/ghl-field-sync.js';
import { buildGHLFieldPayload } from '../src/ghl-field-map.js';

// Two leads for GHL contact Ylhk8PUwzxNq8uVYThRJ, intentionally passed
// oldest-first to prove the merge sorts by updated_at_lp DESC itself.
const leads = [
  {
    lp_lead_id: '313031', lp_prospect_id: '254393', ghl_contact_id: 'Ylhk8PUwzxNq8uVYThRJ',
    ghl_fields_hash: 'URWTGtobi9a9Y7gwGxC8=CXL', disposition_code: 'CXL',
    demo_completed: false, closed_won: false, appointment_set: true,
    appointment_date: '2024-04-11T10:00:00+00:00', updated_at_lp: '2024-04-10T17:04:06.41+00:00',
  },
  {
    lp_lead_id: '511450', lp_prospect_id: '254393', ghl_contact_id: 'Ylhk8PUwzxNq8uVYThRJ',
    ghl_fields_hash: null, disposition_code: 'OPPFDN',
    demo_completed: true, closed_won: false, appointment_set: true,
    appointment_date: '2026-03-10T14:00:00+00:00', updated_at_lp: '2026-03-10T15:03:48.767+00:00',
  },
];

const merged = buildMergedLead(leads);

assert.equal(merged.disposition_code, 'OPPFDN', 'disposition must come from newest lead');
assert.equal(merged.demo_completed, true, 'demo_completed must aggregate true across leads');
assert.equal(merged.lp_lead_id, '511450', 'identity must be the newest lead id');
assert.equal(merged.appointment_date, '2026-03-10T14:00:00+00:00', 'appointment from most-recent appt lead');

// The GHL payload must carry the newest disposition + lead-id fields.
const payload = buildGHLFieldPayload(merged);
const byId = Object.fromEntries(payload.map(f => [f.id, f.field_value]));
assert.equal(byId['URWTGtobi9a9Y7gwGxC8'], 'OPPFDN', 'LP Disposition field = OPPFDN');
assert.equal(byId['j84cNc7Rk6BkiYdZwuOO'], 'Yes', 'LP Demo Completed field = Yes');
assert.equal(byId['GmAVmW6V9sekD7pVONKr'], '511450', 'canonical LP Lead ID = newest');
assert.equal(byId['yII9akTft1RKOG0Ri4Q9'], '511450', 'LP Last Appointment ID = newest');

console.log('OK — buildMergedLead resolves prospect 254393 to newest lead 511450 (OPPFDN, demo=Yes)');
