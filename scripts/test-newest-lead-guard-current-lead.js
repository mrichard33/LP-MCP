// 2026-10-04 (fix/newest-lead-guard-current-lead) — the newest-lead guard must
// agree with pickCurrentLead: a blank Data duplicate does not bury the lead
// that holds the appointment.
import test from 'node:test';
import assert from 'node:assert/strict';

process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://localhost:54321';
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'test-key';

const { _internal } = await import('../src/decision-engine.js');
const { isNewestLeadForContact } = _internal;

const mockDb = (rows) => ({
  from: () => {
    const q = { select: () => q, eq: () => q, is: () => q,
      limit: async () => ({ data: rows, error: null }) };
    return q;
  },
});

const ev = (leadId, disp, type = 'lp.disposition_changed') => ({
  id: 1, event_type: type, event_subtype: disp, entity_id: leadId,
  ghl_contact_id: 'C1', payload: { disposition_code: disp },
});

const appt = { lp_lead_id: '580183', disposition_code: 'Set',
  appointment_date: '2026-10-07T18:00:00Z',
  created_at_lp: '2026-10-01T15:33:50Z', updated_at_lp: '2026-10-03T13:08:00Z' };
const blankData = { lp_lead_id: '580312', disposition_code: 'Data',
  appointment_date: null,
  created_at_lp: '2026-10-02T10:25:50Z', updated_at_lp: '2026-10-02T10:25:50Z' };

test('Waleid: Set on the appointment lead passes under a newer blank Data lead', async () => {
  assert.equal(await isNewestLeadForContact(ev('580183', 'Set'), mockDb([appt, blankData])), true);
});

test('Waleid: reschedule event on the appointment lead passes too', async () => {
  assert.equal(await isNewestLeadForContact(
    ev('580183', 'Set', 'lp.appointment_rescheduled'), mockDb([appt, blankData])), true);
});

test('a newer WORKED lead still blocks the older lead', async () => {
  const newerCxl = { lp_lead_id: '590000', disposition_code: 'CXL',
    appointment_date: '2026-10-05T14:00:00Z',
    created_at_lp: '2026-10-02T10:00:00Z', updated_at_lp: '2026-10-02T12:00:00Z' };
  assert.equal(await isNewestLeadForContact(ev('580183', 'Set'), mockDb([appt, newerCxl])), false);
});

test('a Data lead outside the 15-day window is a new cycle and still blocks', async () => {
  const oldAppt = { lp_lead_id: '500001', disposition_code: 'Set',
    appointment_date: '2026-01-10T14:00:00Z',
    created_at_lp: '2026-01-05T10:00:00Z', updated_at_lp: '2026-01-06T10:00:00Z' };
  assert.equal(await isNewestLeadForContact(ev('500001', 'Set'), mockDb([oldAppt, blankData])), false);
});

test('an event on the current lead passes', async () => {
  const worked = { ...blankData, disposition_code: 'NOC' };
  assert.equal(await isNewestLeadForContact(ev('580312', 'NOC'), mockDb([appt, worked])), true);
});

test('no leads on file fails open', async () => {
  assert.equal(await isNewestLeadForContact(ev('580183', 'Set'), mockDb([])), true);
});
