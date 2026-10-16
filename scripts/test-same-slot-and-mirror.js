/**
 * Same-slot duplicate leads (Badley, Fix 1) and LP-before-GHL mirroring
 * (Rhoads / Bogard, Fix 3) — handoff v3.4, 2026-10-16.
 */

delete process.env.SUPABASE_URL;
delete process.env.SUPABASE_SERVICE_ROLE_KEY;
process.env.GHL_API_KEY = 'test-key';

import test from 'node:test';
import assert from 'node:assert/strict';

// ─── stateful GHL calendar stub ─────────────────────────────────────────
let calls = [];
let events = [];
function jsonRes(body) {
  return { status: 200, ok: true, headers: { get: (k) => (String(k).toLowerCase() === 'content-type' ? 'application/json' : null) }, json: async () => body, text: async () => JSON.stringify(body) };
}
globalThis.fetch = async (url, opts = {}) => {
  const method = opts.method || 'GET';
  const path = String(url).replace('https://services.leadconnectorhq.com', '');
  const body = opts.body ? JSON.parse(opts.body) : null;
  calls.push({ method, path, body });
  if (method === 'GET' && /^\/contacts\/[^/]+\/appointments/.test(path)) return jsonRes({ events });
  if (method === 'GET' && /^\/contacts\/[^/]+$/.test(path)) return jsonRes({ contact: { id: 'c1', tags: [] } });
  if (method === 'POST' && path === '/calendars/events/appointments') {
    const id = `appt-${events.length + 1}`;
    events.push({ id, calendarId: body.calendarId, startTime: body.startTime, appointmentStatus: body.appointmentStatus });
    return jsonRes({ id });
  }
  return jsonRes({});
};
const reset = () => { calls = []; events = []; };
const posts = () => calls.filter((c) => c.method === 'POST' && c.path === '/calendars/events/appointments');

const { findSameSlotLiveSibling, slotKeyOf, findDuplicateLeadGroups } = await import('../src/same-slot-sibling.js');
const { maybeIgnoreSameSlotCancel, authorityFollowUp, SAME_SLOT_IGNORED, shouldBlockOnAuthority } =
  await import('../src/actions/handlers/lp-ghl-appointment-sync.js');
const { buildMergedLead } = await import('../src/ghl-field-sync.js');
const { mirrorLeadAppointment, pickMirrorLead, tooLateToMirror } = await import('../src/services/mirror-on-link.js');
const { createAppointmentFromLpHandler, __setBookingGuardDepsForTest } = await import('../src/appointments/booking-endpoint.js');

// Badley: two leads for one visit, 10/17 10:00 ET.
const SLOT = '2027-10-17T10:00:00+00:00';
const CXL = { lp_lead_id: '583460', disposition_code: 'CXL', appointment_date: SLOT, created_at_lp: '2026-10-15T12:00:00+00:00', updated_at_lp: '2026-10-16T09:00:00+00:00' };
const CNF = { lp_lead_id: '583453', disposition_code: 'Cnf', appointment_date: SLOT, created_at_lp: '2026-10-15T11:00:00+00:00', updated_at_lp: '2026-10-15T11:00:00+00:00' };
const liveAt = (disposition, mirror = SLOT) => ({ ok: true, disposition, date: '2027-10-17', time: '10:00', timeStatus: 'known', mirrorAppointmentDate: mirror });

// ═══ 1. the pure rule ═════════════════════════════════════════════════
test('slotKeyOf reads the stored ET wall clock; midnight and sentinels are "no slot"', () => {
  assert.equal(slotKeyOf(SLOT), '2027-10-17T10:00');
  assert.equal(slotKeyOf('2027-10-17T00:00:00+00:00'), null);
  assert.equal(slotKeyOf('1900-01-01T14:00:00+00:00'), null);
});

test('same-slot sibling: a live lead at the SAME date and time; never Verif / ND / a different time', () => {
  assert.equal(findSameSlotLiveSibling([CXL, CNF], CXL)?.lp_lead_id, '583453');
  assert.equal(findSameSlotLiveSibling([CXL, { ...CNF, disposition_code: 'Verif' }], CXL), null);
  assert.equal(findSameSlotLiveSibling([CXL, { ...CNF, disposition_code: 'ND' }], CXL), null);
  assert.equal(findSameSlotLiveSibling([CXL, { ...CNF, appointment_date: '2027-10-17T14:00:00+00:00' }], CXL), null);
  assert.equal(findSameSlotLiveSibling([CXL, { ...CNF, lp_deleted_at: '2026-10-16' }], CXL), null);
});

// ═══ 2. the cancel path ═══════════════════════════════════════════════
test('Badley: the CXL is ignored, LP Lead ID fields move to the live lead, nothing else', async () => {
  const repointed = [];
  const r = await maybeIgnoreSameSlotCancel({
    contactId: 'badley', lead: CXL,
    deps: { readContactLeads: async () => [CXL, CNF], readLiveForSync: async () => liveAt('Cnf'), writeLeadIdFields: async (c, id) => { repointed.push([c, id]); } },
  });
  assert.equal(r.outcome, SAME_SLOT_IGNORED);
  assert.equal(r.live_lead_id, '583453');
  assert.deepEqual(repointed, [['badley', '583453']]);
  // The authority seat is untouched: neither released nor re-recorded.
  assert.deepEqual(authorityFollowUp({ granted: true }, r), { release: false, record: null });
});

test('a sibling at a DIFFERENT time does not stop the cancel (CANARY behaviour)', async () => {
  const other = { ...CNF, appointment_date: '2027-10-17T14:00:00+00:00' };
  const r = await maybeIgnoreSameSlotCancel({ contactId: 'c', lead: CXL, deps: { readContactLeads: async () => [CXL, other], readLiveForSync: async () => liveAt('Cnf') } });
  assert.equal(r, null);
});

test('LP unreadable, or LP says the sibling moved / is not live → the cancel goes through', async () => {
  const base = { readContactLeads: async () => [CXL, CNF] };
  assert.equal(await maybeIgnoreSameSlotCancel({ contactId: 'c', lead: CXL, deps: { ...base, readLiveForSync: async () => ({ ok: false, error: 'down' }) } }), null);
  assert.equal(await maybeIgnoreSameSlotCancel({ contactId: 'c', lead: CXL, deps: { ...base, readLiveForSync: async () => liveAt('CXL') } }), null);
  assert.equal(await maybeIgnoreSameSlotCancel({ contactId: 'c', lead: CXL, deps: { ...base, readLiveForSync: async () => liveAt('Cnf', '2027-10-18T10:00:00+00:00') } }), null);
  assert.equal(await maybeIgnoreSameSlotCancel({ contactId: 'c', lead: CXL, deps: { readContactLeads: async () => { throw new Error('db'); } } }), null);
});

test('CANARY intact: a denied CXL is still never blocked on authority', () => {
  assert.equal(shouldBlockOnAuthority({ granted: false }, 'CXL'), false);
});

test('field sync: a CXL duplicate at the live lead\'s slot does not take the contact\'s LP fields', () => {
  const merged = buildMergedLead([CXL, CNF]);
  assert.equal(merged.lp_lead_id, '583453');
  assert.equal(merged.disposition_code, 'Cnf');
  // A CXL with no same-slot live sibling stays the current lead.
  assert.equal(buildMergedLead([CXL, { ...CNF, appointment_date: '2027-10-18T10:00:00+00:00' }]).lp_lead_id, '583460');
});

test('duplicate notice: 2+ leads with appointments within 7 days', () => {
  const rows = [{ ...CXL, ghl_contact_id: 'b' }, { ...CNF, ghl_contact_id: 'b' }, { ...CNF, ghl_contact_id: 'solo' }];
  const groups = findDuplicateLeadGroups(rows);
  assert.deepEqual(groups.map((g) => g.contactId), ['b']);
});

// ═══ 3. mirror on link (Fix 3) ═══════════════════════════════════════
// Dates relative to now: a visit 10 days out, the lead touched today (inside the
// 120-day plausibility window), synced in the wall-clock era.
const { lpWallClockToGhlStartTime } = await import('../src/appointment-dates.js');
const VISIT_DAY = new Date(Date.now() + 10 * 86400000).toISOString().slice(0, 10);
const VISIT = `${VISIT_DAY}T10:00:00+00:00`;
const VISIT_GHL = lpWallClockToGhlStartTime(VISIT);
const TODAY = new Date().toISOString();
const RHOADS = { lp_lead_id: '583915', disposition_code: 'Set', appointment_date: VISIT, synced_at: TODAY, created_at_lp: TODAY, updated_at_lp: TODAY };

for (const [code, status] of [['Set', 'new'], ['Cnf', 'confirmed'], ['Issue', 'confirmed']]) {
  test(`Rhoads: a ${code} lead with no GHL appointment is created on link (status ${status})`, async () => {
    reset();
    const r = await mirrorLeadAppointment({ contactId: 'rhoads', lead: { ...RHOADS, disposition_code: code }, deps: { readLiveForSync: async () => null } });
    assert.equal(r.outcome, 'created');
    assert.equal(posts().length, 1);
    assert.equal(posts()[0].body.appointmentStatus, status);
  });
}

test('Verif and ND / No Demo are never created on link; no GHL call', async () => {
  for (const code of ['Verif', 'ND', 'No Demo']) {
    reset();
    const r = await mirrorLeadAppointment({ contactId: 'x', lead: { ...RHOADS, disposition_code: code }, deps: { readLiveForSync: async () => null } });
    assert.equal(r.outcome, 'noop', code);
    assert.equal(calls.length, 0, code);
  }
});

test('a visit inside 60 minutes is "too late to mirror"', async () => {
  reset();
  assert.equal(tooLateToMirror(new Date(Date.now() + 30 * 60_000).toISOString()), true);
  assert.equal(tooLateToMirror(new Date(Date.now() + 3 * 3600_000).toISOString()), false);
  const live = { ok: true, disposition: 'Set', date: VISIT_DAY, time: '10:00', timeStatus: 'known' };
  const r = await mirrorLeadAppointment({
    contactId: 'x', lead: RHOADS,
    deps: { readLiveForSync: async () => live, nowMs: Date.parse(VISIT_GHL) - 20 * 60_000 }, // 20 minutes before the visit
  });
  assert.equal(r.reason, 'too_late_to_mirror');
  assert.equal(posts().length, 0);
});

test('Bogard: a canvass lead is created with notifications off', async () => {
  reset();
  const r = await mirrorLeadAppointment({ contactId: 'bogard', lead: { ...RHOADS, lp_lead_id: '583851', lead_source: 'Canvass' }, deps: { readLiveForSync: async () => null } });
  assert.equal(r.outcome, 'created');
  assert.equal(posts()[0].body.toNotify, false);
});

test('a year-typo LP date on link books nothing and raises ONE LP-looks-wrong card', async () => {
  reset();
  const cards = [];
  const old = { ...RHOADS, created_at_lp: '2025-01-20T00:00:00Z', updated_at_lp: '2025-01-26T00:00:00Z' };
  const r = await mirrorLeadAppointment({ contactId: 'x', lead: old, deps: { readLiveForSync: async () => null, notifyImplausibleAppointment: async (a) => { cards.push(a); } } });
  assert.equal(r.reason, 'implausible_future_appointment');
  assert.equal(posts().length, 0);
  assert.equal(cards.length, 1);
});

test('pickMirrorLead: the live current lead, else a live same-slot sibling, else nothing', () => {
  assert.equal(pickMirrorLead([RHOADS]).lp_lead_id, '583915');
  assert.equal(pickMirrorLead([CXL, CNF]).lp_lead_id, '583453');
  assert.equal(pickMirrorLead([{ ...RHOADS, disposition_code: 'Verif' }]), null);
});

test('I.LP-IN endpoint booking + the Fix 3 create for the same contact and slot → ONE appointment', async () => {
  reset();
  process.env.APPT_BOOKING_ENDPOINT_KEY = 'k';
  process.env.APPT_SLOT_CHECK_ENABLED = 'true';
  __setBookingGuardDepsForTest({ resolveLead: async () => RHOADS, readLive: async () => ({ ok: false }), notify: async () => {}, budgetMs: 1000 });
  try {
    const res = { status() { return this; }, json(b) { this.body = b; return this; } };
    await createAppointmentFromLpHandler({
      body: { contactId: 'rhoads', calendarId: 'aJj14ONxh1oFyDcQ706O', startTime: VISIT_GHL, status: 'new' },
      query: {}, headers: { 'x-appt-booking-key': 'k' },
    }, res);
    assert.equal(res.body.outcome, 'created');
    const r = await mirrorLeadAppointment({ contactId: 'rhoads', lead: RHOADS, deps: { readLiveForSync: async () => null } });
    assert.equal(r.outcome, 'noop');
    assert.equal(posts().length, 1, 'the second path sees the first appointment and books nothing');
  } finally {
    __setBookingGuardDepsForTest(null);
    delete process.env.APPT_BOOKING_ENDPOINT_KEY;
    delete process.env.APPT_SLOT_CHECK_ENABLED;
  }
});
