/**
 * LP → GHL appointment parity self-heal — Roberta Ritchie, 2026-10-16.
 *
 * GHL contact 0Hwk6Mw05TSkKfQDhssm, appointment w0KtmFfsOnC3DilwxYIu. LP lead
 * 583833 was Set for 10/17 10 AM (our sync created the GHL estimate), then LP
 * moved it to 10/16 2 PM and issued it in one edit (no Issue sync rule: GHL never
 * heard), the watchdog's Class C only emitted an event, Fix 8 sat in shadow, and
 * at 18:28Z Class A wrote GHL's stale 10/17 10 AM back onto her OLDER lead 579742
 * (Data → Set). The demo happened (OPPFDN at 20:33Z) and nothing closed GHL.
 *
 * This file pins every fix on her shape:
 *   Fix 0  Class A never writes an LP-created appointment back (lp-origin-guard.js);
 *          postDemoLock refuses an older lead when a newer one is issued / post-demo
 *   Fix 2  Class C heals through the mirror and counts confirm_healed
 *   Fix 4  the close: demo → showed at LP's time + P1 move; NoHome → noshow; CXL → cancelled
 *   Fix 5  Confirmation Pipeline coverage: an upcoming visit with no card gets one
 *   end-to-end: her books as of the evening of 10/16 → no LP write, GHL showed at 2 PM.
 *
 * Run: node --test scripts/test-parity-roberta.js
 */

process.env.PARITY_AUTOHEAL = 'true';
process.env.PARITY_MAX_WRITES = '25';
process.env.PARITY_GHL_MISSING_MIN_AGE_MIN = '90';
process.env.PARITY_GHL_LIVE_CHECK = 'false';

import test from 'node:test';
import assert from 'node:assert/strict';

const { runAppointmentParityWatchdog } = await import('../src/jobs/appointment-parity-watchdog.js');
const { lpOriginBlock, supersededByNewerLead, lpVisitMs, readLpOriginFacts } = await import('../src/appointments/lp-origin-guard.js');
const {
  decideClose, owningLead, closeOne, closeCandidates, runPostAppointmentClose, closedStatusFor, postApptCloseMode,
  createSettledMemo, settledTtl,
} = await import('../src/appointments/post-appointment-close.js');
const { executeClosePastLpAppointment } = await import('../src/actions/handlers/post-appointment-close.js');
const { readUncoveredLeads } = await import('../src/jobs/confirmation-pipeline-clock.js');
const { postDemoLock } = await import('../src/lp-post-demo-lock.js');
const { liveAppointmentFromLead } = await import('../src/services/lp-live-appointment.js');
const { utcToLpStoredIso } = await import('../src/lp-dates.js');
const { lpWallClockToGhlStartTime } = await import('../src/appointment-dates.js');
const { WINDOW_ESTIMATE_CALENDAR_ID } = await import('../src/services/lp-ghl-appointment-reconciler.js');
const { fakeSupabase } = await import('./lib/fake-supabase.js');

const HOUR = 3600_000;
const DAY = 24 * HOUR;
const WE = WINDOW_ESTIMATE_CALENDAR_ID;
const CID = '0Hwk6Mw05TSkKfQDhssm';
const APPT = 'w0KtmFfsOnC3DilwxYIu';
const quiet = () => {};

// LP stores the ET wall clock labelled +00:00; on the hour so the parser keeps the time.
const onHour = (ms) => Math.floor(ms / HOUR) * HOUR;
const lpAt = (ms) => utcToLpStoredIso(onHour(ms));
const ghlAt = (ms) => lpWallClockToGhlStartTime(lpAt(ms));

// ═══ Fix 0: the LP-origin guard (pure) ═══════════════════════════════════

test('lpOriginBlock: an appointment OUR sync created is never written back to LP', () => {
  assert.deepEqual(lpOriginBlock({ syncCreated: true }), { block: true, reason: 'sync_created', lp_lead_id: null });
});

test('lpOriginBlock: a visit LP held in the last 72h (Issue, a demo, a live code) blocks', () => {
  const now = Date.now();
  for (const code of ['Issue', 'OPPFDN', 'Cnf', 'Set', 'Sale']) {
    const r = lpOriginBlock({ leads: [{ lp_lead_id: '583833', disposition_code: code, appointment_date: lpAt(now - 5 * HOUR) }], nowMs: now });
    assert.equal(r.reason, 'recent_lp_visit', code);
  }
  // A cancelled visit, or one 4 days ago, does not.
  assert.equal(lpOriginBlock({ leads: [{ lp_lead_id: '1', disposition_code: 'CXL', appointment_date: lpAt(now - 5 * HOUR) }], nowMs: now }).block, false);
  assert.equal(lpOriginBlock({ leads: [{ lp_lead_id: '1', disposition_code: 'Issue', appointment_date: lpAt(now - 4 * DAY) }], nowMs: now }).block, false);
});

test('lpOriginBlock: the newest lead post-demo within 30 days blocks; an old demo does not', () => {
  // A fixed midday clock (2026-10-18): run between midnight and 1 AM ET, now - 10 days landed on an LP
  // midnight, which reads as a date with no visit time, and the test failed for that hour only.
  const now = Date.parse('2026-10-16T16:00:00Z');
  const leads = [
    { lp_lead_id: '579742', disposition_code: 'Data', appointment_date: null },
    { lp_lead_id: '583833', disposition_code: 'OPPFDN', appointment_date: lpAt(now - 10 * DAY) },
  ];
  assert.equal(lpOriginBlock({ leads, nowMs: now }).reason, 'post_demo_lead');
  leads[1].appointment_date = lpAt(now - 90 * DAY);
  assert.equal(lpOriginBlock({ leads, nowMs: now }).block, false, 'a returning homeowner from months ago books for real');
});

test('lpOriginBlock: a contact LP has never seen passes (the real Class A case)', () => {
  assert.deepEqual(lpOriginBlock({ leads: [] }), { block: false, reason: null });
});

test('lpVisitMs: the 1900 sentinel and blanks are no visit', () => {
  assert.equal(lpVisitMs('1900-01-01T14:00:00+00:00'), null);
  assert.equal(lpVisitMs(null), null);
  assert.ok(Number.isFinite(lpVisitMs('2026-10-16T14:00:00+00:00')));
});

test('supersededByNewerLead: the phantom on 579742 is superseded by 583833\'s demo', () => {
  const now = Date.now();
  const phantom = { lp_lead_id: '579742', disposition_code: 'Set', appointment_date: lpAt(now + 18 * HOUR) };
  const leads = [phantom, { lp_lead_id: '583833', disposition_code: 'OPPFDN', appointment_date: lpAt(now - 6 * HOUR) }];
  assert.equal(supersededByNewerLead({ lead: phantom, leads, nowMs: now }).reason, 'newer_post_demo_lead');
  assert.equal(supersededByNewerLead({ lead: phantom, leads: [phantom], nowMs: now }).superseded, false);
  // An OLDER demo never supersedes a newer booking.
  const fresh = { lp_lead_id: '590000', disposition_code: 'Set', appointment_date: lpAt(now + DAY) };
  assert.equal(supersededByNewerLead({ lead: fresh, leads: [fresh, leads[1]], nowMs: now }).superseded, false);
});

test('readLpOriginFacts: gathers the contact\'s and the prospect\'s leads, and the sync-created ids', async () => {
  const db = fakeSupabase({ lp_leads: [
    { lp_lead_id: '583833', lp_prospect_id: '461906', ghl_contact_id: CID, disposition_code: 'Issue', appointment_date: '2026-10-16T14:00:00+00:00' },
    { lp_lead_id: '579742', lp_prospect_id: '461906', ghl_contact_id: null, disposition_code: 'Data', appointment_date: null },
    { lp_lead_id: '1', lp_prospect_id: '9', ghl_contact_id: 'other', disposition_code: 'Set', appointment_date: null },
  ] });
  const f = await readLpOriginFacts({
    candidates: new Map([[CID, { ghl_appointment_id: APPT }]]), db,
    readSyncCreatedStarts: async (ids) => new Map(ids.map((id) => [id, '2026-10-17T10:00:00-04:00'])),
  });
  assert.ok(f.syncCreated.has(APPT));
  assert.deepEqual(f.leadsByContact.get(CID).map((r) => r.lp_lead_id).sort(), ['579742', '583833']);
  await assert.rejects(() => readLpOriginFacts({ candidates: new Map([[CID, {}]]), db: null, readSyncCreatedStarts: async () => new Map() }));
});

// ═══ The watchdog ═════════════════════════════════════════════════════════

function deps({ ghlActive = new Map(), lpActive = new Map(), origin, originThrows = false, mirror, sync, emitted = [], close = async () => null } = {}) {
  return {
    readGhlBook: async () => ({ active: ghlActive, cancelled: new Map() }),
    readLpBook: async () => ({ active: lpActive, resolved: new Map(), settled: new Map() }),
    getGHLContact: async () => ({ tags: [] }),
    syncAppointmentToLP: sync || (async () => ({ action: 'lp_appointment_set' })),
    readLpOrigin: async () => { if (originThrows) throw new Error('LP read down'); return origin || { syncCreated: new Set(), leadsByContact: new Map() }; },
    runEstimateDriftFix: async () => null,
    runPostAppointmentClose: close,
    mirrorLeadAppointment: mirror || (async () => ({ outcome: 'status_updated', appointment_id: APPT, new_status: 'confirmed' })),
    readLiveForSync: async () => null,
    emitEvent: async (evt) => { emitted.push(evt); return { id: emitted.length }; },
    queueAction: async () => {},
    claimAlertConditionSet: async () => ({ ok: true, newlyFiring: [], cleared: [] }),
    confirmAlertSend: async () => ({ ok: true }),
    send: async () => ({ sent: true }),
  };
}
const ghlRow = (over = {}) => ({ ghl_contact_id: CID, ghl_appointment_id: APPT, status: 'new', start_time: ghlAt(Date.now() + 18 * HOUR), ghl_calendar_id: WE, ...over });

test('Class A: Roberta\'s sync-created GHL appointment is NOT written into LP (lp_origin_drift)', async () => {
  let syncCalls = 0;
  const r = await runAppointmentParityWatchdog({ deps: deps({
    ghlActive: new Map([[CID, ghlRow()]]),
    origin: { syncCreated: new Set([APPT]), leadsByContact: new Map() },
    sync: async () => { syncCalls++; return { action: 'lp_appointment_set' }; },
  }) });
  assert.equal(syncCalls, 0, 'never syncAppointmentToLP');
  assert.equal(r.counts.lp_origin_drift, 1);
  assert.equal(r.counts.lp_missing_appointment, 0);
  assert.equal(r.findings.find((f) => f.contact_id === CID).reason, 'sync_created');
});

test('Class A: her issued lead\'s visit 5h ago blocks a GHL-made appointment too', async () => {
  let syncCalls = 0;
  const leads = [{ lp_lead_id: '583833', disposition_code: 'Issue', appointment_date: lpAt(Date.now() - 5 * HOUR) }];
  const r = await runAppointmentParityWatchdog({ deps: deps({
    ghlActive: new Map([[CID, ghlRow()]]),
    origin: { syncCreated: new Set(), leadsByContact: new Map([[CID, leads]]) },
    sync: async () => { syncCalls++; return { action: 'lp_appointment_set' }; },
  }) });
  assert.equal(syncCalls, 0);
  assert.equal(r.findings.find((f) => f.contact_id === CID).reason, 'recent_lp_visit');
});

test('Class A: an unreadable LP history writes nothing to LP (fail closed)', async () => {
  let syncCalls = 0;
  const r = await runAppointmentParityWatchdog({ deps: deps({
    ghlActive: new Map([[CID, ghlRow()]]), originThrows: true,
    sync: async () => { syncCalls++; return { action: 'lp_appointment_set' }; },
  }) });
  assert.equal(syncCalls, 0);
  assert.equal(r.counts.lp_origin_unreadable, 1);
});

test('Class A: a booking LP has never seen still heals', async () => {
  const r = await runAppointmentParityWatchdog({ deps: deps({ ghlActive: new Map([['new-contact', ghlRow({ ghl_contact_id: 'new-contact', ghl_appointment_id: 'x' })]]) }) });
  assert.equal(r.outcomes.healed, 1);
});

const lpConfirmedRow = (over = {}) => ({
  ghl_contact_id: CID, lp_lead_id: '583833', disposition_code: 'Set', appointment_confirmed: true,
  appointment_date: lpAt(Date.now() + 18 * HOUR), first_name: 'Roberta', last_name: 'Ritchie', ...over,
});

test('Class C: LP confirmed, GHL new → the mirror confirms GHL; counted confirm_healed, event kept for audit', async () => {
  const emitted = [];
  const mirrored = [];
  const r = await runAppointmentParityWatchdog({ deps: deps({
    ghlActive: new Map([[CID, ghlRow()]]), lpActive: new Map([[CID, lpConfirmedRow()]]), emitted,
    mirror: async (args) => { mirrored.push(args); return { outcome: 'status_updated', appointment_id: APPT, new_status: 'confirmed' }; },
  }) });
  assert.equal(mirrored.length, 1);
  assert.equal(mirrored[0].contactId, CID);
  assert.equal(mirrored[0].lead.lp_lead_id, '583833');
  assert.equal(r.outcomes.confirm_healed, 1);
  assert.equal(r.outcomes.confirm_emitted, 0);
  const drift = emitted.find((e) => e.event_type === 'appointment.confirmation_drift');
  assert.ok(drift, 'the audit event still goes out');
  assert.equal(drift.payload.lp_lead_id, '583833');
  assert.equal(drift.payload.disposition_code, 'Set');
  assert.ok(emitted.some((e) => e.event_type === 'appointment.parity_auto_fixed' && e.event_subtype === 'confirmed'));
});

test('Class C: a refusal is not a heal — the event is confirm_emitted as before', async () => {
  const r = await runAppointmentParityWatchdog({ deps: deps({
    ghlActive: new Map([[CID, ghlRow()]]), lpActive: new Map([[CID, lpConfirmedRow()]]),
    mirror: async () => ({ outcome: 'noop', skipped: true, reason: 'multiple_estimate_appointments' }),
  }) });
  assert.equal(r.outcomes.confirm_healed, 0);
  assert.equal(r.outcomes.confirm_emitted, 1);
});

test('Class C respects PARITY_MAX_WRITES: 30 drifts, 25 heals, 5 over the ceiling', async () => {
  const ghl = new Map();
  const lp = new Map();
  for (let i = 0; i < 30; i++) {
    ghl.set(`c${i}`, ghlRow({ ghl_contact_id: `c${i}`, ghl_appointment_id: `a${i}` }));
    lp.set(`c${i}`, lpConfirmedRow({ ghl_contact_id: `c${i}`, lp_lead_id: `${i}` }));
  }
  let mirrors = 0;
  const r = await runAppointmentParityWatchdog({ deps: deps({ ghlActive: ghl, lpActive: lp, mirror: async () => { mirrors++; return { outcome: 'status_updated' }; } }) });
  assert.equal(mirrors, 25);
  assert.equal(r.outcomes.confirm_healed, 25);
  assert.equal(r.counts.write_ceiling_hit, 5);
});

test('Class B: the phantom 579742 is never mirrored back into GHL after the close (superseded)', async () => {
  const now = Date.now();
  const phantom = { ghl_contact_id: CID, lp_lead_id: '579742', disposition_code: 'Set', appointment_confirmed: false,
    appointment_date: lpAt(now + 18 * HOUR), created_at_lp: utcToLpStoredIso(now - 20 * DAY), updated_at_lp: utcToLpStoredIso(now - 3 * HOUR) };
  let mirrors = 0;
  const r = await runAppointmentParityWatchdog({ deps: deps({
    lpActive: new Map([[CID, phantom]]),
    origin: { syncCreated: new Set(), leadsByContact: new Map([[CID, [phantom, { lp_lead_id: '583833', disposition_code: 'OPPFDN', appointment_date: lpAt(now - 6 * HOUR) }]]]) },
    mirror: async () => { mirrors++; return { outcome: 'created' }; },
  }) });
  assert.equal(mirrors, 0);
  assert.equal(r.counts.ghl_create_superseded, 1);
  assert.equal(r.counts.ghl_missing_appointment, 0);
});

// ═══ Fix 4: the close (pure) ══════════════════════════════════════════════

const NOW = Date.UTC(2026, 9, 16, 21, 0);   // 10/16 5 PM ET, after her 4:33 PM OPPFDN
const DEMO_LP = '2026-10-16T14:00:00+00:00';  // 2 PM ET as LP stores it
const DEMO_GHL = '2026-10-16T14:00:00-04:00';
const live = (disposition, date = '2026-10-16', time = '14:00') => ({ ok: true, disposition, date, time, timeStatus: 'known' });

test('closedStatusFor: the user\'s ruling', () => {
  for (const c of ['OPPFDN', 'Sale', 'NoRehash', 'FDNS', 'SW', 'PM']) assert.equal(closedStatusFor(c), 'showed', c);
  assert.equal(closedStatusFor('NoHome'), 'noshow');
  for (const c of ['CXL', 'CCC', 'NG']) assert.equal(closedStatusFor(c), 'cancelled', c);
  for (const c of ['Set', 'Cnf', 'Issue', 'Verif', 'ND', 'No Demo', '']) assert.equal(closedStatusFor(c), null, c);
});

test('postApptCloseMode: default shadow; a typo never writes', () => {
  assert.equal(postApptCloseMode({}), 'shadow');
  assert.equal(postApptCloseMode({ POST_APPT_CLOSE_MODE: 'live' }), 'live');
  assert.equal(postApptCloseMode({ POST_APPT_CLOSE_MODE: 'yes' }), 'shadow');
});

test('decideClose: Roberta — demo done, GHL a day late → showed AT LP\'s time, P1 forward', () => {
  const appt = { ghl_appointment_id: APPT, ghl_calendar_id: WE, status: 'new', start_time: '2026-10-17T10:00:00-04:00' };
  const d = decideClose({ appt, lead: { lp_lead_id: '583833', disposition_code: 'OPPFDN', appointment_date: DEMO_LP }, live: live('OPPFDN'), nowMs: NOW });
  assert.equal(d.op, 'close');
  assert.equal(d.status, 'showed');
  assert.equal(d.moveP1, true);
  assert.equal(Date.parse(d.rescheduleTo), Date.parse(DEMO_GHL));
});

test('decideClose: the table', () => {
  const at = (status = 'confirmed') => ({ ghl_appointment_id: 'a', ghl_calendar_id: WE, status, start_time: DEMO_GHL });
  const l = (code) => ({ lp_lead_id: '1', disposition_code: code, appointment_date: DEMO_LP });
  const d = (code, o = {}) => decideClose({ appt: at(o.status), lead: l(code), live: o.live ?? live(code), nowMs: o.now ?? NOW });
  assert.deepEqual([d('NoHome').op, d('NoHome').status, d('NoHome').moveP1], ['close', 'noshow', false]);
  assert.equal(d('CXL').status, 'cancelled');
  assert.equal(d('Sale').status, 'showed');
  assert.equal(d('Sale').rescheduleTo, null, 'already at LP\'s time');
  assert.deepEqual([d('Issue').op, d('Issue').reason], ['wait', 'lp_not_dispositioned']);
  assert.equal(d('Set').op, 'wait');
  assert.equal(d('Verif').op, 'wait');
  assert.equal(d('OPPFDN', { now: Date.UTC(2026, 9, 16, 12) }).reason, 'visit_not_passed');
  assert.equal(d('OPPFDN', { now: NOW + 5 * DAY }).reason, 'outside_lookback');
  assert.equal(d('OPPFDN', { live: { ok: false } }).reason, 'lp_unreadable');
  assert.equal(d('OPPFDN', { status: 'showed' }).reason, 'already_closed');
  assert.equal(d('ND').op, 'none', 'ND is LP_DISP_DISQUALIFIED\'s (invalid), never ours');
});

test('decideClose: a FUTURE GHL appointment against an LP cancel is Class E\'s, never closed here', () => {
  const appt = { ghl_appointment_id: 'a', ghl_calendar_id: WE, status: 'new', start_time: '2026-10-20T10:00:00-04:00' };
  const r = decideClose({ appt, lead: { lp_lead_id: '1', disposition_code: 'CXL', appointment_date: DEMO_LP }, live: live('CXL'), nowMs: NOW });
  assert.equal(r.reason, 'future_ghl_cancel_is_class_e');
});

test('owningLead: the newest lead with a just-past visit wins over the phantom at the GHL time', () => {
  const leads = [
    { lp_lead_id: '579742', disposition_code: 'Set', appointment_date: '2026-10-17T10:00:00+00:00' },
    { lp_lead_id: '583833', disposition_code: 'OPPFDN', appointment_date: DEMO_LP },
  ];
  const appt = { start_time: '2026-10-17T10:00:00-04:00' };
  assert.equal(owningLead(leads, appt, NOW).lp_lead_id, '583833');
  // Without a fresh visit on the newest lead, the lead at the GHL time owns it.
  const older = [{ lp_lead_id: '1', disposition_code: 'NoHome', appointment_date: DEMO_LP }, { lp_lead_id: '2', disposition_code: 'Data', appointment_date: null }];
  assert.equal(owningLead(older, { start_time: DEMO_GHL }, NOW).lp_lead_id, '1');
});

test('closeCandidates: past open estimates, plus a future one only when a demo just happened', () => {
  const rows = [
    { ghl_contact_id: 'past', ghl_appointment_id: 'p', ghl_calendar_id: WE, status: 'new', start_time: DEMO_GHL },
    { ghl_contact_id: CID, ghl_appointment_id: APPT, ghl_calendar_id: WE, status: 'new', start_time: '2026-10-17T10:00:00-04:00' },
    { ghl_contact_id: 'future', ghl_appointment_id: 'f', ghl_calendar_id: WE, status: 'new', start_time: '2026-10-17T10:00:00-04:00' },
    { ghl_contact_id: 'done', ghl_appointment_id: 'd', ghl_calendar_id: WE, status: 'showed', start_time: DEMO_GHL },
    { ghl_contact_id: 'call', ghl_appointment_id: 'c', ghl_calendar_id: 'gFWoSQrlKIdfRbAPV842', status: 'new', start_time: DEMO_GHL },
  ];
  const leadsByContact = new Map([[CID, [{ lp_lead_id: '583833', disposition_code: 'OPPFDN', appointment_date: DEMO_LP }]], ['future', [{ lp_lead_id: '9', disposition_code: 'Set', appointment_date: '2026-10-17T10:00:00+00:00' }]]]);
  assert.deepEqual(closeCandidates({ ghlRows: rows, leadsByContact, nowMs: NOW }).map((r) => r.ghl_appointment_id).sort(), ['p', APPT].sort());
});

function closeDeps(over = {}) {
  const rec = { puts: [], queued: [], events: [] };
  return {
    rec,
    deps: {
      readLive: async () => live('OPPFDN'),
      putAppointment: async (id, body) => { rec.puts.push({ id, body }); return {}; },
      queueAction: async (row) => { rec.queued.push(row); },
      emitEvent: async (e) => { rec.events.push(e); return { id: rec.events.length }; },
      settledMemo: createSettledMemo(),
      nowMs: NOW, log: quiet, ...over,
    },
  };
}
const robertaLeads = [
  { lp_lead_id: '579742', disposition_code: 'Set', appointment_date: '2026-10-17T10:00:00+00:00' },
  { lp_lead_id: '583833', disposition_code: 'OPPFDN', appointment_date: DEMO_LP },
];
const robertaAppt = { ghl_contact_id: CID, ghl_appointment_id: APPT, ghl_calendar_id: WE, status: 'new', start_time: '2026-10-17T10:00:00-04:00' };

test('closeOne live: ONE PUT moves her estimate to 2 PM 10/16 and sets showed, toNotify false; P1 move queued', async () => {
  const { rec, deps } = closeDeps({ mode: 'live' });
  const r = await closeOne({ contactId: CID, appt: robertaAppt, leads: robertaLeads, deps });
  assert.equal(r.applied, true);
  assert.equal(rec.puts.length, 1);
  const { id, body } = rec.puts[0];
  assert.equal(id, APPT);
  assert.equal(body.appointmentStatus, 'showed');
  assert.equal(body.toNotify, false);
  assert.equal(Date.parse(body.startTime), Date.parse(DEMO_GHL));
  assert.equal(body.calendarId, WE);
  assert.equal(rec.queued.length, 1);
  assert.equal(rec.queued[0].action_type, 'move_opportunity');
  assert.deepEqual(rec.queued[0].action_payload, { stage: 'Appointment Completed', status: 'open', pipeline: 'P1' });
  assert.equal(rec.queued[0].target_id, CID);
});

test('closeOne shadow: no GHL write, no queue, one appt.close_would_apply event', async () => {
  const { rec, deps } = closeDeps({ mode: 'shadow' });
  const r = await closeOne({ contactId: CID, appt: robertaAppt, leads: robertaLeads, deps });
  assert.equal(r.applied, false);
  assert.equal(r.op, 'close');
  assert.equal(rec.puts.length, 0);
  assert.equal(rec.queued.length, 0);
  assert.deepEqual(rec.events.map((e) => e.event_type), ['appt.close_would_apply']);
});

test('closeOne off: nothing read, nothing written', async () => {
  let reads = 0;
  const { rec, deps } = closeDeps({ mode: 'off', readLive: async () => { reads++; return live('OPPFDN'); } });
  await closeOne({ contactId: CID, appt: robertaAppt, leads: robertaLeads, deps });
  assert.equal(reads, 0);
  assert.equal(rec.puts.length + rec.events.length, 0);
});

test('closeOne live, NoHome: noshow at its own time, no P1 move', async () => {
  const { rec, deps } = closeDeps({ mode: 'live', readLive: async () => live('NoHome') });
  const appt = { ...robertaAppt, start_time: DEMO_GHL };
  await closeOne({ contactId: 'x', appt, leads: [{ lp_lead_id: '1', disposition_code: 'NoHome', appointment_date: DEMO_LP }], deps });
  assert.deepEqual(rec.puts[0].body, { appointmentStatus: 'noshow', toNotify: false });
  assert.equal(rec.queued.length, 0);
});

test('runPostAppointmentClose: live writes are capped', async () => {
  const rows = Array.from({ length: 4 }, (_, i) => ({ ghl_contact_id: `c${i}`, ghl_appointment_id: `a${i}`, ghl_calendar_id: WE, status: 'new', start_time: DEMO_GHL }));
  const leads = new Map(rows.map((r, i) => [r.ghl_contact_id, [{ lp_lead_id: `${i}`, disposition_code: 'OPPFDN', appointment_date: DEMO_LP }]]));
  const { rec, deps } = closeDeps({ mode: 'live', cap: 3, readGhlRows: async () => rows, readLeads: async () => leads });
  const s = await runPostAppointmentClose({ deps });
  assert.equal(s.writes, 3);
  assert.equal(s.capped, 1);
  assert.equal(rec.puts.length, 3);
  // The watchdog's report mode never writes, whatever the variable says.
  const d2 = closeDeps({ mode: 'live', readGhlRows: async () => rows, readLeads: async () => leads });
  const s2 = await runPostAppointmentClose({ dryRun: true, deps: d2.deps });
  assert.equal(s2.mode, 'shadow');
  assert.equal(d2.rec.puts.length, 0);
});

test('close_past_lp_appointment handler: reads the contact, closes her estimate (live)', async () => {
  const db = fakeSupabase({ lp_leads: robertaLeads.map((l) => ({ ...l, ghl_contact_id: CID })) });
  const { rec, deps } = closeDeps({ mode: 'live' });
  const r = await executeClosePastLpAppointment({ target_id: CID }, {}, {
    ...deps, supabase: db,
    fetchRecentAndUpcomingAppointments: async () => [{ appointment_id: APPT, calendar_id: WE, status: 'new', start_time: '2026-10-17T10:00:00-04:00' }],
  });
  assert.equal(r.outcome, 'closed');
  assert.equal(rec.puts.length, 1);
  // GHL unreadable → throws, so the executor retries.
  await assert.rejects(() => executeClosePastLpAppointment({ target_id: CID }, {}, { ...deps, supabase: db, fetchRecentAndUpcomingAppointments: async () => null }));
});

// ═══ End to end: her books on the evening of 10/16 ════════════════════════

test('Roberta end to end: no LP write, GHL moved to the demo time and showed, P1 queued', async () => {
  const prev = process.env.POST_APPT_CLOSE_MODE;
  process.env.POST_APPT_CLOSE_MODE = 'live';
  try {
    const now = Date.now();
    const demoMs = onHour(now - 6 * HOUR);
    const leads = [
      { lp_lead_id: '579742', lp_prospect_id: '461906', ghl_contact_id: CID, disposition_code: 'Data', appointment_date: null },
      { lp_lead_id: '583833', lp_prospect_id: '461906', ghl_contact_id: CID, disposition_code: 'OPPFDN', appointment_date: lpAt(demoMs) },
    ];
    const stale = ghlRow({ start_time: ghlAt(now + 18 * HOUR) });
    let syncCalls = 0;
    const puts = [];
    const queued = [];
    const d = deps({
      ghlActive: new Map([[CID, stale]]),
      origin: { syncCreated: new Set([APPT]), leadsByContact: new Map([[CID, leads]]) },
      sync: async () => { syncCalls++; return { action: 'lp_appointment_set' }; },
      close: undefined,
    });
    delete d.runPostAppointmentClose;   // the REAL Class F pass, with injected reads
    Object.assign(d, {
      readGhlCloseRows: async () => [stale],
      readContactLeads: async () => new Map([[CID, leads]]),
      readLiveLpAppointment: async () => liveAppointmentFromLead({ apptdate: lpAt(demoMs).replace('+00:00', ''), disposition: 'OPPFDN' }),
      putAppointment: async (id, body) => { puts.push({ id, body }); return {}; },
      queueAction: async (row) => { queued.push(row); },
    });
    const r = await runAppointmentParityWatchdog({ deps: d });
    assert.equal(syncCalls, 0, 'LP is never written');
    assert.equal(r.counts.lp_origin_drift, 1);
    assert.equal(puts.length, 1);
    assert.equal(puts[0].body.appointmentStatus, 'showed');
    assert.equal(Date.parse(puts[0].body.startTime), Date.parse(ghlAt(demoMs)), 'moved to LP\'s demo time');
    assert.equal(queued.filter((q) => q.action_type === 'move_opportunity').length, 1);
    assert.equal(r.post_appointment_close.closed.showed, 1);
    assert.equal(r.writes >= 1, true, 'the close counts against PARITY_MAX_WRITES');
  } finally {
    if (prev === undefined) delete process.env.POST_APPT_CLOSE_MODE; else process.env.POST_APPT_CLOSE_MODE = prev;
  }
});

// ═══ postDemoLock: a newer issued / post-demo lead locks an older one ════

test('postDemoLock: Data lead 579742 is locked while newer 583833 is Issue (or OPPFDN)', async () => {
  for (const code of ['Issue', 'OPPFDN']) {
    const db = fakeSupabase({ lp_leads: [
      { lp_lead_id: '579742', lp_prospect_id: '461906', disposition_code: 'Data' },
      { lp_lead_id: '583833', lp_prospect_id: '461906', disposition_code: code },
    ] });
    const r = await postDemoLock('579742', { deps: { supabase: db, getLeadByLdsId: async () => [{ lds_id: '579742', Disposition: 'Data' }] } });
    assert.deepEqual([r.locked, r.source, r.newer_lp_lead_id], [true, 'newer_lead', '583833'], code);
  }
});

test('postDemoLock: an OLDER issued lead never locks a newer one, and a newer Set does not lock', async () => {
  const db = fakeSupabase({ lp_leads: [
    { lp_lead_id: '500000', lp_prospect_id: '461906', disposition_code: 'OPPFDN' },
    { lp_lead_id: '583833', lp_prospect_id: '461906', disposition_code: 'Set' },
    { lp_lead_id: '590000', lp_prospect_id: '461906', disposition_code: 'Set' },
  ] });
  const r = await postDemoLock('583833', { deps: { supabase: db, getLeadByLdsId: async () => [{ lds_id: '583833', Disposition: 'Set' }] } });
  assert.equal(r.locked, false);
});

// ═══ LP live carries the confirmed checkbox ═════════════════════════════

test('liveAppointmentFromLead: confirmed true / false / absent', () => {
  assert.equal(liveAppointmentFromLead({ apptdate: '2026-10-16 14:00', confirmed: 'true' }).confirmed, true);
  assert.equal(liveAppointmentFromLead({ apptdate: '2026-10-16 14:00', Confirmed: false }).confirmed, false);
  assert.equal(liveAppointmentFromLead({ apptdate: '2026-10-16 14:00' }).confirmed, undefined);
});

// ═══ Fix 5: Confirmation Pipeline coverage ═════════════════════════════

test('readUncoveredLeads: an upcoming visit with no card is listed; a carded one, a past one and an unlinked one are not', async () => {
  const now = new Date(Date.UTC(2026, 9, 16, 16));
  const db = fakeSupabase({
    lp_leads: [
      { lp_lead_id: '1', ghl_contact_id: 'c1', disposition_code: 'Set', appointment_date: '2026-10-18T10:00:00+00:00', lp_deleted_at: null },
      { lp_lead_id: '2', ghl_contact_id: 'c2', disposition_code: 'Cnf', appointment_date: '2026-10-17T14:00:00+00:00', lp_deleted_at: null },
      { lp_lead_id: '3', ghl_contact_id: 'c3', disposition_code: 'Set', appointment_date: '2026-10-10T10:00:00+00:00', lp_deleted_at: null },
      { lp_lead_id: '4', ghl_contact_id: null, disposition_code: 'Set', appointment_date: '2026-10-18T10:00:00+00:00', lp_deleted_at: null },
      { lp_lead_id: '5', ghl_contact_id: 'c5', disposition_code: 'Issue', appointment_date: '2026-10-18T10:00:00+00:00', lp_deleted_at: null },
      { lp_lead_id: '6', ghl_contact_id: 'c6', disposition_code: 'Set', appointment_date: '2026-11-30T10:00:00+00:00', lp_deleted_at: null },
    ],
    confirmation_opportunities: [{ lp_lead_id: '2', ghl_contact_id: 'c2', stage_key: 'confirmed', last_moved_by: 'lp' }],
  });
  const out = await readUncoveredLeads(db, { now, tz: 'America/New_York' });
  assert.deepEqual(out.map((l) => l.lp_lead_id), ['1']);
  const capped = await readUncoveredLeads(db, { now, tz: 'America/New_York', cap: 0 });
  assert.equal(capped.length, 0);
});

test('runPostAppointmentClose: LP live reads are capped per pass (the rest wait a sweep)', async () => {
  const rows = Array.from({ length: 5 }, (_, i) => ({ ghl_contact_id: `c${i}`, ghl_appointment_id: `a${i}`, ghl_calendar_id: WE, status: 'new', start_time: DEMO_GHL }));
  const leads = new Map(rows.map((r, i) => [r.ghl_contact_id, [{ lp_lead_id: `${i}`, disposition_code: 'Issue', appointment_date: DEMO_LP }]]));
  let reads = 0;
  const { deps } = closeDeps({ mode: 'shadow', readCap: 2, readGhlRows: async () => rows, readLeads: async () => leads, readLive: async () => { reads++; return live('Issue'); } });
  const s = await runPostAppointmentClose({ deps });
  assert.equal(reads, 2);
  assert.equal(s.waiting, 2);
  assert.equal(s.capped, 3);
});

test('close memo (2026-10-18): a second pass re-reads no settled row and reaches the rows past the cap', async () => {
  const rows = Array.from({ length: 5 }, (_, i) => ({ ghl_contact_id: `c${i}`, ghl_appointment_id: `a${i}`, ghl_calendar_id: WE, status: 'new', start_time: DEMO_GHL }));
  const leads = new Map(rows.map((r, i) => [r.ghl_contact_id, [{ lp_lead_id: `${i}`, disposition_code: 'Issue', appointment_date: DEMO_LP }]]));
  const read = [];
  const memo = createSettledMemo();
  const { deps } = closeDeps({ mode: 'shadow', readCap: 2, settledMemo: memo, readGhlRows: async () => rows, readLeads: async () => leads, readLive: async (lead) => { read.push(lead.lp_lead_id); return live('Issue'); } });
  await runPostAppointmentClose({ deps });
  const second = await runPostAppointmentClose({ deps });
  const third = await runPostAppointmentClose({ deps });
  assert.deepEqual(read, ['0', '1', '2', '3', '4'], 'every row read once, none twice');
  assert.equal(second.remembered, 2);
  assert.equal(third.remembered, 4, 'pass 3 reads only the last row');
  assert.equal(third.waiting, 5, 'a remembered wait still counts as waiting');
  assert.equal(third.capped, 0);
});

test('close memo: LP dispositioning the lead re-reads at once; a shadow close is remembered, a live write and an unreadable LP never', async () => {
  const memo = createSettledMemo();
  const rows = [{ ghl_contact_id: 'c0', ghl_appointment_id: 'a0', ghl_calendar_id: WE, status: 'new', start_time: DEMO_GHL }];
  let code = 'Issue';
  let reads = 0;
  const { deps } = closeDeps({ mode: 'shadow', settledMemo: memo, readGhlRows: async () => rows,
    readLeads: async () => new Map([['c0', [{ lp_lead_id: '7', disposition_code: code, appointment_date: DEMO_LP }]]]),
    readLive: async () => { reads++; return live(code); } });
  await runPostAppointmentClose({ deps });
  code = 'OPPFDN';
  const s = await runPostAppointmentClose({ deps });
  assert.equal(reads, 2, 'a new stored disposition is a new key');
  assert.equal(s.would.showed, 1);
  const again = await runPostAppointmentClose({ deps });
  assert.equal(reads, 2, 'the shadow close is remembered');
  assert.equal(again.would.showed, 1, 'and still reported');
  assert.equal(settledTtl({ op: 'close', applied: true }, 'live'), 0);
  assert.equal(settledTtl({ op: 'skip', reason: 'lp_unreadable' }, 'shadow'), 0);
  assert.equal(settledTtl({ op: 'wait', reason: 'visit_not_passed' }, 'shadow'), 0);
});
