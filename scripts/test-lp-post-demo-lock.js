/**
 * Post-demo LP lock (the user, 2026-10-09): "We should never modify a lead
 * marked OPP FDN." LP lead 581695 (Monica, OPPFDN) took a SetAppointment for a
 * rehash phone call on 2026-10-08 and flipped to Set.
 *
 * Run: node --test scripts/test-lp-post-demo-lock.js
 */
import test from 'node:test';
// The cases inject resolveLPLeadId; the 15-day lead rule would answer first
// and read LP / Supabase, so it is off here (its cases: test-lp-appointment-target.js).
process.env.LP_APPT_TARGET_RULE_MODE = 'off';
import assert from 'node:assert/strict';
import { postDemoLock } from '../src/lp-post-demo-lock.js';
import { syncAppointmentToLP } from '../src/lp-appointment-sync.js';

const sb = (row, error = null) => ({
  from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: row, error }) }) }) }),
});
const live = (disp) => async () => [{ lds_id: '581695', Disposition: disp }];
const boom = async () => { throw new Error('LP 500'); };

test('the caller\'s own disposition locks with no I/O', async () => {
  const r = await postDemoLock('581695', { knownDisposition: 'OPPFDN', deps: { supabase: sb(null, { message: 'x' }), getLeadByLdsId: boom } });
  assert.deepEqual([r.locked, r.source], [true, 'caller']);
});

test('lp_leads OPPFDN locks; a sale locks too', async () => {
  assert.equal((await postDemoLock('1', { deps: { supabase: sb({ disposition_code: 'OPPFDN' }), getLeadByLdsId: live('Set') } })).locked, true);
  assert.equal((await postDemoLock('1', { deps: { supabase: sb({ disposition_code: 'Sale' }), getLeadByLdsId: live('Set') } })).locked, true);
});

test('LP live OPPFDN locks even when our copy is stale', async () => {
  const r = await postDemoLock('581695', { knownDisposition: 'Set', deps: { supabase: sb({ disposition_code: 'Set' }), getLeadByLdsId: live('OPPFDN') } });
  assert.deepEqual([r.locked, r.source, r.disposition], [true, 'lp_live', 'OPPFDN']);
});

test('a pre-demo lead (Set, CXL, blank) is not locked', async () => {
  for (const d of ['Set', 'CXL', 'Data', '']) {
    const r = await postDemoLock('1', { deps: { supabase: sb({ disposition_code: d }), getLeadByLdsId: live(d) } });
    assert.equal(r.locked, false, d);
  }
});

test('a brand-new lead: no lp_leads row and LP live down → not locked', async () => {
  const r = await postDemoLock('1', { deps: { supabase: sb(null), getLeadByLdsId: boom } });
  assert.deepEqual([r.locked, r.source], [false, 'unknown_new_lead']);
});

test('both reads failing is "could not tell" and locks', async () => {
  const r = await postDemoLock('1', { deps: { supabase: sb(null, { message: 'down' }), getLeadByLdsId: boom } });
  assert.deepEqual([r.locked, r.source], [true, 'unreadable']);
});

test('syncAppointmentToLP: a blank resolver disposition still hits the lock', async () => {
  let set = 0;
  const res = await syncAppointmentToLP({ contactId: '5YGVd3kh5IcY6pUJVcs4', appointmentDate: '2026-10-09', appointmentTime: '06:00 PM' }, {
    lpAlreadyHasAppointment: async () => false,
    resolveLPLeadId: async () => ({ ldsId: '581695', prospectId: '463408', source: 's', step: 0, disp: '' }),
    lpSetAppointment: async () => { set++; return { Result: 0 }; },
    postDemoLock: async () => ({ locked: true, disposition: 'OPPFDN', source: 'lp_live' }),
  });
  assert.equal(res.action, 'skipped_terminal_disposition');
  assert.equal(res.disposition, 'OPPFDN');
  assert.equal(set, 0);
});
